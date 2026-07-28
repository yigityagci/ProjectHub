import { prisma } from "../core/prisma.js";
import { ConflictError, ValidationError } from "../core/errors.js";
import { hashPassword } from "./password.js";

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
  isPlatformAdmin?: boolean;
}

export async function registerUser(input: RegisterUserInput) {
  const email = normalizeEmail(input.email);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    // Generic message: don't confirm which detail (email vs password
    // strength) caused the failure beyond "this email is taken".
    throw new ConflictError(GENERIC_DUPLICATE_EMAIL_MESSAGE);
  }

  const passwordHash = await hashPassword(input.password);

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      displayName: input.displayName,
      isPlatformAdmin: input.isPlatformAdmin ?? false,
    },
  });

  return user;
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
