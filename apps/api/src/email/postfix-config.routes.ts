import crypto from "node:crypto";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { updatePostfixConfigSchema, generateDkimKeySchema } from "@projecthub/shared";
import type { PlatformPostfixConfig } from "@prisma/client";
import { AppError, ValidationError } from "../core/errors.js";
import { requireAuth, requireCsrf, requirePlatformAdmin } from "../rbac/guards.js";
import { recordAuditEvent } from "../audit/audit.service.js";
import { decryptSecret } from "../core/secret-box.js";
import {
  getPostfixConfigRow,
  serializePostfixConfig,
  upsertPostfixConfig,
  recordApplyResult,
  storeDkimKey,
  deletePostfixConfig,
} from "./postfix-config.service.js";
import { PLATFORM_EMAIL_CONFIG_ID, serializePlatformEmailConfig } from "./platform-email-config.service.js";
import { invalidateEmailTransportCache } from "./email.service.js";
import { runDnsCheck } from "./dns-check.service.js";
import {
  applyConfig,
  validateConfig,
  readStatus,
  readQueueSummary,
  sendControlTestEmail,
  getSelfHostedAvailability,
  invalidateSelfHostedAvailability,
  type MailControlApplyPayload,
  type MailControlValidatePayload,
} from "./mail-control.client.js";
import { prisma } from "../core/prisma.js";

const generateKeyPairAsync = promisify(crypto.generateKeyPair);

// Distinct, tighter-than-default rate limits per route — mirrors the
// TEST_EMAIL_RATE_LIMIT precedent in platform-email.routes.ts. Every
// mutating/expensive op here also dispatches a real network call to the
// mail-control listener (or generates an RSA keypair), so each gets its
// own budget rather than sharing the global default.
const PATCH_RATE_LIMIT = { max: 20, timeWindow: "15 minutes" };
const APPLY_RATE_LIMIT = { max: 10, timeWindow: "15 minutes" };
const VALIDATE_RATE_LIMIT = { max: 30, timeWindow: "5 minutes" };
const DKIM_KEY_RATE_LIMIT = { max: 5, timeWindow: "15 minutes" };
const STATUS_RATE_LIMIT = { max: 60, timeWindow: "1 minute" };
const QUEUE_RATE_LIMIT = { max: 60, timeWindow: "1 minute" };
const TEST_EMAIL_RATE_LIMIT = { max: 5, timeWindow: "15 minutes" };
const DNS_CHECK_RATE_LIMIT = { max: 20, timeWindow: "5 minutes" };

/**
 * Audit metadata allowlist — deliberately excludes dkimPrivateKeyCiphertext
 * and any key material. This is the PRIMARY control (not
 * audit.service.ts's FORBIDDEN_METADATA_KEYS denylist, which does not
 * catch a field literally named `dkimPrivateKeyCiphertext`).
 */
function postfixAuditMetadata(
  row: {
    enabled: boolean;
    sendingDomain: string;
    mailHostname: string;
    dkimSelector: string;
    dkimSigningEnabled: boolean;
    destinationRateDelaySeconds: number;
    destinationConcurrencyLimit: number;
    messageSizeLimitBytes: number;
  },
  applyOk: boolean | null,
) {
  return {
    enabled: row.enabled,
    sendingDomain: row.sendingDomain,
    mailHostname: row.mailHostname,
    dkimSelector: row.dkimSelector,
    dkimSigningEnabled: row.dkimSigningEnabled,
    destinationRateDelaySeconds: row.destinationRateDelaySeconds,
    destinationConcurrencyLimit: row.destinationConcurrencyLimit,
    messageSizeLimitBytes: row.messageSizeLimitBytes,
    applyOk,
  };
}

/** Builds the mail-control wire payload's `dkim` field (never null here — always a typed object). */
function buildDkimPayload(
  row: Pick<PlatformPostfixConfig, "dkimSigningEnabled" | "dkimSelector" | "dkimPrivateKeyCiphertext">,
  includePrivateKey: boolean,
): MailControlApplyPayload["dkim"] {
  const base = { enabled: row.dkimSigningEnabled, selector: row.dkimSelector };
  if (!includePrivateKey || !row.dkimSigningEnabled) {
    return base;
  }
  if (!row.dkimPrivateKeyCiphertext) {
    throw new ValidationError("Generate a DKIM key before enabling DKIM signing.");
  }
  return { ...base, privateKeyPem: decryptSecret(row.dkimPrivateKeyCiphertext) };
}

