#!/usr/bin/env bun --watch
/**
 * GitHub Issue Priorities Labeler
 *
 * This task keeps priority labels in sync between a Notion database and GitHub issues and pull requests.
 * It supports bidirectional synchronization: changes in Notion can update GitHub labels, and changes in
 * GitHub priority labels can be reflected back into Notion.
 *
 * Workflow:
 * Notion → GitHub:
 * 1. Fetches tasks from the Notion database filtered by entries with GitHub links and priorities.
 * 2. Maps Notion priorities (High/Medium/Low) to corresponding GitHub labels (High-Priority/Medium-Priority/Low-Priority).
 * 3. For each task:
 *    - Retrieves current labels from the GitHub issue/PR.
 *    - Adds missing priority labels.
 *    - Removes obsolete priority labels that don't match the current Notion priority.
 *
 * GitHub → Notion:
 * 4. Scans GitHub issues and pull requests that are linked to Notion tasks.
 * 5. Reads the current priority label state (and recent label events where available).
 * 6. Updates the corresponding Notion page's Priority property when GitHub's priority label differs,
 *    so that Notion reflects the latest effective priority on GitHub.
 *
 * Both directions:
 * 7. Uses checkpoint-based incremental processing for Notion and GitHub scanners to resume from the
 *    last processed items without reprocessing the entire dataset.
 *
 * Important behaviors:
 * - Processes Notion items in ascending order by last_edited_time for consistent checkpoint tracking.
 * - Maintains separate checkpoints for Notion and GitHub scans to support robust bidirectional sync.
 * - Sequential processing ensures checkpoint state remains consistent.
 * - Caches GitHub and Notion API responses to reduce API calls.
 * - Gracefully handles errors for individual label or property update operations without stopping
 *   the entire task.
 */
import { github, notion } from "@/lib";
import { db } from "@/src/db";
import type { GH } from "@/lib/github";
import { ghPageFlow } from "@/src/ghPageFlow";
import { parseIssueUrl, stringifyIssueUrl } from "@/src/parseIssueUrl";
import { parseGithubRepoUrl } from "@/src/parseOwnerRepo";
import Notion, { type PageObjectResponse } from "@notionhq/client";
import DIE from "@snomiao/die";
import chalk from "chalk";
import { compareBy } from "comparing";
import isCI from "is-ci";
import Keyv from "keyv";
import KeyvMongodbStore from "keyv-mongodb-store";
import KeyvNedbStore from "keyv-nedb-store";
import KeyvNest from "keyv-nest";
import sflow, { pageFlow } from "sflow";

const _DEBUG_CACHE = !!process.env.VERBOSE;

type IssuesState = {
  page_id?: string;
  Priority?: string | null;
  labels?: string[];
  timeline?: {
    event: "LabeledEvent" | "UnlabeledEvent";
    createdAt: string;
    label: {
      name: string;
    } | null;
  }[];
};

const State = new Keyv(
  KeyvNest(
    new Map(),
    // new KeyvNedbStore('.cache/gh-issue-priorities.nedb.yml'), // debuggable state store
    new KeyvMongodbStore(db.collection("GithubIssuePrioritiesState")), // persist to prod mongodb
  ),
);

// issue/pr url -> {id: comfy-task-id, Priority: string}
const IssuesState = KeyvNest<IssuesState>(
  new Map(),
  new KeyvNedbStore(".cache/gh-issue-priorities-issues-state.nedb.yml"), // debuggable state store
  new KeyvMongodbStore(db.collection("GithubIssuePrioritiesIssuesState")), // persist to prod mongodb
);

// await IssuesState.clear() // for testing
const NotionCheckpoint = "checkpoint"; // notion scanner checkpoint
const GithubCheckpointPrefix = "github-checkpoint-2-"; // github issue scanner checkpoint
// await State.delete(CHECKPOINT); // reset checkpoint for testing

