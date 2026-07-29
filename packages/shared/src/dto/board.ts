import { z } from "zod";

export const COLUMN_CATEGORIES = ["todo", "in_progress", "done"] as const;
export type ColumnCategory = (typeof COLUMN_CATEGORIES)[number];

const hexColorPattern = /^#[0-9a-fA-F]{6}$/;

export const columnNameSchema = z
  .string({ required_error: "Column name is required." })
  .trim()
  .min(1, "Column name is required.")
  .max(100, "Column name must be between 1 and 100 characters.");

export const columnCategorySchema = z.enum(COLUMN_CATEGORIES, {
  errorMap: () => ({ message: "Invalid column category." }),
});

// Optional custom accent color for a column, independent of its
// todo/in_progress/done category — a hex color string like the existing
// Label.color convention (see packages/shared/src/dto/label.ts). Nullable on
// update so a user can explicitly clear a custom color back to "use the
// category default".
export const columnColorSchema = z
  .string()
  .trim()
  .regex(hexColorPattern, "Column color must be a hex color, e.g. #4F46E5.");

export const createColumnSchema = z
  .object({
    name: columnNameSchema,
    category: columnCategorySchema,
    color: columnColorSchema.nullable().optional(),
  })
  .strict();
export type CreateColumnInput = z.infer<typeof createColumnSchema>;

export const updateColumnSchema = z
  .object({
    name: columnNameSchema.optional(),
    category: columnCategorySchema.optional(),
    color: columnColorSchema.nullable().optional(),
  })
  .strict();
export type UpdateColumnInput = z.infer<typeof updateColumnSchema>;

export const reorderColumnsSchema = z
  .object({
    columnIds: z.array(z.string().min(1)).min(1, "At least one column id is required."),
  })
  .strict();
export type ReorderColumnsInput = z.infer<typeof reorderColumnsSchema>;
