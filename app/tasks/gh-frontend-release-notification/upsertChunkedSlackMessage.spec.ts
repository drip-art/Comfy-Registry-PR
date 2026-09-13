import { describe, expect, it, mock } from "bun:test";

type SlackMessageType = Record<string, unknown>;

let postedMessages: SlackMessageType[] = [];
let deleteCalls: { channel: string; ts: string }[] = [];
let slackMsgCounter = 0;

mock.module("./../gh-desktop-release-notification/upsertSlackMessage", () => ({
  upsertSlackMessage: async (msg: SlackMessageType) => {
    postedMessages.push(msg);
    const channel = (msg.channel as string) || "test-channel-id";
    const url =
      (msg.url as string) ||
      `https://comfy-organization.slack.com/archives/${channel}/p${1700000000000000 + slackMsgCounter++}`;
    return { ...msg, url, channel };
  },
}));

mock.module("@/lib/slack", () => ({
  getSlack: () => ({
    chat: {
      delete: async ({ channel, ts }: { channel: string; ts: string }) => {
        deleteCalls.push({ channel, ts });
        return { ok: true };
      },
    },
  }),
}));

const { upsertChunkedSlackMessage, SLACK_CHUNK_CHAR_LIMIT } =
  await import("./upsertChunkedSlackMessage");

describe("upsertChunkedSlackMessage", () => {
  it("posts only a main message when the text fits in one chunk", async () => {
    postedMessages = [];
    deleteCalls = [];

    const { main, overflowUrls } = await upsertChunkedSlackMessage({
      channelName: "frontend",
      fullText: "a short message",
    });

    expect(postedMessages.length).toBe(1);
    expect(overflowUrls).toEqual([]);
    expect(main.text).toBe("a short message");
  });

  it("posts a main message plus thread replies for text over the chunk limit", async () => {
    postedMessages = [];
    deleteCalls = [];

    const lines = Array.from(
      { length: 200 },
      (_, i) => `* PR entry ${i} in https://example.com/${i}`,
    );
    const fullText = lines.join("\n");
    expect(fullText.length).toBeGreaterThan(SLACK_CHUNK_CHAR_LIMIT);

    const { main, overflowUrls } = await upsertChunkedSlackMessage({
      channelName: "frontend",
      fullText,
    });

    expect(postedMessages.length).toBeGreaterThan(1);
    expect(overflowUrls.length).toBe(postedMessages.length - 1);
    // Every overflow reply must have been posted as a reply into the main
    // message's thread (never nested under another overflow reply).
    for (const msg of postedMessages.slice(1)) {
      expect(msg.replyUrl).toBe(main.url);
    }
  });

  it("deletes stale trailing thread replies when the message becomes shorter on a later run", async () => {
    postedMessages = [];
    deleteCalls = [];

    const staleUrl1 = "https://comfy-organization.slack.com/archives/C0A4FRL1JN9/p1700000000000001";
    const staleUrl2 = "https://comfy-organization.slack.com/archives/C0A4FRL1JN9/p1700000000000002";

    const { main, overflowUrls } = await upsertChunkedSlackMessage({
      channelName: "frontend",
      fullText: "now a short message",
      existingMainUrl:
        "https://comfy-organization.slack.com/archives/C0A4FRL1JN9/p1700000000000000",
      existingOverflowUrls: [staleUrl1, staleUrl2],
    });

    // No overflow chunks needed anymore.
    expect(overflowUrls).toEqual([]);

    // Both previously-posted overflow replies should have been deleted.
    expect(deleteCalls.length).toBe(2);
    expect(deleteCalls.map((c) => c.ts)).toEqual(
      expect.arrayContaining(["1700000000.000001", "1700000000.000002"]),
    );
    expect(deleteCalls.every((c) => c.channel === main.channel)).toBe(true);
  });
});
