import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
/**
 * Prompts the user with a yes/no question in the terminal and returns their response as a boolean.
 *
 * @param {string} question - The question to display to the user.
 * @returns {Promise<boolean>} - Resolves to `true` if the user answers "y" or "yes" (case-insensitive), otherwise `false`.
 *
 * @example
 * const answer = await confirm("Do you want to continue?");
 * if (answer) {
 *   // User confirmed
 * } else {
 *   // User declined
 * }
 */
export async function confirm(question: string) {
  return new Promise<boolean>((resolve) => {
    process.stdin.resume();
    process.stdout.write(`${question} (y/n): `);
    process.stdin.once("data", function (data) {
      const answer = data.toString().trim().toLowerCase();
      process.stdin.pause();
      resolve(answer === "y" || answer === "yes");
    });
  });
}

/**
 * Truncate text from the middle, preserving start and end
 */
export function truncateFromMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const truncationMarker = "\n\n...TRUNCATED...\n\n";
  const markerLength = truncationMarker.length;
  const halfLength = Math.floor((maxLength - markerLength) / 2);

  return text.slice(0, halfLength) + truncationMarker + text.slice(-halfLength);
}

/**
 * Split text into chunks of at most maxLength characters, breaking only on
 * line boundaries so a single list entry (e.g. one changelog PR line) is
 * never split across two chunks. A single line longer than maxLength is
 * hard-split, since there's no boundary left to break on.
 */
export function chunkTextByLines(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    const pieces =
      line.length <= maxLength
        ? [line]
        : Array.from({ length: Math.ceil(line.length / maxLength) }, (_, i) =>
            line.slice(i * maxLength, (i + 1) * maxLength),
          );
    for (const piece of pieces) {
      const withPiece = current ? `${current}\n${piece}` : piece;
      if (withPiece.length <= maxLength) {
        current = withPiece;
      } else {
        if (current) chunks.push(current);
        current = piece;
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
