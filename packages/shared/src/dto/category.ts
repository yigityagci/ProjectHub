import { z } from "zod";

export const CATEGORY_VISIBILITIES = ["workspace", "private"] as const;
export type CategoryVisibility = (typeof CATEGORY_VISIBILITIES)[number];

export const categoryNameSchema = z
  .string({ required_error: "Category name is required." })
  .trim()
  .min(1, "Category name is required.")
  .max(255, "Category name must be between 1 and 255 characters.");

export const categoryVisibilitySchema = z.enum(CATEGORY_VISIBILITIES, {
  errorMap: () => ({ message: "Invalid category visibility." }),
});

/**
 * Strict allowlist: only fields a client may set at creation time.
 * `workspaceId`/`projectId`/`id` are always derived server-side from the
 * already-verified route params, never accepted from the request body —
 * mirrors createProjectSchema/createColumnSchema exactly.
 */
export const createCategorySchema = z
  .object({
    name: categoryNameSchema,
    visibility: categoryVisibilitySchema.optional(),
  })
  .strict();
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export const updateCategorySchema = z
  .object({
    name: categoryNameSchema.optional(),
    visibility: categoryVisibilitySchema.optional(),
  })
  .strict();
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;

export const addCategoryMemberSchema = z
  .object({
    userId: z.string().min(1, "userId is required."),
  })
  .strict();
export type AddCategoryMemberInput = z.infer<typeof addCategoryMemberSchema>;
