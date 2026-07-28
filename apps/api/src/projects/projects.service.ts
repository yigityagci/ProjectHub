import { ROLE_RANK, type RoleKey } from "@projecthub/shared";
import type { CreateProjectInput, UpdateProjectInput } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors.js";

const DEFAULT_COLUMNS = [
  { name: "To Do", category: "todo" as const, position: 1 },
  { name: "In Progress", category: "in_progress" as const, position: 2 },
  { name: "Done", category: "done" as const, position: 3 },
];

export interface CreateProjectServiceInput extends CreateProjectInput {
  workspaceId: string;
  ownerId: string;
}

export async function createProject(input: CreateProjectServiceInput) {
  return prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
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

    await tx.boardColumn.createMany({
      data: DEFAULT_COLUMNS.map((c) => ({
        workspaceId: input.workspaceId,
        projectId: project.id,
        name: c.name,
        category: c.category,
        position: c.position,
      })),
    });

    return project;
  });
}

/**
 * Access-filtered project list, mirroring the same visibility rules as
 * requireProjectAccess:
 *  - CLIENT: only projects they hold a ProjectMembership row for.
 *  - Everyone else: workspace-visible projects, plus any private projects
 *    they hold a ProjectMembership row for, plus (if ranked >= PROJECT_MANAGER)
 *    every private project regardless of membership.
 */
export async function listProjectsForUser(workspaceId: string, userId: string, roleKey: RoleKey) {
  if (roleKey === "CLIENT") {
    return prisma.project.findMany({
      where: {
        workspaceId,
        memberships: { some: { userId } },
      },
      orderBy: { createdAt: "asc" },
    });
  }

  const hasElevatedRank = ROLE_RANK[roleKey] >= ROLE_RANK.PROJECT_MANAGER;

  return prisma.project.findMany({
    where: {
      workspaceId,
      OR: [
        { visibility: "workspace" },
        ...(hasElevatedRank ? [{ visibility: "private" as const }] : []),
        { visibility: "private", memberships: { some: { userId } } },
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

export async function deleteProject(projectId: string) {
  await prisma.project.delete({ where: { id: projectId } });
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
