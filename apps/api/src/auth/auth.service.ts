import { prisma } from "../core/prisma.js";
import { ConflictError, ValidationError } from "../core/errors.js";
import { hashPassword } from "./password.js";
import { consumeRegistrationToken } from "./registration-token.service.js";

export const GENERIC_DUPLICATE_EMAIL_MESSAGE =
  "An account with this email address already exists.";
export const GENERIC_LOGIN_FAILURE_MESSAGE = "Invalid email or password. Please try again.";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface RegisterUserInput {
  email: string;
  password: string;
  displayName: string;
  registrationToken: string;
  isPlatformAdmin?: boolean;
}

/**
 * Creates the user, joins them to the token's workspace with the token's
 * role, AND marks the token used — all in a single transaction. Mirrors
 * consumePasswordResetToken's lookup+write-together shape, and
 * acceptInvitation's membership-creation shape. If anything fails
 * (duplicate email), the whole transaction rolls back, so the token is
 * never consumed and can be retried with a corrected email.
 */
export async function registerUser(input: RegisterUserInput) {
  const email = normalizeEmail(input.email);

  return prisma.$transaction(async (tx) => {
    const token = await consumeRegistrationToken(input.registrationToken, tx);

    const existing = await tx.user.findUnique({ where: { email } });
    if (existing) {
      // Generic message: don't confirm which detail (email vs password
      // strength) caused the failure beyond "this email is taken".
      throw new ConflictError(GENERIC_DUPLICATE_EMAIL_MESSAGE);
    }

    const passwordHash = await hashPassword(input.password);

    const user = await tx.user.create({
      data: {
        email,
        passwordHash,
        displayName: input.displayName,
        isPlatformAdmin: input.isPlatformAdmin ?? false,
      },
    });

    await tx.workspaceMembership.create({
      data: {
        workspaceId: token.workspaceId,
        userId: user.id,
        roleId: token.roleId,
        status: "active",
      },
    });

    await tx.registrationToken.update({
      where: { id: token.id },
      data: { usedAt: new Date(), usedByUserId: user.id },
    });

    return { user, workspace: token.workspace, role: token.role };
  });
}

export async function findUserByEmail(email: string) {
  return prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
}

export function assertNoUnknownFields<T extends object>(_input: T): void {
  // Placeholder retained for readability at call sites; actual
  // allowlisting happens via Zod `.strict()` schemas in @projecthub/shared.
  void _input;
}

export function ensureValidWorkspaceName(name: unknown): asserts name is string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new ValidationError("Workspace name is required.");
  }
  if (name.trim().length > 255) {
    throw new ValidationError("Workspace name must be between 1 and 255 characters.");
  }
}
