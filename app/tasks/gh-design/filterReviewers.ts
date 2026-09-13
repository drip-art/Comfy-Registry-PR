/**
 * Compute eligible reviewers for a PR.
 * Returns `requestReviewers` (all reviewers minus the PR author) and
 * `newReviewers` (eligible reviewers not yet requested).
 * GitHub usernames are case-insensitive, so comparisons are normalized.
 */
export function filterReviewers(
  allReviewers: string[],
  prAuthor: string,
  alreadyRequested?: string[],
): { requestReviewers: string[]; newReviewers: string[] } {
  const normalizedAuthor = prAuthor.toLowerCase();
  const normalizedRequested = new Set(alreadyRequested?.map((r) => r.toLowerCase()) ?? []);
  const requestReviewers = allReviewers.filter((e) => e.toLowerCase() !== normalizedAuthor);
  const newReviewers = requestReviewers.filter((e) => !normalizedRequested.has(e.toLowerCase()));
  return { requestReviewers, newReviewers };
}
