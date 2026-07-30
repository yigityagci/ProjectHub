import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../core/prisma.js";
import { env } from "../config/env.js";

export const SESSION_COOKIE_NAME = "ph_session";
export const CSRF_COOKIE_NAME = "ph_csrf";

function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export interface CreateSessionOptions {
  userId: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface CreatedSession {
  id: string;
  rawToken: string;
  expiresAt: Date;
  absoluteExpiresAt: Date;
}

export async function createSession(opts: CreateSessionOptions): Promise<CreatedSession> {
  const rawToken = randomToken();
  const tokenHash = hashToken(rawToken);
  const now = Date.now();
  const expiresAt = new Date(now + env.SESSION_TTL_HOURS * 3600 * 1000);
  const absoluteExpiresAt = new Date(now + env.SESSION_ABSOLUTE_TTL_HOURS * 3600 * 1000);

  const session = await prisma.session.create({
    data: {
      userId: opts.userId,
      tokenHash,
      expiresAt,
      absoluteExpiresAt,
      ip: opts.ip ?? null,
      userAgent: opts.userAgent ?? null,
    },
  });

  return { id: session.id, rawToken, expiresAt, absoluteExpiresAt };
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: "lax" as const,
    path: "/",
  };
}

export function setSessionCookie(reply: FastifyReply, rawToken: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE_NAME, rawToken, {
    ...cookieOptions(),
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, { path: "/" });
}

export function setCsrfCookie(reply: FastifyReply): string {
  const token = crypto.randomBytes(24).toString("base64url");
  reply.setCookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false,
    secure: env.COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
  });
  return token;
}

export function getRawSessionToken(req: FastifyRequest): string | undefined {
  return req.cookies[SESSION_COOKIE_NAME];
}

/**
 * Loads (and idle-slides) a session by its raw cookie token. Returns null if
 * missing, revoked, or expired (idle or absolute).
 */
export async function resolveSession(rawToken: string) {
  const tokenHash = hashToken(rawToken);
  const session = await prisma.session.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!session) return null;
  if (session.revokedAt) return null;

  const now = new Date();
  if (session.expiresAt < now || session.absoluteExpiresAt < now) return null;
  if (session.user.status !== "active") return null;

  // Slide the idle expiry forward, bounded by the absolute expiry.
  const nextExpiry = new Date(
    Math.min(now.getTime() + env.SESSION_TTL_HOURS * 3600 * 1000, session.absoluteExpiresAt.getTime()),
  );

  await prisma.session.update({
    where: { id: session.id },
    data: { expiresAt: nextExpiry, lastSeenAt: now },
  });

  return session;
}

export async function revokeSession(sessionId: string): Promise<void> {
  await prisma.session.update({
    where: { id: sessionId },
    data: { revokedAt: new Date() },
  });
}

/**
 * Revokes every currently-active session for a user. Used by the password
 * reset flow: once a password is reset, every existing logged-in session
 * (which may have been established with the now-replaced password, or by
 * an attacker who had compromised the old one) is invalidated.
 */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Revokes every other currently-active session for a user, preserving
 * `keepSessionId`. Used by password/email change (Settings): unlike a
 * password reset (which revokes everything, since the requester may not be
 * the account holder), these flows are performed by an already-authenticated
 * user who should stay logged in on the device they just used.
 */
export async function revokeAllUserSessionsExcept(userId: string, keepSessionId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { userId, revokedAt: null, id: { not: keepSessionId } },
    data: { revokedAt: new Date() },
  });
}
