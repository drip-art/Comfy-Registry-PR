# Claude Development Notes

## Bot Startup (oxmgr)

The Slack bot runs on the `sno-bot` branch and should always be running via oxmgr.

> Migrated from pm2 to oxmgr on 2026-05-12. The npm-installed oxmgr binary
> ships glibc-linked and requires GLIBC_2.39 (Debian 13+); on Debian 12 we
> manually swap in the musl static-pie binary from the GitHub release:
> `/root/.nvm/versions/node/v25.2.1/lib/node_modules/oxmgr/vendor/oxmgr`.
> Original at `.glibc.bak`. Upstream tracking: Vladimir-Urik/OxMgr#32.

### Start / Restart

```bash
# Start (or restart if already running)
oxmgr start --name comfy-pr-bot --restart always \
  --cwd /v1/code/Comfy-Org/Comfy-PR/tree/sno-bot \
  "/root/.bun/bin/bun bot/index.ts --continue"

# Or use the convenience script (stops old instance first)
bash bot/up.sh
```

### Check Status & Logs

```bash
oxmgr ls                       # one-line status
oxmgr status comfy-pr-bot      # detailed view
oxmgr logs comfy-pr-bot        # recent logs
oxmgr logs comfy-pr-bot -f     # follow live
```

Log files are at `/root/.local/share/oxmgr/logs/comfy-pr-bot.{out,err}.log`.

### Stop

```bash
oxmgr stop comfy-pr-bot
oxmgr rm   comfy-pr-bot   # also drops the persisted definition
```

### Important Notes

- The bot **always runs from the `sno-bot` branch** — ensure you're on that branch before starting
- Uses `--continue` flag to resume any in-progress tasks on restart
- Port `3475` is used for health checks (env `PRBOT_PORT`)
- RestartManager watches `bot/`, `src/`, `lib/` for file changes and auto-restarts when idle
- If the bot crash-loops, check for merge conflicts: `grep -n '<<<<<<' bot/slack-bot.ts`
- If a single resumed task triggers a SIGKILL loop (memory spike), clear `current-working-tasks` from SlackBotState; helper: `bun tmp/clear-working-tasks.ts`. See project memory `bot-poison-pill-task.md`.

## Security: Top-Level `await createIndex` Is Intentional

**Do NOT convert `await createIndex()` calls to fire-and-forget (`.catch(() => {})`) or move them into lazy init functions.**

Top-level `await createIndex()` at module scope is a deliberate security pattern. These calls ensure indexes exist **before** any queries run against the collection. This guarantees:

1. **Unique constraints are enforced** before any inserts/upserts — prevents duplicate data from race conditions
2. **Query correctness** — certain queries depend on index existence for correct filtering behavior
3. **Predictable startup** — the process won't serve requests or run tasks until the database is in a known-good state

The only exception is `CNRepos.createIndex(...).catch(() => {})` for non-critical compound indexes used purely for performance optimization (not correctness).

## TypeScript Performance Optimization (2026-01-10)

### Problem

The TypeScript server was experiencing severe performance issues causing slowdowns and crashes.

### Root Causes

1. **Overly broad include pattern** (`**/*.ts`) - forced scanning of 15,355+ .d.ts files in node_modules
2. **Expensive recursive type** (`DeepAsyncWrapper<T>`) - computed over 122K+ line Octokit type definitions
3. **Test files included** - unnecessary type checking during development

### Solution (PR #139)

- Replaced `**/*.ts` with specific directory patterns in tsconfig.json
- Removed `DeepAsyncWrapper` type from src/ghc.ts (runtime proxy handles async wrapping)
- Excluded `**/*.spec.ts` and `**/*.test.ts` from compilation
- TypeScript compilation now completes in ~33s with clean builds

### Key Files Modified

- `tsconfig.json`: Specific includes instead of broad patterns
- `src/ghc.ts`: Simplified type annotation for `ghc` export
- `next-env.d.ts`: Created (auto-generated, git-ignored)

## General Development Flow for All Scripts

### Standard Development Pattern

