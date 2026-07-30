import crypto from "node:crypto";
import type { RoleKey } from "@projecthub/shared";
import { prisma } from "../core/prisma.js";
import { env } from "../config/env.js";
import { ConflictError, NotFoundError, ValidationError } from "../core/errors.js";
import { normalizeEmail } from "../auth/auth.service.js";

export const INVITATION_INVALID_MESSAGE =
  "This invitation link is invalid or has expired. Please ask the workspace owner to send you a new one.";
export const INVITATION_REVOKED_MESSAGE = "This invitation has been revoked.";
export const INVITATION_ALREADY_USED_MESSAGE = "This invitation has already been used.";
export const ALREADY_MEMBER_MESSAGE = "You're already a member of this workspace.";

function randomInviteToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function hashInviteToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export function buildInvitationLink(rawToken: string): string {
  return `${env.WEB_URL}/invite/accept?token=${rawToken}`;
}

export interface CreateInvitationInput {
  workspaceId: string;
  email: string;
  roleKey: RoleKey;
  invitedById: string;
}

export async function createInvitation(input: CreateInvitationInput) {
  const email = normalizeEmail(input.email);

  const role = await prisma.role.findUnique({
    where: { workspaceId_key: { workspaceId: input.workspaceId, key: input.roleKey } },
  });
  if (!role) {
    throw new ValidationError("This role does not exist. Please select a valid role.");
  }

  const rawToken = randomInviteToken();
  const tokenHash = hashInviteToken(rawToken);
  const expiresAt = new Date(Date.now() + env.INVITE_TTL_HOURS * 3600 * 1000);

  try {
    const invitation = await prisma.invitation.create({
      data: {
        workspaceId: input.workspaceId,
        email,
        roleId: role.id,
        tokenHash,
        invitedById: input.invitedById,
        expiresAt,
      },
    });
    return { invitation, rawToken };
  } catch (err) {
    // Unique violation raised by the partial unique index on
    // (workspaceId, email) WHERE status = 'pending'.
    if (isUniqueConstraintError(err)) {
      throw new ConflictError(
        "There is already a pending invitation for this email address in this workspace.",
      );
    }
    throw err;
  }
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "P2002"
  );
}

export async function getInvitationByToken(rawToken: string) {
  const tokenHash = hashInviteToken(rawToken);
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash },
    include: { workspace: true, role: true },
  });

  if (!invitation) {
    throw new NotFoundError(INVITATION_INVALID_MESSAGE);
  }

  if (invitation.status === "revoked") {
    throw new ConflictError(INVITATION_REVOKED_MESSAGE);
  }
  if (invitation.status === "accepted") {
    throw new ConflictError(INVITATION_ALREADY_USED_MESSAGE);
  }
  if (invitation.status === "expired" || invitation.expiresAt < new Date()) {
    throw new ConflictError(INVITATION_INVALID_MESSAGE);
  }

  return invitation;
}

export interface AcceptInvitationInput {
  rawToken: string;
  currentUserId: string;
  currentUserEmail: string;
}

export async function acceptInvitation(input: AcceptInvitationInput) {
  const tokenHash = hashInviteToken(input.rawToken);

  return prisma.$transaction(async (tx) => {
    const invitation = await tx.invitation.findUnique({
      where: { tokenHash },
      include: { role: true, workspace: true },
    });

    if (!invitation) {
      throw new NotFoundError(INVITATION_INVALID_MESSAGE);
    }
    if (invitation.status === "revoked") {
      throw new ConflictError(INVITATION_REVOKED_MESSAGE);
    }
    if (invitation.status === "accepted") {
      throw new ConflictError(INVITATION_ALREADY_USED_MESSAGE);
    }
    if (invitation.status === "expired" || invitation.expiresAt < new Date()) {
      throw new ConflictError(INVITATION_INVALID_MESSAGE);
    }

    const invitedEmail = normalizeEmail(invitation.email);
    const currentEmail = normalizeEmail(input.currentUserEmail);
    if (invitedEmail !== currentEmail) {
      const err = new ConflictError(
        `The email you're signed in with (${input.currentUserEmail}) doesn't match this invitation (${invitation.email}). Please sign in as ${invitation.email} or ask the workspace owner for a new invite.`,
      );
      throw err;
    }

    const existingMembership = await tx.workspaceMembership.findUnique({
      where: {
        workspaceId_userId: { workspaceId: invitation.workspaceId, userId: input.currentUserId },
      },
    });

    if (existingMembership && existingMembership.status === "active") {
      // Idempotent accept: the user is already a member, so there is
      // nothing to change. Throwing here rolls back the transaction
      // cleanly (no partial writes) and surfaces a clear message.
      throw new ConflictError(ALREADY_MEMBER_MESSAGE);
    }

    await tx.workspaceMembership.create({
      data: {
        workspaceId: invitation.workspaceId,
        userId: input.currentUserId,
        roleId: invitation.roleId,
        status: "active",
      },
    });

    const updatedInvitation = await tx.invitation.update({
      where: { id: invitation.id },
      data: { status: "accepted", acceptedAt: new Date(), acceptedUserId: input.currentUserId },
    });

    return { invitation: updatedInvitation, workspace: invitation.workspace, role: invitation.role };
  });
}

/**
 * Lists only *pending* invitations for a workspace (accepted/revoked/expired
 * ones are excluded — those are historical, not actionable from this list).
 * Ordered newest-first so a manager sees the invitations they just sent at
 * the top.
 */
export async function listWorkspaceInvitations(workspaceId: string) {
  const invitations = await prisma.invitation.findMany({
    where: { workspaceId, status: "pending" },
    include: { role: true },
    orderBy: { createdAt: "desc" },
  });

  return invitations.map((invitation) => ({
    id: invitation.id,
    email: invitation.email,
    roleKey: invitation.role.key,
    roleName: invitation.role.name,
    status: invitation.status,
    expiresAt: invitation.expiresAt,
    createdAt: invitation.createdAt,
  }));
}

export async function revokeInvitation(workspaceId: string, invitationId: string) {
  const invitation = await prisma.invitation.findUnique({ where: { id: invitationId } });
  if (!invitation || invitation.workspaceId !== workspaceId) {
    throw new NotFoundError("This invitation could not be found.");
  }
  if (invitation.status !== "pending") {
    throw new ConflictError("This invitation cannot be revoked because it is no longer pending.");
  }

  return prisma.invitation.update({
    where: { id: invitationId },
    data: { status: "revoked" },
  });
}
