import type { Prisma } from "@prisma/client";
import { ROLE_RANK, type RoleKey } from "@projecthub/shared";
import type { CreateCategoryInput, UpdateCategoryInput } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors.js";
import { assertNotLastCategory } from "../rbac/authorize.js";

/**
 * Same 3 default columns Phase 2 used to seed directly inside
 * createProject — moved one level down to category-creation time, since a
 * project itself no longer creates any BoardColumns. See categories
 * requirement #4: "no default categories, ever" is about category NAMES,
 * not about the columns within a (permitted-user-created) category.
 */
const DEFAULT_COLUMNS = [
  { name: "To Do", category: "todo" as const, position: 1 },
  { name: "In Progress", category: "in_progress" as const, position: 2 },
  { name: "Done", category: "done" as const, position: 3 },
];

export interface CreateCategoryServiceInput extends CreateCategoryInput {
  workspaceId: string;
  projectId: string;
}

/**
 * Creates a category and, in the same transaction, seeds its own 3 default
 * BoardColumns (To Do/In Progress/Done) onto it. Each category has its OWN
 * Kanban board (its own BoardColumns), not a shared project-wide board
 * filtered by category.
 */
export async function createCategory(input: CreateCategoryServiceInput) {
  const existing = await prisma.taskCategory.findUnique({
    where: { projectId_name: { projectId: input.projectId, name: input.name } },
  });
  if (existing) {
    throw new ConflictError("A category with this name already exists in this project.");
  }

  return prisma.$transaction(async (tx) => {
    const category = await tx.taskCategory.create({
      data: {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        name: input.name,
        visibility: input.visibility ?? "workspace",
      },
    });

    await tx.boardColumn.createMany({
      data: DEFAULT_COLUMNS.map((c) => ({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        categoryId: category.id,
        name: c.name,
        category: c.category,
        position: c.position,
      })),
    });

    return category;
  });
}

/**
 * Shared access-filtering `WHERE` clause, mirroring
 * projects.service.ts#listProjectsForUser's exact visibility rules one
 * level down:
 *  - CLIENT: only categories they hold a CategoryMembership row for
 *    (matching CLIENT's "always requires explicit membership" rule in
 *    requireCategoryAccess).
 *  - Everyone else: workspace-visible categories, plus any private
 *    categories they hold a CategoryMembership row for, plus (if ranked
 *    >= PROJECT_MANAGER) every private category regardless of membership.
 *
 * This is the single shared building block reused by category listing, the
 * Phase 5 activity-feed visibility fix, and the Phase 6 analytics
 * visibility fix below (via listVisibleCategoryIdsForUser) — deliberately
 * not reimplemented three times.
 */
function buildVisibleCategoryWhere(
  projectId: string,
  userId: string,
  roleKey: RoleKey,
): Prisma.TaskCategoryWhereInput {
  if (roleKey === "CLIENT") {
    return { projectId, memberships: { some: { userId } } };
  }

  const hasElevatedRank = ROLE_RANK[roleKey] >= ROLE_RANK.PROJECT_MANAGER;
  return {
    projectId,
    OR: [
      { visibility: "workspace" },
      ...(hasElevatedRank ? [{ visibility: "private" as const }] : []),
      { visibility: "private", memberships: { some: { userId } } },
    ],
  };
}

/** Access-filtered category list for the project-scoped category picker. */
export async function listCategoriesForUser(projectId: string, userId: string, roleKey: RoleKey) {
  return prisma.taskCategory.findMany({
    where: buildVisibleCategoryWhere(projectId, userId, roleKey),
    orderBy: { createdAt: "asc" },
  });
}

/**
 * The caller's set of visible category ids within `projectId` — reused by
 * activity.service.ts#listActivityEvents (to exclude events belonging to a
 * private category the caller can't see) and
 * analytics.service.ts#getProjectAnalytics (to narrow the aggregate task
 * query to only tasks in categories the caller can see).
 */
export async function listVisibleCategoryIdsForUser(
  projectId: string,
  userId: string,
  roleKey: RoleKey,
): Promise<string[]> {
  const rows = await prisma.taskCategory.findMany({
    where: buildVisibleCategoryWhere(projectId, userId, roleKey),
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export async function updateCategory(projectId: string, categoryId: string, input: UpdateCategoryInput) {
  if (input.name !== undefined) {
    const existing = await prisma.taskCategory.findFirst({
      where: { projectId, name: input.name, NOT: { id: categoryId } },
    });
    if (existing) {
      throw new ConflictError("A category with this name already exists in this project.");
    }
  }

  return prisma.taskCategory.update({
    where: { id: categoryId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
    },
  });
}

/**
 * Deletion is blocked by two independent invariants, checked live in the
 * same request as the delete (no caching, no TOCTOU window left open):
 *  1. assertNotLastCategory — a project can never be reduced to zero
 *     categories via deletion (the only zero-category state ever allowed is
 *     the transient one between project-creation and first-category-
 *     creation — see docs/PHASES.md).
 *  2. No tasks may remain in the category — mirrors
 *     columns.service.ts#deleteColumn's existing task-count check one
 *     level up, so a category delete can never silently orphan/cascade-
 *     delete real task data.
 */
export async function deleteCategory(projectId: string, categoryId: string) {
  await assertNotLastCategory(projectId);

  const taskCount = await prisma.task.count({ where: { categoryId } });
  if (taskCount > 0) {
    throw new ConflictError(
      "This category still has tasks in it. Move or delete its tasks before deleting the category.",
    );
  }

  try {
    await prisma.taskCategory.delete({ where: { id: categoryId } });
  } catch (_err) {
    // Defense in depth against a race where a task was inserted into this
    // category (in one of its columns) between the count check above and
    // the delete (Task.categoryId's FK is onDelete: Restrict), surfaced as
    // a clean 409 instead of a raw DB error.
    throw new ConflictError(
      "This category still has tasks in it. Move or delete its tasks before deleting the category.",
    );
  }
}

export async function listCategoryMembers(categoryId: string) {
  const memberships = await prisma.categoryMembership.findMany({
    where: { categoryId },
    include: { user: true },
    orderBy: { createdAt: "asc" },
  });

  return memberships.map((m) => ({
    userId: m.userId,
    email: m.user.email,
    displayName: m.user.displayName,
    addedAt: m.createdAt,
  }));
}

export async function addCategoryMember(workspaceId: string, categoryId: string, userId: string) {
  // The target must be an active workspace member first — category
  // membership is always a subset of workspace membership, mirroring
  // addProjectMember's exact validation shape.
  const workspaceMembership = await prisma.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (!workspaceMembership || workspaceMembership.status !== "active") {
    throw new ValidationError("This user is not an active member of this workspace.");
  }

  const existing = await prisma.categoryMembership.findUnique({
    where: { categoryId_userId: { categoryId, userId } },
  });
  if (existing) {
    throw new ConflictError("This user is already a member of this category.");
  }

  return prisma.categoryMembership.create({
    data: { workspaceId, categoryId, userId },
  });
}

export async function removeCategoryMember(categoryId: string, userId: string) {
  const existing = await prisma.categoryMembership.findUnique({
    where: { categoryId_userId: { categoryId, userId } },
  });
  if (!existing) {
    throw new NotFoundError("This user is not a member of this category.");
  }
  await prisma.categoryMembership.delete({ where: { categoryId_userId: { categoryId, userId } } });
}
