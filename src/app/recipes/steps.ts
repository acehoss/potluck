/**
 * Split a recipe's `directions` (one newline-separated string) into display
 * steps. Used by both the read view's numbered list and the Cook view's
 * stepper so the two never disagree about where a step begins.
 *
 * Rules: split on newlines (blank lines fall out as empties), trim, drop
 * empties, then strip a leading "1." / "1)" style number so a hand-numbered
 * paste doesn't double up with our own numbering.
 */
export function splitSteps(directions: string | null | undefined): string[] {
  if (!directions) return [];
  return directions
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^\d+[.)]\s*/, '').trim())
    .filter((line) => line.length > 0);
}
