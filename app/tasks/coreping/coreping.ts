#!/usr/bin/env bun --watch
import { confirm } from "@/lib/utils";
import { tsmatch } from "@/packages/mongodb-pipeline-ts/Task";
import { db } from "@/src/db";
import { MetaCollection } from "@/src/db/TaskMeta";
import { type GH } from "@/lib/github";
import { ghc } from "@/lib/github/githubCached";
import { ghPageFlow } from "@/src/ghPageFlow";
import { parseIssueUrl } from "@/src/parseIssueUrl";
import { parseGithubRepoUrl } from "@/src/parseOwnerRepo";
import { parsePullUrl } from "@/src/parsePullUrl";
import { slack } from "@/lib/slack";
import { slackCached } from "@/lib/slack/slackCached";
import { yaml } from "@/src/utils/yaml";
import DIE from "@snomiao/die";
import chalk from "chalk";
import { compareBy } from "comparing";
import isCI from "is-ci";
import ms from "ms";
import sflow, { pageFlow } from "sflow";
import { P } from "ts-pattern";
import type { UnionToIntersection } from "type-fest";
import z from "zod";
import { slackMessageUrlParse } from "../gh-design/slackMessageUrlParse";
import { upsertSlackMessage } from "../gh-desktop-release-notification/upsertSlackMessage";

// yeah, if the bot could ping when updates have been made to a previously-reviewed PR, would be extremely helpful

/**
 * [Comfy- CorePing] The Core/Important PR Review Reminder Service
 * This service reminders @comfyanonymous for unreviewed Core/Core-Important PRs every 24 hours in the morning 8am of california
 *
 * Environment: it's designed to be run in github actions by cron-job.
 *
 * Usage: run this script in github actions by cron job, it will scan all Core/Important PRs and send a slack message to @comfyanonymous
 *
 * How should it works:
 *
 * Scan all comfy-prs, with labels 'Core-*'
 *    match theLabel("Core-Important") or theLabel("Core")
 *      check if the pr is reviewed (after the label added):
 *        when it's not reviewed yet:
 *          < 24h since the labeled event to now: fresh
 *          > 24h since the labeled event to now: stale
 *            Collect and send @comfy reminder
 *        when it's reviewed by @comfy after label:
 *          after pr-review/pr-comment, add comment can set "Core-Ready-For-Review", by '+label:Core-Ready-For-Review'
 *    match theLabel('Core-Ready-For-Review'):
 *
 */

export const coreReviewTrackerConfig = {
  REPOLIST: [
    // "https://github.com/comfyanonymous/ComfyUI", // deprecated
    "https://github.com/Comfy-Org/ComfyUI", // 2026-01-08 new
    "https://github.com/Comfy-Org/Comfy-PR",
    "https://github.com/Comfy-Org/ComfyUI_frontend",
    "https://github.com/Comfy-Org/desktop",
  ],
  // labels
  labels: ["Core", "Core-Important", "CoreImportant"],
  // personalLabels: label to slack user mapping
  personalLabels: [
    { label: "notify:jk", slackUser: "@jk" },
    { label: "notify:sno", slackUser: "snomiao" },
  ],
  minReminderInterval: "24h", // edit-existed-slack-message < this-interval < send-another-slack-message
  slackChannelName: "develop", // develop channel, without notification

  // github message
  messageUpdatePattern: "<!-- COMFY_PR_BOT_TRACKER -->",
  staleMessage: `<!-- COMFY_PR_BOT_TRACKER --> This PR has been waiting for a response for too long. A reminder is being sent to @comfyanonymous.`,
  reviewedMessage: `<!-- COMFY_PR_BOT_TRACKER --> This PR is reviewed! When it's ready for review again, please add a comment with **+label:Core-Ready-for-Review** to reminder @comfyanonymous to restart the review process.`,
};
const cfg = coreReviewTrackerConfig;

export const LABELS = cfg.labels;

