#!/usr/bin/env bun

/**
 * ComfyPR Bot
 * 
 * Slack 

 */
import { slack } from "@/lib";
import { yaml } from "@/src/utils/yaml";
import { createHmac, timingSafeEqual } from "crypto";
import DIE from "@snomiao/die";
import { compareBy } from "comparing";
import { mkdir } from "fs/promises";
import { existsSync } from "fs";
import sflow from "sflow";
import winston from "winston";
import zChatCompletion, { initZChat } from "../lib/zChat";
import z from "zod";
import { IdleWaiter } from "./IdleWaiter";
import { RestartManager } from "./RestartManager";
import { parseSlackMessageToMarkdown } from "@/lib/slack/parseSlackMessageToMarkdown";
import { slackTsToISO } from "@/lib/slack/slackTsToISO";
import { safeSlackPostMessage, safeSlackUpdateMessage } from "@/lib/slack/safeSlackMessage";
import { slackMessageUrlParse } from "@/app/tasks/gh-design/slackMessageUrlParse";
import minimist from "minimist";
import { loadClaudeMd, loadSkills } from "./templateLoader";
import { appendFile } from "fs/promises";
import fsp from "fs/promises";
import { mdFmt } from "@/app/tasks/gh-desktop-release-notification/upsertSlackMessage";
import { getSlackChannelName } from "@/lib/slack";
import { SlackBotState } from "./state";
import { ErrorCollector } from "./error-collector";
import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  createTaskUser,
  prepareTaskWorkspace,
  cleanupStaleTaskUsers,
  touchTaskUserActivity,
} from "./task-user";
import { createUserSpawner } from "./spawn-as-user";
import { enqueueWebhook, startWebhookConsumer, type WebhookQueueDoc } from "./webhook-queue";

