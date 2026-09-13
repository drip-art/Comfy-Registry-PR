#!/usr/bin/env bun --hot
import { db } from "@/src/db";
import { gh } from "@/lib/github";
import { parseGithubRepoUrl } from "@/src/parseOwnerRepo";
import { normalizeGithubUrl } from "@/src/normalizeGithubUrl";
import DIE from "@snomiao/die";
import isCI from "is-ci";
import parseGithubUrl from "parse-github-url";
import sflow from "sflow";
import { upsertChunkedSlackMessage } from "./upsertChunkedSlackMessage";

/**
 * GitHub Frontend Release Notification Task
 *
 * Workflow:
 * 1. Fetch ComfyUI_frontend repo latest releases
 * 2. Save the release info to the database
 * 3. If it's stable, notify the release to slack
 * 4. If it's a pre-release, send drafting notification
 */

const config = {
  repos: ["https://github.com/Comfy-Org/ComfyUI_frontend"],
  slackChannelName: "frontend",
  slackMessage: "🎨 {repo} <{url}|Release {version}> is {status}!",
  sendSince: new Date("2025-09-03T00:00:00Z").toISOString(),
};

export type GithubFrontendReleaseNotificationTask = {
  url: string;
  version?: string;
  createdAt: Date;
  releasedAt?: Date;
  isStable?: boolean;
  status: "draft" | "prerelease" | "stable";
  releaseNotes?: string;

  slackMessageDrafting?: {
    text: string;
    channel: string;
    url?: string;
    overflowUrls?: string[];
  };

  slackMessage?: {
    text: string;
    channel: string;
    url?: string;
    overflowUrls?: string[];
  };
};

export const GithubFrontendReleaseNotificationTask =
  db.collection<GithubFrontendReleaseNotificationTask>("GithubFrontendReleaseNotificationTask");

const save = async (task: { url: string } & Partial<GithubFrontendReleaseNotificationTask>) => {
  // Normalize URLs to handle both comfyanonymous and Comfy-Org formats
  const normalizedTask = {
    ...task,
    url: normalizeGithubUrl(task.url),
  };

  // Incremental migration: Check both normalized and old URL formats
  const oldUrl = normalizedTask.url.replace(/Comfy-Org/i, "comfyanonymous");
  const existing = await GithubFrontendReleaseNotificationTask.findOne({
    $or: [{ url: normalizedTask.url }, { url: oldUrl }],
  });

  return (
    (await GithubFrontendReleaseNotificationTask.findOneAndUpdate(
      existing ? { _id: existing._id } : { url: normalizedTask.url },
      { $set: normalizedTask },
      { upsert: true, returnDocument: "after" },
    )) || DIE("never")
  );
};

if (import.meta.main) {
  await runGithubFrontendReleaseNotificationTask();
  if (isCI) {
    await db.close();
    process.exit(0);
  }
}

async function runGithubFrontendReleaseNotificationTask() {
  await GithubFrontendReleaseNotificationTask.createIndex({ url: 1 }, { unique: true });
  await sflow(config.repos)
    .map(parseGithubRepoUrl)
    .flatMap(({ owner, repo }) =>
      gh.repos
        .listReleases({
          owner,
          repo,
          per_page: 3,
        })
        .then((e) => e.data),
    )
    .map(async (release) => {
      const url = release.html_url;
      const status = release.draft ? "draft" : release.prerelease ? "prerelease" : "stable";

      // Extract release notes from body
      const releaseNotes = release.body ?? "";

      let task = await save({
        url,
        status: status,
        isStable: status == "stable",
        version: release.tag_name,
        releaseNotes: releaseNotes,
        createdAt: new Date(
          release.created_at || DIE("no created_at in release, " + JSON.stringify(release)),
        ),
        releasedAt: !release.published_at ? undefined : new Date(release.published_at),
      });

      if (+task.createdAt! < +new Date(config.sendSince)) return task;

      // Format release notes for Slack (not truncate, slack will fold automatically)
      const formattedReleaseNotes = task.isStable ? releaseNotes || "" : "";

      const newSlackMessageText = config.slackMessage
        .replace("{url}", task.url)
        .replace(
          "{repo}",
          parseGithubUrl(task.url)?.repo || DIE(`Unable to parse REPO from URL ${task.url}`),
        )
        .replace(
          "{version}",
          task.version || DIE(`Unable to parse version from task ${JSON.stringify(task)}`),
        )
        .replace("{status}", task.status)
        .replace(/$/, "\n" + formattedReleaseNotes)
        .replace(/(.*) in (https:\/\/\S*)$/gm, "<$2|$1>") // linkify URLs at the end of lines;
        .replace("**Full Changelog**", "Full Changelog");

      console.log(newSlackMessageText);
      const shouldSendDraftingMessage = !task.isStable;
      const draftingTextChanged =
        !task.slackMessageDrafting?.text ||
        task.slackMessageDrafting.text.trim() !== newSlackMessageText.trim();
      if (shouldSendDraftingMessage && draftingTextChanged) {
        const { main, overflowUrls } = await upsertChunkedSlackMessage({
          channelName: config.slackChannelName,
          fullText: newSlackMessageText,
          existingMainUrl: task.slackMessageDrafting?.url,
          existingOverflowUrls: task.slackMessageDrafting?.overflowUrls,
        }).catch((e) => {
          console.error("Failed to send draft slack message for release", task.url, e);
          throw e;
        });
        task = await save({
          url,
          slackMessageDrafting: {
            text: newSlackMessageText,
            channel: main.channel,
            url: main.url,
            overflowUrls,
          },
        });
      }

      const shouldSendMessage = task.isStable;
      const messageTextChanged =
        !task.slackMessage?.text || task.slackMessage.text.trim() !== newSlackMessageText.trim();
      if (shouldSendMessage && messageTextChanged) {
        const { main, overflowUrls } = await upsertChunkedSlackMessage({
          channelName: config.slackChannelName,
          fullText: newSlackMessageText,
          existingMainUrl: task.slackMessage?.url,
          existingOverflowUrls: task.slackMessage?.overflowUrls,
          replyUrl: task.slackMessageDrafting?.url,
        }).catch((e) => {
          console.error("Failed to send slack message for release", task.url, JSON.stringify(e));
          throw e;
        });
        task = await save({
          url,
          slackMessage: {
            text: newSlackMessageText,
            channel: main.channel,
            url: main.url,
            overflowUrls,
          },
        });
      }
      return task;
    })
    .log()
    .run();
}

export default runGithubFrontendReleaseNotificationTask;