1. **Install Dependencies**: Use `bun add <package>` for runtime deps, `bun add -d <package>` for dev deps
2. **Create Implementation**: Write the main functionality in TypeScript
3. **Add Testing**: Create `.spec.ts` files with comprehensive test coverage
4. **Test Execution**: Use `bun <file.ts>` to run scripts directly with `if (import.meta.main)` blocks
5. **Type Safety**: Ensure full TypeScript coverage and proper type definitions
6. **Error Handling**: Handle errors gracefully and don't cache failed responses
7. **Documentation**: Update CLAUDE.md with implementation details and usage examples

### Testing Standards

- **File Naming**: Use `.spec.ts` suffix for test files
- **Mocking**: Mock external APIs and services to avoid real calls during tests
- **Coverage Areas**: Test happy path, error cases, edge cases, concurrent scenarios
- **Setup/Teardown**: Clean up resources (files, caches, etc.) in test lifecycle hooks

### Common Patterns

- **Caching**: Use Keyv with SQLite for persistent caching in `node_modules/.cache/Comfy-PR/`
- **Configuration**: Store config in environment variables with sensible defaults
- **Logging**: Use console.log sparingly, prefer structured logging for debugging
- **File Organization**: Keep related functionality together, use clear module exports

### Repository Structure

- **`src/`**: Core utilities and shared functionality
- **`app/tasks/`**: Specific task implementations
- **`bot/code/`**: GitHub integration tools including prbot for spawning AI agents on repositories
- **`gh-service/`**: GitHub webhook service components
- **`run/`**: Executable scripts and services
- **Tests**: Co-located with source files using `.spec.ts` suffix

## Working Tasks State Management

### Overview

The bot uses a simplified state management system to track currently active tasks. Instead of querying the entire database, it maintains a lightweight list of working message events in the `current-working-tasks` state key.

### Implementation

- **File**: `bot/index.ts` (lines ~96-119 for helper functions)
- **Tests**: `bot/WorkingTasksManager.spec.ts`
- **Documentation**: `docs/WORKING-TASKS.md`

### Key Features

1. **Lightweight State**: Single state key `current-working-tasks` with array of event objects
2. **Automatic Management**: Tasks added when started, removed when completed/stopped
3. **Fast Resume**: On `--continue`, reads list and resumes each task by calling `processSlackAppMentionEvent(event)`
4. **No Database Queries**: Eliminates need to scan entire MongoDB collection for incomplete tasks

### State Structure

```typescript
{
  "current-working-tasks": {
    workingMessageEvents: [
      { type: "app_mention", user: "U123", ts: "1234567890.123456", channel: "C123", ... },
      // ... more events
    ]
  }
}
```

### Usage

```typescript
// Add task when starting
await addWorkingTask(event);

// Remove task when done
await removeWorkingTask(event);

// Resume on restart (--continue flag)
const workingTasks = (await State.get("current-working-tasks")) || { workingMessageEvents: [] };
for (const event of workingTasks.workingMessageEvents) {
  processSlackAppMentionEvent(event).catch((err) => logger.error("Resume error", { err }));
}
```

## Smart Restart Manager

### Overview

The bot includes a smart restart mechanism that watches for file changes and automatically restarts **only when idle** (no active tasks running). This replaces the problematic `--watch` flag that would interrupt ongoing tasks.

### Implementation

- **File**: `bot/RestartManager.ts`
- **Tests**: `bot/RestartManager.spec.ts`
- **Example**: `bot/restart-example.ts`
- **Startup Script**: `bot/up.sh` (production auto-restart loop)
- **Documentation**: `docs/RESTART.md`, `docs/RESTART-SUMMARY.md`, `docs/RESTART-FLOW.md`, `docs/RESTART-QUICKREF.md`

### Key Features

1. **File Watching**: Monitors specified directories for changes using Node.js `fs.watch`
2. **Debouncing**: Prevents multiple restarts from rapid file changes (default: 1 second)
3. **Idle Detection**: Checks if bot is idle before restarting (default: every 5 seconds)
4. **Smart Restart**: Only restarts when `TaskInputFlows.size === 0` (no active tasks)
5. **Configurable**: Easy to customize watch paths, intervals, and ignored files

