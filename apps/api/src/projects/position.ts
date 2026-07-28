/**
 * Fractional-index helpers shared by BoardColumn ordering (within a
 * project) and Task ordering (within a project+column). New items get
 * `maxPosition + 1` (or 1 if the list is empty). Inserting between two
 * existing items uses the midpoint of their positions; inserting at the
 * head uses `firstPosition / 2`. If a computed gap collapses below a safe
 * floating-point threshold, callers must rebalance the whole list.
 */

export const MIN_SAFE_GAP = 1e-6;

export function computeAppendPosition(maxPosition: number | null): number {
  return maxPosition === null ? 1 : maxPosition + 1;
}

export interface ComputedPosition {
  position: number;
  needsRebalance: boolean;
}

/**
 * `prevPosition` is the position of the item immediately before the
 * insertion point (null = inserting at the head of the list).
 * `nextPosition` is the position of the item immediately after the
 * insertion point (null = inserting at the tail of the list).
 */
export function computeInsertPosition(
  prevPosition: number | null,
  nextPosition: number | null,
): ComputedPosition {
  if (prevPosition === null && nextPosition === null) {
    return { position: 1, needsRebalance: false };
  }
  if (prevPosition === null) {
    // Insert at head: half of the first item's position.
    return { position: nextPosition! / 2, needsRebalance: nextPosition! < MIN_SAFE_GAP * 2 };
  }
  if (nextPosition === null) {
    // Insert at tail: one past the last item's position.
    return { position: prevPosition + 1, needsRebalance: false };
  }
  const gap = nextPosition - prevPosition;
  return {
    position: prevPosition + gap / 2,
    needsRebalance: gap < MIN_SAFE_GAP,
  };
}

/**
 * Rewrites `orderedIds` to positions 1..n, in order. Callers pass a
 * `write` function bound to their model/transaction so this helper stays
 * model-agnostic (used for both BoardColumn and Task rebalancing).
 */
export async function rebalancePositions(
  orderedIds: string[],
  write: (id: string, position: number) => Promise<unknown>,
): Promise<void> {
  await Promise.all(orderedIds.map((id, index) => write(id, index + 1)));
}