export const SLACK_ORG_DOMAIN_NAME = "comfy-organization";
// Configure winston logger
const logDate = new Date().toISOString().split("T")[0]; // YYYY-MM-DD format
const logger = winston.createLogger({
  level: process.env.VERBOSE ? "debug" : process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : "";
      return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr ? "\n" + metaStr : ""}`;
    }),
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : "";
          return `[${timestamp}] ${level}: ${message}${metaStr ? "\n" + metaStr : ""}`;
        }),
      ),
    }),
    new winston.transports.File({
      filename: `./.logs/bot-${logDate}.log`,
      level: "debug",
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length ? JSON.stringify(meta, null, 2) : "";
          return `[${timestamp}] [${level.toUpperCase()}] ${message}${metaStr ? "\n" + metaStr : ""}`;
        }),
      ),
    }),
  ],
});

const TaskInputFlows = new Map<string, TransformStream<string, string>>();
// AbortControllers keyed by `${channel}:${ts}` of the original user message
// so a Slack reaction handler can cancel the running agent.
const TaskAbortControllers = new Map<string, AbortController>();
// https://comfy-pr-bot.pages.dev/
// Slack block type definition
const zSlackBlock = z
  .object({
    type: z.string(),
    block_id: z.string().optional(),
    elements: z.array(z.unknown()).optional(),
  })
  .passthrough();

// Slack attachment type definition
const zSlackAttachment = z
  .object({
    title: z.string().optional(),
    title_link: z.string().optional(),
    text: z.string().optional(),
    fallback: z.string().optional(),
    image_url: z.string().optional(),
    from_url: z.string().optional(),
  })
  .passthrough();

const zAppMentionEvent = z.object({
  type: z.literal("app_mention"),
  user: z.string(),
  ts: z.string(),
  client_msg_id: z.string().optional(),
  text: z.string(),
  team: z.string(),
  thread_ts: z.string().optional(),
  parent_user_id: z.string().optional(),
  blocks: z.array(zSlackBlock),
  channel: z.string(),
  assistant_thread: z.unknown().optional(),
  attachments: z.array(zSlackAttachment).optional(),
  event_ts: z.string(),
});

// Helper functions to manage current working tasks
async function addWorkingTask(event: z.infer<typeof zAppMentionEvent>) {
  const workingTasks = (await SlackBotState.get("current-working-tasks")) || {
    workingMessageEvents: [],
  };
  const events = workingTasks.workingMessageEvents || [];

  // Check if event already exists (by ts and channel)
  const exists = events.some(
    (e: z.infer<typeof zAppMentionEvent>) => e.ts === event.ts && e.channel === event.channel,
  );
  if (!exists) {
    events.push(event);
    await SlackBotState.set("current-working-tasks", { workingMessageEvents: events });
    logger.info(`Added task to working list: ${event.ts} (total: ${events.length})`);
  }
}

async function removeWorkingTask(event: z.infer<typeof zAppMentionEvent>) {
  const workingTasks = (await SlackBotState.get("current-working-tasks")) || {
    workingMessageEvents: [],
  };
  const events = workingTasks.workingMessageEvents || [];

  // Remove event by ts and channel
  const filtered = events.filter(
    (e: z.infer<typeof zAppMentionEvent>) => !(e.ts === event.ts && e.channel === event.channel),
  );
  await SlackBotState.set("current-working-tasks", { workingMessageEvents: filtered });
  logger.info(`Removed task from working list: ${event.ts} (remaining: ${filtered.length})`);
}
const g = globalThis as typeof globalThis & { instanceId?: string; hotId?: string };
const now = new Date().toISOString();
g.instanceId ??= now;
g.hotId = now;

if (import.meta.main) {
  await startSlackBot();
}

export async function startSlackBot() {
  console.log("Starting ComfyPR Bot...");
  await initZChat();
  const argv = minimist(process.argv.slice(2));
  const port = Number(process.env.PRBOT_PORT || DIE("missing env.PRBOT_PORT"));

  // Step 1: Health check (only for non-PTY launches)
  const isHumanLaunched = process.stdin.isTTY;

  if (!isHumanLaunched) {
    // Non-PTY launch (PM2): Poll for 10 seconds to ensure port is continuously unhealthy
    logger.info(`Detected non-PTY launch - polling for 10s to ensure port ${port} is unhealthy`);

    const pollDuration = 10000; // 10 seconds
    const pollInterval = 1000; // 1 second
    const startTime = Date.now();
    let healthyInstanceFound = false;

    while (Date.now() - startTime < pollDuration) {
      try {
        const statusResp = await fetch(`http://localhost:${port}/status`, {
          signal: AbortSignal.timeout(1000),
        });

        if (statusResp.ok) {
          // Found a healthy instance - abort and exit
          const statusData = await statusResp.json();
          healthyInstanceFound = true;

          // Try to get PID of existing process
          let existingPid = "unknown";
          try {
            const lsofOutput = await Bun.$`lsof -ti:${port}`.text();
            existingPid = lsofOutput.trim();
          } catch {}

          logger.info(
            `Healthy instance detected (PID: ${existingPid}) - aborting launch to avoid conflict`,
          );
          logger.info(`Status: ${JSON.stringify(statusData)}`);
          process.exit(0);
        }
      } catch (err) {
        // Port is unhealthy/unreachable - this is expected
        logger.debug(
          `Health check: port ${port} is unhealthy (${Date.now() - startTime}ms elapsed)`,
        );
      }

      await sleep(pollInterval);
    }

    if (!healthyInstanceFound) {
      logger.info(`Port ${port} remained unhealthy for 10s - proceeding to launch`);
    }
  } else {
    // PTY launch (human): Skip health check entirely
    logger.info(`Detected PTY launch - skipping health check`);
  }

  // Step 2: Kill port and launch
  logger.info(`Killing port ${port} and starting server`);
  await Bun.$`npx -y kill-port ${port}`;

  const slackSigningSecret =
    process.env.SLACK_SIGNING_SECRET || DIE("missing env.SLACK_SIGNING_SECRET");

  const server = Bun.serve({
    port: port,
    fetch: async (req: Request) => {
      const url = new URL(req.url);

      if (url.pathname === "/status") {
        const workingTasks = (await SlackBotState.get("current-working-tasks")) || {
          workingMessageEvents: [],
        };
        const events = workingTasks.workingMessageEvents || [];
        const processing_message_urls = events.map((event: z.infer<typeof zAppMentionEvent>) => {
          const tsForUrl = event.ts.replace(".", "");
          return `https://${SLACK_ORG_DOMAIN_NAME}.slack.com/archives/${event.channel}/p${tsForUrl}`;
        });
        return new Response(
          JSON.stringify(
            {
              status: TaskInputFlows.size === 0 ? "idle" : "busy",
              processing_message_urls,
              processing_message_urls_count: processing_message_urls.length,
            },
            null,
            2,
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.pathname === "/slack/events" && req.method === "POST") {
        const body = await req.text();

        // Verify Slack signature
        const timestamp = req.headers.get("x-slack-request-timestamp") ?? "";
        const slackSig = req.headers.get("x-slack-signature") ?? "";
        if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
          return new Response("Request too old", { status: 401 });
        }
        const hmac = createHmac("sha256", slackSigningSecret)
          .update(`v0:${timestamp}:${body}`)
          .digest("hex");
        const expected = Buffer.from(`v0=${hmac}`);
        const received = Buffer.from(slackSig);
        if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
          return new Response("Invalid signature", { status: 401 });
        }

        const payload = JSON.parse(body);

        // URL verification challenge (first-time setup)
        if (payload.type === "url_verification") {
          return new Response(JSON.stringify({ challenge: payload.challenge }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        // Event callbacks — push into the MongoDB webhook_queue and
        // respond 200 immediately. The actual Slack event dispatch happens
        // in the changeStream consumer started below in startSlackBot(),
        // so a bot restart mid-task can't drop the webhook on the floor.
        if (payload.type === "event_callback") {
          const retryNum = req.headers.get("x-slack-retry-num");
          const retryReason = req.headers.get("x-slack-retry-reason");
          const eventId =
            payload.event_id ||
            `${payload.event?.channel ?? "-"}_${payload.event?.event_ts ?? payload.event?.ts ?? "-"}`;

          const alreadySeen = await SlackBotState.get(`webhook-event-${eventId}`);
          if (alreadySeen) {
            logger.info(
              `Ignoring duplicate webhook event ${eventId} (retry=${retryNum ?? "0"}, reason=${retryReason ?? "-"}, firstSeenAt=${new Date(alreadySeen.receivedAt).toISOString()})`,
            );
            return new Response("", { status: 200 });
          }

          // TTL 1h — Slack retries up to ~30min, so 1h covers worst case.
          // This is independent of the queue's 24h TTL: the dedup key only
          // lives on the http-edge to suppress retry storms; queue docs
          // are authoritative for replay.
          await SlackBotState.set(
            `webhook-event-${eventId}`,
            { receivedAt: Date.now(), retryNum, retryReason },
            60 * 60 * 1000,
          );

          await enqueueWebhook({
            source: "slack",
            eventId,
            payload,
            meta: {
              retryNum: retryNum ?? null,
              retryReason: retryReason ?? null,
              receivedAt: Date.now(),
            },
          }).catch((err) => logger.error("Webhook enqueue failed", { err, eventId }));
        }

        return new Response("", { status: 200 });
      }

      return new Response("ComfyPR Bot is running.\n", { status: 200 });
    },
  });

  // const missedMsg = "https://comfy-organization.slack.com/archives/C09QKKXK8RX/p1767849032076329?thread_ts=1767838632.470639&cid=C09QKKXK8RX"
  // const missedMsg = "https://comfy-organization.slack.com/archives/C0A4XMHANP3/p1767893546609709?thread_ts=1767862331.962569&cid=C0A4XMHANP3"
  // await spawnBotOnSlackMessageUrl(
  //   "https://comfy-organization.slack.com/archives/D09GGTE7S00/p1769576340892099",
  // );

  const msgs = await fsp
    .readFile("./inbox.yaml", "utf-8")
    .then((s) => yaml.parse(s))
    .then((e) => z.object({ missed: z.string().array() }).parseAsync(e));
  await fsp.writeFile("./inbox.yaml", "missed: []");

  // clean the file
  //
  sflow(msgs.missed)
    .forEach((url) => spawnBotOnSlackMessageUrl(url))
    .run();

  if (argv.continue) {
    logger.info("BOT - --continue flag detected, resuming crashed tasks...");

    const workingTasks = (await SlackBotState.get("current-working-tasks")) || {
      workingMessageEvents: [],
    };
    const events = workingTasks.workingMessageEvents || [];

    if (events.length === 0) {
      logger.info("No working tasks to resume");
    } else {
      logger.info(`Found ${events.length} working task(s) to resume`);

      for (const event of events) {
        if (event && event.ts) {
          logger.info(
            `Resuming task for event ${event.ts} in channel ${await getSlackChannelName(event.channel)}, text: ${event.text}`,
          );
          spawnBotOnSlackMessageEvent(event).catch((err) => {
            logger.error(`Error resuming task for event ${event.ts}`, { err });
          });
        }
      }
    }
  }

  logger.info(`Starting ComfyPR Bot... id: ${g.instanceId}, hotId: ${g.hotId}`);

  // Setup smart restart manager (only restart when bot is idle)
  if (!argv["no-watch"]) {
    const restartManager = new RestartManager({
      watchPaths: ["bot", "src", "lib"],
      isIdle: () => TaskInputFlows.size === 0,
      onRestart: () => {
        logger.warn("🔄 Restarting bot process...");
        process.exit(0);
      },
      idleCheckInterval: 5000,
      debounceDelay: 1000,
      logger: {
        info: (msg, meta) => logger.info(`[RestartManager] ${msg}`, meta),
        warn: (msg, meta) => logger.warn(`[RestartManager] ${msg}`, meta),
      },
    });
    restartManager.start();
    logger.info("Smart restart manager enabled (use --no-watch to disable)");
  }

  // Start the webhook queue consumer. Drains backlog (any unprocessed docs
  // sitting in Mongo from a previous crash/restart) then tails the
  // changeStream for new ones. Slack docs go through the existing
  // handleSlackEvent; github/notion are accepted into the queue but only
  // logged for now (no downstream handler yet — adding one is what closes
  // the multi-source story).
  await startWebhookConsumer({
    sources: ["slack", "github", "notion"],
    drainBacklog: true,
    logger: {
      info: (msg, meta) => logger.info(`[webhook-queue] ${msg}`, meta as object),
      warn: (msg, meta) => logger.warn(`[webhook-queue] ${msg}`, meta as object),
      error: (msg, meta) => logger.error(`[webhook-queue] ${msg}`, meta as object),
    },
    consume: async (doc: WebhookQueueDoc) => {
      if (doc.source === "slack") {
        const payload = doc.payload as { event?: Record<string, unknown>; team_id?: string };
        // Forward team_id from envelope onto event for the same reason as
        // before (some Events API payloads only have it on the envelope).
        const event = {
          ...payload.event,
          team: (payload.event as { team?: string } | undefined)?.team || payload.team_id,
        };
        await handleSlackEvent(event);
        return;
      }
      if (doc.source === "github") {
        const eventType = (doc.meta as { eventType?: string } | undefined)?.eventType;
        logger.info(
          `[webhook-queue] github event ${doc.eventId} (${eventType}) — no handler wired yet`,
        );
        return;
      }
      if (doc.source === "notion") {
        const type = (doc.payload as { type?: string } | undefined)?.type;
        logger.info(`[webhook-queue] notion event ${doc.eventId} (${type}) — no handler wired yet`);
        return;
      }
    },
  });
  logger.info("Webhook queue consumer started");

  // Periodic cleanup of stale task users (every hour)
  setInterval(
    async () => {
      try {
        const workingTasks = (await SlackBotState.get("current-working-tasks")) || {
          workingMessageEvents: [],
        };
        // Keep keys in sync with workspaceId = thread_ts || ts; otherwise
        // long-running threaded tasks get marked stale and their isolated
        // Linux users get deleted out from under them.
        const activeIds = new Set<string>(
          (workingTasks.workingMessageEvents || []).map(
            (e: { ts: string; thread_ts?: string }) => e.thread_ts || e.ts,
          ),
        );
        const cleaned = await cleanupStaleTaskUsers(activeIds);
        if (cleaned.length > 0) {
          logger.info(`Cleaned up ${cleaned.length} stale task user(s): ${cleaned.join(", ")}`);
        }
      } catch (err) {
        logger.warn("Task user cleanup error", { err });
      }
    },
    60 * 60 * 1000,
  );

  logger.info(`BOT - Webhook mode active. Listening on port ${port} at /slack/events`);
}

const zSlackMessage = z
  .object({
    type: z.literal("message"),
    user: z.string().optional(),
    ts: z.string().optional(),
    client_msg_id: z.string().optional(),
    text: z.string().optional(),
    team: z.string().optional(),
    thread_ts: z.string().optional(),
    parent_user_id: z.string().optional(),
    blocks: z.array(zSlackBlock).optional(),
    channel: z.string().optional(),
    channel_type: z.string().optional(),
    assistant_thread: z.unknown().optional(),
    attachments: z.array(zSlackAttachment).optional(),
    event_ts: z.string().optional(),
    bot_id: z.string().optional(),
  })
  .passthrough();

async function handleSlackEvent(event: unknown) {
  const raw = event as Record<string, unknown>;

  // ❌ reaction → cancel the matching running task. The reaction is on
  // the original user message, so we look up its (channel, ts) in
  // TaskAbortControllers. Only the message author can cancel — this
  // prevents bystanders in the channel from killing other people's tasks.
  if (raw.type === "reaction_added") {
    const reaction = raw.reaction as string | undefined;
    const item = raw.item as { type?: string; channel?: string; ts?: string } | undefined;
    const reactingUser = raw.user as string | undefined;
    if (reaction === "x" && item?.type === "message" && item.channel && item.ts) {
      const key = `${item.channel}:${item.ts}`;
      const ac = TaskAbortControllers.get(key);
      if (!ac) return;

      try {
        const original = await slack.conversations.replies({
          channel: item.channel,
          ts: item.ts,
          limit: 1,
        });
        const author = original.messages?.[0]?.user;
        if (reactingUser && author && reactingUser !== author) {
          logger.info(`Ignoring ❌ from <@${reactingUser}> on task by <@${author}>`);
          return;
        }
      } catch (err) {
        logger.warn("Could not verify reaction author, allowing cancel", { err });
      }

      logger.warn(`User <@${reactingUser}> cancelled task ${key} via ❌ reaction`);
      ac.abort();
      await slack.reactions
        .add({ name: "no_entry", channel: item.channel, timestamp: item.ts })
        .catch(() => {});
    }
    return;
  }

  if (raw.type === "app_mention") {
    const parsedEvent = await zAppMentionEvent.parseAsync(event);
    await spawnBotOnSlackMessageEvent(parsedEvent);
    return;
  }

  if (raw.type === "message") {
    // message_changed events wrap the edited content under .message; flatten
    // it so a user editing a prior request triggers a new agent run when the
    // text is meaningfully different (dedup is content-hash based above).
    if (raw.subtype === "message_changed" && raw.message && raw.channel) {
      const inner = raw.message as Record<string, unknown>;
      Object.assign(raw, inner, { channel: raw.channel, channel_type: raw.channel_type });
    }

    const messageEvent = zSlackMessage.parse(raw);
    logger.debug("MESSAGE EVENT", { event });

    // Default: ignore messages from any bot to prevent bot-vs-bot loops.
    // Exception: env-configured allowlist of "human-equivalent" bots
    // (typically a developer's CLI like `sc sl send` posting via their
    // own Slack app) so we can drive end-to-end tests without logging
    // into the human Slack account.
    //
    // SLACK_ALLOWED_BOT_IDS / SLACK_ALLOWED_APP_IDS are comma-separated.
    if (messageEvent.bot_id) {
      const allowedBotIds = (process.env.SLACK_ALLOWED_BOT_IDS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const allowedAppIds = (process.env.SLACK_ALLOWED_APP_IDS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const botAppId = (messageEvent as { app_id?: string }).app_id;
      const isAllowed =
        allowedBotIds.includes(messageEvent.bot_id) ||
        (botAppId && allowedAppIds.includes(botAppId));
      if (!isAllowed) return;
      logger.info(
        `Allowing bot message from bot_id=${messageEvent.bot_id} app_id=${botAppId} (allowlisted for testing)`,
      );
    }

    const botUserId = process.env.SLACK_BOT_USER_ID || "U078499LK5K";
    const text = messageEvent.text || "";
    const hasBotMention = text.includes(`<@${botUserId}>`);
    const isDM = messageEvent.channel_type === "im" || messageEvent.channel_type === "mpdm";

    if (
      (isDM || hasBotMention) &&
      messageEvent.user &&
      messageEvent.text &&
      messageEvent.channel &&
      messageEvent.ts &&
      messageEvent.team &&
      messageEvent.event_ts
    ) {
      const mentionEvent: z.infer<typeof zAppMentionEvent> = {
        type: "app_mention" as const,
        user: messageEvent.user,
        ts: messageEvent.ts,
        client_msg_id: messageEvent.client_msg_id,
        text: messageEvent.text,
        team: messageEvent.team,
        thread_ts: messageEvent.thread_ts,
        parent_user_id: messageEvent.parent_user_id,
        blocks: messageEvent.blocks || [],
        channel: messageEvent.channel,
        assistant_thread: messageEvent.assistant_thread,
        attachments: messageEvent.attachments,
        event_ts: messageEvent.event_ts,
      };
      await spawnBotOnSlackMessageEvent(mentionEvent);
    }
  }
}
async function spawnBotOnSlackMessageEvent(event: z.infer<typeof zAppMentionEvent>) {
  // Whole-task safety net. Anything thrown from setup, the SDK loop, the
  // cleanup tail, or a stray Slack/Mongo call inside this body MUST NOT
  // escape this function or it crashes the master and takes every other
  // running task down with it.
  try {
    return await spawnBotOnSlackMessageEventInner(event);
  } catch (err) {
    logger.error(`Task crashed for event ${event.ts} in channel ${event.channel}`, {
      err:
        err instanceof Error
          ? { name: err.name, message: err.message, stack: err.stack?.slice(0, 4000) }
          : err,
    });
    // Best-effort: drop this task from the working-tasks list so a restart
    // doesn't try to resume a poison-pill message forever.
    await removeWorkingTask(event).catch(() => {});
    return;
  }
}

async function spawnBotOnSlackMessageEventInner(event: z.infer<typeof zAppMentionEvent>) {
  // Dedup by content hash so message edits with new intent re-trigger,
  // but truly identical retries within 10s are suppressed.
  const contentHash = createHmac("sha256", "msg")
    .update(event.text || "")
    .digest("hex")
    .slice(0, 8);
  const dedupKey = `msg-${event.ts}-${contentHash}`;
  const eventProcessed = await SlackBotState.get(dedupKey);
  if (+new Date() - (eventProcessed?.touchedAt ?? 0) <= 10e3) return;
  // 1h TTL keeps the dedup window long enough to absorb Slack edit retries
  // without growing the SlackBotState collection unboundedly.
  await SlackBotState.set(
    dedupKey,
    { touchedAt: +new Date(), content: event.text },
    60 * 60 * 1000,
  );

  logger.info(
    await parseSlackMessageToMarkdown(
      `SPAWN - Received Slack app_mention event in channel <#${event.channel}> from user <@${event.user}>`,
    ),
  );

  // whitelist channel name #comfypr-bot, for security reason, only runs agent against @mention messages in #comfyprbot channel
  // you can forward other channel messages to #comfyprbot if needed, and the bot will read the context from the original thread messages
  // DMs are also allowed to spawn agents directly
  const channelInfo = await slack.conversations.info({ channel: event.channel });
  const channelName = channelInfo.channel?.name;
  const isDM = channelInfo.channel?.is_im === true;
  const isAgentChannel = isDM || channelName?.match(/^(comfypr-bot|pr-bot)\b/); //starts with comfyprbot or pr-bot, will spawn agent without requireing @mention

  const user =
    (await slack.users.info({ user: event.user })).user ||
    DIE("failed to fetch user info of <@" + event.user + ">");
  if (user?.is_restricted || user?.is_ultra_restricted) {
    logger.info(`User ${event.user} is a guest user, skipping processing.`);
    return;
  }

  const username =
    user.name ||
    user.id?.replace(/(.*)/, "<@$1>") ||
    DIE("failed to get username of <@" + event.user + ">");

  // task state
  const workspaceId = event.thread_ts || event.ts;
  const eventId = event.channel + "_" + event.ts;
  logger.info(
    `Processing Slack app_mention event in channel ${event.channel} (isAgentChannel: ${isAgentChannel}) with workspaceId: ${workspaceId}`,
  );
  const botWorkingDir = `/bot/slack/${sanitized(channelName || username)}/${workspaceId.replace(".", "-")}`;
  const task = await SlackBotState.get(`task-${workspaceId}`);

  // Allow append messages to running task

  // grab 100 most nearby messages in this thread or channel
  const nearbyMessagesResp = await slack.conversations.replies({
    channel: event.channel,
    ts: workspaceId,
    limit: 100,
  });
  // Type definitions for Slack message components
  type SlackFile = {
    name?: string;
    title?: string;
    mimetype?: string;
    size?: number;
    url_private?: string;
    permalink?: string;
  };

  type SlackReaction = {
    name?: string;
    count?: number;
  };

  const nearbyMessages = (
    await sflow(nearbyMessagesResp.messages || [])
      .map(async (m) => ({
        username: await slack.users
          .info({ user: m.user || DIE("missing user id in message") })
          .then((res) => res.user?.name || "<@" + m.user + ">"),
        markdown: await parseSlackMessageToMarkdown(m.text || ""),
        ts: m.ts,
        iso: slackTsToISO(m.ts || DIE("missing ts")),
        ...(m.files &&
          m.files.length > 0 && {
            files: m.files.map((f: unknown) => {
              const file = f as SlackFile;
              return {
                name: file.name,
                title: file.title,
                mimetype: file.mimetype,
                size: file.size,
                url_private: file.url_private,
                permalink: file.permalink,
              };
            }),
          }),
        ...(m.attachments &&
          m.attachments.length > 0 && {
            attachments: await Promise.all(
              m.attachments.map(async (a: unknown) => {
                const attachment = a as z.infer<typeof zSlackAttachment>;
                // Parse from_url to extract channel name
                let from_channel: string | undefined;
                if (attachment.from_url) {
                  try {
                    const parsed = slackMessageUrlParse(attachment.from_url);
                    const channelInfo = await slack.conversations.info({ channel: parsed.channel });
                    from_channel = channelInfo.channel?.name
                      ? `#${channelInfo.channel.name}`
                      : undefined;
                  } catch {
                    // Ignore parsing errors
                  }
                }
                return {
                  title: attachment.title,
                  title_link: attachment.title_link,
                  text: attachment.text
                    ? await parseSlackMessageToMarkdown(attachment.text)
                    : undefined,
                  fallback: attachment.fallback
                    ? await parseSlackMessageToMarkdown(attachment.fallback)
                    : undefined,
                  image_url: attachment.image_url,
                  from_url: attachment.from_url,
                  from_channel, // Add resolved channel name
                };
              }),
            ),
          }),
        ...(m.reactions &&
          m.reactions.length > 0 && {
            reactions: m.reactions.map((r: unknown) => {
              const reaction = r as SlackReaction;
              return {
                name: reaction.name,
                count: reaction.count,
              };
            }),
          }),
      }))
      .toArray()
  ).toSorted(compareBy((e) => +(e.ts || 0))); // sort by ts asc

  // Compress thread context: keep the most recent 15 messages verbatim, and
  // summarize older ones with gpt-4o-mini to slash token usage on long
  // threads. Skip summarization entirely if there's nothing old.
  let nearbyMessagesForLLM: typeof nearbyMessages | string = nearbyMessages;
  if (nearbyMessages.length > 20) {
    const recent = nearbyMessages.slice(-15);
    const older = nearbyMessages.slice(0, -15);
    try {
      const olderYaml = yaml.stringify(older);
      const summary = (await zChatCompletion(z.object({ summary: z.string() }), {
        model: "gpt-4o-mini",
      })`Summarize the following older Slack thread messages into a tight bullet
list capturing: (1) decisions made, (2) open questions, (3) named files/PRs/URLs
mentioned, (4) any errors or constraints surfaced. Keep under 400 words.

<older-messages-yaml>
${olderYaml}
</older-messages-yaml>`) as { summary: string };

      nearbyMessagesForLLM = `## Older thread summary (${older.length} messages)\n${summary.summary}\n\n## Recent messages (${recent.length})\n${yaml.stringify(recent)}`;
      logger.info(
        `Compressed ${older.length} older messages → summary (${summary.summary.length} chars)`,
      );
    } catch (err) {
      logger.warn("Older-message summarization failed, sending full thread", { err });
    }
  }

  const existedTaskInputFlow = TaskInputFlows.get(workspaceId);
  if (existedTaskInputFlow && false) {
    // disable for now, lets use --queue to serialize tasks
    // while agent still running, user sent new message in the same thread very quickly
    // lets understand the user's intent and give a quick response, and then append the msg to the existing agent input flow
    // const threadMessages = await pageFlow(undefined as undefined | string, async (cursor, limit = 100) => {
    //   const resp = await slack.conversations.replies({
    //     channel: event.channel,
    //     ts: workspaceId,
    //     cursor,
    //     limit,
    //   });
    //   return {
    //     data: resp.messages || [],
    //     next: resp.response_metadata?.next_cursor,
    //   };
    // })
    //   .flat()
    //   .map(async (m) => ({
    //     ts: slackTsToISO(m.ts || DIE("missing ts")),
    //     username: await slack.users
    //       .info({ user: m.user || DIE("missing user id in message") })
    //       .then((res) => res.user?.name || "<@" + m.user + ">"),
    //     markdown: await parseSlackMessageToMarkdown(m.text || ""),
    //   }))
    //   .toArray();

    // use LLM to understand the new message intent
    const action = await zChatCompletion(
      z.object({
        user_intent: z.string(),
        my_quick_respond: z.string(),
        stop_existing_task: z.boolean(),
        msg_to_append_to_agent: z.string(),
      }),
      { model: "gpt-4o" },
    )`
The user sent a new message in a Slack thread where I am already assisting them with an ongoing task. The new message is as follows:
${event.text}

The thread's recent messages are:
${((data: string) => {
  logger.debug("Thread messages:", { data });
  return data;
})(
  yaml.stringify(
    nearbyMessages.toSorted(compareBy((e) => +(e.ts || 0))), // sort by ts asc
  ),
)}

Based on the new message and the thread context,

Please analyze the new message and determine:
1. The user's intent behind this new message.
2. A quick response I can send to the user right away to acknowledge their new message.
3. Whether I should append this new message to the existing task's input flow for further processing.
4. Whether I should stop the existing task based on this new message.

Respond in JSON format with the following fields:
- user_intent: A brief description of the user's intent regarding the new message.
- my_quick_respond: A short message I can send to the user immediately.
- stop_existing_task: true or false, indicating whether to stop the existing task.
- msg_to_append_to_agent: The content of the new message to append to the existing task's input flow. Use empty string "" if not applicable.
`;
    logger.info("New message intent analysis", { action });

    // send quick response
    const myQuickRespondMsg = await safeSlackPostMessage(slack, {
      channel: event.channel,
      thread_ts: event.ts,
      text: action.my_quick_respond, // Fallback text for notifications
      blocks: [
        {
          type: "markdown",
          text: action.my_quick_respond,
        },
      ],
    });

    if (action.stop_existing_task) {
      // stop existing task
      TaskInputFlows.delete(workspaceId);
      await safeSlackPostMessage(slack, {
        channel: event.channel,
        thread_ts: event.thread_ts || event.ts,
        text: `The existing task has been stopped as per your request.`, // Fallback text for notifications
        blocks: [
          {
            type: "markdown",
            text: `The existing task has been stopped as per your request.`,
          },
        ],
      });
      await SlackBotState.set(`task-${workspaceId}`, {
        ...(await SlackBotState.get(`task-${workspaceId}`)),
        status: "stopped_by_user",
      });

      // Remove task from working list
      await removeWorkingTask(event);

      return "existing task stopped by user";
    }
    if (action.msg_to_append_to_agent && action.msg_to_append_to_agent.trim()) {
      if (!existedTaskInputFlow) {
        logger.warn("No existing task input flow found");
        return;
      }
      await touchTaskUserActivity(workspaceId);
      const w = existedTaskInputFlow!.writable.getWriter();
      await w.write(
        await parseSlackMessageToMarkdown(
          `New message from <@${event.user}> in the thread:\n${event.text}\n\nMy quick response to the user: ${action.my_quick_respond}\n\n`,
        ),
      );
      w.releaseLock();
      logger.info(`Appended new message to existing task ${workspaceId} input flow`);
      return "msg appended to existing task";
    }
    return;
  }

  const taskInputFlow = new TransformStream<string, string>();
  TaskInputFlows.set(workspaceId, taskInputFlow); // able to append more inputs later

  // mark that msg as seeing
  await SlackBotState.set(`task-${workspaceId}`, {
    ...(await SlackBotState.get(`task-${workspaceId}`)),
    status: "checking",
    event,
    startTime: Date.now(),
  });
  await slack.reactions
    .add({ name: "eyes", channel: event.channel, timestamp: event.ts })
    .catch(() => {});

  // Post a placeholder immediately so the user sees activity within 1–2s.
  // The real intent analysis runs in parallel below and edits this same message.
  type QuickRespondMsg = { ts: string; text: string; channel?: string; url?: string };
  const placeholderText = "👀 受け取りました。内容を確認しています…";
  const existingPlaceholder = (await SlackBotState.get(`task-quick-respond-msg-${eventId}`)) as
    | QuickRespondMsg
    | undefined;
  let placeholderTs: string;
  if (existingPlaceholder?.ts) {
    placeholderTs = existingPlaceholder.ts;
  } else {
    const posted = await safeSlackPostMessage(slack, {
      channel: event.channel,
      thread_ts: event.ts,
      text: placeholderText,
      blocks: [{ type: "markdown", text: placeholderText }],
    });
    placeholderTs = posted.ts!;
    await SlackBotState.set(`task-quick-respond-msg-${eventId}`, {
      ts: placeholderTs,
      text: placeholderText,
      channel: event.channel,
      url: `https://${SLACK_ORG_DOMAIN_NAME}.slack.com/archives/${event.channel}/p${placeholderTs.replace(".", "")}`,
    });
  }

  // Intent detection — mini is fast/cheap and good enough for classification;
  // falls back to 4o implicitly via retries inside zChatCompletion on failure.
  const resp = await zChatCompletion(
    z.object({
      user_intent: z.string(),
      my_respond_before_spawn_agent: z.string(),
      should_spawn_agent: z.boolean(),
      // simple = lookup/single tool / quick answer; medium = multi-step research;
      // complex = code change, multi-repo, lots of files, or open-ended exploration.
      complexity: z.enum(["simple", "medium", "complex"]),
    }),
    {
      model: "gpt-4o-mini",
    },
  )`
The user mentioned me with the following message in Slack: ${event.text}
Based on this message, please determine the user's intent in a concise manner.
Also, provide a brief response that I can send to the user immediately to acknowledge their request.
Finally, I will spawn an agent to help with this request if necessary.

For context, recent thread messages (older ones may already be summarized):
${
  typeof nearbyMessagesForLLM === "string"
    ? nearbyMessagesForLLM
    : nearbyMessagesForLLM
        .map((m) => `- User ${m.username} said: ${JSON.stringify(m.markdown)}`)
        .join("\n\n")
}

Possible Context Repos:
- https://github.com/comfyanonymous/ComfyUI: The main ComfyUI repository containing the core application logic and features. Its a python backend to run unknown machine learning models and solves various machine learning tasks.
- https://github.com/Comfy-Org/ComfyUI_frontend: The frontend codebase for ComfyuUI, built with Vue and TypeScript.
- https://github.com/Comfy-Org/docs: Documentation for ComfyUI, including setup guides, tutorials, and API references.
- https://github.com/Comfy-Org/desktop: The desktop application for ComfyUI, providing a user-friendly interface and additional functionalities.
- https://github.com/Comfy-Org/registry: The registry.comfy.org, where users can share and discover ComfyUI custom-nodes, and extensions.
- https://github.com/Comfy-Org/workflow_templates: A collection of official shared workflow templates for ComfyUI to help users get started quickly.

- https://github.com/Comfy-Org/comfy-api: A RESTful API service for comfy-registry, it stores custom-node metadatas and user profile/billings informations.

- And also other repos under Comfy-Org organization on GitHub.

Respond in JSON format with the following fields:
- user_intent: A brief description of the user's intent. e.g. "The user is asking for help with setting up a CI/CD pipeline."
- my_respond_before_spawn_agent: A short message I can send to the user right away. e.g. "Got it, let me look into that for you."
- should_spawn_agent: true if further research needed
- complexity: "simple" for quick lookups answerable with one tool call; "medium" for multi-step research across docs/code; "complex" for code changes, multi-repo work, or open-ended exploration.
`;

  const myResponseMessage = await mdFmt(resp.my_respond_before_spawn_agent);
  logger.info("Intent detection response", JSON.stringify({ resp }));

  // Replace the earlier "👀 受け取りました" placeholder with the LLM-synthesized intro.
  // placeholderTs was set during the pre-intent fast-ack above.
  await slack.reactions
    .remove({ name: "x", channel: event.channel, timestamp: placeholderTs })
    .catch(() => {});
  await safeSlackUpdateMessage(slack, {
    channel: event.channel,
    ts: placeholderTs,
    text: myResponseMessage,
    blocks: [{ type: "markdown", text: myResponseMessage }],
  });
  await SlackBotState.set(`task-quick-respond-msg-${eventId}`, {
    ts: placeholderTs,
    text: myResponseMessage,
    channel: event.channel,
    url: `https://${SLACK_ORG_DOMAIN_NAME}.slack.com/archives/${event.channel}/p${placeholderTs.replace(".", "")}`,
  });
  const quickRespondMsg: QuickRespondMsg = {
    ts: placeholderTs,
    text: myResponseMessage,
    channel: event.channel,
  };

  // and now, lets update quickRespondMsg freq until user is satisfied or agent finished its work

  // spawn agent if needed & allowed
  // if (!resp.should_spawn_agent) {
  //   // update status
  //   await slack.reactions.remove({ name: 'eyes', channel: event.channel, timestamp: event.ts, });
  //   await slack.reactions.add({ name: 'white_check_mark', channel: event.channel, timestamp: event.ts, });j
  //   await State.set(`task-${workspaceId}`, { ...await State.get(`task-${workspaceId}`), status: 'done' });
  //   return 'no agent spawned'
  // }

  // The problem not easy to solve in original thread, lets forward this message to #prbot channel, and then spawn agent using that message.
  // if (!isAgentChannel) {
  //   // update status, remove eye, add forwarding reaction
  //   await slack.reactions.remove({ name: "eyes", channel: event.channel, timestamp: event.ts }).catch(() => { });
  //   await slack.reactions.add({ name: "arrow_right", channel: event.channel, timestamp: event.ts }).catch(() => { });

  //   const originalMessageUrl = `https://${event.team}.slack.com/archives/${event.channel}/p${event.ts.replace(".", "")}`;
  //   // forward msg to #prbot channel, mention original msg user:content, and the original msg url for agent to read
  //   const agentChannelId =
  //     (await slack.conversations.list({ types: "public_channel" })).channels?.find((c) => c.name === "pr-bot")?.id ||
  //     DIE("failed to find #prbot channel id");
  //   // this is a user facing msg to tell user we are forwarding the msg
  //   const text = `Forwarded message from <@${event.user}> in <#${event.channel}>:\n${await parseSlackMessageToMarkdown(event.text)}\n\nYou can view the original message here: ${originalMessageUrl}`;
  //   const forwardedMsg = await slack.chat.postMessage({
  //     channel: agentChannelId,
  //     text,
  //   });

  //   // mention forwarded msg in original thread says I will continue there
  //   await slack.chat.update({
  //     channel: event.channel,
  //     ts: quickRespondMsg.ts!,
  //     markdown_text: `${myResponseMessage}\n\nI have forwarded your message to <#${agentChannelId}>. I will continue the research there.`,
  //   });
  //   await State.set(`task-${workspaceId}`, { ...(await State.get(`task-${workspaceId}`)), status: "forward_to_pr_bot_channel" });

  //   // process the forwarded message in agent channel
  //   return await spawnBotOnSlackMessageEvent({
  //     ...event,
  //     channel: agentChannelId,
  //     ts: forwardedMsg.ts!,
  //     thread_ts: undefined,
  //     text: forwardedMsg.text || "",
  //   });
  // }

  await SlackBotState.set(`task-${workspaceId}`, {
    ...(await SlackBotState.get(`task-${workspaceId}`)),
    status: "thinking",
    event,
  });

  // Add task to working list
  await addWorkingTask(event);

  slack.reactions
    .remove({ name: "eyes", channel: event.channel, timestamp: event.ts })
    .catch(() => {});
  slack.reactions
    .add({ name: "thinking_face", channel: event.channel, timestamp: event.ts })
    .catch(() => {});

  const CLAUDEMD = loadClaudeMd({
    EVENT_CHANNEL: event.channel,
    QUICK_RESPOND_MSG_TS: quickRespondMsg.ts!,
    USERNAME: username,
    NEARBY_MESSAGES_YAML: yaml.stringify(nearbyMessages),
    EVENT_TEXT_JSON: JSON.stringify(await parseSlackMessageToMarkdown(event.text)),
    USER_INTENT: resp.user_intent,
    MY_RESPONSE_MESSAGE_JSON: JSON.stringify(myResponseMessage),
    EVENT_THREAD_TS: event.thread_ts || event.ts,
  });

  // Create per-task Linux user for agent isolation
  const taskUser = await createTaskUser(workspaceId);
  logger.info(`Created task user: ${taskUser.username} for workspace ${workspaceId}`);
  await mkdir(botWorkingDir, { recursive: true });

  // fill initial files for agent

  await Bun.write(`${botWorkingDir}/CLAUDE.md`, CLAUDEMD);

  // Download images attached to the triggering message into ./attachments/ so
  // Claude (which has vision) can open them locally instead of needing a
  // Slack-authenticated URL fetch.
  const attachmentsDir = `${botWorkingDir}/attachments`;
  const downloadedImages: { localPath: string; name: string; mimetype?: string }[] = [];
  const MAX_IMAGE_BYTES = 25 * 1024 * 1024; // 25MB — Slack's free-tier upload cap
  const triggeringFiles = nearbyMessages.find((m) => m.ts === event.ts)?.files ?? [];
  if (triggeringFiles.length > 0) {
    await mkdir(attachmentsDir, { recursive: true });
    const slackToken =
      process.env.SLACK_BOT_TOKEN || DIE("missing SLACK_BOT_TOKEN for image download");
    for (const [idx, file] of triggeringFiles.entries()) {
      const downloadUrl =
        (file as { url_private_download?: string }).url_private_download || file.url_private;
      if (!downloadUrl || !file.mimetype?.startsWith("image/")) continue;
      if (typeof file.size === "number" && file.size > MAX_IMAGE_BYTES) {
        logger.warn(
          `Skipping oversized image ${file.name} (${file.size} bytes > ${MAX_IMAGE_BYTES})`,
        );
        continue;
      }
      try {
        const resp = await fetch(downloadUrl, {
          headers: { Authorization: `Bearer ${slackToken}` },
        });
        if (!resp.ok) {
          logger.warn(`Image download failed (${resp.status}) for ${file.name}`);
          continue;
        }
        // Prefix with idx + Slack file id (when available) so two attachments
        // with the same filename don't collide and overwrite each other.
        const fileId = (file as { id?: string }).id ?? `i${idx}`;
        const baseName = (file.name || "image").replace(/[^\w.-]/g, "_");
        const safeName = `${fileId}-${baseName}`;
        const localPath = `${attachmentsDir}/${safeName}`;
        await Bun.write(localPath, await resp.bytes());
        downloadedImages.push({ localPath, name: safeName, mimetype: file.mimetype });
        logger.info(`Downloaded image ${safeName} (${file.mimetype}) → ${localPath}`);
      } catch (err) {
        logger.warn("Image download error", { err, file: file.name });
      }
    }
  }

  // Make the PR-Bot source tree available to the agent under
  // codes/Comfy-Org/pr-bot/tree/main. Idempotent: a previous spawn for the
  // same workspace will already have populated this dir; re-running
  // `git clone` against an existing directory dumps a stderr storm
  // (`fatal: destination path '...' already exists`) on every restart
  // (see 2026-05-11 pm2 logs). If the .git directory is present, just
  // fast-forward; otherwise clone fresh.
  const prBotRepoDir = `${botWorkingDir}/codes/Comfy-Org/pr-bot/tree/main`;
  await mkdir(prBotRepoDir, { recursive: true });
  try {
    const hasGit = existsSync(`${prBotRepoDir}/.git`);
    if (hasGit) {
      await Bun.$`cd ${prBotRepoDir} && git fetch --quiet origin main && git reset --hard --quiet origin/main`.quiet();
    } else {
      await Bun.$`git clone --quiet --branch main https://github.com/Comfy-Org/Comfy-PR ${prBotRepoDir}`.quiet();
    }
  } catch (cloneErr) {
    logger.warn("PR-Bot source tree prepare failed (non-fatal)", { err: cloneErr });
  }

  // await Bun.write(`${botWorkingDir}/PROMPT.txt`, agentPrompt);

  // Add Claude Skills to working dir (.claude/skills)
  // Reference: https://docs.claude.ai/en/claude-code/skills
  const skillsBase = `${botWorkingDir}/.claude/skills`;
  await mkdir(skillsBase, { recursive: true });
  const skills = loadSkills({
    EVENT_CHANNEL: event.channel,
    QUICK_RESPOND_MSG_TS: quickRespondMsg.ts!,
    EVENT_THREAD_TS: event.thread_ts || event.ts,
  });

  for (const [dir, content] of Object.entries(skills)) {
    const p = `${skillsBase}/${dir}`;
    await mkdir(p, { recursive: true });
    await Bun.write(`${p}/SKILL.md`, content);
  }

  // Index file to make skills easy to discover alongside CLAUDE.md
  await Bun.write(
    `${botWorkingDir}/SKILLS.txt`,
    `
Available Skills (.claude/skills):
- slack-messaging: Communicate in Slack threads using prbot slack commands.
- slack-file-sharing: Upload and download files, share deliverables with users.
- github-pr-bot: Delegate all code changes via prbot pr command.
- code-search: Search ComfyUI code using prbot code search.
- github-issue-search: Search issues and PRs using prbot github-issue search.
- notion-search: Discover and cite internal Notion pages using prbot notion search.
- registry-search: Search custom nodes using prbot registry search.
- repo-reading: Clone and inspect Comfy-Org repos read-only, or use prbot code search.
- web-research: Pull in external context and cite sources.

Open the corresponding SKILL.md under .claude/skills/<name>/ for details.
`,
  );

  await Bun.write(
    `${botWorkingDir}/TODO.md`,
    `
# Task TODOs

- Analyze the user's request and gather necessary information.
- Search relevant documents, codebases, and resources using prbot CLI:
  - Code search: prbot code search --query="<search terms>" [--repo=<owner/repo>]
  - Issue search: prbot github-issue search --query="<search terms>"
  - Notion search: prbot notion search --query="<search terms>"
  - Registry search: prbot registry search --query="<search terms>"
- Coordinate with prbot agents for unknown coding tasks:
  - prbot pr --repo=<owner/repo> --prompt="<detailed coding task>"
- For each deliverable: save to ./deliverable-<name>.md then immediately upload to Slack.
- Compile findings and provide a comprehensive response to the user.

## GitHub Changes
- IMPORTANT: Remember to use the prbot CLI for unknown GitHub code changes:
  prbot pr --repo=<owner/repo> [--branch=<branch>] --prompt="<detailed coding task>"

## Deliverables Convention
- ALWAYS save any document, guide, report, or artifact to: ./deliverable-<name>.md
- Then IMMEDIATELY post to Slack (smart-post: short → inline message, long → file upload):
  prbot slack post --channel=<channel> --file=./deliverable-<name>.md --title="<title>" --comment="<summary>" --thread=<thread_ts>
- Examples:
  - ./deliverable-research-report.md
  - ./deliverable-analysis.md
  - ./deliverable-summary.md

## Tool Error Recovery
When a prbot CLI command fails:
1. Record error to ./TOOLS_ERRORS.md (command, error, context)
2. Read the failing tool's source in ./codes/Comfy-Org/Comfy-PR/tree/sno-bot to diagnose
3. Spawn a fix via: prbot pr --repo=Comfy-Org/Comfy-PR --prompt="Fix <tool>: <error>. Root cause: <analysis>. Fix: <change>"
4. Workaround to complete the user's task while the fix PR is open

`,
  );
  await Bun.$`code ${botWorkingDir}`.catch(() => null); // open the working dir in vscode for debugging

  const attachmentsBlock = downloadedImages.length
    ? `\nATTACHED IMAGES (downloaded into ./attachments/, open them with the Read tool to see the contents):\n${downloadedImages.map((i) => `- ./attachments/${i.name} (${i.mimetype})`).join("\n")}\n`
    : "";

  const agentPrompt = `
the @${username} intented to ${resp.user_intent}
Please assist them with their request using all your resources available.
${attachmentsBlock}
IMPORTANT WORKSPACE CONVENTIONS:
- Save ALL deliverables (documents, guides, reports, summaries, analysis, code snippets, etc.) to ./deliverable-<name>.md in the current workspace directory. For example: ./deliverable-draft-pr-guide.md, ./deliverable-research-report.md
- Log any tool errors or failures to ./TOOLS_ERRORS.md
- Keep deliverables self-contained and well-formatted so they can be shared directly with the user
`;

  // Write PROMPT.txt so claude-yes can read the user's intent
  await Bun.write(`${botWorkingDir}/PROMPT.txt`, agentPrompt);

  logger.info(`Spawning agent in ${botWorkingDir} with prompt: ${JSON.stringify(agentPrompt)}`);
  // todo: spawn in a worker user

  // Create dedicated log files for this task
  const taskLogDir = `${botWorkingDir}/.logs`;
  await mkdir(taskLogDir, { recursive: true });
  const agentLogPath = `${taskLogDir}/agent-output.log`;
  const statusLogPath = `${taskLogDir}/STATUS.txt`;

  const isDebugMode = process.env.DEBUG === "true" || process.env.DEBUG === "1";

  // Start error collector to monitor workspace for errors
  const errorLogPath = `${taskLogDir}/COLLECTED_ERRORS.md`;
  const errorCollector = new ErrorCollector({
    workspaceDir: botWorkingDir,
    outputLogPath: errorLogPath,
    onError: isDebugMode
      ? (errorPath: string, content: string) => {
          logger.warn(`Error detected in workspace: ${errorPath}`);
          logger.warn(`Error content preview: ${content.substring(0, 500)}...`);
        }
      : undefined,
    // fs.watch handles real-time detection; this slow poll is a safety net
    // for FS layers that drop events.
    checkInterval: 60_000,
  });
  await errorCollector.start();

  // --- Claude Agent SDK ---
  logger.info(
    `Spawning agent via SDK in ${botWorkingDir} with env GH_TOKEN_COMFY_PR_BOT=[REDACTED]`,
  );

  const sdkPrompt =
    "Please read PROMPT.txt and TODO.md in the current directory and complete all tasks listed there.";

  const abortController = new AbortController();
  const abortKey = `${event.channel}:${event.ts}`;
  TaskAbortControllers.set(abortKey, abortController);

  // Handle follow-up messages: when user sends more messages in the thread,
  // pipe them to the running agent via streamInput
  let agentQuery: Query | null = null;

  // Drain taskInputFlow into the SDK agent. Buffer values that arrive before
  // `agentQuery` is created so early follow-ups aren't silently dropped.
  const earlyBuffer: string[] = [];
  let agentReady = false;
  const inputDrainPromise = (async () => {
    const reader = taskInputFlow.readable.getReader();
    const pushToAgent = async (value: string) => {
      const userMsg: SDKUserMessage = {
        type: "user" as const,
        message: { role: "user" as const, content: value },
        parent_tool_use_id: null,
        session_id: "",
      };
      await (agentQuery as Query).streamInput(
        (async function* () {
          yield userMsg;
        })(),
      );
      logger.info(`Injected follow-up message into SDK agent: ${value.slice(0, 100)}`);
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (agentQuery && agentReady) {
          // Drain anything queued during startup first to preserve order.
          while (earlyBuffer.length > 0) await pushToAgent(earlyBuffer.shift()!);
          await pushToAgent(value);
        } else {
          earlyBuffer.push(value);
        }
      }
    } catch {
      // taskInputFlow closed
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released or stream errored */
      }
    }
  })();

  // Track agent output for Slack updates
  let agentOutput = "";
  let lastSentOutput = "";
  const idleWaiter = new IdleWaiter();
  let isThinking = false;

  // Track GitHub PR URLs surfaced by the sub-agent so they always appear in 📎 成果物.
  const seenPrUrls = new Set<string>();
  const PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

  // Slack update logic — extracted so it can be called from interval and finally
  let lastSlackUpdateTime = 0;
  const MIN_SLACK_UPDATE_INTERVAL_MS = 10_000; // minimum 10s between LLM-synthesized updates
  const sendSlackUpdate = async () => {
    if (agentOutput === lastSentOutput || !agentOutput) return;

    const now = Date.now();
    if (now - lastSlackUpdateTime < MIN_SLACK_UPDATE_INTERVAL_MS) return;
    lastSlackUpdateTime = now;

    const news = agentOutput.slice(lastSentOutput.length);
    lastSentOutput = agentOutput;

    for (const url of news.match(PR_URL_RE) ?? []) seenPrUrls.add(url);

    const my_internal_thoughts = agentOutput.split("\n").slice(-80).join("\n");
    logger.info(
      "Agent output preview: " +
        yaml.stringify({
          preview: my_internal_thoughts.slice(0, 200),
          news_preview: news.slice(0, 200),
        }),
    );

    // Route small incremental updates to the cheaper mini model (~80% cost cut).
    // Fall back to gpt-4o on large diffs or when no prior message exists.
    const hasPrior = (quickRespondMsg.text || "").length > 0;
    const updateModel = hasPrior && news.length < 2000 ? "gpt-4o-mini" : "gpt-4o";

    const contexts = {
      my_internal_thoughts,
      news,
      user_original_intent: resp.user_intent,
      my_response_md_original: quickRespondMsg.text || "",
      // Auto-extracted GitHub PR URLs the agent has produced so far. The
      // prompt template instructs the model to surface every entry under
      // the 📎 成果物 section so users never miss a freshly-opened PR.
      detected_pr_urls: [...seenPrUrls],
    };
    const updateResponseResp = (await zChatCompletion(
      { my_response_md_updated: z.string() },
      { model: updateModel },
    )`
TASK: Update my_response_md_original for Slack using the agent's new my_internal_thoughts.
Output the FULL updated message (not a diff), preserving the section structure below.

SECTION STRUCTURE (keep these exact headings in this order; omit a section only if it has no content):
## 📋 理解
One short line restating user intent.

## 🔍 進捗
Bulleted current progress. Append new bullets for new findings.
Prefix in-progress bullets with "- ⏳" and completed with "- ✅".
Keep at most 8 recent bullets; drop oldest when over limit.

## 📎 成果物
Links to deliverables (PR URLs, gist/file shares). Omit if none.
IMPORTANT: every URL listed in contexts.detected_pr_urls MUST appear here as a bullet (e.g. "- PR: <url>"). Never drop one once it has been surfaced.

## ✅ 完了
Checklist "- [x] …" for finished subtasks. Omit if none.

RULES:
- Preserve finished "- [x]" items. Never delete them.
- If my_internal_thoughts contains brand new information, add it as a bullet under 進捗.
- If a previous ⏳ bullet is now done, flip it to ✅ (and if it ends a logical subtask, also append to 完了).
- If truly nothing changed since my_response_md_original, return {my_response_md_updated: "__NOTHING_CHANGED__"}.

CRITICAL FILTERING (non-negotiable):
- KEEP: user-facing progress, task completion, findings relevant to user's intent, PR/doc URLs
- REMOVE: file paths, stack traces, debug output, timestamps, internal process logs, env var values
  Examples to drop: "/bot/slack/...", "DEBUG: ...", "[2026-..]", "✓ Created /tmp/...", "undefined received in chunk"

TONE & LENGTH:
- Short, informative; link out instead of pasting large content
- Up to ~16 lines total across all sections
- Non-technical wording when possible
- No questions to the user, no code blocks, no raw paths beginning with "/" or "./"
- LENGTH LIMIT: <= 4000 chars (system truncates if exceeded)
- Standard GitHub-flavored markdown

<task-context-yaml>
${yaml.stringify(contexts)}
</task-context-yaml>
`) as { my_response_md_updated: string };

    // Log raw response
    await appendFile(
      ".logs/my_response_md_updated.jsonl",
      JSON.stringify({
        timestamp: new Date().toISOString(),
        workspaceId,
        stage: "raw_from_claude",
        my_response_md_updated_raw: updateResponseResp.my_response_md_updated,
        my_internal_thoughts_preview: my_internal_thoughts.slice(0, 500),
        my_response_md_original: quickRespondMsg.text || "",
      }) + "\n",
    ).catch(() => {});

    const updated_response_full = await mdFmt(
      updateResponseResp.my_response_md_updated
        .trim()
        .replace(/^__NOTHING_CHANGED__$/m, quickRespondMsg.text || ""),
    );

    // Truncate to 4000 chars from the middle
    const my_response_md_updated =
      updated_response_full.length > 4000
        ? updated_response_full.slice(0, 2000) +
          "\n\n...TRUNCATED...\n\n" +
          updated_response_full.slice(-2000)
        : updated_response_full;

    await appendFile(
      ".logs/my_response_md_updated.jsonl",
      JSON.stringify({
        timestamp: new Date().toISOString(),
        workspaceId,
        stage: "final_processed",
        my_response_md_updated_final: my_response_md_updated,
        was_truncated: updated_response_full.length > 4000,
        original_length: updated_response_full.length,
      }) + "\n",
    ).catch(() => {});

    if (quickRespondMsg.ts && quickRespondMsg.channel) {
      await safeSlackUpdateMessage(slack, {
        channel: quickRespondMsg.channel,
        ts: quickRespondMsg.ts,
        text: my_response_md_updated,
        blocks: [{ type: "markdown", text: my_response_md_updated }],
      });
      quickRespondMsg.text = my_response_md_updated;
      await SlackBotState.set(`task-quick-respond-msg-${eventId}`, {
        ts: quickRespondMsg.ts,
        text: quickRespondMsg.text,
        channel: event.channel,
        url: `https://${SLACK_ORG_DOMAIN_NAME}.slack.com/archives/${event.channel}/p${quickRespondMsg.ts.replace(".", "")}`,
      });
    }
  };

  // Periodic Slack update interval
  // Synthesizer runs less aggressively now: the agent is instructed to call
  // `prbot slack update` directly for real progress, so this interval is just
  // a safety net for agents that go quiet on Slack while still producing
  // tool output. 30s vs the old 10s further cuts LLM cost.
  const slackUpdateInterval = setInterval(sendSlackUpdate, 30e3);

  // Run the agent
  let exitCode: number | null = 0;
  try {
    // Prepare workspace ownership for the task user
    await prepareTaskWorkspace(taskUser.username, botWorkingDir);

    // Cap agent turns by classified complexity to avoid runaway cost on
    // simple questions while still allowing complex tasks room to breathe.
    const turnsByComplexity = { simple: 40, medium: 100, complex: 200 } as const;
    const maxTurns = turnsByComplexity[resp.complexity] ?? 200;
    logger.info(`Agent maxTurns=${maxTurns} for complexity=${resp.complexity}`);

    // Allowlist env vars passed into the Claude agent subprocess. The bot
    // process holds Slack signing/bot tokens that the agent never needs;
    // forwarding the entire process.env widens the blast radius if the
    // agent's bash tool is asked to dump env (it will, when prompted).
    const ghToken = process.env.GH_TOKEN_COMFY_PR_BOT || DIE("missing GH_TOKEN_COMFY_PR_BOT env");
    const passEnv: Record<string, string> = {
      HOME: taskUser.homeDir,
      USER: taskUser.username,
      LOGNAME: taskUser.username,
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      LANG: process.env.LANG || "C.UTF-8",
      LC_ALL: process.env.LC_ALL || "C.UTF-8",
      TERM: process.env.TERM || "xterm-256color",
      GH_TOKEN: ghToken,
      GITHUB_TOKEN: ghToken,
    };
    // Whitelist anything the agent legitimately needs at runtime.
    //
    // ANTHROPIC_API_KEY is intentionally NOT forwarded: the claude binary
    // prefers it over OAuth when present, which forced the agent onto
    // pay-per-token API billing and exhausted credit on 2026-04-30. The task
    // user's HOME has the host's `claude login` OAuth credentials copied in
    // by `ensureClaudeCredentials`, so the binary auths via Claude Max/Pro
    // subscription instead. To opt back into API billing for a single task,
    // export ANTHROPIC_API_KEY explicitly here.
    for (const k of [
      "OPENAI_API_KEY",
      "NOTION_TOKEN",
      "SLACK_BOT_TOKEN", // agent uses prbot slack update / read
      "PRBOT_PORT",
      "PRBOT_FEEDBACK_CHANNEL",
      "MONGODB_URI",
      "DEBUG",
      "VERBOSE",
      "LOG_LEVEL",
      "NODE_ENV",
    ]) {
      const v = process.env[k];
      if (v) passEnv[k] = v;
    }

    // Pin to the glibc binary explicitly. The SDK's auto-resolution
    // tries `@anthropic-ai/claude-agent-sdk-linux-x64-musl` first (because
    // it's installed alongside `-linux-x64`), but the musl variant fails
    // on Debian/Ubuntu hosts with "No such file or directory" because
    // /lib/ld-musl-x86_64.so.1 isn't present in glibc-based images. The
    // failure looks like a generic "exit code 1" and was the root cause
    // of the bot dying on every Slack DM (2026-04-30 incident).
    const sdkRoot = require.resolve("@anthropic-ai/claude-agent-sdk/package.json");
    const claudeBinary = sdkRoot.replace(
      /\/claude-agent-sdk\/package\.json$/,
      "/claude-agent-sdk-linux-x64/claude",
    );

    agentQuery = query({
      prompt: sdkPrompt,
      options: {
        cwd: botWorkingDir,
        pathToClaudeCodeExecutable: claudeBinary,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        // SDK isolation mode: do not load ANY filesystem settings or CLAUDE.md.
        // The host's `/root/.claude/CLAUDE.md` is in Japanese ("すべての返答は
        // 自然な日本語で行ってください") and would leak into the agent's tone
        // even when the user wrote in English. Each task gets a clean context;
        // intent context flows in via PROMPT.txt only.
        settingSources: [],
        maxTurns,
        persistSession: false,
        abortController,
        // Run the CLI subprocess as the per-task non-root user
        spawnClaudeCodeProcess: createUserSpawner(taskUser.username, taskUser.homeDir),
        env: passEnv,
        stderr: (data: string) => {
          logger.warn(`[agent stderr]: ${data}`);
        },
      },
    });
    agentReady = true;

    await Bun.write(
      statusLogPath,
      `Started: ${new Date().toISOString()}\nStatus: Running (SDK)\nLog: ${agentLogPath}\n`,
    );

    for await (const message of agentQuery) {
      // Loading indicator management
      idleWaiter.ping();
      if (!isThinking && quickRespondMsg.ts && quickRespondMsg.channel) {
        isThinking = true;
        const msgChannel = quickRespondMsg.channel;
        const msgTs = quickRespondMsg.ts;
        slack.reactions
          .add({ name: "loading", channel: msgChannel, timestamp: msgTs })
          .catch(() => {});
        idleWaiter.wait(5e3).finally(async () => {
          await slack.reactions
            .remove({ name: "loading", channel: msgChannel, timestamp: msgTs })
            .catch(() => {});
          isThinking = false;
        });
      }

      // Process SDK messages
      if (message.type === "assistant") {
        const textBlocks = (message.message.content as Array<{ type: string; text?: string }>)
          .filter(
            (block): block is { type: "text"; text: string } =>
              block.type === "text" && typeof block.text === "string",
          )
          .map((block) => block.text);
        if (textBlocks.length > 0) {
          const text = textBlocks.join("\n");
          agentOutput += text + "\n";
          await appendFile(agentLogPath, text + "\n").catch(() => {});
          logger.debug(`Agent assistant text (${text.length} chars): ${text.slice(0, 200)}`);
        }
      } else if (message.type === "result") {
        if (message.subtype === "success") {
          exitCode = 0;
          logger.info(
            `Agent completed successfully. Turns: ${message.num_turns}, Cost: $${message.total_cost_usd.toFixed(4)}, Duration: ${(message.duration_ms / 1000).toFixed(1)}s`,
          );
          // Append final result to output for last Slack update
          if ("result" in message && message.result) {
            agentOutput += "\n" + message.result;
          }
        } else {
          exitCode = 1;
          const errors = "errors" in message ? (message as { errors: string[] }).errors : [];
          logger.error(
            `Agent failed (${message.subtype}). Turns: ${message.num_turns}, Errors: ${errors.join(", ")}`,
          );
        }
        await appendFile(
          agentLogPath,
          `\n--- Result: ${message.subtype} | Turns: ${message.num_turns} | Cost: $${message.total_cost_usd.toFixed(4)} ---\n`,
        ).catch(() => {});
      } else {
        // Log other message types for debugging
        logger.debug(
          `SDK message: ${message.type}${"subtype" in message ? `.${(message as { subtype: string }).subtype}` : ""}`,
        );
      }
    }
  } catch (err) {
    exitCode = 1;
    // winston serializes Error objects as `{}`, which made the
    // ".claude.json corrupt → spawn dies immediately" incident
    // (2026-04-29) hard to debug — the only log line was `{err:{}}`.
    // Pull message+stack out by hand so the next regression is visible.
    const e = err as Error & { code?: string | number };
    logger.error(`Agent SDK error: ${e?.message ?? String(err)}`, {
      name: e?.name,
      code: e?.code,
      stack: e?.stack?.slice(0, 4000),
    });
  } finally {
    clearInterval(slackUpdateInterval);
    // Remove loading icon if still showing
    if (isThinking && quickRespondMsg.ts && quickRespondMsg.channel) {
      await slack.reactions
        .remove({
          name: "loading",
          channel: quickRespondMsg.channel,
          timestamp: quickRespondMsg.ts,
        })
        .catch(() => {});
    }
    // Send one final Slack update with complete output
    lastSlackUpdateTime = 0; // bypass throttle for final update
    await sendSlackUpdate().catch((err) => logger.error("Final Slack update error:", { err }));
    // Cancel input drain
    abortController.abort();
    TaskAbortControllers.delete(abortKey);
  }

  TaskInputFlows.delete(workspaceId);

  // Stop error collector
  errorCollector.stop();

  // Final status
  const finalStatus = exitCode === 0 ? "Completed Successfully" : `Failed (exit code ${exitCode})`;
  await Bun.write(
    statusLogPath,
    `Status: ${finalStatus}\nEnded: ${new Date().toISOString()}\nErrors: ${errorLogPath}\n`,
  ).catch(() => {});

  if (exitCode !== 0) {
    logger.error(`claude-yes process for task ${workspaceId} exited with code ${exitCode}`);
    // those error tasks will got  retry after a restart
    // update my slack message reactions shows a cross mark and update it appending a error happened and say will retry later
    await slack.reactions
      .remove({ name: "thinking_face", channel: event.channel, timestamp: event.ts })
      .catch(() => {});
    if (quickRespondMsg.ts && quickRespondMsg.channel) {
      await slack.reactions
        .add({ name: "x", channel: quickRespondMsg.channel, timestamp: quickRespondMsg.ts })
        .catch(() => {});
      const errorText = await mdFmt(
        (quickRespondMsg.text || "") +
          `\n\n:warning: An error occurred while processing this request <@snomiao>, I will try it again later`,
      );
      await safeSlackUpdateMessage(slack, {
        channel: event.channel,
        ts: quickRespondMsg.ts,
        text: errorText, // Fallback text for notifications
        blocks: [
          {
            type: "markdown",
            text: errorText,
          },
        ],
      });
    }
  }

  // claude exited as no more inputs/outputs for a while, update the status message
  await slack.reactions
    .remove({ name: "thinking_face", channel: event.channel, timestamp: event.ts })
    .catch(() => {});
  await slack.reactions
    .add({ name: "white_check_mark", channel: event.channel, timestamp: event.ts })
    .catch(() => {});
  const taskState = await SlackBotState.get(`task-${workspaceId}`);
  const endTime = Date.now();
  const responseDuration = taskState?.startTime ? endTime - taskState.startTime : undefined;

  await SlackBotState.set(`task-${workspaceId}`, {
    ...taskState,
    status: "done",
    endTime,
    responseDuration,
  });

  // Remove task from working list
  await removeWorkingTask(event);

  // Note: Task user cleanup is handled by periodic cleanupStaleTaskUsers()
  // We don't delete the user immediately in case of task resume via --continue
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getSlackMessageFromUrl(url: string) {
  const { ts, channel } = slackMessageUrlParse(url);
  const page = await slack.conversations.history({
    channel,
    limit: 1,
    inclusive: true,
    latest: ts,
  });
  return page.messages?.[0] || DIE("not found");
}

function commonPrefix(...args: string[]): string {
  if (args.length === 0) return "";
  let prefix = args[0];
  for (let i = 1; i < args.length; i++) {
    let j = 0;
    while (j < prefix.length && j < args[i].length && prefix[j] === args[i][j]) {
      j++;
    }
    prefix = prefix.slice(0, j);
    if (prefix === "") break;
  }
  return prefix;
}

/**
 * Clean terminal output by removing ANSI codes, debug info, and system paths
 * This ensures Claude only sees user-meaningful progress information
 */
function cleanTerminalOutput(text: string): string {
  // Remove ANSI color codes and escape sequences
  text = text.replace(/\x1b\[[0-9;]*m/g, "");
  text = text.replace(/\x1b\[[^m]*m/g, "");
  text = text.replace(/\u0007/g, ""); // Bell character
  text = text.replace(/\r/g, ""); // Carriage returns

  // Remove box drawing characters (Claude Code banner)
  text = text.replace(/[▐▛▜▘▝█▌▙▟▞▚░▒▓│┃├┤┬┴┼─═║╔╗╚╝╠╣╦╩╬]/g, "");

  // Filter lines to remove debug noise
  const lines = text.split("\n").filter((line) => {
    const trimmed = line.trim();

    // Skip empty or whitespace-only lines
    if (!trimmed) return true;

    // Skip timestamp-prefixed log lines (multiple formats)
    // Format 1: [2026-02-20T15:10:40.123Z]
    if (/^\[[\d\-T:.Z]+\]/.test(trimmed)) return false;
    // Format 2: 2026-02-20 15:42:09 [info]:
    if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\s+\[/.test(trimmed)) return false;

    // Skip warning lines
    if (/^⚠|^Warning:|^WARN:|^\[warn\]/i.test(trimmed)) return false;

    // Skip debug/verbose/trace/info prefixed lines
    if (/^(DEBUG|VERBOSE|TRACE|INFO):/i.test(trimmed)) return false;
    if (/\[(debug|verbose|trace|info)\]:/i.test(trimmed)) return false;

    // Skip claude-yes specific output
    if (/\[claude-yes\]|claude-yes|Spawned claude|PID \d+/i.test(trimmed)) return false;
    if (/Claude Code v\d|Opus \d|Claude Max/i.test(trimmed)) return false;

    // Skip lines containing system paths anywhere
    if (/\/bot\/slack\/|\/codes\/|\.logs\/|\/repos\/|\/tmp\//i.test(trimmed)) return false;

    // Skip undefined/null error indicators
    if (/received undefined\/null|undefined\/null/i.test(trimmed)) return false;

    // Skip deprecation warnings
    if (/deprecated|--exit-on-idle|-e are deprecated/i.test(trimmed)) return false;

    // Skip pure terminal control output or lines that are mostly special chars
    if (/^(\s*|cursor\s+|bell|bel|\x07)$/i.test(trimmed)) return false;

    // Skip lines that are mostly whitespace or contain only special characters
    if (/^[\s\u2000-\u206F\u2500-\u257F]*$/.test(trimmed)) return false;

    return true;
  });

  return lines.join("\n").trim();
}
function sanitized(name: string) {
  return name.replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 50);
}

export async function spawnBotOnSlackMessageUrl(url: string) {
  const { team, channel, ts } = await slackMessageUrlParse(url);
  const event = await slack.conversations
    .replies({
      channel: channel,
      ts: ts,
      limit: 1,
    })
    .then((res) => res.messages?.[0] || DIE("failed to fetch message from slack"));
  logger.info("Processing missed message " + JSON.stringify({ url, event }));
  // Parse the event to ensure it matches the expected type
  const mentionEvent = zAppMentionEvent.parse({
    ...event,
    type: "app_mention",
    user: event.user || "",
    channel: channel,
    event_ts: event.ts || ts,
  });
  await spawnBotOnSlackMessageEvent(mentionEvent);
}
