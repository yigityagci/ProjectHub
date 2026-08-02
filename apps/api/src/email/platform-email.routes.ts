import type { FastifyInstance } from "fastify";
import { updatePlatformEmailConfigSchema } from "@projecthub/shared";
import { ValidationError } from "../core/errors.js";
import { requireAuth, requireCsrf, requirePlatformAdmin } from "../rbac/guards.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import {
  PLATFORM_EMAIL_CONFIG_ID,
  serializePlatformEmailConfig,
  upsertPlatformEmailConfig,
  deletePlatformEmailConfig,
} from "./platform-email-config.service.js";
import { sendTestEmail, invalidateEmailTransportCache } from "./email.service.js";
import { prisma } from "../core/prisma.js";

// Distinct from LOGIN_RATE_LIMIT/PASSWORD_RESET_RATE_LIMIT in auth.routes.ts —
// this endpoint actually dispatches an SMTP send on every call, so it gets
// its own, tighter limit to blunt abuse via a compromised admin session.
const TEST_EMAIL_RATE_LIMIT = { max: 5, timeWindow: "15 minutes" };

/** Audit metadata for a saved config — deliberately excludes username and,
 * of course, the password/ciphertext (the FORBIDDEN_METADATA_KEYS denylist
 * in audit.service.ts is defense in depth here, not the primary control). */
function configAuditMetadata(row: { enabled: boolean; host: string; port: number; security: string; fromAddress: string }) {
  return {
    enabled: row.enabled,
    host: row.host,
    port: row.port,
    security: row.security,
    fromAddress: row.fromAddress,
  };
}

export async function registerPlatformEmailRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/platform/email-config",
    { preHandler: [requireAuth, requirePlatformAdmin] },
    async (_req, reply) => {
      const row = await prisma.platformEmailConfig.findUnique({
        where: { id: PLATFORM_EMAIL_CONFIG_ID },
        include: { updatedBy: { select: { displayName: true } } },
      });
      return reply.send({ config: row ? serializePlatformEmailConfig(row) : null });
    },
  );

  app.patch(
    "/api/platform/email-config",
    { preHandler: [requireAuth, requireCsrf, requirePlatformAdmin] },
    async (req, reply) => {
      const parsed = updatePlatformEmailConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }

      const config = await upsertPlatformEmailConfig(parsed.data, req.ctx.user!.id);
      invalidateEmailTransportCache();

      await recordAuditEvent({
        workspaceId: null,
        actorId: req.ctx.user!.id,
        action: "platform.email_config.updated",
        targetType: "PlatformEmailConfig",
        targetId: "singleton",
        metadata: configAuditMetadata(config),
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });

      return reply.send({ config });
    },
  );

  app.post(
    "/api/platform/email-config/test",
    {
      preHandler: [requireAuth, requireCsrf, requirePlatformAdmin],
      config: { rateLimit: TEST_EMAIL_RATE_LIMIT },
    },
    async (req, reply) => {
      // The recipient is ALWAYS the caller's own account email — never
      // client-supplied — to prevent open-relay/spam abuse via a
      // compromised admin session.
      const recipientEmail = req.ctx.user!.email;

      let ok = true;
      let error: string | undefined;
      try {
        await sendTestEmail(recipientEmail);
      } catch (err) {
        ok = false;
        error = err instanceof Error ? err.message : "Failed to send the test email.";
      }

      await recordAuditEvent({
        workspaceId: null,
        actorId: req.ctx.user!.id,
        action: "platform.email_config.test_sent",
        targetType: "PlatformEmailConfig",
        targetId: "singleton",
        metadata: { ok },
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });

      return reply.send(ok ? { ok } : { ok, error });
    },
  );

  app.delete(
    "/api/platform/email-config",
    { preHandler: [requireAuth, requireCsrf, requirePlatformAdmin] },
    async (req, reply) => {
      await deletePlatformEmailConfig();
      invalidateEmailTransportCache();

      await recordAuditEvent({
        workspaceId: null,
        actorId: req.ctx.user!.id,
        action: "platform.email_config.deleted",
        targetType: "PlatformEmailConfig",
        targetId: "singleton",
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });

      return reply.send({ ok: true });
    },
  );
}
