import { describe, expect, it } from "bun:test";
import { filterReviewers } from "./filterReviewers";

describe("filterReviewers", () => {
  const REVIEWERS = ["PabloWiedemann", "AliceDev"];

  it("excludes the PR author from both lists", () => {
    const result = filterReviewers(REVIEWERS, "PabloWiedemann");
    expect(result.requestReviewers).toEqual(["AliceDev"]);
    expect(result.newReviewers).toEqual(["AliceDev"]);
  });

  it("returns all reviewers when author is not in the list", () => {
    const result = filterReviewers(REVIEWERS, "SomeoneElse");
    expect(result.requestReviewers).toEqual(["PabloWiedemann", "AliceDev"]);
    expect(result.newReviewers).toEqual(["PabloWiedemann", "AliceDev"]);
  });

  it("excludes already-requested reviewers from newReviewers only", () => {
    const result = filterReviewers(REVIEWERS, "SomeoneElse", ["PabloWiedemann"]);
    expect(result.requestReviewers).toEqual(["PabloWiedemann", "AliceDev"]);
    expect(result.newReviewers).toEqual(["AliceDev"]);
  });

  it("returns empty newReviewers when all are already requested", () => {
    const result = filterReviewers(REVIEWERS, "SomeoneElse", ["PabloWiedemann", "AliceDev"]);
    expect(result.requestReviewers).toEqual(["PabloWiedemann", "AliceDev"]);
    expect(result.newReviewers).toEqual([]);
  });

  it("returns empty lists when author is the only reviewer", () => {
    const result = filterReviewers(["PabloWiedemann"], "PabloWiedemann");
    expect(result.requestReviewers).toEqual([]);
    expect(result.newReviewers).toEqual([]);
  });

  it("handles undefined alreadyRequested as no-one requested yet", () => {
    const result = filterReviewers(REVIEWERS, "SomeoneElse", undefined);
    expect(result.newReviewers).toEqual(["PabloWiedemann", "AliceDev"]);
  });

  it("compares usernames case-insensitively", () => {
    const result = filterReviewers(REVIEWERS, "pablowiedemann");
    expect(result.requestReviewers).toEqual(["AliceDev"]);
  });

  it("matches already-requested reviewers case-insensitively", () => {
    const result = filterReviewers(REVIEWERS, "SomeoneElse", ["pablowiedemann"]);
    expect(result.newReviewers).toEqual(["AliceDev"]);
  });
});