const notionPriorityToGithubLabelsMap = {
  High: "High-Priority",
  Medium: "Medium-Priority",
  Low: "Low-Priority",
  // "": "",
};
const PRIORITY_LABELS = Object.values(notionPriorityToGithubLabelsMap);
const mapNotionPriorityToGithubLabel = (priority: string) =>
  (notionPriorityToGithubLabelsMap as Record<string, string>)[priority] ||
  DIE(`Unknown priority: ${priority}`);

const notionComfyTasks = "https://www.notion.so/bf086637f74c4292ae588ab84ff18550";
if (import.meta.main) {
  // 2025-12-19 debugging single comfy task noted by @cbyrne, need sync from github to notion
  // const debugtask = "https://www.notion.so/comfy-org/Issue-7446-Nodes-v2-Joining-sockets-in-subgraphs-bug-2c86d73d36508136961adb165f75d05f"
  // const comfyTask = await notion.pages.retrieve({ page_id: debugtask.split("-").pop()! }) as Notion.PageObjectResponse;
  // console.log(JSON.stringify(comfyTask, null, 2));
  // await ComfyTaskPrioritySync(comfyTask)

  await SyncPriorityBetweenComfyTaskAndGithubIssue();

  console.log("Done");
  if (isCI) {
    await db.close();
    process.exit(0);
  }
}
async function SyncPriorityBetweenComfyTaskAndGithubIssue() {
  const st = Date.now() / 1000;

  // prefetch all issues' labels + timeline into IssuesState cache, to reduce github api calls during sync
  const repoUrls = [
    "https://github.com/Comfy-Org/ComfyUI_frontend",
    "https://github.com/Comfy-Org/desktop",
  ];
  const searchedIssues = await sflow(repoUrls)
    .flatMap(async (repoUrl) => [
      await repoIssueLabelsFlow(repoUrl, { isClosed: false }),
      await repoIssueLabelsFlow(repoUrl, { isClosed: true }),
    ])
    .confluenceByParallel()
    .toArray();

  // notion -> github, also collects issue/prs -> comfy-task mapping
  // Fetch the Comfy tasks database
  console.log("Fetching Comfy tasks database...");

  const database_id = notionComfyTasks.split("/").pop()!;
  const database = (await notion.databases.retrieve({
    database_id,
  })) as Notion.DatabaseObjectResponse;
  const data_source_id = database.data_sources?.[0]?.id ?? DIE("No data sources found in database");

  console.log("Database info:", JSON.stringify(database));

  // // Query the database to get tasks
  // console.log('\nFetching tasks from database...');
  // // full scan + incremental watching
  // Checkpoint shape:
  //   { editedAt, processedIdsAtEditedAt[] } — robust against ties at the same last_edited_time.
  //   Legacy { id, editedAt } is upgraded by treating { id } as the only processed id at editedAt.
  const checkpoint = (await State.get(NotionCheckpoint)) as
    | { id?: string; editedAt?: string; processedIdsAtEditedAt?: string[] }
    | undefined;
  console.log("[notion] comfy-task scan resuming from checkpoint:", checkpoint);
  const boundaryEditedAt = checkpoint?.editedAt;
  const processedIdsAtBoundary = new Set<string>(
    checkpoint?.processedIdsAtEditedAt ?? (checkpoint?.id ? [checkpoint.id] : []),
  );
  // Mutable copies used while processing this run, so subsequent items at the same
  // boundary timestamp persist into the checkpoint and are skipped on the next run.
  let currentBoundaryEditedAt: string | undefined = boundaryEditedAt;
  const currentProcessedIdsAtBoundary = new Set<string>(processedIdsAtBoundary);

  // Sync Recent edited Comfy Tasks to GitHub Issues/PRs
  // Notion's start_cursor must be a token returned by a previous query (next_cursor),
  // not an arbitrary page ID. To resume from a checkpoint, filter by last_edited_time
  // and start pagination from undefined. To handle multiple pages sharing the same
  // last_edited_time as the checkpoint, skip those whose ids are already in
  // processedIdsAtBoundary.
  const checkpointFilter = boundaryEditedAt
    ? [
        {
          timestamp: "last_edited_time" as const,
          last_edited_time: { on_or_after: boundaryEditedAt },
        },
      ]
    : [];
  const tasks = await pageFlow(undefined as string | undefined, async (cursor, page_size = 100) => {
    // console.log(`Querying Notion data source ${data_source_id} with cursor=${cursor} page_size=${page_size}...`);
    const ret = await notion.dataSources.query({
      data_source_id,
      result_type: "page",
      filter: {
        and: [{ property: "[GH🤖] Link", url: { is_not_empty: true } }, ...checkpointFilter],
      },
      sorts: [{ direction: "ascending", timestamp: "last_edited_time" }],
      page_size,
      start_cursor: cursor,
    });
    return { next: ret.next_cursor, data: ret.results };
  })
    .flat()
    .map((e) => e as Notion.PageObjectResponse)
    .filter((e) => !(e.last_edited_time === boundaryEditedAt && processedIdsAtBoundary.has(e.id)))
    .map((e) => {
      return {
        ...e,
        Title: (
          (e.properties.Task as unknown as Record<string, unknown[]>)?.title?.[0] as
            | Record<string, string>
            | undefined
        )?.plain_text,
        Priority:
          (e.properties.Priority as unknown as { select?: { name?: string } })?.select?.name ||
          null,
        issueUrl: (e.properties["[GH🤖] Link"] as unknown as { url?: string })?.url?.trim(),
      };
    })
    // update issue Priority state cache
    .forEach(async ({ id, issueUrl, Priority }) => {
      if (!issueUrl?.trim()) return;
      await IssuesState.set(issueUrl, {
        ...(await IssuesState.get(issueUrl)),
        page_id: id,
        Priority,
      });
    })

    .filter((e) => e.Title) // only with title
    // .filter((e) => e.Priority?.trim()) // only with priority
    .filter((e) => e.issueUrl?.trim()) // github issue or pull url

    // process each task with error catcher
    .forEach(
      tryCatcher(
        (error, fn, e) => {
          const eRecord = e as Record<string, unknown>;
          console.error(
            chalk.red(
              `Error processing task ${eRecord.id} - ${eRecord.issueUrl}:`,
              error instanceof Error ? error.message : error,
            ),
          );
        },
        async (e) => {
          const task = e as Notion.PageObjectResponse;
          await ComfyTaskPrioritySync(task);
          // Per-item checkpoint. When advancing past the previous boundary timestamp,
          // reset the processed-id set; otherwise append the id so future runs skip
          // every page already handled at this exact timestamp.
          const isNewBoundary = task.last_edited_time !== currentBoundaryEditedAt;
          if (isNewBoundary) {
            currentBoundaryEditedAt = task.last_edited_time;
            currentProcessedIdsAtBoundary.clear();
          }
          currentProcessedIdsAtBoundary.add(task.id);
          await State.set(NotionCheckpoint, {
            id: task.id,
            editedAt: currentBoundaryEditedAt,
            processedIdsAtEditedAt: [...currentProcessedIdsAtBoundary],
          });
        },
      ),
    )
    .toArray();

  console.log("Tasks:", JSON.stringify(tasks.length, null, 2));

  // github -> notion (when github issues updated, sync back to comfy task)
  await sflow(searchedIssues)
    .forEach(async (e) => {
      const issueState = (await IssuesState.get(e.url)) as IssuesState;
      if (!issueState.page_id) return null; // no notion page linked yet, maybe unito sync not working
      const page = (await notion.pages.retrieve({
        page_id: issueState.page_id,
      })) as PageObjectResponse;
      await ComfyTaskPrioritySync(page);
    })
    .run();

  const et = Date.now() / 1000;
  console.log(`Done in ${(et - st).toFixed(2)} seconds.`);
}

