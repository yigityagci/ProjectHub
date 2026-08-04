/**
 * Pure derivation helpers for the Milestones module on CategoriesPage.tsx.
 * Extracted so the "display order" rule (dated milestones sorted ascending,
 * undated milestones appended afterward in their original/creation order)
 * has a single, testable definition rather than being inlined in the page.
 */

export interface MilestoneLike {
  id: string;
  name: string;
  description: string | null;
  targetDate: string | null;
  completedAt: string | null;
}

/**
 * Returns a NEW array (never mutates `milestones`) ordered as:
 * 1. Milestones with a non-null `targetDate`, sorted ascending by date.
 * 2. Milestones with no `targetDate`, in their original relative order.
 */
export function getMilestoneDisplayOrder<T extends MilestoneLike>(milestones: T[]): T[] {
  const dated = milestones.filter((m) => m.targetDate !== null && m.targetDate !== undefined);
  const undated = milestones.filter((m) => m.targetDate === null || m.targetDate === undefined);
  const sortedDated = [...dated].sort(
    (a, b) => Date.parse(a.targetDate as string) - Date.parse(b.targetDate as string),
  );
  return [...sortedDated, ...undated];
}

/** First not-yet-completed milestone in display order, or null if none. */
export function getCurrentMilestone<T extends MilestoneLike>(displayOrder: T[]): T | null {
  return displayOrder.find((m) => !m.completedAt) ?? null;
}
