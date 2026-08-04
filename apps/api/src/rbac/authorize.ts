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

/**
 * Prevents a user from self-deleting their account (see
 * account.service.ts#deleteAccount) while they are still the sole OWNER of
 * any workspace. Unlike assertNotLastOwner, this must inspect every
 * workspace the user belongs to and name ALL of the offending workspaces in
 * a single error, so it is a separate function rather than a third `mode`
 * on assertNotLastOwner (which only ever throws on the first offending
 * workspace). Reuses assertNotLastOwner's own OWNER-role-lookup-then-count
 * query pattern, just iterated across every workspace membership.
 *
 * Called OUTSIDE the deletion transaction (check-then-act) — this has the
 * same accepted, pre-existing race as concurrent member removal elsewhere in
 * this codebase (e.g. two co-owners of the same workspace self-deleting at
 * the same instant); not fully race-proof, intentionally not over-engineered.
 */
export async function assertNotSoleOwnerOfAnyWorkspace(userId: string): Promise<void> {
  const memberships = await prisma.workspaceMembership.findMany({
    where: { userId, status: "active" },
    include: { workspace: true, role: true },
  });

  const soleOwnerWorkspaceNames: string[] = [];

  for (const membership of memberships) {
    if (membership.role.key !== "OWNER") continue;

    const ownerRole = await prisma.role.findUnique({
      where: { workspaceId_key: { workspaceId: membership.workspaceId, key: "OWNER" } },
    });
    if (!ownerRole) continue;

    const ownerCount = await prisma.workspaceMembership.count({
      where: { workspaceId: membership.workspaceId, roleId: ownerRole.id, status: "active" },
    });

    if (ownerCount <= 1) {
      soleOwnerWorkspaceNames.push(membership.workspace.name);
    }
  }

  if (soleOwnerWorkspaceNames.length > 0) {
    throw new ConflictError(
      `Every workspace must have at least one owner. You're still the only owner of: ${soleOwnerWorkspaceNames.join(", ")}. Promote another member to owner in each of these workspaces before deleting your account.`,
    );
  }
}

const LAST_PLATFORM_ADMIN_MESSAGE =
  "You're the only ProjectHub administrator. Grant administrator access to someone else before deleting your account.";

/**
 * Prevents a user from self-deleting their account while they are the last
 * remaining platform admin — there is no self-service "grant platform
 * admin to someone else" flow in this codebase today, so this guard just
 * prevents an irrecoverable dead end (see docs/PHASES.md).
 *
 * Called OUTSIDE the deletion transaction, same check-then-act caveat as
 * assertNotSoleOwnerOfAnyWorkspace above.
 */
export async function assertNotLastPlatformAdmin(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.isPlatformAdmin) return;

  const adminCount = await prisma.user.count({ where: { isPlatformAdmin: true } });
  if (adminCount <= 1) {
    throw new ConflictError(LAST_PLATFORM_ADMIN_MESSAGE);
  }
}

const LAST_CATEGORY_MESSAGE =
  "Every project must have at least one category. Create another category before deleting this one.";

/**
 * Prevents deleting the last remaining TaskCategory of a project, mirroring
 * assertNotLastOwner's style/race-avoidance requirement above: a project
 * that already has >= 1 category can never be reduced to 0 via deletion
 * (this is distinct from a brand-new project's transient zero-category
 * state between project-creation and its forced first-category-creation
 * step — see docs/PHASES.md). Must be called from within the same
 * request/transaction as the delete to avoid a race between the check and
 * the write.
 */
export async function assertNotLastCategory(projectId: string): Promise<void> {
  const categoryCount = await prisma.taskCategory.count({ where: { projectId } });
  if (categoryCount <= 1) {
    throw new ConflictError(LAST_CATEGORY_MESSAGE);
  }
}
