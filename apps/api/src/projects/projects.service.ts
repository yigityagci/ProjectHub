import type { Prisma } from "@prisma/client";
import { ROLE_RANK, type RoleKey } from "@projecthub/shared";
import type { CreateProjectInput, ProjectListQuery, UpdateProjectInput } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors.js";

export interface CreateProjectServiceInput extends CreateProjectInput {
  workspaceId: string;
  ownerId: string;
}

/**
 * Creates a project with ZERO categories and therefore zero BoardColumns —
 * a deliberate product decision (Option A, two-step creation UX; see
 * docs/PHASES.md), not an oversight. Phase 2 used to seed 3 default
 * BoardColumns directly here; that seeding has moved one level down to
 * category-creation time (see categories.service.ts#createCategory), since
 * every category now owns its own board. The frontend forces the caller
 * through a mandatory "create your first category" step immediately after
 * this call succeeds, before any board can be reached.
 */
export async function createProject(input: CreateProjectServiceInput) {
  return prisma.project.create({
    data: {
      workspaceId: input.workspaceId,
      name: input.name,
      description: input.description ?? null,
      ownerId: input.ownerId,
      status: input.status ?? "planning",
      visibility: input.visibility ?? "workspace",
      startDate: input.startDate ?? null,
      targetDate: input.targetDate ?? null,
    },
  });
}

/**
 * Builds the Phase 7 search/filter clauses (`q`/`status`/`archived`) as an
 * `AND`-composed array, so they only ever narrow an already access-filtered
 * project list — never replace or relax the visibility rules built by
 * `listProjectsForUser` below. Substring match (`contains`), not a
 * full-text index — same deliberate v1 scaffolding tradeoff as task search.
 */
function buildProjectFilterClauses(filters: ProjectListQuery = {}): Prisma.ProjectWhereInput[] {
  const clauses: Prisma.ProjectWhereInput[] = [];
  if (filters.q) {
    clauses.push({
      OR: [
        { name: { contains: filters.q, mode: "insensitive" } },
        { description: { contains: filters.q, mode: "insensitive" } },
      ],
    });
  }
  if (filters.status) clauses.push({ status: filters.status });
  if (filters.archived !== undefined) clauses.push({ archived: filters.archived });
  return clauses;
}

/**
 * Access-filtered project list, mirroring the same visibility rules as
 * requireProjectAccess:
 *  - CLIENT: only projects they hold a ProjectMembership row for.
 *  - Everyone else: workspace-visible projects, plus any private projects
 *    they hold a ProjectMembership row for, plus (if ranked >= PROJECT_MANAGER)
 *    every private project regardless of membership.
 *
 * `filters` (Phase 7 search/filter) are AND-composed on top of the above —
 * they can only ever narrow this same access-filtered set, never widen it
 * beyond what the caller could already see.
 */
export async function listProjectsForUser(
  workspaceId: string,
  userId: string,
  roleKey: RoleKey,
  filters: ProjectListQuery = {},
) {
  const filterClauses = buildProjectFilterClauses(filters);

  if (roleKey === "CLIENT") {
    return prisma.project.findMany({
      where: {
        workspaceId,
        memberships: { some: { userId } },
        AND: filterClauses,
      },
      orderBy: { createdAt: "asc" },
    });
  }

  const hasElevatedRank = ROLE_RANK[roleKey] >= ROLE_RANK.PROJECT_MANAGER;

  return prisma.project.findMany({
    where: {
      workspaceId,
      AND: [
        {
          OR: [
            { visibility: "workspace" },
            ...(hasElevatedRank ? [{ visibility: "private" as const }] : []),
            { visibility: "private", memberships: { some: { userId } } },
          ],
        },
        ...filterClauses,
      ],
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function updateProject(workspaceId: string, projectId: string, input: UpdateProjectInput) {
  return prisma.project.update({
    where: { id: projectId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
      ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
      ...(input.targetDate !== undefined ? { targetDate: input.targetDate } : {}),
    },
  });
}

export async function archiveProject(projectId: string) {
  return prisma.project.update({
    where: { id: projectId },
    data: { archived: true, archivedAt: new Date() },
  });
}

export async function unarchiveProject(projectId: string) {
  return prisma.project.update({
    where: { id: projectId },
    data: { archived: false, archivedAt: null },
  });
}

/**
 * A bare `project.delete` would let Postgres cascade-delete this project's
 * BoardColumn/TaskCategory rows and its Task rows as sibling cascades from
 * the same parent delete, in unspecified order. Task.taskCategory/Task.column
 * are `onDelete: Restrict` (not Cascade) — if a BoardColumn or TaskCategory
 * cascade fires before its still-referencing Task rows are gone, Postgres
 * raises a foreign key violation and the whole delete 500s. Deleting every
 * Task row first (in the same transaction) clears those RESTRICT blockers up
 * front, so the subsequent project delete's remaining cascades (BoardColumn,
 * TaskCategory, Milestone, Label, ProjectMembership, ActivityEvent, ...) can
 * proceed in any order.
 */
export async function deleteProject(projectId: string) {
  await prisma.$transaction([
    prisma.task.deleteMany({ where: { projectId } }),
    prisma.project.delete({ where: { id: projectId } }),
  ]);
}

export async function listProjectMembers(projectId: string) {
  const memberships = await prisma.projectMembership.findMany({
    where: { projectId },
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

export async function addProjectMember(workspaceId: string, projectId: string, userId: string) {
  // The target must be an active workspace member first — project
  // membership is always a subset of workspace membership.
  const workspaceMembership = await prisma.workspaceMembership.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
  });
  if (!workspaceMembership || workspaceMembership.status !== "active") {
    throw new ValidationError("This user is not an active member of this workspace.");
  }

  const existing = await prisma.projectMembership.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });
  if (existing) {
    throw new ConflictError("This user is already a member of this project.");
  }

  return prisma.projectMembership.create({
    data: { workspaceId, projectId, userId },
  });
}

export async function removeProjectMember(projectId: string, userId: string) {
  const existing = await prisma.projectMembership.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });
  if (!existing) {
    throw new NotFoundError("This user is not a member of this project.");
  }
  await prisma.projectMembership.delete({ where: { projectId_userId: { projectId, userId } } });
}
