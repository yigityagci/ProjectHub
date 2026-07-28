import type { FastifyInstance } from "fastify";
import { createInvitationSchema } from "@projecthub/shared";
import { ValidationError, ForbiddenError } from "../core/errors.js";
import { requireAuth, requireMembership, requirePermission, requireCsrf } from "../rbac/guards.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { sendInvitationEmail } from "../email/email.service.js";
import {
  createInvitation,
  getInvitationByToken,
  acceptInvitation,
  revokeInvitation,
  buildInvitationLink,
} from "./invitations.service.js";

export async function registerInvitationRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/workspaces/:workspaceId/invitations",
    {
      preHandler: [requireAuth, requireCsrf, requireMembership, requirePermission("member.invite")],
    },
    async (req, reply) => {
      const parsed = createInvitationSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }

      const workspace = req.ctx.workspace!;
      const { invitation, rawToken } = await createInvitation({
        workspaceId: workspace.id,
        email: parsed.data.email,
        roleKey: parsed.data.roleKey,
        invitedById: req.ctx.user!.id,
      });

      const link = buildInvitationLink(rawToken);
      // The raw token only ever appears in the emailed (or dev-logged)
      // link — it is never included in this API response.
      await sendInvitationEmail({
        inviterName: req.ctx.user!.displayName,
        invitedEmail: parsed.data.email,
        workspaceName: workspace.name,
        invitationLink: link,
      });

      await recordAuditEvent({
        workspaceId: workspace.id,
        actorId: req.ctx.user!.id,
        action: "member.invited",
        targetType: "Invitation",
        targetId: invitation.id,
        metadata: { invitedEmail: parsed.data.email, roleKey: parsed.data.roleKey },
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });

      return reply.code(201).send({
        invitation: {
          id: invitation.id,
          email: invitation.email,
          status: invitation.status,
          expiresAt: invitation.expiresAt,
        },
      });
    },
  );

  app.get(
    "/api/invitations/:token",
    { config: { rateLimit: { max: 30, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const { token } = req.params as { token: string };
      const invitation = await getInvitationByToken(token);

      return reply.send({
        workspaceName: invitation.workspace.name,
        roleName: invitation.role.name,
        roleKey: invitation.role.key,
        email: invitation.email,
        expiresAt: invitation.expiresAt,
      });
    },
  );

  app.post(
    "/api/invitations/:token/accept",
    { preHandler: [requireAuth, requireCsrf] },
    async (req, reply) => {
      const { token } = req.params as { token: string };

      const result = await acceptInvitation({
        rawToken: token,
        currentUserId: req.ctx.user!.id,
        currentUserEmail: req.ctx.user!.email,
      });

      await recordAuditEvent({
        workspaceId: result.workspace.id,
        actorId: req.ctx.user!.id,
        action: "invitation.accepted",
        targetType: "Invitation",
        targetId: result.invitation.id,
        metadata: { roleKey: result.role.key },
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });

      return reply.send({
        workspace: { id: result.workspace.id, name: result.workspace.name, slug: result.workspace.slug },
        role: result.role.key,
      });
    },
  );

  app.post(
    "/api/workspaces/:workspaceId/invitations/:id/revoke",
    { preHandler: [requireAuth, requireCsrf, requireMembership] },
    async (req, reply) => {
      const canInvite = req.ctx.permissions?.has("member.invite");
      const canManageRoles = req.ctx.permissions?.has("role.manage");
      if (!canInvite && !canManageRoles) {
        throw new ForbiddenError();
      }

      const { workspaceId, id } = req.params as { workspaceId: string; id: string };
      const invitation = await revokeInvitation(workspaceId, id);

      await recordAuditEvent({
        workspaceId,
        actorId: req.ctx.user!.id,
        action: "invitation.revoked",
        targetType: "Invitation",
        targetId: invitation.id,
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });

      return reply.send({ ok: true });
    },
  );
}