### Usage in bot/index.ts

```typescript
import { RestartManager } from "./RestartManager";

const restartManager = new RestartManager({
  watchPaths: ["bot", "src", "lib"],
  isIdle: () => TaskInputFlows.size === 0,
  onRestart: () => process.exit(0),
  idleCheckInterval: 5000,
  debounceDelay: 1000,
  logger: {
    info: (msg, meta) => logger.info(`[RestartManager] ${msg}`, meta),
    warn: (msg, meta) => logger.warn(`[RestartManager] ${msg}`, meta),
  },
});
restartManager.start();
```

### Deployment

The `bot/up.sh` script includes an auto-restart loop that catches the exit code and restarts the bot:

```bash
while true; do
  bun bot/index.ts --continue
  EXIT_CODE=$?
  if [ $EXIT_CODE -eq 0 ]; then
    sleep 2  # Clean exit (file change restart)
  else
    sleep 5  # Crash (wait longer)
  fi
done
```

### Benefits vs `--watch`

| Feature              | `--watch` | Smart Restart |
| -------------------- | --------- | ------------- |
| Detects changes      | ✅        | ✅            |
| Restarts immediately | ✅        | ❌            |
| Waits for idle       | ❌        | ✅            |
| Interrupts tasks     | ✅        | ❌            |
| Configurable         | ❌        | ✅            |

### Testing

Run the example to see it in action:

```bash
bun bot/restart-example.ts
# Then edit any file in bot/ directory while it's running
```

Run the test suite:

```bash
bun test bot/RestartManager.spec.ts
```

## Cached GitHub Client (ghc)

### Overview

Created a cached wrapper around the GitHub API client that transparently caches all API responses to improve performance and reduce API rate limiting.

### Implementation

- **File**: `src/ghc.ts`
- **Cache Storage**: SQLite via Keyv in `node_modules/.cache/Comfy-PR/gh-cache.sqlite`
- **Default TTL**: 5 minutes
- **Cache Key Format**: `gh.{apiPath}({truncatedArgs})#{hash}`

### Key Features

1. **Transparent Caching**: Same interface as `gh` object, just import `ghc` instead
2. **Smart Cache Keys**: Truncates long arguments but preserves full hash for accuracy
3. **SQLite Storage**: Persistent cache across runs
4. **Type Safety**: Maintains full TypeScript types from original GitHub client

### Usage

```typescript
import { ghc } from "./src/ghc";

// Same as gh.repos.get() but with caching
const repo = await ghc.repos.get({
  owner: "octocat",
  repo: "Hello-World",
});

// Second call uses cache
const cachedRepo = await ghc.repos.get({
  owner: "octocat",
  repo: "Hello-World",
});
```

### Cache Management

```typescript
import { clearGhCache, getGhCacheStats } from "./src/ghc";

// Clear all cached data
await clearGhCache();

// Get cache statistics
const stats = await getGhCacheStats();
```

### Testing

- **Test File**: `src/ghc.spec.ts`
- **Coverage**: Cache hits/misses, error handling, concurrent requests, key generation
- **Mocking**: Uses Jest mocks to avoid real API calls during tests

### Development Flow

1. Install dependencies: `bun add keyv @keyv/sqlite`
2. Create cached wrapper with Proxy pattern
3. Implement cache key generation with argument truncation
4. Add comprehensive test suite
5. Test with real API calls: `bun src/ghc.ts`

### Cache Key Examples

- Short args: `gh.repos.get({"owner":"octocat","repo":"Hello-World"})#b3117af2`
- Long args: `gh.repos.get({"owner":"octocat","descripti...bbbbbbbbbb"})#4240f076`

## ComfyPR Bot Skills

### Overview

The ComfyPR Bot (defined in `bot/index.ts`) is a Slack-integrated AI assistant that helps with research, documentation, and code investigation tasks. When spawned, the bot agent has access to several specialized skills.

### Architecture: Master-Worker Pattern

The bot system uses a two-tier architecture:

1. **Master Agent (ComfyPR Bot)** - Research and Coordination
   - Handles Slack interactions and user communication
   - Performs research, documentation searches, and code analysis (READ-ONLY)
   - Coordinates work by spawning specialized sub-agents
   - **CANNOT make direct code changes to GitHub repositories**
   - Must delegate all coding tasks to PR-Bot sub-agents

2. **Worker Agents (PR-Bot Sub-Agents)** - Code Modification
   - Spawned by master agent via `bun bot/code/prbot.ts`
   - Clones repositories to isolated directories (`/repos/`)
   - Has full write access to make code changes
   - Creates commits, branches, and pull requests
   - Works independently in isolated environment

This separation ensures:

- Clear separation of concerns (research vs. execution)
- Better isolation and safety for code modifications
- Ability to spawn multiple coding agents in parallel
- Master agent stays focused on coordination and communication

### Available Skills

The bot agent prompt (lines 390-396 in `bot/index.ts`) includes the following skills:

1. **Web Search**
   - Search the web for relevant information
   - Gather up-to-date information and context

2. **GitHub Repository Access (READ-ONLY)**
   - Clone any repositories from https://github.com/Comfy-Org
   - Inspect codebases at `./codes/Comfy-Org/[repo]/tree/[branch]`
   - Read and analyze source code
   - **Note**: Master bot CANNOT make direct code changes - must use prbot tool

3. **Slack Integration**
   - **Update messages**: `bun ../bot/slack/msg-update.ts --channel ${event.channel} --ts ${quickRespondMsg.ts} --text "<response>"`
   - **Read threads**: `bun ../bot/slack/msg-read-thread.ts --channel ${event.channel} --ts [ts]`
   - Update responses frequently to provide live progress updates

4. **Notion Documentation Search**
   - Search Notion docs from Comfy-Org team: `./bot/notion/search.ts`
   - Access internal documentation and knowledge base

5. **Code Modification via PR-Bot (REQUIRED for GitHub changes)**
   - To make any code changes to GitHub repositories, use: `bun ../bot/code/prbot.ts --repo=<owner/repo> [--base=<base-branch>] [--head=<head-branch>] --prompt="<detailed coding task>"`
   - If `--head` is not provided, the branch name will be auto-generated based on the prompt
   - Master bot is a RESEARCH and COORDINATION agent only
   - All actual coding work must be delegated to prbot sub-agents
   - Master bot CANNOT create commits, branches, or PRs directly

### Context Repositories

The bot has knowledge of these Comfy-Org repositories:

- **comfyanonymous/ComfyUI**: Main ComfyUI repository (Python ML backend)
- **Comfy-Org/ComfyUI_frontend**: Frontend codebase (Vue + TypeScript)
- **Comfy-Org/docs**: Documentation, setup guides, tutorials, API references
- **Comfy-Org/desktop**: Desktop application
- **Comfy-Org/registry**: registry.comfy.org for custom-nodes and extensions
- **Comfy-Org/workflow_templates**: Official shared workflow templates

### Usage

The bot is automatically spawned when:

1. A user mentions the bot in a Slack channel
2. The message is in an authorized channel (`#comfyprbot` or `#prbot`)
3. The bot determines that agent assistance is needed

See `.bot/AGENT.md` (and symlinked `.bot/README.md`) for complete prbot CLI documentation used by sub-agents.

## Coding Sub-Agent

### Overview

The coding sub-agent system (`bot/code/coding/`) allows you to spawn AI coding agents that work on specific GitHub repositories. The agent automatically clones repositories, manages branches for PRs, and runs in an interactive coding session.

### Implementation

- **Main Script**: `bot/code/prbot.ts`
- **Core Logic**: `bot/code/coding/pr-agent.ts`
- **Tests**: `bot/code/coding/pr-agent.spec.ts`
- **Repository Storage**: `/repos/[owner]/[repo]/tree/[head]/`

### Usage

```bash
bun bot/code/prbot.ts --repo=<owner/repo> [--base=<base-branch>] [--head=<head-branch>] --prompt="<your prompt>"
```

**Arguments:**

- `--repo` (required): GitHub repository in format `owner/repo`
- `--base` (optional): Base branch to merge into (defaults to `main`)
- `--head` (optional): Head branch to develop on (auto-generated if not provided)
- `--prompt` (required): The coding task for the agent

