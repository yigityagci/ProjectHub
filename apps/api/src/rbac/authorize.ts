import { ROLE_RANK, type RoleKey } from "@projecthub/shared";
import { ForbiddenError, ConflictError } from "../core/errors.js";
import { prisma } from "../core/prisma.js";

/**
 * True for ADMIN/OWNER-ranked roles. Used by the Phase 4 "author or
 * Admin/Owner" ownership-or-elevated-role rule on comment/attachment
 * deletion.
 */
export function isElevatedRole(roleKey: RoleKey): boolean {
  return ROLE_RANK[roleKey] >= ROLE_RANK.ADMIN;
}

/**
 * Enforces that a caller may not assign a role ranked higher than their own.
 */
export function assertCanAssignRole(callerRoleKey: RoleKey, targetRoleKey: RoleKey): void {
  if (ROLE_RANK[targetRoleKey] > ROLE_RANK[callerRoleKey]) {
    throw new ForbiddenError("You don't have permission to perform this action.");
  }
}

const LAST_OWNER_MESSAGE =
  "Every workspace must have at least one owner. Please promote another member to owner before changing this role.";
const LAST_OWNER_REMOVAL_MESSAGE =
  "Every workspace must have at least one owner. You cannot remove the only owner.";

/**
 * Prevents demoting or removing the last remaining OWNER of a workspace.
 * Must be called from within the same transaction/request as the mutation
 * to avoid a race between the check and the write.
 */
export async function assertNotLastOwner(
  workspaceId: string,
  membershipUserId: string,
  mode: "demote" | "remove",
): Promise<void> {
  const ownerRole = await prisma.role.findUnique({
    where: { workspaceId_key: { workspaceId, key: "OWNER" } },
  });
  if (!ownerRole) return;

  const targetMembership = await prisma.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId: membershipUserId } },
  });
  if (!targetMembership || targetMembership.roleId !== ownerRole.id) {
    // Target isn't currently an owner, so the last-owner rule doesn't apply.
    return;
  }

  const ownerCount = await prisma.workspaceMembership.count({
    where: { workspaceId, roleId: ownerRole.id, status: "active" },
  });

  if (ownerCount <= 1) {
    throw new ConflictError(mode === "demote" ? LAST_OWNER_MESSAGE : LAST_OWNER_REMOVAL_MESSAGE);
  }
}