export default SyncPriorityBetweenComfyTaskAndGithubIssue;

function tryCatcher<F extends (...args: unknown[]) => Promise<unknown>, R>(
  onError: (error: unknown, fn: F, ...args: unknown[]) => R,
  fn: F,
) {
  return async (...args: Parameters<F>): Promise<ReturnType<F> | R> => {
    try {
      return (await fn(...args)) as unknown as ReturnType<F>;
    } catch (error) {
      return onError(error, fn, ...args);
    }
  };
}

async function ComfyTaskPrioritySync(e: Notion.PageObjectResponse) {
  const Title = (
    e.properties.Task as {
      title: Array<{ plain_text: string }>;
    }
  )?.title?.[0]?.plain_text as string | undefined;

  const Priority =
    (e.properties.Priority as Notion.SelectPropertyItemObjectResponse)?.select?.name || null;
  const issueUrl =
    (e.properties["[GH🤖] Link"] as Notion.UrlPropertyItemObjectResponse)?.url?.trim() ||
    DIE(`no issue Url defined in page ${e.id} - ${Title}`);
  const issueCache =
    ((await IssuesState.get(issueUrl)) as IssuesState) ||
    (await IssuesState.get(stringifyIssueUrl(parseIssueUrl(issueUrl))));

  const issueLabels: string[] =
    issueCache?.labels ||
    (await github.rest.issues
      .listLabelsOnIssue({ ...parseIssueUrl(issueUrl) })
      .then((e) => e.data.map((l) => l.name)));
  const currentPriorityLabels = issueLabels.filter((l) => PRIORITY_LABELS.includes(l));
  const timeline =
    issueCache?.timeline?.map((ev) => ({
      event:
        ev.event === "LabeledEvent"
          ? "labeled"
          : ev.event === "UnlabeledEvent"
            ? "unlabeled"
            : ev.event,
      created_at: ev.createdAt,
      label: ev.label,
    })) ||
    (await ghPageFlow(github.rest.issues.listEventsForTimeline)({ ...parseIssueUrl(issueUrl) })
      .toArray()
      .catch((error) => {
        console.warn(
          `Failed to fetch timeline for ${issueUrl}:`,
          error instanceof Error ? error.message : error,
        );
        return [];
      }));
  const labelEvents = timeline
    .flatMap((e) =>
      e.event === "labeled" || e.event === "unlabeled"
        ? [e as GH["labeled-issue-event"] | GH["unlabeled-issue-event"]]
        : [],
    )
    .toSorted(compareBy((e) => e.created_at && new Date(e.created_at).getTime()));
  const issuePriorityEditedAt =
    labelEvents
      .filter((ev) => ev.label && PRIORITY_LABELS.includes(ev.label.name))
      .map((ev) => ({ name: ev.label.name, created_at: ev.created_at }))
      ?.at(-1)?.created_at || null;
  const desiredNotionPriority =
    Object.entries(notionPriorityToGithubLabelsMap).find(([_k, v]) =>
      currentPriorityLabels.includes(v),
    )?.[0] || null; // when multiple exists, pick highest priority
  const desiredPriorityLabels = Priority ? [mapNotionPriorityToGithubLabel(Priority)] : [];

  const notionEditedAt = e.last_edited_time || null;

  console.log(`+Task: ${e.id} \t IssueUrl: ${issueUrl || " ".repeat(30)} \t Title: ${Title}`);
  console.log(
    `       Notion edited at: ${notionEditedAt}, Issue priority label edited at: ${issuePriorityEditedAt}`,
  );
  console.log(
    `       Notion Priority: ${Priority || "_".repeat(10)},  GH labels:`,
    currentPriorityLabels,
  );
  // console.log(`       DesiredNotionPriority: ${desiredNotionPriority || "_".repeat(10)},  Desired Github labels:`, desiredPriorityLabels);

  // detect sync direction
  if (
    notionEditedAt &&
    (!issuePriorityEditedAt || new Date(notionEditedAt) > new Date(issuePriorityEditedAt))
  ) {
    // notion is newer, sync to github
    const addLabels = desiredPriorityLabels.filter((l) => !currentPriorityLabels.includes(l));
    const removeLabels = PRIORITY_LABELS.filter(
      (l) => currentPriorityLabels.includes(l) && !desiredPriorityLabels.includes(l),
    );
    if (addLabels.length || removeLabels.length) {
      console.log(
        `       [Notion->GitHub] +/- Labels ${issueUrl}: `,
        addLabels.map((e) => "+" + e).join(", "),
        removeLabels.map((e) => "-" + e).join(", "),
      );

      // labels op
      if (addLabels.length) {
        await github.rest.issues.addLabels({ ...parseIssueUrl(issueUrl), labels: addLabels });
      }
      await sflow(removeLabels)
        .map((l) => github.rest.issues.removeLabel({ ...parseIssueUrl(issueUrl), name: l }))
        .run();

      console.log(
        `       [Notion->GitHub] Labeled issue/pr ${issueUrl} with labels:`,
        desiredPriorityLabels,
      );
    }
  } else if (
    issuePriorityEditedAt &&
    (!notionEditedAt || new Date(issuePriorityEditedAt) > new Date(notionEditedAt))
  ) {
    // github priority is newer, sync to notion
    if (desiredNotionPriority !== Priority) {
      console.log(
        `       [GitHub->Notion] Update Comfy Task ${e.id} Priority: ${Priority || "_".repeat(10)} -> ${desiredNotionPriority || "_".repeat(10)}`,
      );

      // update notion task priority
      await notion.pages.update({
        page_id: e.id,
        properties: {
          Priority: {
            select: desiredNotionPriority ? { name: desiredNotionPriority } : null,
          },
        },
      });
    }
  }
}