**Examples:**

```bash
# Auto-generate head branch name from prompt
bun bot/code/prbot.ts --repo=Comfy-Org/ComfyUI --prompt="Fix authentication bug in login module"

# Specify both base and head branches explicitly
bun bot/code/prbot.ts --repo=Comfy-Org/ComfyUI --base=main --head=fix/auth-bug --prompt="Fix authentication bug"

# Work on a feature branch to merge into develop
bun bot/code/prbot.ts --repo=Comfy-Org/ComfyUI_frontend --base=develop --head=feature/dark-mode --prompt="Add dark mode support"
```

### How It Works

1. **Branch Name Generation**: If `--head` is not provided, uses AI (GPT-4o-mini) to generate an appropriate branch name following conventions (e.g., `feature/add-dark-mode`, `fix/auth-bug`)
2. **Auto-Clone**: Clones the repository to `/repos/[owner]/[repo]/tree/[head]/` if not already present
3. **Branch Setup**:
   - Verifies base branch exists
   - Checks if head branch exists remotely; creates it from base if not
   - Ensures proper branch isolation for feature development
4. **Update**: If repository exists, pulls latest changes
5. **Spawn Agent**: Launches `claude-yes` agent with enhanced prompt including branch context
6. **Interactive Session**: Agent has full access to read, edit, and create files, with clear instructions to create a PR merging `head` → `base`

### Key Features

1. **Automatic Repository Management**: No manual cloning needed
2. **Branch Isolation**: Each branch is stored separately in its own directory
3. **Reusable Sessions**: Existing clones are reused and updated
4. **Clean Separation**: Cloned repos stored in `/repos/` (absolute system path)

### Development Flow

1. Install dependencies: Already included in main `package.json`
2. Created implementation with CLI arg parsing using `minimist`
3. Implemented auto-clone logic with Bun shell `$` wrapper
4. Added comprehensive test suite with Bun test
5. Documentation in `bot/github/coding/README.md`

## Prbot CLI - Unified Command Interface

### Overview

The prbot CLI (`bot/cli.ts`) is a unified command-line interface built with yargs that provides access to all bot capabilities including GitHub PR creation, code search, issue search, registry search, Slack integration, and Notion search.

### Installation & Usage

Available via package.json bin entries:

- `prbot <command>` (primary)
- `pr-bot <command>` (alias)
- `bun bot/cli.ts <command>` (direct execution)

### Complete Command Reference

#### 1. GitHub PR Commands

Create a PR with an AI coding agent:

```bash
# Primary commands (all equivalent)
prbot code pr -r <owner/repo> [-b <base>] [--head <head>] -p "<task>"
prbot github pr -r <owner/repo> [-b <base>] [--head <head>] -p "<task>"
prbot pr -r <owner/repo> [-b <base>] [--head <head>] -p "<task>"
prbot prbot -r <owner/repo> [-b <base>] [--head <head>] -p "<task>"

# Examples
prbot pr -r Comfy-Org/ComfyUI -p "Fix authentication timeout"
prbot pr -r Comfy-Org/ComfyUI --head fix/auth-timeout -p "Fix auth"
prbot pr -r Comfy-Org/ComfyUI_frontend -b develop -p "Add dark mode"
```

**Options:**

- `-r, --repo` (required): Repository in format `owner/repo`
- `-b, --base`: Base branch (default: `main`)
- `--head`: Head branch (auto-generated if not provided using GPT-4o-mini)
- `-p, --prompt` (required): Task description

#### 2. Code Search

Search ComfyUI codebases using comfy-codesearch:

```bash
prbot code search -q "<query>" [--repo <owner/repo>] [--path <pattern>]

# Examples
prbot code search -q "binarization"
prbot code search -q "auth" --repo Comfy-Org/ComfyUI
prbot code search -q "useAuth" --path "src/hooks/**"
```

**Options:**

- `-q, --query` (required): Search query (supports `repo:` and `path:` filters)
- `--repo`: Filter by repository
- `--path`: Filter by file path pattern

#### 3. GitHub Issue Search

