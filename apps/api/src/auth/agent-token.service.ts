import crypto from "node:crypto";
import { prisma } from "../core/prisma.js";
import { env } from "../config/env.js";
import { NotFoundError, ConflictError } from "../core/errors.js";

/**
 * Deliberately duplicated random/hash helpers (rather than importing
 * session.ts's) — this mirrors this codebase's established convention: every
 * bearer-token model (Session, RegistrationToken, PasswordResetToken) has
 * its own local copies of the exact same two primitives. See
 * registration-token.service.ts for the precedent.
 */
function randomAgentToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function hashAgentToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export interface GenerateAgentTokenInput {
  userId: string;
  label: string;
}

export interface GeneratedAgentToken {
  agentToken: {
    id: string;
    label: string;
    createdAt: Date;
    expiresAt: Date;
    lastUsedAt: Date | null;
    revokedAt: Date | null;
  };
  rawToken: string;
}

/**
 * Mints a brand-new AgentToken. `rawToken` is returned from this function
 * exactly once, ever — it is never persisted anywhere (only its sha256 hash
 * is stored), and no other function in this file can ever reconstruct it.
 */
export async function generateAgentToken(input: GenerateAgentTokenInput): Promise<GeneratedAgentToken> {
  const rawToken = randomAgentToken();
  const tokenHash = hashAgentToken(rawToken);
  const expiresAt = new Date(Date.now() + env.AGENT_TOKEN_TTL_DAYS * 24 * 3600 * 1000);

  const token = await prisma.agentToken.create({
    data: {
      userId: input.userId,
      tokenHash,
      label: input.label,
      expiresAt,
    },
  });

  return {
    agentToken: {
      id: token.id,
      label: token.label,
      createdAt: token.createdAt,
      expiresAt: token.expiresAt,
      lastUsedAt: token.lastUsedAt,
      revokedAt: token.revokedAt,
    },
    rawToken,
  };
}

export interface ResolvedAgentToken {
  id: string;
  label: string;
  userId: string;
  user: {
    id: string;
    email: string;
    displayName: string;
    isPlatformAdmin: boolean;
    status: string;
  };
}

/**
 * Resolves a raw bearer token to its AgentToken + owning user, or `null` for
 * EVERY failure mode uniformly (unknown hash, revoked, expired, or the
 * owning user no longer active) — callers must not be able to distinguish
 * these cases; they all become the same 401. Never compares the presented
 * secret via string equality — always hashes and looks up by the unique
 * `tokenHash` index. On success, unconditionally bumps `lastUsedAt`.
 */
export async function resolveAgentToken(rawToken: string): Promise<ResolvedAgentToken | null> {
  const tokenHash = hashAgentToken(rawToken);
  const token = await prisma.agentToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!token) return null;
  if (token.revokedAt !== null) return null;
  if (token.expiresAt < new Date()) return null;
  if (token.user.status !== "active") return null;

  await prisma.agentToken.update({
    where: { id: token.id },
    data: { lastUsedAt: new Date() },
  });

  return {
    id: token.id,
    label: token.label,
    userId: token.userId,
    user: {
      id: token.user.id,
      email: token.user.email,
      displayName: token.user.displayName,
      isPlatformAdmin: token.user.isPlatformAdmin,
      status: token.user.status,
    },
  };
}

export interface AgentTokenListItem {
  id: string;
  label: string;
  createdAt: Date;
  expiresAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Newest-first listing for a single user's own AgentTokens. Never returns
 * `tokenHash` or any raw value.
 */
export async function listAgentTokens(userId: string): Promise<AgentTokenListItem[]> {
  const tokens = await prisma.agentToken.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });

  return tokens.map((t) => ({
    id: t.id,
    label: t.label,
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt,
    revokedAt: t.revokedAt,
  }));
}

/**
 * Revokes one of the caller's own AgentTokens. If the token doesn't exist OR
 * belongs to a different user, throws the SAME not-found error in both
 * cases — never leaks existence of another user's token via a different
 * status code (mirrors auth.routes.ts's session-revoke handler). Revoking an
 * already-revoked token is a 409, mirroring revokeRegistrationToken's
 * already-revoked convention.
 */
export async function revokeAgentToken(userId: string, tokenId: string) {
  const token = await prisma.agentToken.findUnique({ where: { id: tokenId } });
  if (!token || token.userId !== userId) {
    throw new NotFoundError("This agent token could not be found.");
  }
  if (token.revokedAt !== null) {
    throw new ConflictError("This agent token has already been revoked.");
  }

  return prisma.agentToken.update({
    where: { id: tokenId },
    data: { revokedAt: new Date() },
  });
}

/**
 * Revokes every currently-active AgentToken for a user. Called from the
 * password-reset flow and from self-service account deletion, mirroring
 * session.ts#revokeAllUserSessions's exact "nuke everything, this identity
 * may have been compromised or is going away" semantics — deliberately NOT
 * called from the password-CHANGE flow (which uses
 * revokeAllUserSessionsExcept and leaves agent tokens alone), mirroring the
 * existing asymmetry where password change doesn't revoke every other
 * session either.
 */
export async function revokeAllUserAgentTokens(userId: string): Promise<void> {
  await prisma.agentToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