type ReviewStatus = Awaited<ReturnType<typeof determinePullRequestReviewStatus>>["status"];

type ComfyCorePRs = {
  url: string;
  title: string;

  // pr info
  created_at: Date;
  labels: string[];
  state: GH["pull-request"]["state"]; // open/closed
  author?: string; // pr author login

  // review status
  status: ReviewStatus;
  statusAt?: Date;
  /** @deprecated use pr.title to compose status message */
  statusMsg?: string; // status message used to fill summary
  lastStatus?: ReviewStatus; // for diff status and then send ping message

  // send a ping when status changed to pingable status
  isPingNeeded?: boolean;
  lastPingMessage?: null | {
    url: string;
    text: string; // ping message
  };

  // review status
  last_labeled_at?: Date;
  last_reviewed_at?: Date;
  last_commented_at?: Date;
  task_updated_at: Date;
};
export const ComfyCorePRs = db.collection<ComfyCorePRs>("ComfyCorePRs");

/* only one */
// type ComfyCorePRsLastMessage = {
//   url: string;
//   text: string;
// };
// export const ComfyCorePRsLastMessage = db.collection<ComfyCorePRsLastMessage>("ComfyCorePRsLastMessage");
const Meta = MetaCollection(
  ComfyCorePRs,
  z.object({
    lastSlackMessage: z
      .object({
        url: z.string(),
        text: z.string(),
        sendAt: z.date(),
      })
      .optional(),
  }),
);

const saveTask = async (pr: Partial<ComfyCorePRs> & { url: string }) => {
  return (
    (await ComfyCorePRs.findOneAndUpdate(
      { url: pr.url },
      { $set: { ...pr, task_updated_at: new Date() } },
      { upsert: true, returnDocument: "after" },
    )) || DIE(`fail to save task${JSON.stringify(pr)}`)
  );
};

if (import.meta.main) {
  // Designed to be mon to sat, TIME CHECKING
  // Pacific Daylight Time

  // const url = "https://github.com/Comfy-Org/ComfyUI/pull/10179";
  // const url = "https://github.com/Comfy-Org/ComfyUI/pull/8351";
  // await determinePullRequestReviewStatus(url);

  // await _cleanSpammyMessages20251117()
  await runCorePingTaskFull();
  // await runCorePingTaskIncremental();
  // reviewCommentsCheckpoint()

  console.log("done", import.meta.file);

  if (isCI) {
    await db.close();
    process.exit(0);
  }
}

function reviewStatusExplained(status: ReviewStatus) {
  return tsmatch(status)
    .with("DRAFT", () => "The PR is in draft mode, not ready for review yet.")
    .with("MERGED", () => "The PR has been merged.")
    .with("CLOSED", () => "The PR has been closed without merging.")
    .with("REVIEWED", () => "The PR has been reviewed by a collaborator.")
    .with("OPEN", () => "The PR is open and ready for review, but no reviews or responses yet.")
    .with(
      "REVIEW_REQUESTED",
      () =>
        "The PR has requested reviews from specific reviewers, but none have reviewed or commented yet.",
    )
    .with("AUTHOR_COMMENTED", () => "The PR has been responed by the author.")
    .with("COMMITTED", () => "The PR has new commits pushed to it.")
    .with("REVIEWER_COMMENTED", () => "A requested reviewer has commented on the PR.")
    .with("UNRELATED", () => "The PR is not labeled as Core or Core-Important.")
    .exhaustive();
}
/**
 * Determines review status of PR, by:
 *   1. draft: is draft
 *   2. merged: have merged_at
 *   3. closed: have closed_at
 *   4. requested: Requested someone to review, but none reviewed neither commented yet
 *   5. reviewed: Reviewed/Commented by unknown collaborator after requested
 *   6. responded: A Latest change is responds by the PR author
 *   7. open: is ready for review, but no review/response yet
 */
