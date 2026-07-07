export type PositionedMedia = { id: string; position: number };

/**
 * Return the position updates needed to move `targetId` to 0 while shifting
 * every earlier row up by one. Rows after the target keep their sparse slots.
 */
export function moveMediaToMain(
  rows: readonly PositionedMedia[],
  targetId: string,
): { id: string; position: number }[] {
  const target = rows.find((row) => row.id === targetId);
  if (!target) throw new Error('Target media row not found.');

  return rows.map((row) => {
    if (row.id === targetId) return { id: row.id, position: 0 };
    if (row.position < target.position) return { id: row.id, position: row.position + 1 };
    return { id: row.id, position: row.position };
  });
}
