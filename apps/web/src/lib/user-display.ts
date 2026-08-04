/**
 * Account Deletion with History Preservation: a soft-deleted account's
 * `displayName` is NEVER modified by the deletion flow (see
 * apps/api/src/auth/account.service.ts#deleteAccount) — every past comment,
 * activity entry, attachment, and task assignment keeps showing the
 * person's original name, with this plain-text suffix appended wherever the
 * backend has flagged that user as deleted (the various `*IsDeleted`/
 * `isDeleted` wire fields). Deliberately plain text, no extra markup/span —
 * per final UX decision, keep this simple.
 */
export const DELETED_ACCOUNT_SUFFIX = " (deleted account)";

export function formatUserName(displayName: string, isDeleted: boolean): string {
  return isDeleted ? `${displayName}${DELETED_ACCOUNT_SUFFIX}` : displayName;
}