async function determinePullRequestReviewStatus(
  pr: GH["pull-request-simple"] | GH["pull-request"],
  {
    isUnrelated,
  }: {
    isUnrelated?: (pr: GH["pull-request-simple"] | GH["pull-request"]) => boolean;
  },
) {
  return await tsmatch(pr)
    .when(
      (pr) => isUnrelated?.(pr),
      () => ({ status: "UNRELATED" as const, statusAt: new Date(pr.updated_at!) }),
    )
    .with({ merged_at: P.string }, () => ({
      status: "MERGED" as const,
      statusAt: new Date(pr.merged_at!),
    }))
    .with({ closed_at: P.string }, () => ({
      status: "CLOSED" as const,
      statusAt: new Date(pr.closed_at!),
    }))
    .with({ draft: true }, () => ({ status: "DRAFT" as const, statusAt: new Date(pr.created_at) }))
    .otherwise(async () => {
      const latestEvent = (await getTimelineReviewStatuses(pr))
        .flatMap((e) => (e.PR_STATUS ? [e] : []))
        .at(-1);
      if (!latestEvent?.PR_STATUS)
        return { statusAt: new Date(pr.created_at), status: "OPEN" as const };
      const latestEventAt =
        latestEvent.committed_at || latestEvent.submitted_at || latestEvent.created_at;

      if (!latestEventAt)
        throw new Error(
          `Failed to determine statusAt: no timestamp found in latest event for PR ${pr.html_url}`,
        );

      return { statusAt: new Date(latestEventAt), status: latestEvent.PR_STATUS };
    });
}

async function getTimelineReviewStatuses(pr: GH["pull-request-simple"] | GH["pull-request"]) {
  const timeline = await ghPageFlow(ghc.issues.listEventsForTimeline)({
    ...parseIssueUrl(pr.html_url),
  }).toArray();

  const reviewers = timeline
    .map((e) =>
      tsmatch(e)
        .with(
          {
            event: "review_requested",
            requested_reviewer: { login: P.select() },
          },
          (e) => e,
        )
        .otherwise(() => null),
    )
    .filter(Boolean) as string[];

  const timeline_statuses = timeline
    .map((e) => e as UnionToIntersection<typeof e>)
    // determine PR_STATUS, committed_at
    .map((e) => ({
      ...e,
      PR_STATUS: tsmatch(e)
        .with({ event: "committed" }, () => "COMMITTED" as const)
        .with({ event: "reviewed" }, () => "REVIEWED" as const)
        .with({ event: "review_requested" }, () => "REVIEW_REQUESTED" as const)
        .with({ event: "commented" }, (e) =>
          reviewers.includes(e.user.login)
            ? ("REVIEWER_COMMENTED" as const)
            : e.user.login === pr.user?.login
              ? ("AUTHOR_COMMENTED" as const)
              : null,
        )
        .otherwise(() => null),
      committed_at: e.committer?.date,
    }))
    // sanitize output for debug
    .map((e) => ({
      ...e,
      url: undefined,
      issue_url: undefined,
      id: undefined,
      node_id: undefined,
      performed_via_github_app: undefined,
      actor: e.actor?.login?.replace(/^/, "@"),
      user: e.user?.login?.replace(/^/, "@"),
      author: e.author?.name?.replace(/^/, ""),
      committer: e.committer?.name?.replace(/^/, "@"),
      tree: undefined,
      parents: undefined,
      verification: undefined,
      _links: undefined,
      sha: undefined,
      review_requester: e.review_requester?.login?.replace(/^/, "@"),
      requested_reviewer: e.requested_reviewer?.login?.replace(/^/, "@"),
      label: e.label?.name,

      reactions: e.reactions?.total_count,
      body: e.body
        ?.replace(/\s+/g, " ")
        .replace(/(?<=.{30})[\s\S]+/g, (e) => `...[${e.length} more chars]`),
      message: e.message
        ?.replace(/\s+/g, " ")
        .replace(/(?<=.{30})[\s\S]+/g, (e) => `...[${e.length} more chars]`),
    }));
  return timeline_statuses;
}

