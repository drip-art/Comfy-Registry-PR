import DIE from "@snomiao/die";
import { readFile } from "fs/promises";
import pMap from "p-map";
import { match } from "ts-pattern";
import { CNRepos } from "./CNRepos";
import { type GithubPull } from "./fetchRepoPRs";
import { fetchPullComments } from "./fetchPullComments";
import { parseTitleBodyOfMarkdown } from "./parseTitleBodyOfMarkdown";
import { summaryLastPullComment } from "./summaryLastPullComment";
if (import.meta.main) {
  // const repository = "https://github.com/ltdrdata/ComfyUI-Manager";
  // const repo = "https://github.com/WASasquatch/PPF_Noise_ComfyUI";
  const repository = "https://github.com/LEv145/images-grid-comfy-plugin";
  const cnrepo =
    (await CNRepos.findOne({ repository })) ?? DIE("Repo not found");
  const pulls = match(cnrepo.pulls)
    .with({ state: "ok" }, ({ data }) => data)
    .otherwise(() => DIE("Pulls not found"));
  const related = await fetchRelatedPullWithComments(repository, pulls);
  console.log(JSON.stringify(related));
  // await checkAllRepoPRStatus();
}
// async function checkAllRepoPRStatus() {
//   return await pMap(CNRepos.find(), async (repo) => {
//     const { repository } = repo;
//     const pulls = match(repo.pulls)
//       .with({ state: "ok" }, ({ data }) => data)
//       .otherwise(() => DIE("Pulls not found"));
//     const { toml, action } = await fetchRelatedPulls(repo, pulls);
//     if (!toml || !action) return [];
//     return [{ repo: e.repo, toml, action }];
//   });
// }
export type RelatedPullsWithComments = Awaited<
  ReturnType<typeof fetchRelatedPullWithComments>
>;
export async function fetchRelatedPullWithComments(
  repository: string,
  pulls: GithubPull[],
) {
  const relatedPulls = await matchRelatedPulls(pulls);
  const relatedPullsWithComment = await pMap(relatedPulls, async (data) => {
    const comments = await fetchPullComments(repository, data.pull);
    const lastText = summaryLastPullComment(comments);
    return { ...data, comments, lastText };
  });
  return relatedPullsWithComment;
}
export type RelatedPull = Awaited<ReturnType<typeof matchRelatedPulls>>[number];
export async function matchRelatedPulls(pulls: GithubPull[]) {
  const readTemplateTitle = async (filename: string) =>
    await readFile("./templates/" + filename, "utf8")
      .then(parseTitleBodyOfMarkdown)
      .then((e) => e.title);
  const relatedPulls = await pMap(pulls, async (pull) =>
    match(pull)
      .with({ title: await readTemplateTitle("add-toml.md") }, (pull) => ({
        type: "pyproject" as const,
        pull,
      }))
      .with({ title: await readTemplateTitle("add-action.md") }, (pull) => ({
        type: "publishcr" as const,
        pull,
      }))
      .otherwise(() => null),
  );
  return relatedPulls.flatMap((e) => (e ? [e] : []));
}