/**
 * Task User Management
 *
 * Creates and manages per-task Linux users for agent isolation.
 * Each agent task runs as its own Linux user to prevent cross-task interference.
 */
import { $ } from "bun";

const TASK_USER_PREFIX = "task-";
const TASK_USER_GROUP = "comfy-tasks";
const TASK_ACTIVITY_FILE = ".last-activity";

export interface TaskUser {
  username: string;
  homeDir: string;
}

function workspaceIdToTaskSuffix(workspaceId: string): string {
  return workspaceId.replace(".", "-").slice(0, 24);
}

function taskHomeDir(username: string): string {
  return `/tmp/${username}`;
}

async function writeTaskActivity(username: string): Promise<void> {
  const homeDir = taskHomeDir(username);
  const activityPath = `${homeDir}/${TASK_ACTIVITY_FILE}`;
  await Bun.write(activityPath, new Date().toISOString());
  await $`chown ${username}:${TASK_USER_GROUP} ${activityPath}`.quiet().catch(() => {});
}

/** Ensure the shared group exists */
async function ensureGroup(): Promise<void> {
  try {
    await $`getent group ${TASK_USER_GROUP}`.quiet();
  } catch {
    await $`groupadd --system ${TASK_USER_GROUP}`.quiet();
  }
}

/** Create a temporary Linux user for a task */
export async function createTaskUser(workspaceId: string): Promise<TaskUser> {
  await ensureGroup();

  const username = `${TASK_USER_PREFIX}${workspaceIdToTaskSuffix(workspaceId)}`;
  const homeDir = taskHomeDir(username);

  // Check if user already exists (task resume)
  try {
    await $`id ${username}`.quiet();
    // User exists, just ensure home dir
    await $`mkdir -p ${homeDir}/.claude`.quiet();
    await ensureClaudeConfig(homeDir);
    await $`chown -R ${username}:${TASK_USER_GROUP} ${homeDir}`.quiet();
    await writeTaskActivity(username);
    return { username, homeDir };
  } catch {
    // User doesn't exist, create it
  }

  await $`useradd --system --no-create-home --gid ${TASK_USER_GROUP} --shell /bin/sh ${username}`.quiet();
  await $`mkdir -p ${homeDir}/.claude`.quiet();
  await ensureClaudeConfig(homeDir);
  await $`chown -R ${username}:${TASK_USER_GROUP} ${homeDir}`.quiet();
  await writeTaskActivity(username);

  return { username, homeDir };
}

/**
 * The Claude Agent SDK CLI bails out immediately if `~/.claude.json`
 * exists but is empty or otherwise unparsable as JSON — the agent
 * subprocess exits with code 1 on launch and the only error visible
 * is "Configuration error in /…/.claude.json: JSON Parse error: Unexpected EOF".
 *
 * The CLI itself sometimes truncates the file mid-write on an aborted run,
 * leaving a 0-byte file that poisons every subsequent task spawn for the
 * same user. Defensively normalize: write a minimal `{}` whenever the file
 * is missing, empty, or invalid JSON. The CLI will fill in real fields on
 * its first successful run.
 */
async function ensureClaudeConfig(homeDir: string): Promise<void> {
  const path = `${homeDir}/.claude.json`;
  let content = "";
  try {
    content = await Bun.file(path).text();
  } catch {
    // missing file is fine, fall through to write {}
  }
  if (content.trim()) {
    try {
      JSON.parse(content);
      return; // already valid
    } catch {
      /* corrupt — overwrite */
    }
  }
  await Bun.write(path, "{}");
}

/** Set up workspace directory ownership for the task user */
export async function prepareTaskWorkspace(username: string, workDir: string): Promise<void> {
  await $`mkdir -p ${workDir}`.quiet();
  await $`chown -R ${username}:${TASK_USER_GROUP} ${workDir}`.quiet();
}

/** Delete a task user and clean up */
export async function deleteTaskUser(username: string): Promise<void> {
  if (!username.startsWith(TASK_USER_PREFIX)) return; // safety guard
  await $`userdel ${username}`.quiet().catch(() => {});
  await $`rm -rf /tmp/${username}`.quiet().catch(() => {});
}

/** Record that a task received new activity */
export async function touchTaskUserActivity(workspaceId: string): Promise<void> {
  const username = `${TASK_USER_PREFIX}${workspaceIdToTaskSuffix(workspaceId)}`;
  const homeDir = taskHomeDir(username);
  await $`mkdir -p ${homeDir}`.quiet();
  await writeTaskActivity(username);
}

/** List all task-* users */
export async function listTaskUsers(): Promise<string[]> {
  try {
    const output = await $`getent passwd`.text();
    return output
      .split("\n")
      .filter((line) => line.startsWith(TASK_USER_PREFIX))
      .map((line) => line.split(":")[0]);
  } catch {
    return [];
  }
}

/** Clean up stale task users not in the active set */
export async function cleanupStaleTaskUsers(activeWorkspaceIds: Set<string>): Promise<string[]> {
  const users = await listTaskUsers();
  const cleaned: string[] = [];
  const activeTaskSuffixes = new Set([...activeWorkspaceIds].map(workspaceIdToTaskSuffix));

  for (const username of users) {
    const taskSuffix = username.slice(TASK_USER_PREFIX.length);

    // Check if this task is still active
    const isActive = activeTaskSuffixes.has(taskSuffix);
    if (isActive) continue;

    // Skip if the task has seen activity in the last 24h.
    const homeDir = taskHomeDir(username);
    const activityPath = `${homeDir}/${TASK_ACTIVITY_FILE}`;
    try {
      const stat = await Bun.file(activityPath).stat();
      if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) continue;
    } catch {
      try {
        const stat = await Bun.file(`${homeDir}/.claude`).stat();
        if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) continue;
      } catch {
        // No activity file or fallback dir; safe to clean.
      }
    }

    await deleteTaskUser(username);
    cleaned.push(username);
  }

  return cleaned;
}