Search issues/PRs across Comfy-Org repositories:

```bash
prbot github-issue search -q "<query>" [-l <limit>]

# Examples
prbot github-issue search -q "authentication bug" -l 5
prbot github-issue search -q "dark mode feature" -l 10
```

**Options:**

- `-q, --query` (required): Search query
- `-l, --limit`: Max results (default: 10)

**Output:** Issue number, title, repository, state, type, author, labels, URL, updated timestamp

#### 4. Registry Search

Search ComfyUI custom nodes registry:

```bash
prbot registry search -q "<query>" [-l <limit>] [--include-deprecated]

# Examples
prbot registry search -q "video" -l 5
prbot registry search -q "animation" --include-deprecated
```

**Options:**

- `-q, --query` (required): Search query
- `-l, --limit`: Max results (default: 10)
- `--include-deprecated`: Include deprecated nodes

**Output:** Node name, ID, description, publisher, version, repository, downloads, stars, tags

#### 5. Slack Commands

**Smart Read (Recommended - NEW!):**

```bash
# Auto-detect URL type (message/file/channel) and read appropriately
prbot slack read "<slack_url>"

# Examples
prbot slack read "https://workspace.slack.com/archives/C123/p1234567890"  # nearby messages
prbot slack read "https://workspace.slack.com/archives/C123"             # recent 10 messages
prbot slack read "https://files.slack.com/files-pri/T123-F456/file.pdf"  # download file
```

**Output:** YAML format with structured data.

**Update Message:**

```bash
prbot slack update -c <channel_id> -t <timestamp> -m "<text>"

# Example
prbot slack update -c C123ABC -t 1234567890.123456 -m "Task completed!"
```

**Read Thread (two methods):**

```bash
# Method 1: Channel + Timestamp
prbot slack read-thread -c <channel_id> -t <thread_ts> [-l <limit>]

# Method 2: Slack URL
prbot slack read-thread -u "<slack_url>" [-l <limit>]

# Examples
prbot slack read-thread -c C123ABC -t 1234567890.123456 -l 50
prbot slack read-thread -u "https://workspace.slack.com/archives/C123/p1234567890"
```

**Read Nearby Messages:**

```bash
# Method 1: Channel + Timestamp
prbot slack read-nearby -c <channel_id> -t <ts> [-b <before>] [-a <after>]

# Method 2: Slack URL
prbot slack read-nearby -u "<slack_url>" [-b <before>] [-a <after>]

# Examples
prbot slack read-nearby -c C123ABC -t 1234567890.123456 -b 20 -a 20
prbot slack read-nearby -u "https://workspace.slack.com/archives/C123/p1234567890"
```

**File Operations:**

```bash
# Upload file
prbot slack upload-file -c <channel> -f <file> [--title] [-m <comment>] [-t <thread>]

# Post message with files
prbot slack post-with-files -c <channel> -m "<text>" -f <file1> [-f <file2>...] [-t <thread>]

# Download file
prbot slack download-file -f <fileId> -o <output>

# Get file info
prbot slack file-info -f <fileId>

# Examples
prbot slack upload-file -c C123ABC -f ./report.pdf -m "Weekly report"
prbot slack post-with-files -c C123ABC -m "Review these" -f design1.png -f design2.png
prbot slack download-file -f F123ABC -o ./downloaded.pdf
prbot slack file-info -f F123ABC
```

**Research & Context Commands:**

```bash
# Get reactions for a message
prbot slack reactions "<message_url>"

# Search messages workspace-wide
prbot slack search -q "authentication bug" -l 10
prbot slack search -q "report.pdf" --type files

# List pinned messages
prbot slack pins "<channel_url>"

# List channel bookmarks
prbot slack bookmarks "<channel_url>"

# Get permalink
prbot slack permalink "<message_url>"

# Get channel info
prbot slack channel-info "<channel_url>"

# List channel members
prbot slack members "<channel_url>" -l 50

# Check user presence
prbot slack presence U123ABC
prbot slack presence U123 U456 U789

# Get complete message context (composite)
prbot slack context "<message_url>"
```

#### 6. Notion Search

Search Notion pages in Comfy-Org workspace:

