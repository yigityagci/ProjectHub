import { z } from "zod";

/**
 * A deliberately small activity-event type catalog for the Phase 5
 * scaffolding: the everyday project events worth surfacing in a
 * user-facing feed (NOT the Phase 1 security/audit log, which is a
 * separate, unrelated model). Extend only when it's genuinely cheap to do
 * so — this is explicitly not meant to capture every possible mutation.
 */
export const ACTIVITY_EVENT_TYPES = [
  "task_created",
  "task_moved",
  "task_assigned",
  "comment_added",
  "milestone_completed",
] as const;
export type ActivityEventType = (typeof ACTIVITY_EVENT_TYPES)[number];

/**
 * Query params for GET .../activity. Cursor-based (most-recent-first):
 * `cursor` is the `id` of the last event on the previous page.
 */
export const activityListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    cursor: z.string().min(1).optional(),
  })
  .strict();
export type ActivityListQuery = z.infer<typeof activityListQuerySchema>;
