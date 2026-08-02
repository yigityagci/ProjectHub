import type { FastifyInstance } from "fastify";
import { createRegistrationTokenSchema, type RoleKey } from "@projecthub/shared";
import { ValidationError } from "../core/errors.js";
import { requireAuth, requireCsrf, requireMembership, requirePermission } from "../rbac/guards.js";
import { assertCanAssignRole } from "../rbac/authorize.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import {
  generateRegistrationToken,
  listRegistrationTokens,
  revokeRegistrationToken,
} from "./registration-token.service.js";

export async function registerRegistrationTokenRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/workspaces/:workspaceId/registration-tokens",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requirePermission("registration_token.manage"),
      ],
    },
    async (req, reply) => {
      const parsed = createRegistrationTokenSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }

      // A caller may only mint a token for a role at or below their own
      // rank — otherwise an ADMIN could hand out an OWNER-creating token.
      // Mirrors members.routes.ts's role-change route exactly.
      const callerRoleKey = req.ctx.membership!.role.key as RoleKey;
      assertCanAssignRole(callerRoleKey, parsed.data.roleKey);

      const workspace = req.ctx.workspace!;
      const { token, rawToken } = await generateRegistrationToken({
        workspaceId: workspace.id,
        createdById: req.ctx.user!.id,
        roleKey: parsed.data.roleKey,
        label: parsed.data.label,
      });

      await recordAuditEvent({
        workspaceId: workspace.id,
        actorId: req.ctx.user!.id,
        action: "registration_token.generated",
        targetType: "RegistrationToken",
        targetId: token.id,
        metadata: { roleKey: parsed.data.roleKey },
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });

      return reply.code(201).send({
        registrationToken: {
          id: token.id,
          label: token.label,
          roleKey: parsed.data.roleKey,
          createdAt: token.createdAt,
          expiresAt: token.expiresAt,
        },
        // The raw token only ever appears in this one response, at
        // creation — it is never returned from the list endpoint.
        rawToken,
      });
    },
  );

  app.get(
    "/api/workspaces/:workspaceId/registration-tokens",
    {
      preHandler: [requireAuth, requireMembership, requirePermission("registration_token.manage")],
    },
    async (req, reply) => {
      const registrationTokens = await listRegistrationTokens(req.ctx.workspace!.id);
      return reply.send({ registrationTokens });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/registration-tokens/:id/revoke",
    {
      preHandler: [
        requireAuth,
        requireCsrf,
        requireMembership,
        requirePermission("registration_token.manage"),
      ],
    },
    async (req, reply) => {
      const { workspaceId, id } = req.params as { workspaceId: string; id: string };
      const token = await revokeRegistrationToken(workspaceId, id);

      await recordAuditEvent({
        workspaceId,
        actorId: req.ctx.user!.id,
        action: "registration_token.revoked",
        targetType: "RegistrationToken",
        targetId: token.id,
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });

      return reply.send({ ok: true });
    },
  );
}
