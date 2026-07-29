import { ROLE_RANK, type RoleKey } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";

/**
 * Standalone re-implementations of the workspace/project access rules from
 * rbac/guards.ts (requireMembership / requireProjectAccess), used by the
 * real-time layer both when a client asks to join a room and when a
 * membership/role change forces a live re-check of rooms a socket is
 * already in. Deliberately reads live data on every call — nothing here is
 * ever cached — so a permission change is reflected on the very next check.
 */
export async function hasWorkspaceAccess(userId: string, workspaceId: string): Promise<boolean> {
  const membership = await prisma.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  return !!membership && membership.status === "active";
}

export async function hasProjectAccess(userId: string, projectId: string): Promise<boolean> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) return false;

  const membership = await prisma.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } },
    include: { role: true },
  });
  if (!membership || membership.status !== "active") return false;

  const roleKey = membership.role.key as RoleKey;
  const projectMembership = await prisma.projectMembership.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });

  if (roleKey === "CLIENT") {
    return !!projectMembership;
  }
  if (project.visibility === "private") {
    const hasElevatedRank = ROLE_RANK[roleKey] >= ROLE_RANK.PROJECT_MANAGER;
    return !!projectMembership || hasElevatedRank;
  }
  return true;
}

/** Returns the workspaceId that owns `projectId`, or null if it doesn't exist. */
export async function workspaceIdForProject(projectId: string): Promise<string | null> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
  return project?.workspaceId ?? null;
}

/**
 * Standalone re-implementation of rbac/guards.ts#requireCategoryAccess,
 * mirroring hasProjectAccess's exact shape one level down (including the
 * CLIENT-role-always-requires-membership rule). Used both when a client
 * asks to join a `category:{id}` room and inside revalidateRoomsForUser's
 * re-check-every-room loop below, so a category membership/visibility
 * change — or a workspace/project membership change — forces immediate
 * re-eviction from a category room the user can no longer access. Never
 * cached, live DB read on every call.
 */
export async function hasCategoryAccess(userId: string, categoryId: string): Promise<boolean> {
  const category = await prisma.taskCategory.findUnique({ where: { id: categoryId } });
  if (!category) return false;

  // A category's access is gated behind its parent project's access first
  // (mirrors requireCategoryAccess running after requireProjectAccess).
  const hasParentProjectAccess = await hasProjectAccess(userId, category.projectId);
  if (!hasParentProjectAccess) return false;

  const project = await prisma.project.findUnique({ where: { id: category.projectId } });
  if (!project) return false;

  const membership = await prisma.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId: project.workspaceId, userId } },
    include: { role: true },
  });
  if (!membership || membership.status !== "active") return false;

  const roleKey = membership.role.key as RoleKey;
  const categoryMembership = await prisma.categoryMembership.findUnique({
    where: { categoryId_userId: { categoryId, userId } },
  });

  if (roleKey === "CLIENT") {
    return !!categoryMembership;
  }
  if (category.visibility === "private") {
    const hasElevatedRank = ROLE_RANK[roleKey] >= ROLE_RANK.PROJECT_MANAGER;
    return !!categoryMembership || hasElevatedRank;
  }
  return true;
}