async function repoIssueLabelsFlow(
  repoUrl: string,
  { isClosed = false }: { isClosed?: boolean } = {},
) {
  const { owner, repo } = parseGithubRepoUrl(repoUrl);
  const checkpointKey = GithubCheckpointPrefix + (isClosed ? "closed-" : "open-") + repoUrl;
  const checkpoint = await State.get<string>(checkpointKey);
  console.log(
    `[github] ${repoUrl}/issues?q=is:${isClosed ? "closed" : "open"} \t resuming from checkpoint: ${checkpoint}`,
  );
  return (
    pageFlow(
      {
        endCursor: null as null | string,
        updatedGt: checkpoint || "",
        // isClosed: false as boolean | null,
      },
      async (cursor, pageSize = 100) => {
        const endCursor = cursor.endCursor;
        const updatedGt = cursor.updatedGt;
        const resp = (await github.graphql(
          `
      query listTasksInRepo {
      search(
        query: "repo:${owner}/${repo} sort:updated-asc${updatedGt ? ` updated:>${updatedGt}` : ""}${isClosed ? " is:closed" : " is:open"}",
        type: ISSUE,
        first: ${pageSize},
        after: ${JSON.stringify(endCursor)}
      ) {
        issueCount

        pageInfo{
          hasNextPage
          endCursor
        }
        nodes {
          ... on PullRequest {
            number
            repository { name, owner { login } }
            type: __typename
            updatedAt
            state

            # 1. Get CURRENT labels attached to the issue
            labels(first: 100) {
              nodes { name }
            }

            # 2. get recent label events to detect priority label update time
            timelineItems(last: 100, itemTypes: [LABELED_EVENT, UNLABELED_EVENT]) {
              nodes {
                ... on LabeledEvent {
                  event: __typename
                  createdAt
                  label { name }
                }
                ... on UnlabeledEvent {
                  event: __typename
                  createdAt
                  label { name }
                }
              }
            }
          }

          ... on Issue {
            number
            repository { name, owner { login } }
            type: __typename
            updatedAt
            state

            # 1. Get CURRENT labels attached to the issue
            labels(first: 100) {
              nodes { name }
            }

            # 2. get recent label events to detect priority label update time
            timelineItems(last: 100, itemTypes: [LABELED_EVENT, UNLABELED_EVENT]) {
              nodes {
                ... on LabeledEvent {
                  event: __typename
                  createdAt
                  label { name }
                }
                ... on UnlabeledEvent {
                  event: __typename
                  createdAt
                  label { name }
                }
              }
            }
          }
        }
      }
    }`.replace(/ +/g, " "),
        )) as {
          search: {
            issueCount: number;
            pageInfo: {
              hasNextPage: boolean;
              endCursor: string | null;
            };
            nodes: Array<{
              number: number;
              repository: { name: string; owner: { login: string } };
              type: "Issue" | "PullRequest";
              labels: { nodes: { name: string }[] };
              timelineItems: {
                nodes: Array<{
                  event: "LabeledEvent" | "UnlabeledEvent";
                  createdAt: string;
                  label: { name: string } | null;
                }>;
              };
              updatedAt: string;
              state: string;
            }>;
          };
        };
        console.debug(
          `+Github Searched: ${repoUrl} - Fetched ${resp.search.nodes.length}/${resp.search.issueCount} issues/prs updated since ${updatedGt || "the beginning"}.`,
        );
        const data = resp.search.nodes;
        // Full Issues Pagination:
        // 1. loop over endCursor from null to no next page
        // 2. loop over updatedGt from '' to no next page
        // 3. loop over isClosed from false to true
        // 4. combine 1,2,3 to cover all issues, note: results not strictly sorted by updatedAt asc, TODO: solve it
        const nextEndCursor = resp.search.pageInfo.hasNextPage
          ? resp.search.pageInfo.endCursor
          : null;
        const nextUpdatedGt = nextEndCursor
          ? updatedGt
          : data.length
            ? data[data.length - 1].updatedAt
            : "";
        // const nextIsClosed = nextEndCursor || nextUpdatedGt ? cursor.isClosed : cursor.isClosed === false ? true : null;
        const next = !nextUpdatedGt
          ? null
          : {
              endCursor: nextEndCursor,
              updatedGt: nextUpdatedGt,
              // isClosed: nextIsClosed,
            };
        return { data, next };
      },
    )
      .flat()
      // save to issues state cache
      .forEach(async (issue) => {
        // const { owner, repo } = parseGithubRepoUrl(repoUrl)
        const owner = issue.repository.owner.login;
        const repo = issue.repository.name;
        const typename = issue.type === "PullRequest" ? "pull" : "issues";
        const issueUrl = `https://github.com/${owner}/${repo}/${typename}/${issue.number}`;
        await IssuesState.set(issueUrl, {
          ...(await IssuesState.get(issueUrl)),
          labels: issue.labels.nodes.map((label) => label.name),
          timeline: issue.timelineItems.nodes,
          updatedAt: issue.updatedAt,
          state: issue.state,
        });
        if (issue.updatedAt) await State.set(checkpointKey, issue.updatedAt);
      })
      // flat the info for further processing
      .map((issue) => {
        const owner = issue.repository.owner.login;
        const repo = issue.repository.name;
        const typename = issue.type === "PullRequest" ? "pull" : "issues";
        const url = `https://github.com/${owner}/${repo}/${typename}/${issue.number}`;
        return {
          url,
          labels: issue.labels.nodes.map((label) => label.name),
          timeline: issue.timelineItems.nodes,
          updatedAt: issue.updatedAt,
          state: issue.state as "OPEN" | "CLOSED" | "MERGED",
        };
      })
  );
}
