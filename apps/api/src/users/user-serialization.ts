import type { UserStatus } from "@prisma/client";

/**
 * The single shared source of "is this account soft-deleted" for every
 * serializer in the codebase (comments, attachments, tasks, activity feed,
 * analytics, ...). `status === "deleted"` is the only source of truth — see
 * account.service.ts#deleteAccount and the UserStatus enum in schema.prisma.
 */
export function isDeletedUser(user: { status: UserStatus }): boolean {
  return user.status === "deleted";
}