/**
 * Deduplicates PR tasks by PR number, preferring Comfy-Org/ComfyUI URLs over comfyanonymous/ComfyUI
 */
function deduplicatePRTasks<T extends { url: string }>(tasks: T[]): T[] {
  const seenPRNumbers = new Map<number, T>();
  for (const task of tasks) {
    const prNumber = Number(task.url.split("/").pop());
    if (isNaN(prNumber)) continue;

    const existingTask = seenPRNumbers.get(prNumber);
    if (!existingTask) {
      seenPRNumbers.set(prNumber, task);
    } else {
      // Prefer Comfy-Org/ComfyUI URLs over comfyanonymous/ComfyUI
      if (
        task.url.includes("Comfy-Org/ComfyUI") &&
        !existingTask.url.includes("Comfy-Org/ComfyUI")
      ) {
        seenPRNumbers.set(prNumber, task);
      }
    }
  }
  return Array.from(seenPRNumbers.values());
}

async function runCorePingTaskFull() {
  console.log("start", import.meta.file);
  const allPRs = await sflow(coreReviewTrackerConfig.REPOLIST)
    .map((repoUrl) =>
      ghPageFlow(ghc.pulls.list)({
        ...parseGithubRepoUrl(repoUrl),
        // state: "all",
        sort: "created",
        direction: "asc",
        query: `label: ${LABELS.map((e) => `"${e}"`).join(" OR label:")}`,
      }),
    )
    .confluenceByConcat()
    .filter((e) => e.labels.some((e) => ["Core", "Core-Important"].includes(e.name)))
    .toArray();

  // Deduplicate PRs by number, preferring Comfy-Org/ComfyUI over comfyanonymous/ComfyUI
  const seenPRNumbers = new Map<number, GH["pull-request-simple"]>();
  for (const pr of allPRs) {
    const existingPR = seenPRNumbers.get(pr.number);
    if (!existingPR) {
      seenPRNumbers.set(pr.number, pr);
    } else {
      // Prefer Comfy-Org/ComfyUI URLs over comfyanonymous/ComfyUI
      if (
        pr.html_url.includes("Comfy-Org/ComfyUI") &&
        !existingPR.html_url.includes("Comfy-Org/ComfyUI")
      ) {
        seenPRNumbers.set(pr.number, pr);
      }
    }
  }
  const deduplicatedPRs = Array.from(seenPRNumbers.values());

  const processedTasks = await sflow(deduplicatedPRs)
    // filter Core/Core-Important labeled PRs
    .map(async (e) => await processPullRequestCorePingTask(e))
    .filter((e) => Boolean(e))
    .toArray();

  console.log("processedTasks", processedTasks.length);

  // process the opening before but not-opened now tasks, e.g. merged/closed recently
  const updatedOldTasks = await sflow(
    ComfyCorePRs.find({
      status: { $nin: ["MERGED", "CLOSED", "UNRELATED"] },
      // Exclude deprecated comfyanonymous/ComfyUI URLs
      url: { $not: { $regex: "comfyanonymous/ComfyUI" } },
    }),
  )
    .filter((task) => !processedTasks.some((t) => t.url === task.url))
    .map((task) => ghc.pulls.get({ ...parsePullUrl(task.url) }).then((e) => e.data))
    .filter()
    .map((e, i) => processPullRequestCorePingTask(e, i))
    .toArray();
  console.log(`updated ${updatedOldTasks.length} old tasks`);

  // processedTasks
  const pendingReviewCorePRs = deduplicatePRTasks(
    await ComfyCorePRs.find({
      status: {
        $in: ["AUTHOR_COMMENTED", "REVIEW_REQUESTED", "OPEN", "COMMITTED"],
      },
      // Exclude deprecated comfyanonymous/ComfyUI URLs to prevent showing stale data
      url: { $not: { $regex: "comfyanonymous/ComfyUI" } },
    })
      .sort({ statusAt: 1, created_at: 1 })
      .toArray(),
  );

  const allOpeningCorePRs = deduplicatePRTasks(
    await ComfyCorePRs.find({
      state: "open",
      // Exclude deprecated comfyanonymous/ComfyUI URLs to prevent showing stale data
      url: { $not: { $regex: "comfyanonymous/ComfyUI" } },
    }).toArray(),
  );

  const remainingOpeningCorePRs = await sflow(allOpeningCorePRs)
    .filter((e) => !pendingReviewCorePRs.map((e) => e.url).includes(e.url))
    .filter(async (e) => {
      const prUrl = e.url;
      // revalidate if it is still open, calls gh.pulls.get
      const pr = await ghc.pulls.get({ ...parsePullUrl(prUrl) }).then((e) => e.data);
      // update to db if state changed
      if (pr.state !== e.state) {
        await saveTask({ url: prUrl, state: pr.state });
      }
      return pr.state === "open";
    })
    .toArray();
  console.log(`Total opening Core/Important PRs: ${allOpeningCorePRs.length}`);

  // sflow(pendingCorePRs).filter(pr=> !processedTasks.some(t=>t.url===pr.url)).run();
  // const pingNeededPRs = await ComfyCorePRs.find({
  // 	isPingNeeded: true,
  // })
  // 	.sort({ created_at: 1 })
  // 	.toArray();

  // console.log("ready to send slack message to notify @comfy");
  // console.log(processedTasks);

  const forDuration = (at?: number | Date) => {
    if (!at) return "";
    const diff = Date.now() - (at instanceof Date ? at.getTime() : at);
    return "for " + ms(diff, { long: true });
  };
  const groupByAuthor = <T extends { author?: string; statusAt?: Date | number }>(prs: T[]) => {
    const groups = new Map<string, T[]>();
    for (const pr of prs) {
      const author = pr.author ?? "unknown";
      if (!groups.has(author)) groups.set(author, []);
      groups.get(author)!.push(pr);
    }
    // Sort PRs within each group by statusAt (oldest first)
    for (const [, group] of groups) {
      group.sort((a, b) => {
        const aTime = a.statusAt instanceof Date ? a.statusAt.getTime() : (a.statusAt ?? 0);
        const bTime = b.statusAt instanceof Date ? b.statusAt.getTime() : (b.statusAt ?? 0);
        return aTime - bTime;
      });
    }
    // Sort author groups by their oldest PR's statusAt (oldest first)
    return [...groups.entries()].sort(([, a], [, b]) => {
      const aTime = a[0].statusAt instanceof Date ? a[0].statusAt.getTime() : (a[0].statusAt ?? 0);
      const bTime = b[0].statusAt instanceof Date ? b[0].statusAt.getTime() : (b[0].statusAt ?? 0);
      return aTime - bTime;
    });
  };

  const formatGroupedPRs = (
    groups: [string, ComfyCorePRs[]][],
    formatPR: (pr: ComfyCorePRs) => string,
  ) =>
    groups
      .map(([author, prs]) => `*@${author}*:\n${prs.map((pr) => `  - ${formatPR(pr)}`).join("\n")}`)
      .join("\n");

  const reviewMessage = !pendingReviewCorePRs.length
    ? `Congratulations! All Core/Important PRs are reviewed! 🎉🎉🎉`
    : `Hey <@comfy>, Here's x${pendingReviewCorePRs.length} Core/Important PRs waiting your feedback!
${formatGroupedPRs(groupByAuthor(pendingReviewCorePRs), (pr) => `<${pr.url}|${pr.title}> (${pr.labels}) is ${pr.status} ${forDuration(pr.statusAt)}`)}`;

  const keepInMindMessage =
    remainingOpeningCorePRs.length > 0
      ? `\n\nAdditionally, there ${remainingOpeningCorePRs.length === 1 ? "is" : "are"} ${remainingOpeningCorePRs.length} other open Core/Important ${remainingOpeningCorePRs.length === 1 ? "PR" : "PRs"} that ${remainingOpeningCorePRs.length === 1 ? "is" : "are"} pending for author's change/update, lets wait for them.
${formatGroupedPRs(groupByAuthor(remainingOpeningCorePRs.toSorted(compareBy((e) => e.created_at))), (pr) => `<${pr.url}|${pr.title}> is ${pr.status} ${forDuration(pr.statusAt)}`)}`
      : "";
  const tail = `\n\nSent from <https://github.com/Comfy-Org/Comfy-PR/blob/main/app/tasks/coreping/coreping.ts|CorePing.ts> by <@snomiao>`;

  const notifyMessage = `${reviewMessage}${keepInMindMessage}${tail}`;
  // console.log(chalk.bgBlue(notifyMessage));
  // // TODO: update message with delete line when it's reviewed
  // // send or update slack message
  let meta = await Meta.$upsert({});

  const lastMessageTsDate = meta.lastSlackMessage?.url
    ? new Date(+slackMessageUrlParse(meta.lastSlackMessage.url).ts * 1000)
    : null;

  // can only post new message when:
  // 1. tz: PST,  day: working day + sat, time: 10-12am
  // 2. or last message sent time( Note: not edited time ) >23h ago (if have last msg)
  const canPostNewMessage =
    (() => {
      const now = new Date();
      const pstTime = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
      const day = pstTime.getDay(); // 0=Sunday, 1=Monday, ..., 6=Saturday
      const hour = pstTime.getHours();

      // Working days (Mon-Fri) + Saturday, but not Sunday
      const isValidDay = day >= 1 && day <= 6;
      // 10am-12pm PST (10-11:59)
      const isValidTime = hour >= 10 && hour < 12;

      return isValidDay && isValidTime;
    })() &&
    (!lastMessageTsDate || Date.now() - lastMessageTsDate.getTime() >= 23 * 60 * 60 * 1000);

  const canUpdateExistingMessage =
    meta.lastSlackMessage?.sendAt &&
    Date.now() - new Date(meta.lastSlackMessage.sendAt).getTime() <= 23.9 * 60 * 60 * 1000;

  // if <24 h since last sent (not edit), update that msg
  const msgUpdateUrl =
    canUpdateExistingMessage && !canPostNewMessage ? meta.lastSlackMessage?.url : undefined;

  // DIE(
  // 	yaml.stringify({
  // 		text: notifyMessage,
  // 		channelName: cfg.slackChannelName,
  // 		url: msgUpdateUrl,
  // 	}),
  // );
  const msg = await upsertSlackMessage({
    text: notifyMessage,
    channelName: cfg.slackChannelName,
    url: msgUpdateUrl,
  });
  meta = await Meta.$upsert({
    lastSlackMessage: { text: msg.text, url: msg.url, sendAt: new Date() },
  });
  console.log(`message posted: ${msg.url}`);

  // send special ping messages for recent updated PRs
  const pingThreadMessageUrl = meta.lastSlackMessage?.url ?? undefined;
  const pings = await sflow(pendingReviewCorePRs)
    .filter((task) => task.isPingNeeded)
    .map(async (task) => {
      const pingMessage = `PING: The PR <${task.url}|${task.title}> status updated ${task.lastStatus} => *${task.status}*. ${reviewStatusExplained(task.status)}`;
      // console.log(chalk.red(`PING NEEDED: ${task.url} ${task.status}: ${reviewStatusExplained(task.status)}`));
      // throw task.lastPingMessage?.url
      const msg = await upsertSlackMessage({
        text: pingMessage,
        channelName: cfg.slackChannelName,
        url: task.lastPingMessage?.url ?? undefined,
        ...(pingThreadMessageUrl && {
          replyUrl: pingThreadMessageUrl,
          reply_broadcast: true,
        }),
      });
      console.log(chalk.red(pingMessage));
      // send ping message and then reset isPingNeeded
      return await saveTask({
        url: task.url,
        lastPingMessage: { url: msg.url, text: msg.text },
        isPingNeeded: false,
      });
    })
    .toArray();
  console.log(`sent ${pings.length} ping messages to pending PRs`);
}
async function processPullRequestCorePingTask(
  pr: GH["pull-request-simple"] | GH["pull-request"],
  i?: number,
): Promise<ComfyCorePRs> {
  const html_url = pr.html_url;
  let task = await saveTask({
    url: pr.html_url,
    title: pr.title,
    created_at: new Date(pr.created_at),
    state: pr.state as GH["pull-request"]["state"],
    author: pr.user?.login,
    labels: pr.labels.map((e) => e.name),
  });

  // save status & lastStatus

  const { status, statusAt } = await determinePullRequestReviewStatus(pr, {
    isUnrelated: (_pr) => !task.labels.some((e) => LABELS.includes(e)),
  });
  // update lastStatus if status changed
  const statusChanged = task.status !== status;
  if (statusChanged) {
    task = await saveTask({ url: pr.html_url, status, statusAt, lastStatus: task.status });
  } else {
    task = await saveTask({ url: pr.html_url, status, statusAt });
  }

  // determine whether to ping in slack
  const isPingNeeded = tsmatch({
    prev: task.lastStatus,
    curr: status,
  })
    // reviewed => unknown(related)
    .with(
      {
        prev: P.union("REVIEWED", "REVIEWER_COMMENTED"),
        curr: P.not(P.union("REVIEWED", "REVIEWER_COMMENTED", "UNRELATED")),
      },
      () => true,
    )
    // unknown => review_requested
    .with(
      {
        prev: P.not(P.union("REVIEW_REQUESTED", "AUTHOR_COMMENTED")),
        curr: P.union("REVIEW_REQUESTED", "AUTHOR_COMMENTED"),
      },
      () => true,
    )
    .otherwise(() => false);

  console.log(
    `${i !== undefined ? i + 1 : ""} ${pr.html_url} # ${task.lastStatus || ""} >> ${status} ${isPingNeeded ? chalk.red("PING") : ""} ${statusAt}`.trim(),
  );

  if (task.lastStatus === status) {
    console.log(`No status change for ${pr.html_url}, skipping`);
    return task;
  }
  // update status
  // task = await saveTask({
  // 	url: pr.html_url,
  // 	last_labeled_at: new Date(lastLabelEvent.created_at),
  // });
  // const now = new Date();
  // const diff = now.getTime() - (statusAt?.getTime() || now.getTime());
  // const isFresh = diff <= 24 * 60 * 60 * 1000;
  // const hours = Math.floor(diff / (60 * 60 * 1000));
  // const sanitizedTitle = pr.title.replace(/\W+/g, " ").trim();
  // const statusMsg = `@${pr.user?.login}: <${pr.html_url}|${sanitizedTitle}> is waiting for your feedback for ${hours} hours.`;

  return await saveTask({
    url: html_url,
    status,
    statusAt,
    // statusMsg,
    isPingNeeded,
    ...(!isPingNeeded ? { lastPingMessage: null } : {}),
  });
}

