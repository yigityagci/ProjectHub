import type { Prisma } from "@prisma/client";
import { prisma } from "../core/prisma.js";
import { logger } from "../core/logger.js";

/**
 * Field names that must never appear in audit metadata. This is a
 * defense-in-depth denylist checked on top of callers only ever passing
 * small, explicit allowlisted metadata objects (never raw request bodies).
 */
const FORBIDDEN_METADATA_KEYS = [
  "password",
  "passwordHash",
  "token",
  "tokenHash",
  "rawToken",
  "secret",
  "appSecret",
  "authorization",
  "cookie",
];

export type AuditAction =
  | "login.succeeded"
  | "login.failed"
  | "admin.setup.completed"
  | "member.invited"
  | "member.removed"
  | "role.changed"
  | "workspace.settings.updated"
  | "session.revoked"
  | "invitation.accepted"
  | "invitation.revoked"
  | "password_reset.requested"
  | "password_reset.completed"
  | "email_change.completed"
  | "email_change.failed"
  | "password_change.completed"
  | "password_change.failed"
  | "account_deletion.completed"
  | "account_deletion.failed"
  | "registration_token.generated"
  | "registration_token.revoked"
  | "agent_token.generated"
  | "agent_token.revoked"
  | "user.registered"
  | "platform.email_config.updated"
  | "platform.email_config.deleted"
  | "platform.email_config.test_sent"
  | "platform.postfix_config.updated"
  | "platform.postfix_config.deleted"
  | "platform.postfix_config.dkim_rotated"
  | "platform.postfix_config.test_sent";

export interface RecordAuditEventInput {
  workspaceId?: string | null;
  actorId?: string | null;
  action: AuditAction;
  targetType?: string | null;
  targetId?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

function sanitizeMetadata(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const lowerKey = key.toLowerCase();
    if (FORBIDDEN_METADATA_KEYS.some((forbidden) => lowerKey.includes(forbidden))) {
      logger.warn({ key }, "Dropped forbidden key from audit metadata");
      continue;
    }
    clean[key] = value;
  }
  return clean;
}

export async function recordAuditEvent(input: RecordAuditEventInput): Promise<void> {
  await prisma.auditLogEntry.create({
    data: {
      workspaceId: input.workspaceId ?? null,
      actorId: input.actorId ?? null,
      action: input.action,
      targetType: input.targetType ?? null,
      targetId: input.targetId ?? null,
      metadata: sanitizeMetadata(input.metadata) as Prisma.InputJsonValue,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    },
  });
}