function buildValidatePayload(row: {
  sendingDomain: string;
  mailHostname: string;
  senderName: string;
  replyToAddress: string | null;
  dkimSigningEnabled: boolean;
  dkimSelector: string;
  dkimPrivateKeyCiphertext: string | null;
  destinationRateDelaySeconds: number;
  destinationConcurrencyLimit: number;
  messageSizeLimitBytes: number;
}): MailControlValidatePayload {
  return {
    sendingDomain: row.sendingDomain,
    mailHostname: row.mailHostname,
    senderName: row.senderName,
    replyToAddress: row.replyToAddress,
    dkim: buildDkimPayload(row, false),
    limits: {
      destinationRateDelaySeconds: row.destinationRateDelaySeconds,
      destinationConcurrencyLimit: row.destinationConcurrencyLimit,
      messageSizeLimitBytes: row.messageSizeLimitBytes,
    },
  };
}

function buildApplyPayload(row: {
  sendingDomain: string;
  mailHostname: string;
  senderName: string;
  replyToAddress: string | null;
  dkimSigningEnabled: boolean;
  dkimSelector: string;
  dkimPrivateKeyCiphertext: string | null;
  destinationRateDelaySeconds: number;
  destinationConcurrencyLimit: number;
  messageSizeLimitBytes: number;
}): MailControlApplyPayload {
  return {
    sendingDomain: row.sendingDomain,
    mailHostname: row.mailHostname,
    senderName: row.senderName,
    replyToAddress: row.replyToAddress,
    dkim: buildDkimPayload(row, true),
    limits: {
      destinationRateDelaySeconds: row.destinationRateDelaySeconds,
      destinationConcurrencyLimit: row.destinationConcurrencyLimit,
      messageSizeLimitBytes: row.messageSizeLimitBytes,
    },
  };
}

/** Strips PEM headers/footers/whitespace, leaving the base64 SPKI body — exactly what's published in a DKIM DNS TXT record. */
function spkiPemToBase64Body(spkiPem: string): string {
  return spkiPem
    .split("\n")
    .filter((line) => !line.includes("-----"))
    .join("")
    .trim();
}

function chunkDkimValue(value: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < value.length; i += 255) {
    chunks.push(value.slice(i, i + 255));
  }
  return chunks;
}

