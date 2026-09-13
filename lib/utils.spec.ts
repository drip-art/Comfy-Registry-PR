import { describe, expect, it } from "bun:test";
import { chunkTextByLines } from "./utils";

describe("chunkTextByLines", () => {
  it("returns a single unchanged chunk when text is under the limit", () => {
    const text = "line one\nline two\nline three";
    expect(chunkTextByLines(text, 100)).toEqual([text]);
  });

  it("splits on line boundaries when text exceeds the limit, never splitting a line", () => {
    const lines = Array.from(
      { length: 20 },
      (_, i) => `* PR title ${i} in https://github.com/x/y/pull/${i}`,
    );
    const text = lines.join("\n");
    const maxLength = 200;
    const chunks = chunkTextByLines(text, maxLength);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(maxLength);
    }

    // Every original line must appear intact in exactly one chunk, in order,
    // and rejoining the chunks reconstructs the original text.
    expect(chunks.join("\n")).toBe(text);
    for (const line of lines) {
      const containingChunks = chunks.filter((c) => c.split("\n").includes(line));
      expect(containingChunks.length).toBe(1);
    }
  });

  it("hard-splits a single line longer than maxLength since there is no boundary to break on", () => {
    const longLine = "a".repeat(250);
    const chunks = chunkTextByLines(longLine, 100);

    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
    expect(chunks.join("")).toBe(longLine);
  });

  it("returns a single empty chunk for empty string input", () => {
    expect(chunkTextByLines("", 100)).toEqual([""]);
  });
});