```bash
prbot notion search -q "<query>" [-l <limit>]

# Examples
prbot notion search -q "ComfyUI setup" -l 5
prbot notion search -q "sprint planning"
```

**Options:**

- `-q, --query` (required): Search query
- `-l, --limit`: Max results (default: 10)

**Output:** Page title, Notion URL, last edited timestamp

### Environment Configuration

The CLI auto-loads `.env.local` from project root. Required variables:

```bash
# GitHub
GITHUB_TOKEN=ghp_...

# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_SOCKET_TOKEN=xapp-...

# Notion
NOTION_TOKEN=secret_...

# OpenAI (for branch name generation)
OPENAI_API_KEY=sk-...
```

### Implementation Details

- **File**: `bot/cli.ts` (yargs-based CLI)
- **Auto-load env**: `loadEnvLocal()` function loads `.env.local` from project root
- **Branch naming**: Uses GPT-4o-mini to generate conventional branch names (`feature/`, `fix/`, etc.)
- **Smart Slack URL parsing**: `parseSlackUrlSmart()` auto-detects message/file/channel URLs
- **YAML output**: All Slack commands output YAML format for better human/AI readability
- **Validation**: Yargs validation ensures required params and mutual exclusivity
- **Slack API modules**:
  - `lib/slack/reactions.ts` - Get message reactions
  - `lib/slack/search.ts` - Search messages and files
  - `lib/slack/pins.ts` - List pinned messages
  - `lib/slack/bookmarks.ts` - List channel bookmarks
  - `lib/slack/permalink.ts` - Get message permalinks
  - `lib/slack/channel-info.ts` - Get channel metadata
  - `lib/slack/members.ts` - List channel members
  - `lib/slack/presence.ts` - Check user presence
  - `lib/slack/context.ts` - Get complete message context (composite)

### Sub-Agent Documentation

Sub-agents (PR bots) spawned by prbot have access to comprehensive documentation in:

- `.bot/AGENT.md` - Complete command reference and usage guide
- `.bot/README.md` - Symlink to AGENT.md

These files are in the `.bot/` workspace directory accessible to spawned agents.

### Usage Patterns

**Research then PR:**

```bash
prbot github-issue search -q "auth timeout" -l 5
prbot code search -q "authentication timeout" --repo Comfy-Org/ComfyUI
prbot notion search -q "authentication" -l 3
prbot pr -r Comfy-Org/ComfyUI -p "Fix auth timeout by increasing session TTL"
```

**Slack Thread Investigation:**

```bash
# Quick context check with smart read
prbot slack read "<slack_url>"

# Deep research on a message
prbot slack context "<message_url>"  # Get everything: reactions, thread, channel, user, pins
prbot slack reactions "<message_url>"  # Check engagement
prbot slack search -q "related topic" -c C123  # Find related discussions

# Update with findings
prbot slack update -c C123 -t 1234567890.123456 -m "Investigated root cause..."
```

**Channel Research:**

```bash
# Understand a channel
prbot slack channel-info "<channel_url>"  # Get topic, purpose, member count
prbot slack pins "<channel_url>"  # Find important messages
prbot slack bookmarks "<channel_url>"  # Find key resources
prbot slack members "<channel_url>"  # See who's in the channel
```

**Registry Research:**

```bash
prbot registry search -q "video processing" -l 10
prbot code search -q "VideoProcessNode" --repo Comfy-Org/ComfyUI
prbot pr -r Comfy-Org/ComfyUI -p "Integrate VideoProcessNode"
```

## SFlow Stream Processing Library

### Overview

SFlow is a powerful functional stream processing library used throughout the codebase for handling asynchronous data operations. It provides a rich set of utilities for transforming streams with a functional programming approach, similar to RxJS but optimized for modern JavaScript/TypeScript and WebStreams.

### Implementation Details

- **Package**: `sflow@1.24.0`
- **Author**: snomiao
- **License**: MIT
- **Core Concepts**: SFlow is built around composable stream operators, lazy evaluation, and support for both synchronous and asynchronous data flows.

## Project TODOs

### How to Find TODOs

To search for all TODO comments across the project:

