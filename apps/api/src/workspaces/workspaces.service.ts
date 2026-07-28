import { ROLE_KEYS, ROLE_DISPLAY_NAME, DEFAULT_ROLE_PERMISSIONS } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { ConflictError } from "../core/errors.js";

export interface CreateWorkspaceInput {
  name: string;
  slug: string;
  ownerId: string;
}

export async function createWorkspace(input: CreateWorkspaceInput) {
  const existingSlug = await prisma.workspace.findUnique({ where: { slug: input.slug } });
  if (existingSlug) {
    throw new ConflictError("A workspace with this slug already exists. Please choose another.");
  }

  return prisma.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({
      data: {
        name: input.name,
        slug: input.slug,
        ownerId: input.ownerId,
      },
    });

    // Seed all six default system roles + their permission rows.
    const roleRecords: Record<string, string> = {};
    for (const roleKey of ROLE_KEYS) {
      const role = await tx.role.create({
        data: {
          workspaceId: workspace.id,
          key: roleKey,
          name: ROLE_DISPLAY_NAME[roleKey],
          isSystem: true,
        },
      });
      roleRecords[roleKey] = role.id;

      const permissions = DEFAULT_ROLE_PERMISSIONS[roleKey];
      if (permissions.length > 0) {
        await tx.rolePermission.createMany({
          data: permissions.map((permission) => ({ roleId: role.id, permission })),
        });
      }
    }

    // The creator becomes the OWNER member.
    await tx.workspaceMembership.create({
      data: {
        workspaceId: workspace.id,
        userId: input.ownerId,
        roleId: roleRecords.OWNER!,
        status: "active",
      },
    });

    return workspace;
  });
}

export async function listWorkspacesForUser(userId: string) {
  const memberships = await prisma.workspaceMembership.findMany({
    where: { userId, status: "active" },
    include: { workspace: true, role: true },
    orderBy: { createdAt: "asc" },
  });

  return memberships.map((m) => ({
    id: m.workspace.id,
    name: m.workspace.name,
    slug: m.workspace.slug,
    createdAt: m.workspace.createdAt,
    role: m.role.key,
  }));
}

export interface UpdateWorkspaceInput {
  name?: string;
  settings?: Record<string, unknown>;
}

export async function updateWorkspace(workspaceId: string, input: UpdateWorkspaceInput) {
  return prisma.workspace.update({
    where: { id: workspaceId },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.settings !== undefined ? { settings: input.settings as object } : {}),
    },
  });
}

export async function listWorkspaceMembers(workspaceId: string) {
  const memberships = await prisma.workspaceMembership.findMany({
    where: { workspaceId, status: "active" },
    include: { user: true, role: true },
    orderBy: { createdAt: "asc" },
  });

  return memberships.map((m) => ({
    userId: m.userId,
    email: m.user.email,
    displayName: m.user.displayName,
    role: m.role.key,
    status: m.status,
    joinedAt: m.createdAt,
  }));
}
