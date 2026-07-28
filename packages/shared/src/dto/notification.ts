/**
 * A deliberately small notification-type catalog for the Phase 4
 * scaffolding: mentions, task assignment, and comment replies. Later phases
 * (e.g. the Phase 5 activity feed) may broaden this.
 */
export const NOTIFICATION_TYPES = ["mention", "task_assigned", "comment_reply"] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
