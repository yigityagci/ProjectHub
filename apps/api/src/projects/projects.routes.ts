import type { FastifyInstance } from "fastify";
import {
  createProjectSchema,
  updateProjectSchema,
  addProjectMemberSchema,
  projectListQuerySchema,
  duplicateProjectSchema,
} from "@projecthub/shared";
import type { Permission, RoleKey } from "@projecthub/shared";
import { ValidationError, NotFoundError, ForbiddenError } from "../core/errors.js";
import {
  requireAuth,
  requireCsrf,
  requireMembership,
  requireProjectAccess,
  requirePermission,
} from "../rbac/guards.js";
import {
  createProject,
  listProjectsForUser,
  updateProject,
  archiveProject,
  unarchiveProject,
  deleteProject,
  listProjectMembers,
  addProjectMember,
  removeProjectMember,
} from "./projects.service.js";
import { duplicateProject } from "./projects.duplicate.service.js";
import { emitToProject, revalidateRoomsForUser } from "../realtime/realtime.js";

/**
 * "Duplicate project" isn't gated by a single new permission — it literally
 * performs a create-project + create-category + create-column + create-label
 * + create-custom-field action in one flow, so the caller must be
 * independently entitled to every one of those underlying actions. Expressed
 * as this explicit AND-of-existing-permissions (rather than inventing one new
 * key) so it stays automatically correct if any one of these five
 * permissions' grants is ever changed independently later.
 */
const DUPLICATE_PROJECT_PERMISSIONS: Permission[] = [
  "project.create",
  "category.manage",
  "board.manage",
  "label.manage",
  "custom_field.manage",
];

function serializeProject(project: {
  id: string;
  name: string;
  description: string | null;
  status: string;
  visibility: string;
  ownerId: string;
  startDate: Date | null;
  targetDate: Date | null;
  archived: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    status: project.status,
    visibility: project.visibility,
    ownerId: project.ownerId,
    startDate: project.startDate,
    targetDate: project.targetDate,
    archived: project.archived,
    archivedAt: project.archivedAt,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/workspaces/:workspaceId/projects",
    {
      preHandler: [requireAuth, requireCsrf, requireMembership, requirePermission("project.create")],
    },
    async (req, reply) => {
      const parsed = createProjectSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }

      const project = await createProject({
        ...parsed.data,
        workspaceId: req.ctx.workspace!.id,
        ownerId: req.ctx.user!.id,
      });

      return reply.code(201).send({ project: serializeProject(project) });
    },
  );

  app.get(
    "/api/workspaces/:workspaceId/projects",
    { preHandler: [requireAuth, requireMembership] },
    async (req, reply) => {
      const parsed = projectListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid filter parameters.");
      }
      const roleKey = req.ctx.membership!.role.key as RoleKey;
      // req.ctx.workspace!.id always comes from requireMembership's already
      // -verified :workspaceId — filters below can only narrow this same
      // workspace's access-filtered project list, never widen it.
      const projects = await listProjectsForUser(
        req.ctx.workspace!.id,
        req.ctx.user!.id,
        roleKey,
        parsed.data,
      );
      return reply.send({ projects: projects.map(serializeProject) });
    },
  );

  app.get(
    "/api/workspaces/:workspaceId/projects/:projectId",
    { preHandler: [requireAuth, requireMembership, requireProjectAccess] },
    async (req, reply) => {
      return reply.send({ project: serializeProject(req.ctx.project!) });
    },
  );

  app.patch(
    "/api/workspaces/:workspaceId/projects/:projectId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("project.edit"),
      ],
    },
    async (req, reply) => {
      const parsed = updateProjectSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const updated = await updateProject(req.ctx.workspace!.id, req.ctx.project!.id, parsed.data);
      return reply.send({ project: serializeProject(updated) });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/projects/:projectId/archive",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("project.archive"),
      ],
    },
    async (req, reply) => {
      const updated = await archiveProject(req.ctx.project!.id);
      return reply.send({ project: serializeProject(updated) });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/projects/:projectId/unarchive",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("project.archive"),
      ],
    },
    async (req, reply) => {
      const updated = await unarchiveProject(req.ctx.project!.id);
      return reply.send({ project: serializeProject(updated) });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/projects/:projectId/duplicate",
    {
      // :projectId here is the SOURCE project's id. requireProjectAccess on
      // the source is the load-bearing access check: without it, a caller
      // who globally holds project.create etc. but can't see this specific
      // private project could still duplicate it.
      preHandler: [requireAuth, requireCsrf, requireMembership, requireProjectAccess],
    },
    async (req, reply) => {
      for (const permission of DUPLICATE_PROJECT_PERMISSIONS) {
        if (!req.ctx.permissions?.has(permission)) {
          throw new ForbiddenError();
        }
      }

      const parsed = duplicateProjectSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }

      const roleKey = req.ctx.membership!.role.key as RoleKey;
      const result = await duplicateProject({
        workspaceId: req.ctx.workspace!.id,
        sourceProjectId: req.ctx.project!.id,
        actorId: req.ctx.user!.id,
        actorRoleKey: roleKey,
        name: parsed.data.name,
      });

      return reply.code(201).send({
        project: serializeProject(result.project),
        copied: result.copied,
      });
    },
  );

  app.delete(
    "/api/workspaces/:workspaceId/projects/:projectId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("project.delete"),
      ],
    },
    async (req, reply) => {
      await deleteProject(req.ctx.project!.id);
      return reply.send({ ok: true });
    },
  );

  app.get(
    "/api/workspaces/:workspaceId/projects/:projectId/members",
    { preHandler: [requireAuth, requireMembership, requireProjectAccess] },
    async (req, reply) => {
      const members = await listProjectMembers(req.ctx.project!.id);
      return reply.send({ members });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/projects/:projectId/members",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("project.members.manage"),
      ],
    },
    async (req, reply) => {
      const parsed = addProjectMemberSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }

      await addProjectMember(req.ctx.workspace!.id, req.ctx.project!.id, parsed.data.userId);
      emitToProject(req.ctx.project!.id, "project.member.changed", {
        projectId: req.ctx.project!.id,
        userId: parsed.data.userId,
        action: "added",
      });
      return reply.code(201).send({ ok: true });
    },
  );

  app.delete(
    "/api/workspaces/:workspaceId/projects/:projectId/members/:userId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requireProjectAccess,
        requirePermission("project.members.manage"),
      ],
    },
    async (req, reply) => {
      const { userId } = req.params as { userId: string };
      if (!userId) {
        throw new NotFoundError("This member could not be found in this project.");
      }
      await removeProjectMember(req.ctx.project!.id, userId);
      emitToProject(req.ctx.project!.id, "project.member.changed", {
        projectId: req.ctx.project!.id,
        userId,
        action: "removed",
      });
      // A removed project member may have lost access to this (private)
      // project's real-time room; force an immediate re-check so they stop
      // receiving further events for it, mirroring the "permissions take
      // effect immediately" guarantee.
      await revalidateRoomsForUser(userId);
      return reply.send({ ok: true });
    },
  );
}
