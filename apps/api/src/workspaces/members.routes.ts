import type { FastifyInstance } from "fastify";
import { updateMemberRoleSchema } from "@projecthub/shared";
import type { RoleKey } from "@projecthub/shared";
import { ValidationError, NotFoundError } from "../core/errors.js";
import { prisma } from "../core/prisma.js";
import { requireAuth, requireMembership, requirePermission, requireCsrf } from "../rbac/guards.js";
import { assertCanAssignRole, assertNotLastOwner } from "../rbac/authorize.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { listWorkspaceMembers } from "./workspaces.service.js";
import { revalidateRoomsForUser } from "../realtime/realtime.js";

export async function registerMemberRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/workspaces/:workspaceId/members",
    { preHandler: [requireAuth, requireMembership] },
    async (req, reply) => {
      const members = await listWorkspaceMembers(req.ctx.workspace!.id);
      return reply.send({ members });
    },
  );

  app.patch(
    "/api/workspaces/:workspaceId/members/:userId/role",
    {
      preHandler: [requireAuth, requireCsrf, requireMembership, requirePermission("role.manage")],
    },
    async (req, reply) => {
      const parsed = updateMemberRoleSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }

      const { workspaceId, userId: targetUserId } = req.params as {
        workspaceId: string;
        userId: string;
      };
      const targetRoleKey = parsed.data.roleKey;

      const callerRoleKey = req.ctx.membership!.role.key as RoleKey;
      assertCanAssignRole(callerRoleKey, targetRoleKey);

      const targetMembership = await prisma.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
        include: { role: true },
      });
      if (!targetMembership || targetMembership.status !== "active") {
        throw new NotFoundError("This member could not be found in this workspace.");
      }

      // Prevent demoting the last remaining OWNER.
      if (targetMembership.role.key === "OWNER" && targetRoleKey !== "OWNER") {
        await assertNotLastOwner(workspaceId, targetUserId, "demote");
      }

      const newRole = await prisma.role.findUnique({
        where: { workspaceId_key: { workspaceId, key: targetRoleKey } },
      });
      if (!newRole) {
        throw new ValidationError("This role does not exist. Please select a valid role.");
      }

      const previousRoleKey = targetMembership.role.key;

      const updated = await prisma.workspaceMembership.update({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
        data: { roleId: newRole.id },
        include: { role: true },
      });

      await recordAuditEvent({
        workspaceId,
        actorId: req.ctx.user!.id,
        action: "role.changed",
        targetType: "WorkspaceMembership",
        targetId: updated.id,
        metadata: { targetUserId, previousRole: previousRoleKey, newRole: targetRoleKey },
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });

      // A role change (e.g. a demotion) can immediately reduce which rooms
      // this user is allowed to receive real-time events for; force an
      // eviction re-check right away rather than waiting for their next
      // REST request.
      await revalidateRoomsForUser(targetUserId);

      return reply.send({
        member: { userId: targetUserId, role: updated.role.key },
      });
    },
  );

  app.delete(
    "/api/workspaces/:workspaceId/members/:userId",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requirePermission("member.remove"),
      ],
    },
    async (req, reply) => {
      const { workspaceId, userId: targetUserId } = req.params as {
        workspaceId: string;
        userId: string;
      };

      const targetMembership = await prisma.workspaceMembership.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
        include: { role: true },
      });
      if (!targetMembership || targetMembership.status !== "active") {
        throw new NotFoundError("This member could not be found in this workspace.");
      }

      if (targetMembership.role.key === "OWNER") {
        await assertNotLastOwner(workspaceId, targetUserId, "remove");
      }

      await prisma.workspaceMembership.delete({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      });

      await recordAuditEvent({
        workspaceId,
        actorId: req.ctx.user!.id,
        action: "member.removed",
        targetType: "WorkspaceMembership",
        targetId: targetMembership.id,
        metadata: { targetUserId },
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });

      // The removed member must stop receiving this workspace's (and its
      // projects') real-time events immediately, not just on their next
      // REST call.
      await revalidateRoomsForUser(targetUserId);

      return reply.send({ ok: true });
    },
  );
}
