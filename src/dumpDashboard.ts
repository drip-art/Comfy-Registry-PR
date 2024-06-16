import { $pipeline } from "@/packages/mongodb-pipeline-ts/$pipeline";
import { csvFormat } from "d3";
import { writeFile } from "fs/promises";
import prettyMs from "pretty-ms";
import { sortBy } from "rambda";
import YAML from "yaml";
import { CNRepos } from "./CNRepos";
// import { $pipeline } from "./db/$pipeline";
// in case of dump production in local environment:
// bun --env-file .env.production.local src/dump.ts > dump.csv

if (import.meta.main) {
  await dumpDashboard();
}
export async function dumpDashboard(limit?: number) {
  "use server";
  const r = await $pipeline<any>(CNRepos)
    .unwind("$crPulls.data")
    .match({ "crPulls.data.comments.data": { $exists: true } })
    .stage({ $set: { "crPulls.data.pull.repo": "$repository" } })
    .stage({ $set: { "crPulls.data.pull.type": "$crPulls.data.type" } })
    .stage({ $set: { "crPulls.data.pull.comments": "$crPulls.data.comments.data" } })
    .replaceRoot({ newRoot: "$crPulls.data.pull" })
    .project({
      created_at: 1,
      updated_at: 1,
      repository: 1,
      registryId: "$cr.id",
      state: "$prState",
      state: { $toUpper: "$prState" },
      url: { $concat: ["$html_url", "#", "$user.login", ":", "$type"] },
      comments: { $size: "$comments" },
      lastwords: { $arrayElemAt: ["$comments", -1] },
    })
    .set({ lastwords: { $concat: ["$lastwords.user.login", ": ", "$lastwords.body"] } })
    .match({ state: { $nin: ["MERGED"] } })
    .stage({ $sort: { updated_at: 1 } })
    .stage({ ...(limit && { $limit: limit }) })
    .aggregate()
    .map(({ updated_at, created_at, ...pull }) => {
      const updated = prettyMs(+new Date() - +new Date(updated_at), { compact: true }) + " ago";
      const created = prettyMs(+new Date() - +new Date(created_at), { compact: true }) + " ago";
      console.log(updated);
      return {
        updated, //: updated === created ? "never" : updated,
        ...pull,
        created,
      };
    })
    .toArray();

  await writeFile(".cache/dump.yaml", YAML.stringify(r));
  await writeFile(".cache/dump.csv", csvFormat(sortBy((e) => e.agoDays, r)));
  console.log("done");
}