```bash
# Search for TODO comments using prbot
prbot code search -q "TODO"

# Or use grep locally
grep -ri "TODO" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.go" .
```

### Priority TODOs (This Project)

**Bot Implementation (`bot/index.ts`)**

- Line 145: Define `zSlackMessage` schema
- Line 527: Create a Linux user for task isolation
- Line 660: Spawn tasks in a worker user for security
- Line 755: Implement periodic screen + TODO.md + REPORT.md checking (every 10s) with Slack updates

**Registry Search (`bot/registry/search.ts`)** ✅ COMPLETED

- ~~Line 1: Call api.comfy.org to search custom nodes~~ - Implemented in `searchRegistryNodes()` function

**GitHub Action Updates**

- `src/GithubActionUpdateTask/updateGithubActionPrepareBranch.ts:96`: GPT review implementation
- `src/createGithubPullRequest.ts:80`: Implement lock mechanism with repo+branch
- `src/createGithubPullRequest.ts:103`: Fix head_repo bugs

**Performance Optimizations**

- `src/CNRepos.ts:28,39`: Refactor into interface to improve performance
- `src/analyzeTotals.ts:19`: Split heavy function into smaller chunks
- `src/updateFollowRuleSet.ts:67`: Enhance performance
- `packages/mongodb-pipeline-ts/$flatten.ts:31`: Optimize implementation

**Tasks**

- `app/tasks/gh-priority-sync/index.ts:452`: Fix sorting by updatedAt when combining results
- `app/tasks/gh-design/gh-design.ts:59`: Find way to record approved state
- `app/tasks/coreping/coreping.ts:360`: Update message with delete line when reviewed
- `app/tasks/github-contributor-analyze/GithubContributorAnalyzeTask.ts:21`: Rename GithubContributorAnalzyeTask => GithubContributorAnalyzeTask (typo fix)

**Type Safety**

- `packages/mongodb-pipeline-ts/$pipeline.ts:163,166`: Fix replaceRoot/replaceWith types

**Deprecations**

- `src/CNRepos.ts:65,72`: Remove deprecated methods
- `src/CRPulls.ts:5`: Utilize CRPulls collection (@sno)
- `src/updateAuthorsFromCNRepo.ts:18`: Get totals open/closed/merged

**Configuration**

- `docker-compose.yml:47`: Use .override.yml to enable testing dmongodb
- `app/api/auth/[...nextauth]/getAuthUser.tsx:10`: Move auth config to .env file

### External Project TODOs (Reference Only)

**comfy-api** (codes/Comfy-Org/comfy-api/)

- Multiple proxy endpoints need user filtering implementation (7 occurrences)
- Service account setup for dev environment
- Machine image creation logic conflicts between dreamboothy-dev and dreamboothy
- Kling video retention policy implementation
- GIN index on preempted_comfy_node_names for performance
- Metric export to NewRelic instead of GCP (2 occurrences)
- Billing verification tests for Moonvalley, Kling, Tripo
- OpenAPI schema validation fixes (multiple required fields)

### TODO Resolution Workflow

When working on TODOs:

1. **Search**: Use `prbot code search -q "TODO"` or `grep -ri "TODO"`
2. **Prioritize**: Focus on TODOs in active development areas first
3. **Context**: Read surrounding code to understand the TODO context
4. **Implement**: Create a branch and implement the solution
5. **Test**: Add tests for the new implementation
6. **Remove**: Delete the TODO comment once resolved
7. **Document**: Update CLAUDE.md if the change affects development patterns

### Creating TODOs

When adding new TODOs, use this format:

```typescript
// TODO: <description of what needs to be done>
// TODO(@username): <description> - for specific person assignments
// TODO(priority): <description> - for urgent items
```

### Auto-Solving TODOs with prbot

You can use prbot to automatically work on TODOs:

```bash
# Search for specific TODO
prbot code search -q "TODO performance"

# Create a PR to fix a TODO
prbot code pr -r Comfy-Org/Comfy-PR -p "Fix TODO in bot/index.ts line 145: Define zSlackMessage schema"
```

### Process Cleaning

use `bunx kill-port [port]`
