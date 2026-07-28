import { z } from "zod";
import { ROLE_KEYS } from "../roles.js";

const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const workspaceNameSchema = z
  .string({ required_error: "Workspace name is required." })
  .trim()
  .min(1, "Workspace name is required.")
  .max(255, "Workspace name must be between 1 and 255 characters.");

export const workspaceSlugSchema = z
  .string({ required_error: "Workspace slug is required." })
  .trim()
  .min(1, "Workspace slug is required.")
  .max(63, "Workspace slug must be between 1 and 63 characters.")
  .regex(
    slugPattern,
    "Workspace slug may only contain lowercase letters, numbers, and hyphens.",
  );

/**
 * Strict allowlist: only name/slug are accepted from the client. Anything
 * else the client sends (ownerId, id, settings, etc.) is rejected outright
 * by Zod's `.strict()` rather than silently ignored, so mass-assignment
 * attempts fail loudly and cannot smuggle privileged fields through.
 */
export const createWorkspaceSchema = z
  .object({
    name: workspaceNameSchema,
    slug: workspaceSlugSchema,
  })
  .strict();
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export const updateWorkspaceSchema = z
  .object({
    name: workspaceNameSchema.optional(),
    settings: z.record(z.unknown()).optional(),
  })
  .strict();
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema>;

export const roleKeySchema = z.enum(ROLE_KEYS, {
  errorMap: () => ({ message: "This role does not exist. Please select a valid role." }),
});

export const updateMemberRoleSchema = z
  .object({
    roleKey: roleKeySchema,
  })
  .strict();
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleSchema>;
