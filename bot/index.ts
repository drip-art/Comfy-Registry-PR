#!/usr/bin/env bun
/**
 * ComfyPR Bot
 *
 * Slack Bot
 * @author snomiao <snomiao@gmail.com>
 */
import { join } from "path";

/**
 * Load .env.local with override semantics so that values in the file
 * take precedence over stale shell env vars injected by pm2/parent shell.
 * Prevents the SLACK_SIGNING_SECRET mismatch incident (2026-04-24).
 */
async function loadEnvLocalWithOverride() {
  const envPath = join(import.meta.dir, "../.env.local");
  try {
    const text = await Bun.file(envPath).text();
    let applied = 0;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      process.env[key] = value;
      applied++;
    }
    console.log(`[env] Loaded ${applied} entries from ${envPath} (override)`);
  } catch {
    console.log(`[env] ${envPath} not found, using shell env only`);
  }

  // Log short prefixes (≤6 chars) so an operator can confirm the right
  // value loaded without exposing enough to attempt token reuse if the log
  // ends up shared. PRBOT_PORT and NODE_ENV are not secrets so the full
  // value is fine.
  const prefix = (k: string) =>
    `${k}=${process.env[k] ? process.env[k]!.slice(0, 6) + "…" : "(unset)"}`;
  const literal = (k: string) => `${k}=${process.env[k] ?? "(unset)"}`;
  console.log(
    "[env] " +
      [
        prefix("SLACK_SIGNING_SECRET"),
        prefix("SLACK_BOT_TOKEN"),
        literal("PRBOT_PORT"),
        literal("NODE_ENV"),
      ].join(" | "),
  );
}

/**
 * Global safety nets so a stray rejection inside any background task or
 * webhook handler cannot kill the master process. The 2026-05-11 crash
 * loop racked up 3000+ pm2 restarts and 6.2GB RSS before stopping;
 * keeping the bot alive long enough to log + continue is more important
 * than failing-fast on bugs we can't pin down at startup.
 */
function installProcessSafetyNets() {
  process.on("unhandledRejection", (reason, promise) => {
    const r = reason as { message?: string; stack?: string; name?: string } | undefined;
    console.error("[safety-net] unhandledRejection (swallowed)", {
      name: r?.name,
      message: r?.message,
      stack: r?.stack?.slice(0, 4000),
      promise: String(promise),
    });
  });
  process.on("uncaughtException", (err) => {
    console.error("[safety-net] uncaughtException (swallowed)", {
      name: err?.name,
      message: err?.message,
      stack: err?.stack?.slice(0, 4000),
    });
  });
}

/**
 * Delete /bot/slack/<channel>/<task> workspace directories that haven't
 * been touched in the last `maxAgeDays`. Run once at startup so a
 * long-running bot doesn't accumulate gigabytes of stale clones +
 * .claude state.
 */
async function pruneStaleWorkspaces(maxAgeDays = 7) {
  const root = "/bot/slack";
  try {
    const { readdir, stat, rm } = await import("fs/promises");
    const channels = await readdir(root).catch(() => [] as string[]);
    const cutoff = Date.now() - maxAgeDays * 86400_000;
    let pruned = 0;
    for (const ch of channels) {
      const chDir = `${root}/${ch}`;
      const tasks = await readdir(chDir).catch(() => [] as string[]);
      for (const t of tasks) {
        const taskDir = `${chDir}/${t}`;
        const st = await stat(taskDir).catch(() => null);
        if (!st) continue;
        if (st.mtimeMs >= cutoff) continue;
        await rm(taskDir, { recursive: true, force: true }).catch(() => {});
        pruned++;
      }
    }
    if (pruned > 0)
      console.log(`[startup] pruned ${pruned} stale workspaces older than ${maxAgeDays}d`);
  } catch (err) {
    console.warn("[startup] pruneStaleWorkspaces failed (non-fatal)", { err });
  }
}

/**
 * If RSS climbs past `limitMb` AND the bot is idle, exit so pm2 can
 * restart a fresh process. Idleness is checked via the same status HTTP
 * endpoint the smart restart manager uses, so we won't kill an in-flight
 * task.
 */
function installMemoryWatchdog(limitMb = 4096, port = Number(process.env.PRBOT_PORT || 0)) {
  setInterval(async () => {
    const rssMb = process.memoryUsage().rss / 1024 / 1024;
    if (rssMb < limitMb) return;
    let idle = true;
    if (port) {
      try {
        const r = await fetch(`http://localhost:${port}/status`, {
          signal: AbortSignal.timeout(2000),
        });
        if (r.ok) {
          const data = (await r.json()) as { status?: string };
          idle = data.status === "idle";
        }
      } catch {
        // Status check failed — be conservative, don't restart yet.
        idle = false;
      }
    }
    if (!idle) {
      console.warn(
        `[watchdog] RSS=${rssMb.toFixed(0)}MB over ${limitMb}MB, but bot is busy — deferring`,
      );
      return;
    }
    console.warn(
      `[watchdog] RSS=${rssMb.toFixed(0)}MB over ${limitMb}MB and idle — exiting for pm2 restart`,
    );
    process.exit(0);
  }, 60_000).unref();
}

if (import.meta.main) {
  installProcessSafetyNets();
  await loadEnvLocalWithOverride();
  await pruneStaleWorkspaces();
  console.log("Starting ComfyPR Slack Bot...");
  const client = await (await import("./slack-bot.ts")).startSlackBot();
  installMemoryWatchdog();
  console.log("ComfyPR Slack Bot Done.");
}
