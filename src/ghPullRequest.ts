import yaml from "yaml";
import { chalk } from "zx";
import { gh } from "./gh";
import { repoUrlParse } from "./parseOwnerRepo";

export async function ghPullRequest({
  title,
  body,
  branch,
  srcUrl,
  dstUrl,
}: {
  title: string;
  body: string;
  branch: string;
  srcUrl: string;
  dstUrl: string;
}) {
  const dst = repoUrlParse(dstUrl);
  const src = repoUrlParse(srcUrl);
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
  if (existedList.length) {
    const msg = {
      PR_Existed: existedList.map((e) => ({ url: e.html_url, title: e.title })),
    };
    console.log(chalk.red(yaml.stringify(msg)));
    return;
  }

  const pr_result = await gh.pulls
    .create({
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
    .catch(async (e) => {
      if (e.message.match("A pull request already exists for")) {
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
        if (existedList.length) {
          const msg = {
            PR_Existed: existedList.map((e) => ({
              url: e.html_url,
              title: e.title,
            })),
          };
          console.log(chalk.red(yaml.stringify(msg)));
          return;
        }
      }
      throw e;
    });
  console.log("PR OK", pr_result!.data.html_url);
  return pr_result!.data;
}