import { z } from "zod";

export const PROJECT_STATUSES = ["planning", "active", "on_hold", "completed"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_VISIBILITIES = ["workspace", "private"] as const;
export type ProjectVisibility = (typeof PROJECT_VISIBILITIES)[number];

export const projectNameSchema = z
  .string({ required_error: "Project name is required." })
  .trim()
  .min(1, "Project name is required.")
  .max(255, "Project name must be between 1 and 255 characters.");

export const projectStatusSchema = z.enum(PROJECT_STATUSES, {
  errorMap: () => ({ message: "Invalid project status." }),
});

export const projectVisibilitySchema = z.enum(PROJECT_VISIBILITIES, {
  errorMap: () => ({ message: "Invalid project visibility." }),
});

/**
 * Strict allowlist: only fields a client may set at creation time. `ownerId`
 * is always derived from the authenticated caller server-side, never
 * accepted from the request body.
 */
export const createProjectSchema = z
  .object({
    name: projectNameSchema,
    description: z.string().trim().max(10000).optional(),
    status: projectStatusSchema.optional(),
    visibility: projectVisibilitySchema.optional(),
    startDate: z.coerce.date().optional(),
    targetDate: z.coerce.date().optional(),
  })
  .strict();
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({
    name: projectNameSchema.optional(),
    description: z.string().trim().max(10000).nullable().optional(),
    status: projectStatusSchema.optional(),
    visibility: projectVisibilitySchema.optional(),
    startDate: z.coerce.date().nullable().optional(),
    targetDate: z.coerce.date().nullable().optional(),
  })
  .strict();
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const addProjectMemberSchema = z
  .object({
    userId: z.string().min(1, "userId is required."),
  })
  .strict();
export type AddProjectMemberInput = z.infer<typeof addProjectMemberSchema>;

/**
 * Phase 7 search/filter query params for `GET .../projects`. `q` is a
 * plain substring match over name/description; results are still filtered
 * through the exact same access-visibility rules as before (this only ever
 * narrows the already-access-filtered list, never widens it).
 */
export const projectListQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(255).optional(),
    status: projectStatusSchema.optional(),
    archived: z
      .enum(["true", "false"])
      .transform((v) => v === "true")
      .optional(),
  })
  .strict();
export type ProjectListQuery = z.infer<typeof projectListQuerySchema>;
