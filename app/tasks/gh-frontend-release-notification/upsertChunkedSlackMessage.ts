import { chunkTextByLines } from "@/lib/utils";
import { getSlack } from "@/lib/slack";
import { upsertSlackMessage } from "../gh-desktop-release-notification/upsertSlackMessage";
import { slackMessageUrlParse } from "../gh-design/slackMessageUrlParse";

/**
 * Chunk size for a single posted Slack message.
 *
 * This is a readability-driven size, not a protocol limit: Slack's real
 * `text` limit is 40,000 characters, so 3500 is nowhere near that - it just
 * keeps each posted message a reasonable, scannable size (matching the
 * spirit of the old, now-removed 4000-char truncation comment).
 */
export const SLACK_CHUNK_CHAR_LIMIT = 3500;

/**
 * Post (or update) a long Slack message by splitting it into chunks on
 * whole-line boundaries so no PR entry is ever split mid-line.
 *
 * The first chunk becomes the main message; any remaining chunks are posted
 * (or updated) as thread replies under the main message, so nothing is
 * dropped or replaced with a "...TRUNCATED..." marker - it's just spread
 * across the thread instead.
 *
 * If the message got shorter on a later run (e.g. the GitHub release notes
 * were edited down), any now-unused trailing overflow replies from a
 * previous run are deleted.
 */
export async function upsertChunkedSlackMessage({
  channelName,
  fullText,
  existingMainUrl,
  existingOverflowUrls = [],
  replyUrl,
}: {
  channelName: string;
  fullText: string;
  existingMainUrl?: string;
  existingOverflowUrls?: string[];
  replyUrl?: string;
}): Promise<{ main: { text: string; channel: string; url: string }; overflowUrls: string[] }> {
  const [mainText, ...overflowTexts] = chunkTextByLines(fullText, SLACK_CHUNK_CHAR_LIMIT);

  const main = await upsertSlackMessage({
    channelName,
    text: mainText,
    url: existingMainUrl,
    replyUrl,
  });

  const overflowUrls: string[] = [];
  for (let i = 0; i < overflowTexts.length; i++) {
    const existingUrl = existingOverflowUrls[i];
    const reply = await upsertSlackMessage({
      channel: main.channel,
      text: overflowTexts[i],
      url: existingUrl,
      replyUrl: existingUrl ? undefined : main.url,
    });
    overflowUrls.push(reply.url);
  }

  // Message got shorter on a later run - clean up now-unused trailing
  // thread replies from a previous, longer version of this message.
  if (existingOverflowUrls.length > overflowTexts.length) {
    const staleUrls = existingOverflowUrls.slice(overflowTexts.length);
    for (const staleUrl of staleUrls) {
      const { ts } = slackMessageUrlParse(staleUrl);
      await getSlack()
        .chat.delete({ channel: main.channel, ts })
        .catch(() => {});
    }
  }

  return { main, overflowUrls };
}
