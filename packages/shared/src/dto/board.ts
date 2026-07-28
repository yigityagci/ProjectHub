import { z } from "zod";

export const COLUMN_CATEGORIES = ["todo", "in_progress", "done"] as const;
export type ColumnCategory = (typeof COLUMN_CATEGORIES)[number];

export const columnNameSchema = z
  .string({ required_error: "Column name is required." })
  .trim()
  .min(1, "Column name is required.")
  .max(100, "Column name must be between 1 and 100 characters.");

export const columnCategorySchema = z.enum(COLUMN_CATEGORIES, {
  errorMap: () => ({ message: "Invalid column category." }),
});

export const createColumnSchema = z
  .object({
    name: columnNameSchema,
    category: columnCategorySchema,
  })
  .strict();
export type CreateColumnInput = z.infer<typeof createColumnSchema>;

export const updateColumnSchema = z
  .object({
    name: columnNameSchema.optional(),
    category: columnCategorySchema.optional(),
  })
  .strict();
export type UpdateColumnInput = z.infer<typeof updateColumnSchema>;

export const reorderColumnsSchema = z
  .object({
    columnIds: z.array(z.string().min(1)).min(1, "At least one column id is required."),
  })
  .strict();
export type ReorderColumnsInput = z.infer<typeof reorderColumnsSchema>;
