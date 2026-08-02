import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { RoleKey } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { env } from "../config/env.js";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors.js";

/**
 * Single generic message for every token-failure mode (missing, expired,
 * revoked, already used) — mirrors PASSWORD_RESET_INVALID_MESSAGE /
 * INVITATION_INVALID_MESSAGE's non-leaking pattern exactly. Never
 * distinguish these cases in the response, even though the threat model
 * here (an internal onboarding token, not a bearer credential mailed to one
 * person) is slightly different.
 */
export const REGISTRATION_TOKEN_INVALID_MESSAGE =
  "This registration token is invalid or has expired. Please ask a workspace admin for a new one.";

function randomRegistrationToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function hashRegistrationToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

// Either the top-level PrismaClient or a $transaction callback's tx client —
// both expose the same `.registrationToken` delegate used here.
type PrismaOrTx = typeof prisma | Prisma.TransactionClient;

export interface GenerateRegistrationTokenInput {
  workspaceId: string;
  createdById: string;
  roleKey: RoleKey;
  label?: string;
}

/**
 * Resolves roleKey -> this workspace's Role row exactly like
 * createInvitation does, so a redeemed token can create a
 * WorkspaceMembership pointed at a concrete roleId. Caller (the route) is
 * responsible for the assertCanAssignRole rank check before calling this —
 * mirrors members.routes.ts's role-change route, which checks rank in the
 * route rather than the service.
 */
export async function generateRegistrationToken(input: GenerateRegistrationTokenInput) {
  const role = await prisma.role.findUnique({
    where: { workspaceId_key: { workspaceId: input.workspaceId, key: input.roleKey } },
  });
  if (!role) {
    throw new ValidationError("This role does not exist. Please select a valid role.");
  }

  const rawToken = randomRegistrationToken();
  const tokenHash = hashRegistrationToken(rawToken);
  const expiresAt = new Date(Date.now() + env.REGISTRATION_TOKEN_TTL_DAYS * 24 * 3600 * 1000);

  const token = await prisma.registrationToken.create({
    data: {
      workspaceId: input.workspaceId,
      roleId: role.id,
      createdById: input.createdById,
      label: input.label ?? null,
      tokenHash,
      expiresAt,
    },
  });

  return { token, rawToken };
}

/**
 * Newest-first, resolving `usedByUserId` to a display-friendly form (email)
 * the same way listWorkspaceInvitations resolves roleKey/roleName from a
 * relation. Never returns tokenHash or any raw token.
 */
export async function listRegistrationTokens(workspaceId: string) {
  const tokens = await prisma.registrationToken.findMany({
    where: { workspaceId },
    include: { createdBy: true, usedBy: true, role: true },
    orderBy: { createdAt: "desc" },
  });

  return tokens.map((t) => ({
    id: t.id,
    label: t.label,
    roleKey: t.role.key,
    roleName: t.role.name,
    createdAt: t.createdAt,
    createdByEmail: t.createdBy.email,
    createdByDisplayName: t.createdBy.displayName,
    expiresAt: t.expiresAt,
    usedAt: t.usedAt,
    usedByEmail: t.usedBy?.email ?? null,
    usedByDisplayName: t.usedBy?.displayName ?? null,
    revokedAt: t.revokedAt,
  }));
}

export async function revokeRegistrationToken(workspaceId: string, tokenId: string) {
  const token = await prisma.registrationToken.findUnique({ where: { id: tokenId } });
  if (!token || token.workspaceId !== workspaceId) {
    throw new NotFoundError("This registration token could not be found.");
  }
  if (token.revokedAt !== null) {
    throw new ConflictError("This registration token has already been revoked.");
  }
  if (token.usedAt !== null) {
    throw new ConflictError("This registration token has already been used and cannot be revoked.");
  }
  if (token.expiresAt < new Date()) {
    throw new ConflictError("This registration token has already expired.");
  }

  return prisma.registrationToken.update({
    where: { id: tokenId },
    data: { revokedAt: new Date() },
  });
}

/**
 * Validates a raw registration token and returns its row, WITHOUT marking
 * it used — the caller (registerUser, see auth.service.ts) must do that
 * atomically together with the user-creation write, inside the same
 * `prisma.$transaction`, so a failed registration (e.g. duplicate email)
 * never consumes the token. Accepts an optional transaction client so it
 * can be called from within that same transaction.
 */
export async function consumeRegistrationToken(rawToken: string, client: PrismaOrTx = prisma) {
  const tokenHash = hashRegistrationToken(rawToken);
  const token = await client.registrationToken.findUnique({
    where: { tokenHash },
    include: { workspace: true, role: true },
  });

  if (!token) {
    throw new NotFoundError(REGISTRATION_TOKEN_INVALID_MESSAGE);
  }
  if (
    token.usedAt !== null ||
    token.revokedAt !== null ||
    token.expiresAt < new Date()
  ) {
    throw new NotFoundError(REGISTRATION_TOKEN_INVALID_MESSAGE);
  }

  return token;
}
