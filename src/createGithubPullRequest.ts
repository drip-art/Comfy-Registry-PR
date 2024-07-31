import DIE, { catchArgs } from "@snomiao/die";
import { Octokit } from "octokit";
import { pickAll } from "rambda";
import { gh } from "./gh";
import type { GithubPull } from "./gh/GithubPull";
import { parseUrlRepoOwner } from "./parseOwnerRepo";

export async function createGithubPullRequest({
  title,
  body,
  branch,
  srcUrl,
  dstUrl,
  updateIfNotMatched = true,
}: {
  title: string;
  body: string;
  branch: string;
  srcUrl: string; // forked branch
  dstUrl: string; // upstream
  updateIfNotMatched?: boolean;
}) {
  const dst = parseUrlRepoOwner(dstUrl);
  const src = parseUrlRepoOwner(srcUrl);
  const repo = (await gh.repos.get({ ...dst })).data;

  // TODO: seems has bugs on head_repo
  const existedList = (
    await gh.pulls.list({
      // source repo
      state: "all",
      head_repo: src.owner + "/" + src.repo,
      head: src.owner + ":" + branch,
      // pr will merge into
      owner: dst.owner,
      repo: dst.repo,
      base: repo.default_branch,
    })
  ).data;
  if (existedList.length > 1)
    DIE(
      new Error(`expect only 1 pr, but got ${existedList.length}`, {
        cause: { existed: existedList.map((e) => ({ url: e.html_url, title: e.title })) },
      }),
    );

  const pr_result =
    existedList[0] ??
    (await ghPR()
      .pulls.create({
        // pr info
        title,
        body,
        // source repo
        head_repo: src.owner + "/" + src.repo,
        head: src.owner + ":" + branch,
        // pr will merge into
        owner: dst.owner,
        repo: dst.repo,
        base: repo.default_branch,
        maintainer_can_modify: true,
        // draft: true,
      })
      .then((e) => e.data)

      // handle existed error
      .catch(async (e) => {
        if (!e.message.match("A pull request already exists for")) throw e;
        console.log("PR Existed ", e);
        // WARN: will search all prs
        const existedList = (
          await gh.pulls.list({
            // source repo
            state: "open",
            head_repo: src.owner + "/" + src.repo,
            // head: src.owner + ":" + branch,
            // pr will merge into
            owner: dst.owner,
            repo: dst.repo,
            base: repo.default_branch,
          })
        ).data;

        if (existedList.length !== 1)
          DIE(
            new Error("expect only 1 pr, but got " + existedList.length, {
              cause: { existed: existedList.map((e) => ({ url: e.html_url, title: e.title })) },
            }),
          );

        return existedList[0];
      }));

  console.log("PR OK", pr_result.html_url);
  const mismatch = pr_result.title !== title || pr_result.body !== body;
  if (mismatch) {
    if (!updateIfNotMatched)
      DIE(
        new Error("pr content mismatch", {
          cause: { mismatch, expected: { title, body }, actual: pickAll(["title", "body"], pr_result) },
        }),
      );
    const { owner, repo } = parseUrlRepoOwner(dstUrl); // upstream repo
    const updated = (await catchArgs(ghPR().pulls.update)({ pull_number: pr_result.number, body, title, owner, repo }))
      .data!;
    const updatedPRStillMismatch = updated.title !== title || updated.body !== body;
    if (updatedPRStillMismatch) DIE(new Error("updatedPRStillMismatch", { cause: arguments }));
    console.warn(`PR content updated ${owner}/${repo} / \n<< ${pr_result.title}\n>> ${updated.title}`);
  }
  return pr_result as GithubPull;
}

function ghPR() {
  return new Octokit({ auth: process.env.GH_TOKEN_COMFY_PR || DIE(new Error("Missing env.GH_TOKEN_COMFY_PR")) }).rest;
}
