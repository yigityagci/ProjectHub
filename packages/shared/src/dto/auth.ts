import { z } from "zod";

/**
 * Password policy: at least 12 characters, including uppercase, lowercase,
 * a digit, and a symbol. Message text matches the design handoff exactly.
 */
export const PASSWORD_POLICY_MESSAGE =
  "Your password must be at least 12 characters and include uppercase letters, lowercase letters, numbers, and symbols.";

export const passwordSchema = z
  .string()
  .min(12, PASSWORD_POLICY_MESSAGE)
  .refine((value) => /[a-z]/.test(value), PASSWORD_POLICY_MESSAGE)
  .refine((value) => /[A-Z]/.test(value), PASSWORD_POLICY_MESSAGE)
  .refine((value) => /[0-9]/.test(value), PASSWORD_POLICY_MESSAGE)
  .refine((value) => /[^a-zA-Z0-9]/.test(value), PASSWORD_POLICY_MESSAGE);

export const emailSchema = z.string().trim().min(1).email().max(320);

export const displayNameSchema = z.string().trim().min(1).max(255);

export const registerSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    displayName: displayNameSchema,
  })
  .strict();
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1),
  })
  .strict();
export type LoginInput = z.infer<typeof loginSchema>;

export const setupSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    displayName: displayNameSchema,
  })
  .strict();
export type SetupInput = z.infer<typeof setupSchema>;

export const requestPasswordResetSchema = z
  .object({
    email: emailSchema,
  })
  .strict();
export type RequestPasswordResetInput = z.infer<typeof requestPasswordResetSchema>;

export const confirmPasswordResetSchema = z
  .object({
    token: z.string().min(1),
    password: passwordSchema,
  })
  .strict();
export type ConfirmPasswordResetInput = z.infer<typeof confirmPasswordResetSchema>;
