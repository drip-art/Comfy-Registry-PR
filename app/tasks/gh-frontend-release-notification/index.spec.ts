import { server } from "@/src/test/msw-setup";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { http, HttpResponse } from "msw";

// Type definitions for mock database
type FilterType = { url?: string; $or?: Array<{ url: string }> };
type UpdateType = { $set: Record<string, unknown> };
type SlackMessageType = Record<string, unknown>;

// Track database operations
let dbOperations: { type: string; args: unknown[]; result?: unknown }[] = [];
let mockSlackMessages: SlackMessageType[] = [];
let createIndexCalls: { keys: unknown; options: unknown }[] = [];

// In-memory document storage to simulate MongoDB for test isolation
const inMemoryDocs = new Map<string, Map<string, unknown>>();
let docIdCounter = 0;

// Mock collection object
const createMockCollection = (collectionName?: string) => {
  const name = collectionName || "default";
  if (!inMemoryDocs.has(name)) {
    inMemoryDocs.set(name, new Map());
  }
  const docs = inMemoryDocs.get(name)!;

  return {
    createIndex: async (keys: unknown, options: unknown) => {
      createIndexCalls.push({ keys, options });
      return {};
    },
    findOne: async (filter: FilterType) => {
      dbOperations.push({ type: "findOne", args: [filter] });
      for (const doc of docs.values()) {
        const d = doc as Record<string, unknown>;
        if (filter.$or) {
          for (const condition of filter.$or) {
            if (d.url === condition.url) return doc;
          }
        }
      }
      return null;
    },
    findOneAndUpdate: async (
      filter: FilterType & { _id?: string },
      update: UpdateType,
      _options?: unknown,
    ) => {
      // Merge into any existing doc so subsequent saves see prior fields
      // (e.g. slackMessageDrafting.url) just like the real upsert would.
      let id: string;
      let existing: Record<string, unknown> | undefined;
      if (filter._id) {
        id = filter._id;
        existing = docs.get(id) as Record<string, unknown> | undefined;
      } else {
        id =
          [...docs.entries()].find(
            ([, d]) => (d as Record<string, unknown>).url === filter.url,
          )?.[0] || `mock_id_${++docIdCounter}`;
        existing = docs.get(id) as Record<string, unknown> | undefined;
      }
      const result = { ...existing, ...update.$set, _id: id };
      docs.set(id, result);
      dbOperations.push({ type: "findOneAndUpdate", args: [filter, update], result });
      return result;
    },
    deleteMany: async () => {
      const count = docs.size;
      docs.clear();
      return { deletedCount: count };
    },
    insertOne: async (doc: unknown) => {
      const id = `mock_id_${++docIdCounter}`;
      const docWithId = { ...(doc as object), _id: id };
      docs.set(id, docWithId);
      return { insertedId: id };
    },
    find: () => ({
      toArray: async () => Array.from(docs.values()),
    }),
    countDocuments: async () => docs.size,
    deleteOne: async (filter: Record<string, unknown>) => {
      for (const [id, doc] of docs.entries()) {
        const d = doc as Record<string, unknown>;
        for (const key of Object.keys(filter)) {
          if (d[key] === filter[key]) {
            docs.delete(id);
            return { deletedCount: 1 };
          }
        }
      }
      return { deletedCount: 0 };
    },
  };
};

// Mock database
const trackingMockDb = {
  collection: (name: string) => createMockCollection(name),
  admin: () => ({
    ping: async () => ({ ok: 1 }),
  }),
};

const { mock } = await import("bun:test");

// Mock @/src/db before importing the module
mock.module("@/src/db", () => ({
  db: trackingMockDb,
}));

// Mock slack channel
mock.module("@/lib/slack/channels", () => ({
  getSlackChannel: async () => ({
    id: "test-channel-id",
    name: "frontend",
  }),
}));

// Mock upsertSlackMessage (used by upsertChunkedSlackMessage)
let slackMsgCounter = 0;
mock.module("../gh-desktop-release-notification/upsertSlackMessage", () => ({
  upsertSlackMessage: async (msg: SlackMessageType) => {
    mockSlackMessages.push(msg);
    const channel = (msg.channel as string) || "test-channel-id";
    const url =
      (msg.url as string) ||
      `https://comfy-organization.slack.com/archives/${channel}/p${1700000000000000 + slackMsgCounter++}`;
    return {
      ...msg,
      url,
      channel,
    };
  },
  upsertSlackMarkdownMessage: async (msg: SlackMessageType) => {
    mockSlackMessages.push(msg);
    return {
      ...msg,
      url: `https://slack.com/message/${Date.now()}`,
    };
  },
  mdFmt: async (md: string) => md,
}));

const { default: runGithubFrontendReleaseNotificationTask } = await import("./index");

function releaseFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    html_url: "https://github.com/Comfy-Org/ComfyUI_frontend/releases/tag/v1.55.5",
    tag_name: "v1.55.5",
    draft: false,
    prerelease: false,
    created_at: new Date().toISOString(),
    published_at: new Date().toISOString(),
    body: "Stable release notes",
    ...overrides,
  };
}

