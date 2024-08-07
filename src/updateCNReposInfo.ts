import { dissoc } from "rambda";
import sflow from "sflow";
import { match } from "ts-pattern";
import { $OK, TaskError, TaskOK } from "../packages/mongodb-pipeline-ts/Task";
import { CNRepos } from "./CNRepos";
import { getWorkerInstance } from "./WorkerInstances";
import { $filaten, $stale } from "./db";
import { gh } from "./gh";
import { parseUrlRepoOwner } from "./parseOwnerRepo";
import { tLog } from "./utils/tLog";

if (import.meta.main) {
  await getWorkerInstance("updateCNReposInfo");
  await tLog("updateCNReposInfo", updateCNReposInfo);
}

export async function updateCNReposInfo() {
  await CNRepos.createIndex($filaten({ info: { mtime: 1 } }));
  return await sflow(
    CNRepos.find($filaten({ info: { mtime: $stale("1d") } }))
  ).pMap(
    async (repo) => {
      const { repository } = repo;
      console.log("[INFO] Fetching meta info from " + repository);
      const _info = await gh.repos
        .get({ ...parseUrlRepoOwner(repository) })
        .then(({ data }) => data)
        .then(TaskOK)
        .catch(TaskError);
      // Handle renamed repos
      const { info, url } = await match(_info)
        .with($OK, async (info) => {
          const url = info.data.html_url;
          if (url === repository) return { info, url: repository };

          // console.log(info.data.use_squash_pr_title_as_default)
          console.log("[INFO] Migrating renamed repo: \nfrom: ", repository + "\n  to: " + url);
          // migrate data into new CNRepo
          await CNRepos.updateOne(
            { repository: url },
            {
              $set: {
                ...dissoc("_id", { ...(await CNRepos.findOneAndDelete({ repository })) }),
                repository: url,
                oldUrls: { $addToSet: repository },
              },
            },
            { upsert: true },
          );
          return { info, url };
        })
        .otherwise((info) => ({ info, url: repository }));

      return await CNRepos.updateOne({ repository: url }, { $set: { info } }, { upsert: true });
    },
    { concurrency: 2 },
  ).toArray();
}
