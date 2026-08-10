import type { FastifyInstance } from "fastify";
import { createAgentTokenSchema } from "@projecthub/shared";
import { ValidationError } from "../core/errors.js";
import { requireAuth, requireCsrf, requireSessionAuth } from "../rbac/guards.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { generateAgentToken, listAgentTokens, revokeAgentToken } from "./agent-token.service.js";
import { LOGIN_RATE_LIMIT } from "./auth.routes.js";

/**
 * Self-service AgentToken lifecycle (generate/list/revoke) for the caller's
 * OWN tokens — a user's own Account/Security settings, not a workspace-admin
 * surface (AgentToken is user-scoped, not workspace-scoped; see
 * agent-token.service.ts). Every route requires `requireSessionAuth`: an
 * agent token can never be used to mint or manage bearer credentials of any
 * kind, including its own kind — see rbac/guards.ts#requireSessionAuth's doc
 * comment for the full rationale.
 */
export async function registerAgentTokenRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/auth/me/agent-tokens",
    {
      config: { rateLimit: LOGIN_RATE_LIMIT },
      preHandler: [requireAuth, requireCsrf, requireSessionAuth],
    },
    async (req, reply) => {
      const parsed = createAgentTokenSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }

      const { agentToken, rawToken } = await generateAgentToken({
        userId: req.ctx.user!.id,
        label: parsed.data.label,
      });

      // targetId carries the id (never metadata — a metadata key literally
      // named e.g. `agentTokenId` would be silently dropped by
      // audit.service.ts's FORBIDDEN_METADATA_KEYS substring-match-on-
      // "token"). workspaceId is null: AgentToken is user-scoped, not
      // workspace-scoped.
      await recordAuditEvent({
        workspaceId: null,
        actorId: req.ctx.user!.id,
        action: "agent_token.generated",
        targetType: "AgentToken",
        targetId: agentToken.id,
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });

      return reply.code(201).send({
        agentToken,
        // The raw token only ever appears in this one response, at
        // creation — it is never returned from the list endpoint.
        rawToken,
      });
    },
  );

  app.get(
    "/api/auth/me/agent-tokens",
    { preHandler: [requireAuth, requireSessionAuth] },
    async (req, reply) => {
      const agentTokens = await listAgentTokens(req.ctx.user!.id);
      return reply.send({ agentTokens });
    },
  );

  app.post(
    "/api/auth/me/agent-tokens/:id/revoke",
    { preHandler: [requireAuth, requireCsrf, requireSessionAuth] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const token = await revokeAgentToken(req.ctx.user!.id, id);

      await recordAuditEvent({
        workspaceId: null,
        actorId: req.ctx.user!.id,
        action: "agent_token.revoked",
        targetType: "AgentToken",
        targetId: token.id,
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });

      return reply.send({ ok: true });
    },
  );
}
