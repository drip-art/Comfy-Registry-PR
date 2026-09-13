#!/usr/bin/env bun --hot
import { db } from "@/src/db";
import { parseGithubRepoUrl } from "@/src/parseOwnerRepo";
import DIE from "@snomiao/die";
import isCI from "is-ci";
import sflow from "sflow";
import { upsertSlackMarkdownMessage } from "../gh-desktop-release-notification/upsertSlackMessage";
import urlRegexSafe from "url-regex-safe";
import { ghc } from "@/lib/github/githubCached";
import { logger } from "@/src/logger";
import prettier from "prettier";
import { ghPageFlow } from "@/src/ghPageFlow";
import { match as tsmatch } from "ts-pattern";
import { getChannelInfo } from "@/lib/slack/channel-info";
import { getSlackChannel } from "@/lib/slack/channels";
import {
  findSlackIdByGithubUsername as findSlackIdFromNotion,
  findGithubUsernameByPersonName,
} from "@/lib/notion/people";
import { slackCached } from "@/lib";
import { getReleaseComparison } from "./releaseComparison";

/**
 * GitHub Frontend Backport Checker Task
 *
 * Automatically monitors ComfyUI_frontend releases for bugfix commits that may
 * need backporting to stable branches (core/1.**, cloud/1.**), then posts a
 * per-release status report to Slack (#frontend-releases).
 *
 * ── How it works ──────────────────────────────────────────────────────────────
 *
 * 1. DISCOVER BACKPORT TARGET BRANCHES
 *    Lists all repo branches matching `core/1.**` or `cloud/1.**` via the
 *    GitHub API. These are the branches that bugfixes may need cherry-picking to.
 *
 * 2. FETCH RECENT RELEASES
 *    Fetches up to `maxReleasesToCheck` (10) releases from ComfyUI_frontend.
 *    Filters them by:
 *      - `processSince` date (skip very old releases)
 *      - `target_commitish === mainBranch` (skip releases NOT made from the
 *        main branch — e.g. patch releases from RC branches like `core/1.42`
 *        already have their commits on that branch, nothing to backport)
 *      - `maxMinorVersionsBehind` (4) — only show releases whose minor version
 *        is at most 4 behind the latest (e.g. if latest is v1.40, v1.36 is
 *        included but v1.35 is not)
 *
 * 3. EXTRACT COMPARE LINK FROM RELEASE BODY
 *    Each release body contains a GitHub compare URL (e.g.
 *    `.../compare/v1.38.0...v1.38.1`). This is used to get the list of commits
 *    included in that release.
 *
 * 4. IDENTIFY BUGFIX COMMITS
 *    From the compare diff, filters commits whose first line matches bugfix
 *    keywords: fix, bugfix, hotfix, patch, bug (case-insensitive).
 *    Excludes commits already tagged as `[backport ...]` (already cherry-picked).
 *
 * 5. RESOLVE ASSOCIATED PR FOR EACH BUGFIX COMMIT
 *    Uses `listPullRequestsAssociatedWithCommit` to find the PR that introduced
 *    each bugfix commit.
 *
 * 6. DETERMINE BACKPORT STATUS FOR EACH PR
 *    For each bugfix PR, checks:
 *
 *    a) PR LABELS — filters labels matching `reBackportTargets` regex
 *       (e.g. `core/1.4`, `cloud/1.36`). If any such labels exist, derives
 *       `backportStatusRaw` from them: checks for "completed"/"in-progress"/
 *       "needs" substrings, but in practice these branch-style labels always
 *       fall through to the default → "needed".
 *
 *    b) PR BODY & COMMENTS — scans for mentions of "backport" or "stable"
 *       (excluding bot comments). If found, marks as "needed".
 *
 *    c) PER-TARGET-BRANCH STATUS — only runs when `backportStatusRaw` is
 *       "needed". For each labeled target branch:
 *       - Checks for `no-backport-needed[-core|-cloud]` labels
 *         → marks that target as "not-needed"
 *       - Uses `compareCommits(target_branch, commit_sha)` to check if the
 *         commit already exists on that branch:
 *           • "identical"/"behind" → "completed" (commit is already there)
 *           • "ahead"             → "needed" (commit is missing)
 *           • "diverged"          → searches for a backport PR with the
 *             naming convention `backport-{prNumber}-to-{branch}`:
 *               - If a merged backport PR exists → "completed"
 *               - If an open backport PR exists  → "in-progress"
 *               - Otherwise                      → "needed"
 *
 *    d) DUAL-HOMED DETECTION — only runs when `backportStatusRaw` is "unknown"
 *       (no target-branch label and no backport/stable mention — the case that
 *       otherwise gets flagged as "❗ Might need backport" purely for lack of
 *       signal). Checks `compareCommits(branch, commit_sha)` against every
 *       currently existing `core/1.**`/`cloud/1.**` branch
 *       (`availableBackportTargetBranches`, discovered in step 1); if the
 *       commit is already "identical"/"behind" on any of them, treats it as
 *       "completed" there instead of leaving it unflagged-but-ambiguous. This
 *       is what a minor-version branch cut produces on purpose — see
 *       "Dual-homed commits" in ComfyUI_frontend's
 *       docs/release-process.md#dual-homed-commits — so it's a same-SHA
 *       ancestry check, not a release-type guess: a real unbackported commit
 *       can never satisfy it, since a cherry-pick backport always gets a new
 *       SHA.
 *
 *    e) OVERALL STATUS — derived from per-target statuses (ignoring not-needed):
 *       - All completed  → "completed"
 *       - Any in-progress → "in-progress"
 *       - Any needed      → "needed"
 *       - All not-needed  → "not-needed"
 *       - Otherwise       → "unknown"
 *
 * 7. GENERATE REPORT & POST TO SLACK
 *    Builds a markdown report per release showing each bugfix and its backport
 *    status across targets. For PRs needing backport, resolves the PR author's
 *    Slack user ID (by matching GitHub username → Slack display name) and tags
 *    them. Falls back to tagging the "Release Sheriff" (parsed from the
 *    #frontend-releases channel topic/purpose).
 *
 *    The report is upserted (created or updated) as a Slack message via
 *    `upsertSlackMarkdownMessage`, so re-runs update existing messages rather
 *    than creating duplicates.
 *
 * 8. PERSISTENCE
 *    All state is stored in MongoDB collection `GithubFrontendBackportCheckerTask`,
 *    keyed by `releaseUrl`. This allows incremental re-checks and preserves
 *    Slack message references for updates.
 *
 * ── Edge Cases & Special Handling ──────────────────────────────────────────────
 *
 * • UNPARSEABLE VERSION TAGS — if `parseMinorVersion` returns null (e.g. tag
 *   "nightly" or "latest"), the release is included rather than excluded, so
 *   non-semver releases are never silently skipped.
 *
 * • MISSING COMPARE LINK — candidate releases without a `.../compare/...` URL
 *   are silently skipped before persistence and processing. Prerelease status
 *   does not affect eligibility, so a prerelease with a valid comparison link
 *   continues through the existing backport workflow.
 *
 * • COMPARE API FAILURE — if `compareCommits` fails for a release (e.g. tags
 *   deleted, repo renamed), the release is saved with `taskStatus: "failed"`
 *   and processing continues to the next release.
 *
 * • ALREADY-BACKPORTED COMMITS — commits whose first line matches
 *   `[backport ...]` (case-insensitive) are filtered out, preventing double-
 *   counting of cherry-pick commits that landed in the same release.
 *
 * • DUAL-HOMED COMMITS — a minor-version bump (x.y.0) freezes the previous
 *   minor by branching `core/<prevMinor>` + `cloud/<prevMinor>` from the
 *   commit right before the bump, so every unreleased commit on `main` at
 *   that point ships in the new release AND already sits, byte-for-byte, on
 *   those freshly-cut branches (see ComfyUI_frontend's
 *   docs/release-process.md#dual-homed-commits). A bugfix PR with no
 *   backport label or mention is checked against every existing
 *   `core/1.**`/`cloud/1.**` branch before being flagged; if its commit SHA
 *   is already an ancestor of one, it's marked "completed" there instead of
 *   "❗ Might need backport". This is intentionally NOT a release-type check
 *   (e.g. "skip all x.y.0 releases") — a minor release can still ship a
 *   genuinely unbackported fix alongside dual-homed ones, and this same
 *   ancestry check also protects patch releases if a commit ever ends up
 *   dual-homed by some other means.
 *
 * • NO ASSOCIATED PR — if `listPullRequestsAssociatedWithCommit` returns
 *   an empty array, the commit produces no bugfix entries (the `.map().flat()`
 *   over PRs yields nothing). Direct pushes without a PR are silently skipped.
 *
 * • BOT COMMENTS — when scanning PR comments for backport mentions, comments
 *   from bots (username ending in `bot` or `[bot]`) are excluded to avoid
 *   false positives from automated messages.
 *
 * • BACKPORT-NOT-NEEDED LABELS — `no-backport-needed` dismisses all targets;
 *   per-target labels `no-backport-needed-core` / `no-backport-needed-cloud`
 *   override individual branch status to "not-needed", even if the commit
 *   hasn't been cherry-picked. When ALL targets are dismissed, the overall
 *   status becomes "not-needed".
 *
 * • DIVERGED BRANCH (backport PR detection) — when the target branch has
 *   diverged from the commit (common for long-lived stable branches), the
 *   checker searches for a PR with branch name `backport-{prNumber}-to-{branch}`
 *   and additionally filters by `head.ref` to avoid false matches from
 *   similarly-named branches. Checks all states (open, closed, merged).
 *
 * • SLACK USER RESOLUTION — attempts to match GitHub username to a Slack user
 *   by comparing against `name`, `display_name`, and `real_name` (with spaces
 *   stripped, case-insensitive). If no match is found, falls back to tagging
 *   the Release Sheriff (parsed from #frontend-releases channel topic/purpose
 *   via regex `Release Sheriff:? <@UXXXXXX>`). If neither resolves, no one is
 *   tagged.
 *
 * • DRY RUN MODE — when `--dry-run` is passed, Slack tags show raw GitHub
 *   usernames (e.g. `@octocat`) instead of making Slack API calls, and no
 *   Slack messages are sent/updated.
 *
 * • IDEMPOTENT SLACK UPDATES — the report is only sent/updated when the
 *   formatted text differs from the previously stored `slackMessage.text`.
 *   Re-runs with no status changes produce no Slack API calls.
 *
 * • NO BUGFIX COMMITS — if a release has zero bugfix commits after filtering,
 *   the task is saved as `taskStatus: "completed"` with an empty array and no
 *   Slack message is sent.
 *
 * • CI MODE — when running in CI (`is-ci` package), the database connection
 *   is closed and the process exits after one run instead of staying alive
 *   for hot-reload.
 *
 * ── Running ───────────────────────────────────────────────────────────────────
 *
 *   bun app/tasks/gh-frontend-backport-checker/index.ts              # normal
 *   bun app/tasks/gh-frontend-backport-checker/index.ts --dry-run    # no Slack
 *
 */

