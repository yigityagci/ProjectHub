import type { FastifyInstance } from "fastify";
import {
  createProjectSchema,
  updateProjectSchema,
  addProjectMemberSchema,
} from "@projecthub/shared";
import type { RoleKey } from "@projecthub/shared";
import { ValidationError, NotFoundError } from "../core/errors.js";
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
  deleteProject,
  listProjectMembers,
  addProjectMember,
  removeProjectMember,
} from "./projects.service.js";

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
      const roleKey = req.ctx.membership!.role.key as RoleKey;
      const projects = await listProjectsForUser(req.ctx.workspace!.id, req.ctx.user!.id, roleKey);
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
      return reply.send({ ok: true });
    },
  );
}