async function _cleanSpammyMessages20251117() {
  // list 2025-11-18 2:00 to 3:55 (in HKT)
  const st = new Date("2025-11-18T02:00:00+0800");
  const et = new Date("2025-11-18T03:55:00+0800");
  console.log(`fetch slack messages from ${st.toISOString()} to ${et.toISOString()}`);
  // slack.history.list(getslackchannel)
  const channel = await pageFlow(undefined as string | undefined, async (cursor, limit = 3) => {
    const resp = await slackCached.conversations.list({ cursor, limit, types: "public_channel" });
    console.log(
      `+${resp.channels?.length} channels: ${resp.channels?.map((c) => c.name).join(", ")}`,
    );
    return { next: resp.response_metadata?.next_cursor || undefined, data: resp.channels };
  })
    .flat()
    .find((e) => e.name === "develop")
    .toAtLeastOne();

  const channelId =
    channel.id || DIE(`no channel id was found in channel: ${yaml.stringify(channel)}`);
  // console.log(channel);
  // slackCached.conversations.join({channel: channel.id}) ;
  // console.log( ) ; //(channels.id)
  const comfyPrBot = await pageFlow(undefined as string | undefined, async (cursor, limit = 3) => {
    const resp = await slackCached.users.list({ cursor, limit });
    return { data: resp.members || [], next: resp.response_metadata?.next_cursor || undefined };
  })
    .flat()
    .find((e) => e.real_name === "ComfyPR-Bot")
    // .log(e => yaml.stringify({}))
    .toAtLeastOne();

  console.log("checking messages sent by ComfyPR-Bot:", comfyPrBot.id, comfyPrBot.name);
  const myspammessages = await pageFlow(
    undefined as string | undefined,
    async (cursor, limit = 100) => {
      const resp = await slackCached.conversations.history({
        channel: channelId,
        cursor,
        limit,
        inclusive: true,
        oldest: String(+st / 1000),
        latest: String(+et / 1000),
      });
      console.log(resp.messages?.length);
      // console.log(`+${resp.messages?.length} messages by ${await sflow(resp.messages || [])
      // 	?.mapMixin(async e => ({ info: await slackCached.users.info({ user: e.user || undefined }).then(u => u.user) }))
      // 	?.map(m => String(m.username || m.info?.real_name || m.user || ''))
      // 	.filter()
      // 	.join(", ")
      // 	.text()
      // 	}`);

      return { next: resp.response_metadata?.next_cursor || undefined, data: resp.messages || [] };
    },
  )
    .flat()
    // .mapMixin(async e => ({ profile: (await slackCached.users.profile.get({ user: e.user || undefined }).then(e => e.profile)) }))
    .mapMixin(async (e) => ({
      username:
        e.username ||
        (await slackCached.users
          .info({ user: e.user || undefined })
          .then((u) => u.user?.real_name || u.user?.name || "")),
    }))
    // .mapMixin(async e => ({ time: new Date(+(e.ts || DIE('Fatal: msg have no .ts ${e}')) * 1000) }))
    // .mapMixin(e => ({ blocks: undefined }))
    // .log(e => yaml.stringify(e.username))
    // .until(e => +(e.ts || DIE('Fatal: msg have no .ts ${e}')) < (+st) / 1000)
    // terminate stream when msg.ts < st
    // .log(e => [new Date(+(e.ts || DIE()) * 1000), +(e.ts || DIE()), e.text])
    // .filter(e => +(e.ts || DIE(`fatal: msg have no .ts ${e}`)) * 1000 <= (+et))
    // .takeWhile(e => +(e.ts || DIE(`Fatal: msg have no.ts ${e}`)) * 1000 >= (+st))
    // .filter(e => e.username)
    .filter((e) => e.user === comfyPrBot.id)
    // throw check
    .toArray();

  console.log(
    yaml.stringify({
      count: myspammessages.length,
      messages: myspammessages.map(
        (e) =>
          `${new Date(+e.ts * 1000).toISOString()} by ${e.username}: ${e.text?.replace(/\n/g, " ").slice(0, 20)}...`,
      ),
    }),
  );

  const confirmed = await confirm(
    `About to delete ${myspammessages.length} messages sent by ComfyPR-Bot in #${channel.name} between ${st.toISOString()} and ${et.toISOString()}. Proceed?`,
  );
  if (!confirmed) {
    console.log("Operation cancelled");
    return;
  }

  const _deletedMessages = await sflow(myspammessages)
    .forEach(async (e) => await slack.chat.delete({ channel: channelId, ts: e.ts || DIE() }))
    .log(
      (e) =>
        `Deleted message at ${new Date(+(e.ts || DIE()) * 1000).toISOString()}: ${e.text?.replace(/\n/g, " ").slice(0, 30)}...`,
    )
    .run();
}