const config = {
  // 1. monitor releases from this repo
  repo: "https://github.com/Comfy-Org/ComfyUI_frontend",
  maxReleasesToCheck: 10, // fetch more releases, then filter by version distance
  maxMinorVersionsBehind: 4, // stop showing backport warnings after this many minor versions behind latest
  processSince: new Date("2026-01-06T00:00:00Z").toISOString(), // only process releases since this date, to avoid posting too msgs in old releases
  mainBranch: "main", // only process releases made from this branch (skips RC branch releases like core/1.42)

  // 2. identify bugfix commits
  reBugfixPatterns: /\b(fix|bugfix|hotfix|patch|bug)\b/i,

  // 4. backport target branches
  reBackportTargets: /^(core|cloud)\/1\..*$/,

  // 3. backport labels on PRs
  backportLabels: ["needs-backport"],

  // labels that dismiss backport requirements per target (or all targets)
  backportNotNeededLabel: "no-backport-needed",
  backportNotNeededLabels: {
    core: "no-backport-needed-core",
    cloud: "no-backport-needed-cloud",
  } as Record<string, string>,

  // 5. detect backport mentions
  reBackportMentionPatterns: /\b(backports?|stable)\b/i,

  // 6. report to slack channel
  slackChannelName: "frontend-releases",

  // 7. bot-authored PR attribution
  // Regex used to detect automation-account PR authors (GitHub Apps end in
  // "[bot]"; plain bot accounts like our own "comfy-pr-bot" end in "bot").
  reBotLogin: /\bbot$|\[bot\]$/i,
  // Matches this workspace's PR-description attribution convention, e.g.
  //   _Requested by **nav** · [Slack thread](...)_
  //   _Requested by **Christian Byrne** · [Slack thread](...)_
  // used by claude[bot]-authored PRs opened on someone's behalf via Slack.
  reAttributionLine: /_Requested by \*\*(.+?)\*\*/,
};

