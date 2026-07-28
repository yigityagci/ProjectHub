import { z } from "zod";

const hexColorPattern = /^#[0-9a-fA-F]{6}$/;

export const labelNameSchema = z
  .string({ required_error: "Label name is required." })
  .trim()
  .min(1, "Label name is required.")
  .max(50, "Label name must be between 1 and 50 characters.");

export const labelColorSchema = z
  .string({ required_error: "Label color is required." })
  .trim()
  .regex(hexColorPattern, "Label color must be a hex color, e.g. #4287f5.");

export const createLabelSchema = z
  .object({
    name: labelNameSchema,
    color: labelColorSchema,
  })
  .strict();
export type CreateLabelInput = z.infer<typeof createLabelSchema>;

export const updateLabelSchema = z
  .object({
    name: labelNameSchema.optional(),
    color: labelColorSchema.optional(),
  })
  .strict();
export type UpdateLabelInput = z.infer<typeof updateLabelSchema>;
