/**
 * Spawn Claude Code CLI as a specific Linux user via sudo.
 *
 * Used with the Claude Agent SDK's `spawnClaudeCodeProcess` option
 * to run agent subprocesses as per-task non-root users.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { SpawnOptions, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";

/**
 * Create a spawnClaudeCodeProcess function that runs the CLI as a specific Linux user.
 *
 * The SDK passes: { command, args, cwd, env, signal }
 * We wrap this in: sudo -n -u <username> <command> <args...>
 */
export function createUserSpawner(
  username: string,
  taskHome: string,
): (options: SpawnOptions) => SpawnedProcess {
  return (options: SpawnOptions): SpawnedProcess => {
    const { command, args, cwd, env, signal } = options;

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...env,
      HOME: taskHome,
      USER: username,
      LOGNAME: username,
    };
    // Ensure PATH includes bun/node/claude locations
    childEnv.PATH = `/root/.bun/bin:/root/.local/bin:/root/.nvm/versions/node/v25.2.1/bin:${childEnv.PATH || "/usr/local/bin:/usr/bin:/bin"}`;

    // Resolve command to full path (sudo resets PATH)
    const resolvedCommand =
      command === "bun"
        ? "/root/.bun/bin/bun"
        : command === "node"
          ? "/root/.nvm/versions/node/v25.2.1/bin/node"
          : command === "claude"
            ? "/root/.local/bin/claude"
            : command;

    // `sudo --preserve-env` with no list uses the env_keep policy
    // (HOME, PATH, TERM only) and silently drops everything else,
    // including ANTHROPIC_API_KEY. The Claude SDK CLI then exits
    // immediately at startup, mid-write of ~/.claude.json, leaving a
    // corrupted file that poisons every later spawn for this user.
    //
    // Fix: explicitly enumerate every env key we want forwarded so
    // sudo lets them through. We pass childEnv (built above) verbatim,
    // sudo strips it down to the listed keys before exec.
    const preserveKeys = Object.keys(childEnv).filter((k) => childEnv[k] !== undefined);
    const sudoArgs = [
      "-n",
      "-u",
      username,
      `--preserve-env=${preserveKeys.join(",")}`,
      resolvedCommand,
      ...args,
    ];

    if (process.env.DEBUG_SPAWN === "1") {
      console.log("[spawn-as-user] sudo", sudoArgs.slice(0, 4).join(" "), "...", resolvedCommand);
      console.log("[spawn-as-user] cwd=", cwd);
      console.log(
        "[spawn-as-user] passes:",
        Object.keys(childEnv)
          .filter((k) =>
            ["HOME", "USER", "PATH", "ANTHROPIC_API_KEY", "GH_TOKEN", "MONGODB_URI"].includes(k),
          )
          .join(","),
      );
    }

    const proc = spawn("sudo", sudoArgs, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv,
    }) as unknown as ChildProcessWithoutNullStreams;

    // Mirror stderr to our process so the SDK's `stderr` callback in
    // bot/slack-bot.ts catches early-startup errors. Without this,
    // a Claude Code CLI that dies before producing JSON-formatted SDK
    // messages just shows up as "exit code 1" with no context.
    proc.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[spawn-as-user stderr] ${chunk}`);
    });

    // Wire up abort signal
    if (signal) {
      signal.addEventListener("abort", () => {
        proc.kill("SIGTERM");
      });
    }

    return {
      stdin: proc.stdin,
      stdout: proc.stdout,
      get killed() {
        return proc.killed;
      },
      get exitCode() {
        return proc.exitCode;
      },
      kill(signal: NodeJS.Signals) {
        return proc.kill(signal);
      },
      on(event, listener) {
        proc.on(event, listener as never);
      },
      once(event, listener) {
        proc.once(event, listener as never);
      },
      off(event, listener) {
        proc.off(event, listener as never);
      },
    };
  };
}