/**
 * Glob-style path patterns for changed files that never warrant a backport
 * check (repo/CI tooling, the marketing site, etc.) — edit freely as the
 * repo layout changes.
 *
 * A PR is skipped ONLY when every one of its changed files matches one of
 * these patterns. If it touches anything else too, it is still flagged as
 * usual, so it's safe to be generous here.
 */
export const IGNORED_BACKPORT_PATH_GLOBS: string[] = [
  // apps/website is the comfy.org marketing site (Astro) — not part of the
  // ComfyUI_frontend app that actually ships/gets backported.
  "apps/website/**",
  // CI/CD workflow + automation definitions.
  ".github/**",
  ".husky/**",
  // Repo-level CI/lint/formatter tooling config (not app code).
  ".coderabbit.yaml",
  ".oxlintrc.json",
  ".oxfmtrc.json",
  ".stylelintrc.json",
  ".pinact.yaml",
  ".yamllint",
  ".fallowrc.jsonc",
  "codecov.yml",
];

/** Convert a simple glob (`**` = any depth, `*` = one path segment) to a RegExp. */
function globToRegExp(glob: string): RegExp {
  const pattern = glob
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((segment) => segment.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${pattern}$`);
}

/** True if `filePath` matches any of `globs` (defaults to {@link IGNORED_BACKPORT_PATH_GLOBS}). */
export function isIgnoredBackportPath(
  filePath: string,
  globs: string[] = IGNORED_BACKPORT_PATH_GLOBS,
): boolean {
  return globs.some((glob) => globToRegExp(glob).test(filePath));
}

/**
 * True only when `filePaths` is non-empty and every file matches an ignored
 * path pattern. An empty list (e.g. file info unavailable) never counts as
 * "all ignored" — we don't want a fetch failure to silently suppress a flag.
 */
export function allChangedFilesIgnored(
  filePaths: string[],
  globs: string[] = IGNORED_BACKPORT_PATH_GLOBS,
): boolean {
  return filePaths.length > 0 && filePaths.every((f) => isIgnoredBackportPath(f, globs));
}

/** True if a GitHub login looks like a bot/automation account (e.g. `claude[bot]`, `comfy-pr-bot`). */
export function isBotLogin(login: string | undefined | null): boolean {
  return !!login && config.reBotLogin.test(login);
}

export type BackportStatus = "not-needed" | "needed" | "in-progress" | "completed" | "unknown";

// track each bugfix PR backport status
export type GithubFrontendBackportCheckerTask = {
  releaseUrl: string; // this is uniq id
  releaseTag: string;
  releaseCreatedAt: Date;
  compareLink?: string;

  // bugfix commits info, the PR needs to be backported
  bugfixCommits?: Array<{
    commitSha: string;
    commitMessage: string;
    prUrl?: string; //
    prNumber?: number;
    prTitle?: string;
    prLabels?: string[];
    prAuthor?: string; // GitHub username of PR author

    backportStatus: BackportStatus; // overall status, derived from backportTargetStatus, calculated by backport targets (core/1.**, cloud/1.**)
    backportStatusRaw: BackportStatus; // raw status from bugfix PR analysis, before checking backport targets status
    backportLabels: string[];
    backportMentioned: boolean;
    backportTargetStatus: Array<{
      status: BackportStatus;
      branch: string;
      prs: {
        prUrl?: string; // if backport PR exists
        prNumber?: number;
        prTitle?: string;
        prStatus?: "open" | "closed" | "merged";
        lastCheckedAt?: Date;
      }[];
    }>;
  }>;

  taskStatus?: "checking" | "completed" | "failed";
  checkedAt: Date; // when was this checked

  report?: string; // generated report markdown

  // slack message info, updated when message is sent/updated
  slackMessage?: {
    text: string;
    channel: string;
    url?: string;
  };
};

export const GithubFrontendBackportCheckerTask = db.collection<GithubFrontendBackportCheckerTask>(
  "GithubFrontendBackportCheckerTask",
);
const save = async (task: { releaseUrl: string } & Partial<GithubFrontendBackportCheckerTask>) =>
  (await GithubFrontendBackportCheckerTask.findOneAndUpdate(
    { releaseUrl: task.releaseUrl },
    { $set: task },
    { upsert: true, returnDocument: "after" },
  )) || DIE("never");

const isDryRun = process.argv.includes("--dry-run");

if (import.meta.main) {
  if (isDryRun) logger.info("🏃 DRY RUN MODE - will not send Slack messages");
  await runGithubFrontendBackportCheckerTask();
  if (isCI || isDryRun) {
    await db.close();
    process.exit(0);
  }
}

export default async function runGithubFrontendBackportCheckerTask() {
  await GithubFrontendBackportCheckerTask.createIndex({ releaseUrl: 1 }, { unique: true });
  await GithubFrontendBackportCheckerTask.createIndex({ releaseTag: 1 });
  await GithubFrontendBackportCheckerTask.createIndex({ checkedAt: 1 });

  // scans backport targets (core/1.**, cloud/1.**)
  const availableBackportTargetBranches = await ghPageFlow(ghc.repos.listBranches)(
    parseGithubRepoUrl(config.repo),
  )
    .filter((branch) => branch.name.match(config.reBackportTargets))
    .map((branch) => branch.name)
    .toArray();
  logger.info(`Backport target branches: ${availableBackportTargetBranches.join(", ")}`);

  // throw 'check'

  // Fetch recent releases
  const releases = await ghPageFlow(ghc.repos.listReleases, { per_page: 10 })({
    ...parseGithubRepoUrl(config.repo),
  })
    .limit(config.maxReleasesToCheck)
    .toArray();

  logger.debug(`Found ${releases.length} recent releases to check`);

  // Find latest minor version for version-based filtering
  const latestMinor = releases
    .map((r) => parseMinorVersion(r.tag_name))
    .filter((v): v is number => v !== null)
    .reduce((a, b) => Math.max(a, b), 0);
  logger.info(
    `Latest minor version: ${latestMinor}, will show releases within ${config.maxMinorVersionsBehind} minor versions`,
  );

  // Process each release
  const processedReleases = await sflow(releases)
    .filter((release) => +new Date(release.created_at) >= +new Date(config.processSince))
    // Filter out releases not made from main branch (e.g. RC branch releases like core/1.42 don't need backport checks)
    .filter((release) => {
      if (release.target_commitish !== config.mainBranch) {
        logger.debug(
          "Skipping release %s (target: %s, not from main)",
          release.tag_name,
          release.target_commitish,
        );
        return false;
      }
      return true;
    })
    // Filter by version distance: show releases up to and including maxMinorVersionsBehind behind latest
    .filter((release) => {
      const minor = parseMinorVersion(release.tag_name);
      if (minor === null) return true; // can't parse, include it
      return latestMinor - minor <= config.maxMinorVersionsBehind;
    })
    .map(async function convertReleaseToTask(release) {
      const comparison = getReleaseComparison(
        {
          prerelease: release.prerelease,
          bodyUrls:
            release.body
              ?.matchAll(urlRegexSafe())
              .map((g) => g[0])
              .toArray() || [],
        },
        config.repo,
      );
      if (!comparison) return [];

      const { compareLink } = comparison;
      logger.debug(`  Found compare link: ${compareLink}`);

      let task = await save({
        releaseUrl: release.html_url,
        releaseTag: release.tag_name,
        releaseCreatedAt: new Date(release.created_at),

        taskStatus: "checking",
        checkedAt: new Date(),
      });
      logger.info(`\nProcessing release: ${task.releaseTag}`);

      // 1. find full changelog link in release body, e.g. https://github.com/Comfy-Org/ComfyUI_frontend/compare/v1.38.0...v1.38.1
      return [await save({ ...task, compareLink })];
    })
    .flat()
    .map((task) => processTask(task, availableBackportTargetBranches))
    .toArray();

  logger.info(
    `\nProcessed ${processedReleases.length} releases, checked ${
      processedReleases.flatMap((r) => r.bugfixCommits).length
    } bugfix commits.`,
  );
}

export function getBackportStatusEmoji(status: BackportStatus): string {
  switch (status) {
    case "completed":
      return ":pr-merged:";
    case "in-progress":
      return ":pr-open:";
    case "needed":
      return "**:exclamation: Need backport**";
    case "not-needed":
      return "➖";
    case "unknown":
      return "  ";
    default:
      return "⚪";
  }
}

export function middleTruncated(maxLength: number, str: string): string {
  if (str.length <= maxLength) return str;
  const half = Math.floor((maxLength - 3) / 2);
  return `${str.slice(0, half)}...${str.slice(-half)}`;
}

/** Parse semver minor version from a release tag like "v1.38.1" → 38 */
export function parseMinorVersion(tag: string): number | null {
  const match = tag.match(/v?\d+\.(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Get the current release sheriff's Slack user ID from the #frontend-releases channel description.
 * Expects format: "Current Release Sheriff: <@U12345678>" in channel purpose or topic.
 */
export async function getReleaseSheriffUserId(): Promise<string | null> {
  try {
    const channel = await getSlackChannel(config.slackChannelName);
    if (!channel?.id) return null;
    const info = await getChannelInfo(channel.id as string);
    // Slack stores mentions as <@U12345678> in description
    const text = `${info.purpose?.value || ""} ${info.topic?.value || ""}`;
    const match = text.match(/Release Sheriff:?\s*<@(\w+)>/i);
    return match?.[1] || null;
  } catch (e) {
    logger.warn("Failed to get release sheriff from channel description", { error: e });
    return null;
  }
}

/** Cached promise for all Slack workspace members — fetched once per run. */
let slackMembersCache: Promise<
  NonNullable<Awaited<ReturnType<typeof slackCached.users.list>>["members"]>
> | null = null;

async function getAllSlackMembers() {
  if (!slackMembersCache) {
    slackMembersCache = (async () => {
      const firstPage = await slackCached.users.list({ limit: 500 });
      const members = [...(firstPage.members || [])];
      let cursor = firstPage.response_metadata?.next_cursor || undefined;
      while (cursor) {
        const page = await slackCached.users.list({ limit: 500, cursor });
        members.push(...(page.members || []));
        cursor = page.response_metadata?.next_cursor || undefined;
      }
      return members;
    })();
  }
  return slackMembersCache;
}

/**
 * Try to find a Slack user ID for a GitHub username.
 * 1. First checks the Notion People database for an explicit mapping.
 * 2. Falls back to fuzzy matching against Slack display_name, name, and real_name.
 * Returns null if no match found.
 */
// Per-process guard: once Notion People lookup fails, skip it for the rest of
// the run so we don't spam the API + logs once per author.
let notionPeopleLookupDisabled = false;

export async function findSlackUserIdByGithubUsername(
  githubUsername: string,
): Promise<string | null> {
  if (!notionPeopleLookupDisabled) {
    try {
      // Primary: Notion People database (explicit GitHub→Slack mapping)
      const notionSlackId = await findSlackIdFromNotion(githubUsername);
      if (notionSlackId) return notionSlackId;
    } catch (e) {
      notionPeopleLookupDisabled = true;
      logger.warn(
        "Notion People lookup failed; disabling for the rest of this run and falling back to Slack fuzzy match",
        {
          githubUsername,
          error: (e as Error)?.message ?? String(e),
          stack: (e as Error)?.stack,
        },
      );
    }
  }

  try {
    // Fallback: fuzzy match against Slack workspace members
    const members = await getAllSlackMembers();
    const lowerGh = githubUsername.toLowerCase();
    const found = members.find((m) => {
      if (m.deleted || m.is_bot) return false;
      const profile = m.profile as Record<string, unknown> | undefined;
      return (
        m.name?.toLowerCase() === lowerGh ||
        (profile?.display_name as string)?.toLowerCase() === lowerGh ||
        ((profile?.real_name as string | undefined) || "")
          .toLowerCase()
          .replace(/\s+/g, "")
          .includes(lowerGh)
      );
    });
    return (found?.id as string) || null;
  } catch (e) {
    logger.warn("Failed to look up Slack user for GitHub username", {
      githubUsername,
      error: e,
    });
    return null;
  }
}

/** Extract a GitHub login from a GitHub-generated `users.noreply.github.com` email, if present. */
function extractGithubLoginFromNoreplyEmail(email: string): string | null {
  const match = email.match(/^(?:\d+\+)?([^@]+)@users\.noreply\.github\.com$/i);
  return match?.[1] || null;
}

/**
 * When a PR's author is a bot/automation account (e.g. `claude[bot]`), try to
 * find the real human who should be tagged instead:
 *
 *   1. `Co-authored-by:` trailers on the PR's commits — if the trailer's
 *      noreply email embeds a GitHub login (GitHub's standard co-author
 *      format), use it directly; otherwise try matching the trailer's name
 *      against the Notion People database.
 *   2. Fall back to this workspace's PR-description attribution convention,
 *      e.g. `_Requested by **Christian Byrne**_` (see `config.reAttributionLine`),
 *      matching the captured name against the Notion People database.
 *
 * Returns a GitHub username to feed into the normal slack-tag resolution
 * pipeline, or null if neither signal resolves — callers should fall back to
 * whatever they'd otherwise do for an unresolved author (e.g. release sheriff).
 */
async function resolveBotAuthorGithubUsername(params: {
  owner: string;
  repo: string;
  prNumber: number;
  body: string | null | undefined;
}): Promise<string | null> {
  const { owner, repo, prNumber, body } = params;

  // 1. Co-authored-by trailers on the PR's commits
  try {
    const commits = await ghc.pulls
      .listCommits({ owner, repo, pull_number: prNumber })
      .then((e) => e.data);
    for (const c of commits) {
      const message = c.commit?.message || "";
      for (const m of message.matchAll(/^Co-authored-by:\s*(.+?)\s*<([^>]+)>/gim)) {
        const [, name, email] = m;
        const loginFromEmail = extractGithubLoginFromNoreplyEmail(email);
        if (loginFromEmail) return loginFromEmail;
        const byName = await findGithubUsernameByPersonName(name);
        if (byName) return byName;
      }
    }
  } catch (e) {
    logger.warn("Failed to inspect PR commits for Co-authored-by trailers", {
      owner,
      repo,
      prNumber,
      error: e,
    });
  }

  // 2. PR description attribution line, e.g. "_Requested by **Christian Byrne**_"
  const attributionMatch = (body || "").match(config.reAttributionLine);
  if (attributionMatch) {
    const byName = await findGithubUsernameByPersonName(attributionMatch[1]);
    if (byName) return byName;
  }

  return null;
}

/**
 * Resolve who to tag in Slack for a backport notification.
 * Tries the PR author first, falls back to release sheriff with a "fallback:" note.
 */
async function resolveSlackTagForAuthor(githubUsername?: string): Promise<string> {
  if (githubUsername) {
    const slackUserId = await findSlackUserIdByGithubUsername(githubUsername);
    if (slackUserId) return `<@${slackUserId}>`;
  }
  // Fall back to release sheriff — annotate so it's clear this is not the author
  const sheriffId = await getReleaseSheriffUserId();
  if (sheriffId) return `_(fallback: <@${sheriffId}>)_`;
  return ""; // no one to tag
}

/** Check if a PR has a backport-not-needed label for a given target prefix (e.g. "core" or "cloud") */
function hasBackportNotNeededLabel(labels: string[], targetPrefix: string): boolean {
  // General label dismisses all targets
  if (labels.some((l) => l.toLowerCase() === config.backportNotNeededLabel.toLowerCase()))
    return true;
  // Per-target label
  const notNeededLabel = config.backportNotNeededLabels[targetPrefix];
  if (!notNeededLabel) return false;
  return labels.some((l) => l.toLowerCase() === notNeededLabel.toLowerCase());
}

/**
 * A `compareCommits(base: branch, head: commitSha)` status that means the
 * commit is already present in `branch`'s history — i.e. nothing to
 * backport there.
 *
 * This is also what makes dual-homed commits detectable at all: a
 * cherry-picked backport always produces a brand-new commit SHA, so the
 * *same* SHA can only show up as an ancestor of another branch if that
 * branch was literally cut from a point in history that already contains
 * it (see "Dual-homed commits" in ComfyUI_frontend's
 * docs/release-process.md#dual-homed-commits). There's no way for a
 * genuinely-unbackported commit to satisfy this by coincidence.
 */
export function isAlreadyOnBranchStatus(status: string): boolean {
  return status === "identical" || status === "behind";
}

/**
 * Check whether `commitSha` already exists on any of `candidateBranches`
 * (e.g. it's dual-homed there from a minor-version branch cut). Returns the
 * branch names where it's already present.
 *
 * Only called for bugfix PRs with no explicit backport signal at all (no
 * `core/…`/`cloud/…` label, no "backport"/"stable" mention) — those are the
 * ones the report would otherwise flag as "❗ Might need backport" purely
 * because nobody said anything either way, which is exactly the false
 * positive dual-homed commits trigger.
 */
async function findDualHomedBranches(
  owner: string,
  repo: string,
  commitSha: string,
  candidateBranches: string[],
): Promise<string[]> {
  const matches: string[] = [];
  for (const branch of candidateBranches) {
    try {
      const { status } = await ghc.repos
        .compareCommits({ owner, repo, base: branch, head: commitSha })
        .then((e) => e.data);
      if (isAlreadyOnBranchStatus(status)) matches.push(branch);
    } catch (e) {
      logger.warn(`      Failed to check dual-homed status of ${commitSha} against ${branch}`, {
        error: e,
      });
    }
  }
  return matches;
}

async function processTask(
  task: GithubFrontendBackportCheckerTask,
  availableBackportTargetBranches: string[],
): Promise<GithubFrontendBackportCheckerTask> {
  const compareLink = task.compareLink || DIE("compareLink missing in task");

  // 2. get commits from the compare link API
  const { owner, repo, base, head } =
    compareLink.match(
      /github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/compare\/(?<base>\S+)\.\.\.(?<head>\S+)/,
    )?.groups || DIE(`Failed to parse compare link: ${compareLink}`);
  logger.debug(`  Comparing to head: ${head}`);
  let compareResult;
  try {
    compareResult = await ghc.repos
      .compareCommits({ owner, repo, base, head })
      .then((e) => e.data.commits);
  } catch (e) {
    logger.warn(`  Failed to compare ${base}...${head}, skipping release ${task.releaseTag}`, {
      error: e,
    });
    return await save({ ...task, bugfixCommits: [], taskStatus: "failed" });
  }
  logger.debug(`  Found ${compareResult.length} commits in release`);

  // // collect already backported commits, for logging purpose
  // await sflow(compareResult)
  //   .filter((commit) => /\[backport .*?\]/i.test(commit.commit.message.split("\n")[0]))
  //   .map(async (commit) => {
  //     const commitSha = commit.sha;
  //     const commitMessage = commit.commit.message.split("\n")[0]; // First line only
  //     logger.debug(
  //       `    Found already backported commit: ${commitSha.substring(0, 7)} - ${commitMessage}`,
  //     );
  //   })
  //   .run();

  // 3. process each commits (need to backport)
  const bugfixCommits = await sflow(compareResult)
    // filter bugfix commits
    .filter((commit) => config.reBugfixPatterns.test(commit.commit.message.split("\n")[0]))
    // filter out [backport .*] commits
    .filter((commit) => !/\[backport .*?\]/i.test(commit.commit.message.split("\n")[0]))

    .map(async function processBugfixCommit(commit) {
      const commitSha = commit.sha;
      const commitMessage = commit.commit.message.split("\n")[0]; // First line only

      logger.debug(`    Checking commit: ${commitSha.substring(0, 7)} - ${commitMessage}`);

      // Find associated PR(s)
      const prs = await ghc.repos
        .listPullRequestsAssociatedWithCommit({
          owner,
          repo,
          commit_sha: commitSha,
        })
        .then((e) => e.data);
      logger.debug(`      Found ${prs.length} associated PR(s)`); // usually have only one

      return sflow(prs)
        .map(async function processBugfixPR(pr) {
          const prNumber = pr.number;
          const prUrl = pr.html_url;
          const prTitle = pr.title;

          logger.debug(`      Processing PR #${prNumber}: ${prTitle}`);

          // Skip PRs that only touch irrelevant paths (website, CI/CD, tooling config, ...).
          // Only skip when EVERY changed file matches — a PR touching anything else is
          // still flagged as usual.
          const changedFiles = await ghPageFlow(ghc.pulls.listFiles)({
            owner,
            repo,
            pull_number: prNumber,
          })
            .map((f) => f.filename)
            .toArray();
          if (allChangedFilesIgnored(changedFiles)) {
            logger.debug(
              `      Skipping PR #${prNumber}: all ${changedFiles.length} changed file(s) under ignored paths`,
            );
            return null;
          }

          // Check labels
          const labels = pr.labels
            .map((l) => (typeof l === "string" ? l : l.name))
            .filter((l): l is string => !!l);
          const backportLabels = labels.filter((l) => config.reBackportTargets.test(l));

          // Check PR body and comments for backport mentions
          const prDetails = await ghc.pulls.get({ owner, repo, pull_number: prNumber });
          const bodyText = (prDetails.data.body || "").toLowerCase();

          const comments = await ghc.issues
            .listComments({
              owner,
              repo,
              issue_number: prNumber,
            })
            .then((e) => e.data);

          const commentTexts = comments
            // no bot msgs
            .filter((c) => !isBotLogin(c.user?.login))
            .map((c) => c.body?.toLowerCase() || "")
            .join(" ");

          const backportMentioned = config.reBackportMentionPatterns.test(
            bodyText + "\n" + commentTexts,
          );

          // Determine status
          let backportStatusRaw: BackportStatus = "unknown";
          if (backportLabels.length > 0) {
            if (backportLabels.some((l) => l.toLowerCase().includes("completed"))) {
              backportStatusRaw = "completed";
            } else if (backportLabels.some((l) => l.toLowerCase().includes("in-progress"))) {
              backportStatusRaw = "in-progress";
            } else if (backportLabels.some((l) => l.toLowerCase().includes("needs"))) {
              backportStatusRaw = "needed";
            } else {
              backportStatusRaw = "needed";
            }
          } else if (backportMentioned) {
            backportStatusRaw = "needed";
          } else {
            backportStatusRaw = "unknown";
          }

          logger.debug(
            `        PR #${prNumber} backport status: ${backportStatusRaw} (labels: ${backportLabels.join(", ")})`,
          );
          // check each backport target branch status
          const targetBranches = labels
            .filter((l) => config.reBackportTargets.test(l))
            .filter((_e) => backportStatusRaw === "needed");

          let backportTargetStatus = await sflow(targetBranches)
            .map(async (branchName) => {
              // Check for no-backport-needed[-core|-cloud] labels first (e.g. "core/1.4" → prefix "core")
              const targetPrefix = branchName.split("/")[0];
              if (hasBackportNotNeededLabel(labels, targetPrefix)) {
                logger.debug(
                  `          Backport target branch ${branchName} marked not-needed by label`,
                );
                return {
                  branch: branchName,
                  status: "not-needed" as BackportStatus,
                  prs: [] as {
                    prUrl?: string;
                    prNumber?: number;
                    prTitle?: string;
                    prStatus?: "open" | "closed" | "merged";
                    lastCheckedAt?: Date;
                  }[],
                };
              }

              // now check if the commit is in the branch
              const comparing = await ghc.repos
                .compareCommits({
                  owner,
                  repo,
                  base: branchName,
                  head: commitSha,
                })
                .then((e) => e.data);
              let PRs: {
                prUrl?: string;
                prNumber?: number;
                prTitle?: string;
                prStatus?: "open" | "closed" | "merged";
                lastCheckedAt?: Date;
              }[] = [];
              const status: BackportStatus = await tsmatch(comparing.status)
                .with("ahead", () => "needed" as const)
                .with("identical", () => "completed" as const)
                .with("behind", () => "completed" as const)
                .with("diverged", async () => {
                  const backportBranch = `backport-${prNumber}-to-${branchName.replaceAll("/", "-")}`;
                  const backportPRs = await ghPageFlow(ghc.pulls.list)({
                    owner,
                    repo,
                    head: backportBranch,
                    base: branchName,
                    state: "all",
                  })
                    .filter((e) => e.head.ref === backportBranch)
                    .toArray();

                  PRs = backportPRs.map((bpr) => ({
                    prUrl: bpr.html_url,
                    prNumber: bpr.number,
                    prTitle: bpr.title,
                    prStatus: bpr.merged_at ? "merged" : bpr.state === "open" ? "open" : "closed",
                    lastCheckedAt: new Date(),
                  }));

                  if (backportPRs.some((e) => e.merged_at)) return "completed" as const;
                  if (backportPRs.some((e) => e.state.toUpperCase() === "OPEN"))
                    return "in-progress" as const;
                  return "needed" as const;
                })
                .otherwise(() => {
                  logger.error(
                    `unable to parse comparing status (${comparing.status}) of [pr](${pr.html_url})`,
                  );
                  return "unknown" as const;
                });

              logger.debug(`          Backport target branch ${branchName} status: ${status}`);
              return { branch: branchName, status, prs: PRs };
            })
            .toArray();

          // No explicit backport signal (no target-branch label, no
          // "backport"/"stable" mention) is exactly what makes the report
          // flag this as "❗ Might need backport" below. Before accepting
          // that, check whether the commit is dual-homed — already present
          // on some other currently-tracked backport branch by construction
          // of a minor-version branch cut (docs/release-process.md
          // #dual-homed-commits in ComfyUI_frontend). If so there's nothing
          // to backport, so treat it the same as an explicit "completed".
          if (backportStatusRaw === "unknown") {
            const dualHomedBranches = await findDualHomedBranches(
              owner,
              repo,
              commitSha,
              availableBackportTargetBranches,
            );
            if (dualHomedBranches.length) {
              logger.debug(
                `        PR #${prNumber} commit ${commitSha.substring(0, 7)} is dual-homed on: ${dualHomedBranches.join(", ")}`,
              );
              backportTargetStatus = dualHomedBranches.map((branch) => ({
                branch,
                status: "completed" as const,
                prs: [],
              }));
            }
          }

          // Determine overall backport status (ignoring "not-needed" targets)
          const activeTargets = backportTargetStatus.filter((t) => t.status !== "not-needed");
          const backportStatus: BackportStatus =
            activeTargets.length && activeTargets.every((t) => t.status === "completed")
              ? "completed"
              : activeTargets.some((t) => t.status === "in-progress")
                ? "in-progress"
                : activeTargets.some((t) => t.status === "needed")
                  ? "needed"
                  : backportTargetStatus.length && !activeTargets.length
                    ? "not-needed" // all targets have backport-not-needed labels
                    : "unknown";

          // If the PR was opened by a bot/automation account (e.g. claude[bot]),
          // try to resolve the real human requester to tag instead — via a
          // Co-authored-by commit trailer, falling back to the PR description's
          // "_Requested by **Name**_" attribution line. Falls back to the raw
          // bot login (and from there to the existing release-sheriff behavior)
          // if neither resolves.
          const rawAuthorLogin = pr.user?.login;
          const prAuthor =
            rawAuthorLogin && isBotLogin(rawAuthorLogin)
              ? ((await resolveBotAuthorGithubUsername({
                  owner,
                  repo,
                  prNumber,
                  body: prDetails.data.body,
                })) ?? rawAuthorLogin)
              : rawAuthorLogin;

          return {
            commitSha,
            commitMessage,
            prUrl,
            prNumber,
            prTitle,
            prLabels: labels,
            prAuthor,

            backportStatus,
            backportStatusRaw,
            backportLabels,
            backportMentioned,
            backportTargetStatus,
          };
        })
        .toArray();
    })
    .flat()
    .toArray()
    .then((results) => results.filter((e): e is NonNullable<typeof e> => e !== null));

  if (!bugfixCommits.length) {
    return await save({ ...task, bugfixCommits, taskStatus: "completed" });
  }

  // Resolve Slack tags for authors who have unresolved backports
  const authorTags = new Map<string, string>();
  for (const bf of bugfixCommits) {
    if (
      bf.prAuthor &&
      !authorTags.has(bf.prAuthor) &&
      bf.backportStatus !== "completed" &&
      bf.backportStatus !== "not-needed"
    ) {
      authorTags.set(bf.prAuthor, await resolveSlackTagForAuthor(bf.prAuthor));
    }
  }

  const statuses = bugfixCommits.map((e) => ({
    ...e,
    status: !e.backportTargetStatus.length
      ? ("not-mentioned" as const)
      : e.backportTargetStatus.some((t) => t.status !== "completed" && t.status !== "not-needed")
        ? ("in-progress" as const)
        : ("completed" as const),
  }));

  // - generate report based on commits, note: slack's markdown not support table
  const rawReport = `**Release [${task.releaseTag}](${task.releaseUrl}) Backport Status:${
    statuses.filter((e) => e.status !== "completed").length ? "" : " Completed"
  }** _by [backport-checker.ts](https://github.com/Comfy-Org/Comfy-PR/tree/HEAD/app/tasks/gh-frontend-backport-checker/index.ts)_

${
  // not mentioned, show might need
  statuses
    .filter((e) => !e.backportTargetStatus.length)
    .map((bf) => {
      const tag = bf.prAuthor ? authorTags.get(bf.prAuthor) || "" : "";
      return `[${middleTruncated(60, bf.commitMessage)}](${bf.prUrl}) ➡️ _❗ Might need backport_ ${tag}`.trim();
    })
    .join("\n")
}
${
  // in-progress/needed, show detailed status with author tags
  bugfixCommits
    .filter(
      (e) =>
        e.backportTargetStatus?.length &&
        e.backportTargetStatus.some((t) => t.status !== "completed" && t.status !== "not-needed"),
    )
    .map((bf) => {
      const targetsStatuses = bf.backportTargetStatus
        .map((ts) => {
          if (ts.status === "not-needed") return `${ts.branch}: ➖`;
          const prStatus = ts.prs
            .map((pr) =>
              pr.prUrl ? `[:pr-${pr.prStatus?.toLowerCase()}: #${pr.prNumber}](${pr.prUrl})` : "",
            )
            .filter(Boolean)
            .join(", ");
          return `${ts.branch}: ${prStatus || getBackportStatusEmoji(ts.status)}`;
        })
        .join(", ");
      const tag = bf.prAuthor ? authorTags.get(bf.prAuthor) || "" : "";
      return `[${middleTruncated(60, bf.commitMessage)}](${bf.prUrl}) ➡️ ${targetsStatuses} ${tag}`.trim();
    })
    .join("\n")
}

`;

  const formattedReport = await prettier.format(rawReport, { parser: "markdown" });
  logger.info(formattedReport);

  task = await save({ ...task, bugfixCommits });

  // - now lets upsert slack message
  if (isDryRun) {
    logger.info("DRY RUN: Would send/update Slack message to #" + config.slackChannelName);
  } else {
    process.env.DRY_RUN = "";

    if (formattedReport.trim() !== task.slackMessage?.text?.trim()) {
      const msg = await upsertSlackMarkdownMessage({
        channelName: config.slackChannelName,
        markdown: formattedReport,
        url: task.slackMessage?.url,
      });
      task = await save({
        ...task,
        slackMessage: { text: msg.text, channel: msg.channel, url: msg.url },
      });
    }
  }
  return {
    ...task,
    report: formattedReport,
    bugfixCommits,
  };
}