describe("GithubFrontendReleaseNotificationTask", () => {
  const originalCollectionFactory = () => createMockCollection();

  beforeEach(() => {
    dbOperations = [];
    mockSlackMessages = [];
    inMemoryDocs.clear();
    trackingMockDb.collection = originalCollectionFactory;
  });

  afterEach(() => {
    server.resetHandlers();
    trackingMockDb.collection = originalCollectionFactory;
  });

  describe("Stable release notification", () => {
    it("sends only a main message when the formatted message fits in one chunk", async () => {
      const release = releaseFixture({ body: "Short release notes." });

      server.use(
        http.get("https://api.github.com/repos/:owner/:repo/releases", () => {
          return HttpResponse.json([release]);
        }),
      );

      await runGithubFrontendReleaseNotificationTask();

      // Only the main message should have been posted, no thread reply overflow.
      expect(mockSlackMessages.length).toBe(1);
      expect(mockSlackMessages[0].text).not.toContain("...TRUNCATED...");

      const saveOps = dbOperations.filter((op) => op.type === "findOneAndUpdate");
      const savedWithMessage = saveOps.find((op) => (op.args[1] as UpdateType).$set.slackMessage);
      expect(savedWithMessage).toBeTruthy();
      const savedSlackMessage = (savedWithMessage!.args[1] as UpdateType).$set.slackMessage as {
        overflowUrls?: string[];
      };
      expect(savedSlackMessage.overflowUrls ?? []).toEqual([]);
    });

    it("splits a long release body into a main message plus thread replies without dropping content", async () => {
      // Build a release body shaped like real GitHub release notes: many PR
      // list entries, long enough to overflow a single Slack chunk.
      const prLines = Array.from(
        { length: 80 },
        (_, i) =>
          `* Fix something important about widget ${i} in https://github.com/Comfy-Org/ComfyUI_frontend/pull/${1000 + i}`,
      );
      const body = [
        "## What's Changed",
        ...prLines,
        "**Full Changelog**: https://example.com/diff",
      ].join("\n");
      const release = releaseFixture({ body });

      server.use(
        http.get("https://api.github.com/repos/:owner/:repo/releases", () => {
          return HttpResponse.json([release]);
        }),
      );

      await runGithubFrontendReleaseNotificationTask();

      // Should have posted more than one Slack message: the main message
      // plus at least one thread reply carrying the overflow.
      expect(mockSlackMessages.length).toBeGreaterThan(1);

      // Nothing should ever be replaced with the old truncation marker.
      for (const msg of mockSlackMessages) {
        expect(msg.text as string).not.toContain("...TRUNCATED...");
      }

      // Concatenating everything that was sent (main + all thread replies,
      // in post order) must reconstruct the full formatted message with no
      // PR entries dropped.
      const combined = mockSlackMessages.map((m) => m.text as string).join("\n");
      for (let i = 0; i < prLines.length; i++) {
        expect(combined).toContain(`widget ${i}`);
      }

      const saveOps = dbOperations.filter((op) => op.type === "findOneAndUpdate");
      const savedWithMessage = saveOps
        .reverse()
        .find((op) => (op.args[1] as UpdateType).$set.slackMessage);
      expect(savedWithMessage).toBeTruthy();
      const savedSlackMessage = (savedWithMessage!.args[1] as UpdateType).$set.slackMessage as {
        text: string;
        overflowUrls?: string[];
      };
      // The full, un-chunked text must still be what's stored for the
      // draftingTextChanged/messageTextChanged diff comparisons to work.
      expect(savedSlackMessage.text).not.toContain("...TRUNCATED...");
      for (let i = 0; i < prLines.length; i++) {
        expect(savedSlackMessage.text).toContain(`widget ${i}`);
      }
      expect((savedSlackMessage.overflowUrls ?? []).length).toBeGreaterThan(0);
    });
  });

  describe("Prerelease processing", () => {
    it("sends a drafting message for prereleases", async () => {
      const release = releaseFixture({
        html_url: "https://github.com/Comfy-Org/ComfyUI_frontend/releases/tag/v1.55.5-beta.1",
        tag_name: "v1.55.5-beta.1",
        prerelease: true,
        body: "Beta release notes",
      });

      server.use(
        http.get("https://api.github.com/repos/:owner/:repo/releases", () => {
          return HttpResponse.json([release]);
        }),
      );

      await runGithubFrontendReleaseNotificationTask();

      const saveOps = dbOperations.filter((op) => op.type === "findOneAndUpdate");
      const hasDraftingMessage = saveOps.some(
        (op) => (op.args[1] as UpdateType).$set.slackMessageDrafting,
      );
      expect(hasDraftingMessage).toBe(true);
      const hasStableMessage = saveOps.some((op) => (op.args[1] as UpdateType).$set.slackMessage);
      expect(hasStableMessage).toBe(false);
    });
  });

  describe("Date filtering", () => {
    it("should skip releases created before sendSince date", async () => {
      const oldRelease = releaseFixture({
        html_url: "https://github.com/Comfy-Org/ComfyUI_frontend/releases/tag/v0.1.0",
        tag_name: "v0.1.0",
        created_at: "2024-01-01T00:00:00Z",
        published_at: "2024-01-01T00:00:00Z",
        body: "Old release",
      });

      server.use(
        http.get("https://api.github.com/repos/:owner/:repo/releases", () => {
          return HttpResponse.json([oldRelease]);
        }),
      );

      await runGithubFrontendReleaseNotificationTask();

      const saveOps = dbOperations.filter((op) => op.type === "findOneAndUpdate");
      expect(saveOps.length).toBeGreaterThanOrEqual(1);
      expect(mockSlackMessages.length).toBe(0);
    });
  });

  describe("Database Index", () => {
    it("should create unique index on url field", async () => {
      expect(createIndexCalls.length).toBeGreaterThanOrEqual(1);
      const indexCall = createIndexCalls[0];
      expect(indexCall.keys).toEqual({ url: 1 });
      expect(indexCall.options).toEqual({ unique: true });
    });
  });
});
