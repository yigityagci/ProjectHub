import { z } from "zod";

export const milestoneNameSchema = z
  .string({ required_error: "Milestone name is required." })
  .trim()
  .min(1, "Milestone name is required.")
  .max(255, "Milestone name must be between 1 and 255 characters.");

export const createMilestoneSchema = z
  .object({
    name: milestoneNameSchema,
    description: z.string().trim().max(10000).optional(),
    targetDate: z.coerce.date().nullable().optional(),
  })
  .strict();
export type CreateMilestoneInput = z.infer<typeof createMilestoneSchema>;

export const updateMilestoneSchema = z
  .object({
    name: milestoneNameSchema.optional(),
    description: z.string().trim().max(10000).nullable().optional(),
    targetDate: z.coerce.date().nullable().optional(),
    completedAt: z.coerce.date().nullable().optional(),
  })
  .strict();
export type UpdateMilestoneInput = z.infer<typeof updateMilestoneSchema>;
