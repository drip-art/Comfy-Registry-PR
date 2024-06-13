#!/usr/bin/env bun
/*
bun index.ts
*/
import DIE from "@snomiao/die";
import type { WithId } from "mongodb";
import "react-hook-form";
import { timingWith } from "timing-with";
import { match } from "ts-pattern";
import { type CMNode } from "./CMNodes";
import { type CRNode } from "./CRNodes";
import type { PushedBranch } from "./PushedBranch";
import { type SlackMsg } from "./SlackNotifications";
import { $OK, type Task } from "./Task";
import { Worker, getWorker } from "./Worker";
import { $flatten, $fresh, db } from "./db";
import { type RelatedPull } from "./fetchRelatedPulls";
import { type GithubPull } from "./fetchRepoPRs";
import { gh } from "./gh";
import { parseRepoUrl, stringifyOwnerRepo } from "./parseOwnerRepo";
import { scanCNRepoPRCandidates } from "./scanCNRepoPRCandidates";
import { updateCMRepos } from "./updateCMRepos";
import { updateCNReposInfo } from "./updateCNReposInfo";
import { updateCNReposPulls } from "./updateCNReposPulls";
import { updateCNReposRelatedPulls } from "./updateCNReposRelatedPulls";
import { updateCRRepos } from "./updateCRRepos";

type Email = {
  from?: string;
  title: string;
  body: string;
  to: string;
};

type Sent = {
  slack?: SlackMsg;
  emails?: Email[];
};

type GithubIssueComment = Awaited<
  ReturnType<typeof gh.issues.getComment>
>["data"];
type GithubIssue = Awaited<ReturnType<typeof gh.issues.get>>["data"];
type GithubRepo = Awaited<ReturnType<typeof gh.repos.get>>["data"];
type CRType = "pyproject" | "publichcr";
export type CustomNodeRepo = {
  repository: string;
  cr?: WithId<CRNode>;
  cm?: WithId<CMNode>;
  info?: Task<GithubRepo>;
  pulls?: Task<GithubPull[]>;
  crPulls?: Task<RelatedPull[]>;
  createFork?: Task<GithubRepo>;
  createBranches?: Task<{ type: CRType; assigned: Worker } & PushedBranch>[];
  createPullRequests?: Task<{ type: CRType; pr: GithubPull }>[];
};

export const CNRepos = db.collection<CustomNodeRepo>("CNRepos");
await CNRepos.createIndex({ repository: 1 }, { unique: true });

if (import.meta.main) {
  await getWorker("Updating CNRepos");
  // await cacheHealthReport();
  await updateCNRepos();
  // updateCNReposPRTasks
  // await scanCNRepoThenPRs();
  // await pMap(candidates, (e) => updateCNRepoPRStatus(e.repository), { concurrency: 4 });
  // candidates
}
export async function scanCNRepoThenCreatePullRequests() {
  const _candidates = await scanCNRepoPRCandidates();
  // const candidates = await pMap(
  //   _candidates,
  //   async ({ repository }) => {
  //     const ghrepo = await gh.repos.get({ ...repoUrlParse(repository) });
  //     return (await CNRepos.findOneAndUpdate(
  //       { repository },
  //       { $set: { archived: ghrepo.data.archived } },
  //       { upsert: true }
  //     ))!;
  //   },
  //   { concurrency: 3 }
  // );

  // await pMap(
  //   shuffleArray(candidates),
  //   async ({ repository, archived }) => {
  //     if (archived) return;
  //     await CNRepos.updateOne(
  //       { repository },
  //       { $set: { prsTask: { state: "pending", stime: new Date() } } }
  //     );
  //     await ComfyRegistryPRs(repository).catch(async (e) => {
  //       await CNRepos.updateOne(
  //         { repository },
  //         {
  //           $set: {
  //             prsTask: { state: "error", mtime: new Date(), error: e.message },
  //           },
  //         }
  //       );
  //       throw e;
  //     });
  //     const prUpdateResult = await updateCNRepoPRStatus(repository);
  //     const links = [prUpdateResult]
  //       .filter((e) => e.modifiedCount || e.upsertedCount)
  //       .flatMap((e) => e.links);
  //     await slackLinksNotify("Custom Node Repo prs created", links);
  //     await CNRepos.updateOne(
  //       { repository },
  //       { $set: { prsTask: { state: "done", mtime: new Date() } } }
  //     );
  //   },
  //   { concurrency: 1, stopOnError: false }
  // );
}

export async function updateCNRepos() {
  scanCNRepoThenCreatePullRequests();
  // outdated related pulls
  // await CNRepos.updateMany(
  //   $flatten({ relates: { mtime: { $lt: new Date(1718213050820) } } }),
  //   { $unset: { relates: 1 } },
  // );
  await Promise.all([
    // stage 1: get repos
    timingWith("Update Repos from ComfyUI Manager", updateCMRepos),
    timingWith("Update Repos from ComfyRegistry", updateCRRepos),
    // stage 2: update repo info & pulls
    timingWith("Update CNRepos for Repo Infos", updateCNReposInfo),
    timingWith("Update CNRepos for Github Pulls", updateCNReposPulls),
    // stage 3: update related pulls and comments
    timingWith("Update CNRepos for Related Pulls", updateCNReposRelatedPulls),
    // stage 4: update related comments (if needed)
    // timingWith("Update CNRepos for Related Comments", udpateCNReposRelatedComments),
    // stage 5:
  ]);

  await updateCNRepoPullsDashboard();
  // show related
  // await CNRepos.find({}).to
  // await timingWith("Make PRs", async function () {
  //   await pMap(
  //     CNRepos.find({ "relates.mtime": $stale("1d") }),
  //     async (repo) => {
  //       const { repository } = repo;
  //       await timingWith("Making PRs for " + repository, async () => {});
  //       // const prs = await ComfyRegistryPRs(repository);
  //       //
  //     },
  //   );
  // });
  console.log("All repo updated");
}
async function updateCNRepoPullsDashboard() {
  const dashBoardIssue =
    process.env.DASHBOARD_ISSUE_URL || DIE("DASHBOARD_ISSUE_URL not found");
  const dashBoardRepo = dashBoardIssue.replace(/\/issues\/\d+$/, "");
  const dashBoardIssueNumber = Number(
    dashBoardIssue.match(/\/issues\/(\d+)$/)?.[1] ||
      DIE("Issue number not found"),
  );

  const repos = await CNRepos.find(
    $flatten({ crPulls: { mtime: $fresh("1d") } }),
  ).toArray();
  const result = repos
    .map((repo) => {
      const crPulls = match(repo.crPulls)
        .with($OK, ({ data }) => data)
        .otherwise(() => DIE("CR Pulls not found"));
      const repoName = stringifyOwnerRepo(parseRepoUrl(repo.repository));
      const body = crPulls
        .map((e) => {
          const date = new Date(e.pull.created_at).toISOString().slice(0, 10);
          const state = e.pull.state.toUpperCase();
          return {
            href: e.pull.html_url,
            name: `PR ${date} ${state}: ${repoName} #${e.type}`,
          };
        })
        .map(({ href, name }) => `- [${name}](${href})`)
        .toSorted()
        .join("\n");
      return body;
    })
    .filter(Boolean)
    .join("\n");
  const body = result;

  await gh.issues.update({
    ...parseRepoUrl(dashBoardRepo),
    issue_number: dashBoardIssueNumber,
    body,
  });
}