export async function registerPostfixConfigRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/api/platform/mail-delivery",
    { preHandler: [requireAuth, requirePlatformAdmin] },
    async (_req, reply) => {
      const [smtpRow, postfixRow, selfHosted] = await Promise.all([
        prisma.platformEmailConfig.findUnique({
          where: { id: PLATFORM_EMAIL_CONFIG_ID },
          include: { updatedBy: { select: { displayName: true } } },
        }),
        getPostfixConfigRow(),
        getSelfHostedAvailability(),
      ]);

      const postfixWithUpdatedBy = postfixRow
        ? await prisma.platformPostfixConfig.findUnique({
            where: { id: postfixRow.id },
            include: { updatedBy: { select: { displayName: true } } },
          })
        : null;

      return reply.send({
        mode: postfixRow?.enabled ? "postfix" : "smtp",
        smtp: smtpRow ? serializePlatformEmailConfig(smtpRow) : null,
        postfix: postfixWithUpdatedBy ? serializePostfixConfig(postfixWithUpdatedBy) : null,
        selfHosted: {
          available: selfHosted.available,
          reason: selfHosted.reason,
          detail: selfHosted.detail,
          checkedAt: selfHosted.checkedAt,
        },
      });
    },
  );

  app.patch(
    "/api/platform/postfix-config",
    {
      preHandler: [requireAuth, requireCsrf, requirePlatformAdmin],
      config: { rateLimit: PATCH_RATE_LIMIT },
    },
    async (req, reply) => {
      const parsed = updatePostfixConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const input = parsed.data;

      // Never trust the frontend to have honored the disabled UI state —
      // re-check availability server-side on every attempt to enable.
      if (input.enabled) {
        const availability = await getSelfHostedAvailability();
        if (!availability.available) {
          throw new AppError(503, "SELF_HOSTED_UNAVAILABLE", availability.detail);
        }
      }

      const existing = await getPostfixConfigRow();
      const effectiveDkimSigningEnabled = input.dkimSigningEnabled ?? existing?.dkimSigningEnabled ?? false;
      if (effectiveDkimSigningEnabled && !existing?.dkimPrivateKeyCiphertext) {
        throw new ValidationError("Generate a DKIM key before enabling DKIM signing.");
      }

      // Step 3: validate against the listener BEFORE any DB write, so a
      // listener-side rejection leaves nothing persisted. Skipped when
      // enabled === false (the admin must always be able to turn
      // self-hosted mode off, or edit its fields, while the container is
      // down/unreachable).
      if (input.enabled) {
        const validatePayload = buildValidatePayload({
          sendingDomain: input.sendingDomain,
          mailHostname: input.mailHostname,
          senderName: input.senderName,
          replyToAddress: input.replyToAddress === undefined ? existing?.replyToAddress ?? null : input.replyToAddress,
          dkimSigningEnabled: effectiveDkimSigningEnabled,
          dkimSelector: input.dkimSelector ?? existing?.dkimSelector ?? "projecthub",
          dkimPrivateKeyCiphertext: existing?.dkimPrivateKeyCiphertext ?? null,
          destinationRateDelaySeconds: input.destinationRateDelaySeconds,
          destinationConcurrencyLimit: input.destinationConcurrencyLimit,
          messageSizeLimitBytes: input.messageSizeLimitBytes,
        });
        const validateResult = await validateConfig(validatePayload);
        if (!validateResult.ok) {
          throw new ValidationError(
            validateResult.error ?? "The mail-control service rejected this configuration.",
            validateResult.fieldErrors,
          );
        }
      }

      const savedRow = await upsertPostfixConfig(input, req.ctx.user!.id);

      let applyOk: boolean | null = existing?.lastApplyOk ?? null;
      let applyError: string | undefined;
      let applyWarnings: string[] | undefined;

      if (input.enabled) {
        const applyPayload = buildApplyPayload(savedRow);
        try {
          const applyResult = await applyConfig(applyPayload);
          applyOk = applyResult.ok;
          applyError = applyResult.error;
          applyWarnings = applyResult.postfixCheck?.warnings;
        } catch (err) {
          applyOk = false;
          applyError = err instanceof Error ? err.message : "Failed to apply the configuration.";
        }

        await recordApplyResult({ ok: applyOk, error: applyOk ? null : applyError ?? null });
        invalidateEmailTransportCache();
        invalidateSelfHostedAvailability();
      }

      const finalRow = await prisma.platformPostfixConfig.findUnique({
        where: { id: savedRow.id },
        include: { updatedBy: { select: { displayName: true } } },
      });

      await recordAuditEvent({
        workspaceId: null,
        actorId: req.ctx.user!.id,
        action: "platform.postfix_config.updated",
        targetType: "PlatformPostfixConfig",
        targetId: "singleton",
        metadata: postfixAuditMetadata(savedRow, applyOk),
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });

      return reply.send({
        config: serializePostfixConfig(finalRow!),
        apply: {
          ok: applyOk ?? true,
          ...(applyError ? { error: applyError } : {}),
          ...(applyWarnings && applyWarnings.length > 0 ? { warnings: applyWarnings } : {}),
        },
      });
    },
  );

  app.post(
    "/api/platform/postfix-config/apply",
    {
      preHandler: [requireAuth, requireCsrf, requirePlatformAdmin],
      config: { rateLimit: APPLY_RATE_LIMIT },
    },
    async (req, reply) => {
      const row = await getPostfixConfigRow();
      if (!row) {
        throw new ValidationError("No self-hosted Postfix configuration has been saved yet.");
      }
      if (!row.enabled) {
        throw new ValidationError("Self-hosted Postfix mode is not enabled. Enable it first.");
      }

      const availability = await getSelfHostedAvailability();
      if (!availability.available) {
        throw new AppError(503, "SELF_HOSTED_UNAVAILABLE", availability.detail);
      }

      const applyPayload = buildApplyPayload(row);
      let applyOk: boolean;
      let applyError: string | undefined;
      let applyWarnings: string[] | undefined;
      try {
        const applyResult = await applyConfig(applyPayload);
        applyOk = applyResult.ok;
        applyError = applyResult.error;
        applyWarnings = applyResult.postfixCheck?.warnings;
      } catch (err) {
        applyOk = false;
        applyError = err instanceof Error ? err.message : "Failed to apply the configuration.";
      }

      await recordApplyResult({ ok: applyOk, error: applyOk ? null : applyError ?? null });
      invalidateEmailTransportCache();
      invalidateSelfHostedAvailability();

      const finalRow = await prisma.platformPostfixConfig.findUnique({
        where: { id: row.id },
        include: { updatedBy: { select: { displayName: true } } },
      });

      await recordAuditEvent({
        workspaceId: null,
        actorId: req.ctx.user!.id,
        action: "platform.postfix_config.updated",
        targetType: "PlatformPostfixConfig",
        targetId: "singleton",
        metadata: postfixAuditMetadata(finalRow!, applyOk),
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });

      return reply.send({
        config: serializePostfixConfig(finalRow!),
        apply: {
          ok: applyOk,
          ...(applyError ? { error: applyError } : {}),
          ...(applyWarnings && applyWarnings.length > 0 ? { warnings: applyWarnings } : {}),
        },
      });
    },
  );

  app.post(
    "/api/platform/postfix-config/validate",
    {
      preHandler: [requireAuth, requireCsrf, requirePlatformAdmin],
      config: { rateLimit: VALIDATE_RATE_LIMIT },
    },
    async (req, reply) => {
      const parsed = updatePostfixConfigSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }
      const input = parsed.data;
      const existing = await getPostfixConfigRow();

      const validatePayload = buildValidatePayload({
        sendingDomain: input.sendingDomain,
        mailHostname: input.mailHostname,
        senderName: input.senderName,
        replyToAddress: input.replyToAddress === undefined ? existing?.replyToAddress ?? null : input.replyToAddress,
        dkimSigningEnabled: input.dkimSigningEnabled ?? existing?.dkimSigningEnabled ?? false,
        dkimSelector: input.dkimSelector ?? existing?.dkimSelector ?? "projecthub",
        dkimPrivateKeyCiphertext: existing?.dkimPrivateKeyCiphertext ?? null,
        destinationRateDelaySeconds: input.destinationRateDelaySeconds,
        destinationConcurrencyLimit: input.destinationConcurrencyLimit,
        messageSizeLimitBytes: input.messageSizeLimitBytes,
      });

      const result = await validateConfig(validatePayload);
      return reply.send(result);
    },
  );

  app.post(
    "/api/platform/postfix-config/dkim-key",
    {
      preHandler: [requireAuth, requireCsrf, requirePlatformAdmin],
      config: { rateLimit: DKIM_KEY_RATE_LIMIT },
    },
    async (req, reply) => {
      const parsed = generateDkimKeySchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Invalid input.");
      }

      const existing = await getPostfixConfigRow();
      if (!existing) {
        throw new ValidationError(
          "Save the sending domain and mail hostname (PATCH /api/platform/postfix-config) before generating a DKIM key.",
        );
      }

      // ASYNC key generation, never generateKeyPairSync — a synchronous
      // 4096-bit RSA keypair generation blocks the event loop for seconds,
      // a trivial admin-session DoS against every other request in flight.
      const { publicKey, privateKey } = await generateKeyPairAsync("rsa", {
        modulusLength: parsed.data.keyBits,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });

      const publicKeyBase64 = spkiPemToBase64Body(publicKey);

      const updated = await storeDkimKey({
        selector: existing.dkimSelector,
        keyBits: parsed.data.keyBits,
        privateKeyPem: privateKey,
        publicKeySpkiBase64: publicKeyBase64,
      });

      const dnsValue = `v=DKIM1; k=rsa; p=${publicKeyBase64}`;

      await recordAuditEvent({
        workspaceId: null,
        actorId: req.ctx.user!.id,
        action: "platform.postfix_config.dkim_rotated",
        targetType: "PlatformPostfixConfig",
        targetId: "singleton",
        metadata: { selector: updated.dkimSelector, keyBits: parsed.data.keyBits },
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });

      return reply.send({
        dkim: {
          selector: updated.dkimSelector,
          keyBits: parsed.data.keyBits,
          generatedAt: updated.dkimGeneratedAt,
          dnsRecord: {
            name: `${updated.dkimSelector}._domainkey.${updated.sendingDomain}`,
            type: "TXT",
            value: dnsValue,
            chunkedValue: chunkDkimValue(dnsValue),
          },
        },
      });
    },
  );

  app.get(
    "/api/platform/postfix-config/status",
    {
      preHandler: [requireAuth, requirePlatformAdmin],
      config: { rateLimit: STATUS_RATE_LIMIT },
    },
    async (_req, reply) => {
      const result = await readStatus();
      return reply.send(result);
    },
  );

  app.get(
    "/api/platform/postfix-config/queue",
    {
      preHandler: [requireAuth, requirePlatformAdmin],
      config: { rateLimit: QUEUE_RATE_LIMIT },
    },
    async (_req, reply) => {
      const result = await readQueueSummary();
      return reply.send(result);
    },
  );

  app.post(
    "/api/platform/postfix-config/test-email",
    {
      preHandler: [requireAuth, requireCsrf, requirePlatformAdmin],
      config: { rateLimit: TEST_EMAIL_RATE_LIMIT },
    },
    async (req, reply) => {
      // Same anti-abuse rationale as POST /api/platform/email-config/test:
      // the recipient is ALWAYS the caller's own account email, never
      // client-supplied.
      const recipientEmail = req.ctx.user!.email;

      let ok = true;
      let error: string | undefined;
      let detail: { code?: string } | undefined;
      let result: Awaited<ReturnType<typeof sendControlTestEmail>> | undefined;
      try {
        result = await sendControlTestEmail(recipientEmail);
        ok = result.ok !== false;
      } catch (err) {
        ok = false;
        error = err instanceof Error ? err.message : "Failed to send the test email.";
        detail = err instanceof AppError ? { code: err.code } : undefined;
      }

      await recordAuditEvent({
        workspaceId: null,
        actorId: req.ctx.user!.id,
        action: "platform.postfix_config.test_sent",
        targetType: "PlatformPostfixConfig",
        targetId: "singleton",
        metadata: { ok },
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });

      return reply.send(ok ? { ok, ...result } : { ok, error, ...(detail ? { detail } : {}) });
    },
  );

  app.get(
    "/api/platform/postfix-config/dns-check",
    {
      preHandler: [requireAuth, requirePlatformAdmin],
      config: { rateLimit: DNS_CHECK_RATE_LIMIT },
    },
    async (_req, reply) => {
      const row = await getPostfixConfigRow();
      if (!row) {
        throw new ValidationError(
          "Save the sending domain and mail hostname (PATCH /api/platform/postfix-config) before checking DNS.",
        );
      }

      const result = await runDnsCheck({
        sendingDomain: row.sendingDomain,
        mailHostname: row.mailHostname,
        dkimSelector: row.dkimSelector,
        dkimPublicKey: row.dkimPublicKey,
      });
      return reply.send(result);
    },
  );

  app.delete(
    "/api/platform/postfix-config",
    { preHandler: [requireAuth, requireCsrf, requirePlatformAdmin] },
    async (req, reply) => {
      await deletePostfixConfig();
      invalidateEmailTransportCache();
      invalidateSelfHostedAvailability();

      await recordAuditEvent({
        workspaceId: null,
        actorId: req.ctx.user!.id,
        action: "platform.postfix_config.deleted",
        targetType: "PlatformPostfixConfig",
        targetId: "singleton",
        ip: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
      });

      return reply.send({ ok: true });
    },
  );
}
