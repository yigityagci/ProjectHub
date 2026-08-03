import { z } from "zod";

/**
 * Custom-field types for project-scoped CustomFieldDefinition. `multi_select`
 * is snake_case because it is the literal wire value stored in the DB's
 * CustomFieldType enum (see apps/api/prisma/schema.prisma) — mirrors
 * ColumnCategory's `in_progress`.
 */
export const CUSTOM_FIELD_TYPES = [
  "text",
  "number",
  "date",
  "select",
  "multi_select",
  "checkbox",
  "url",
] as const;

export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const customFieldTypeSchema = z.enum(CUSTOM_FIELD_TYPES, {
  errorMap: () => ({ message: "Invalid custom field type." }),
});

export const MAX_CUSTOM_FIELDS_PER_PROJECT = 50;
export const MAX_CUSTOM_FIELD_OPTIONS = 50;
export const MAX_CUSTOM_FIELD_TEXT_LENGTH = 1000;
export const MAX_CUSTOM_FIELD_URL_LENGTH = 2048;

const SELECT_TYPES = new Set<CustomFieldType>(["select", "multi_select"]);

// Mirrors labelNameSchema.
export const customFieldNameSchema = z
  .string({ required_error: "Custom field name is required." })
  .trim()
  .min(1, "Custom field name is required.")
  .max(50, "Custom field name must be between 1 and 50 characters.");

const optionSchema = z.string().trim().min(1).max(100);

function hasDuplicates(values: string[]): boolean {
  return new Set(values).size !== values.length;
}

/**
 * Applied to whichever of `type`/`options` are present in the payload. On
 * create, `type` is always present so the select/multi_select <-> options
 * relationship can be fully checked here. On update there is no `type` key
 * at all (immutability is structural — see updateCustomFieldSchema below),
 * so this same function is reused there but only re-checks `options` when
 * it is present; the service layer is responsible for re-running the
 * "options only valid for select/multi_select" check against the STORED
 * type when only `options` is being edited.
 */
function checkOptionsShape(
  body: { type?: CustomFieldType; options?: string[] },
  ctx: z.RefinementCtx,
  { optionsRequired }: { optionsRequired: boolean },
): void {
  if (body.type === undefined) return;

  const isSelectType = SELECT_TYPES.has(body.type);

  if (isSelectType) {
    if (body.options === undefined) {
      if (optionsRequired) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "options is required for select and multi_select fields.",
          path: ["options"],
        });
      }
      return;
    }
    if (body.options.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one option is required for select and multi_select fields.",
        path: ["options"],
      });
      return;
    }
    if (body.options.length > MAX_CUSTOM_FIELD_OPTIONS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `At most ${MAX_CUSTOM_FIELD_OPTIONS} options are allowed.`,
        path: ["options"],
      });
      return;
    }
    if (hasDuplicates(body.options)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Options must not contain duplicates.",
        path: ["options"],
      });
    }
  } else if (body.options !== undefined && body.options.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "options is only valid for select and multi_select fields.",
      path: ["options"],
    });
  }
}

export const createCustomFieldSchema = z
  .object({
    name: customFieldNameSchema,
    type: customFieldTypeSchema,
    options: z.array(optionSchema).optional(),
  })
  .strict()
  .superRefine((body, ctx) => checkOptionsShape(body, ctx, { optionsRequired: true }));
export type CreateCustomFieldInput = z.infer<typeof createCustomFieldSchema>;

// No `type` key at all: type immutability is structural, a 422 via .strict()
// rather than a runtime check. No `position` key either — reordering is a
// dedicated endpoint (reorderCustomFieldsSchema below).
export const updateCustomFieldSchema = z
  .object({
    name: customFieldNameSchema.optional(),
    options: z.array(optionSchema).optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    // `type` isn't in scope here, so this only catches the case where
    // `options` is present but empty/duplicated/too long. The
    // select/multi_select-only rule against the STORED type is re-checked in
    // custom-fields.service.ts#updateCustomField, which has the DB row.
    if (body.options === undefined) return;
    if (body.options.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one option is required.",
        path: ["options"],
      });
      return;
    }
    if (body.options.length > MAX_CUSTOM_FIELD_OPTIONS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `At most ${MAX_CUSTOM_FIELD_OPTIONS} options are allowed.`,
        path: ["options"],
      });
      return;
    }
    if (hasDuplicates(body.options)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Options must not contain duplicates.",
        path: ["options"],
      });
    }
  });
export type UpdateCustomFieldInput = z.infer<typeof updateCustomFieldSchema>;

// Mirrors reorderColumnsSchema.
export const reorderCustomFieldsSchema = z
  .object({
    fieldIds: z.array(z.string().min(1)).min(1, "At least one custom field id is required."),
  })
  .strict();
export type ReorderCustomFieldsInput = z.infer<typeof reorderCustomFieldsSchema>;

// Transport shape ONLY: proves the body is `{ value: <some JSON> }` and
// nothing else. It cannot validate `value` itself, because the legal shape
// depends on the field definition row in the database — that is
// buildCustomFieldValueSchema's job, called from the service layer.
// `z.unknown()` alone would make the key optional and would accept `null`, so
// both are closed explicitly: an omitted key and an explicit null are each a
// 422. "No value" is expressed by DELETEing the row, never by writing a null.
export const setCustomFieldValueSchema = z
  .object({ value: z.unknown() })
  .strict()
  .superRefine((body, ctx) => {
    if (!("value" in body)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "value is required.", path: ["value"] });
    } else if (body.value === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "value cannot be null. Delete the field value to clear it.",
        path: ["value"],
      });
    }
  });
export type SetCustomFieldValueInput = z.infer<typeof setCustomFieldValueSchema>;

function isPlainDateString(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcMillis = Date.UTC(year, month - 1, day);
  const reconstructed = new Date(utcMillis);
  return (
    reconstructed.getUTCFullYear() === year &&
    reconstructed.getUTCMonth() === month - 1 &&
    reconstructed.getUTCDate() === day
  );
}

const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:"]);

// The global `URL` constructor exists in both Node and every browser, but
// this package's tsconfig has neither the DOM lib nor @types/node in scope
// (it must stay platform-agnostic for the eventual frontend consumer), so it
// has no ambient type here. Reached via `globalThis` with a narrow local
// type instead of `declare const URL` to avoid colliding with whatever real
// `URL` type IS in scope in a consuming project (apps/api, apps/web).
function parseUrlProtocol(value: string): string | null {
  try {
    const URLCtor = (globalThis as unknown as { URL: new (input: string) => { protocol: string } }).URL;
    return new URLCtor(value).protocol;
  } catch {
    return null;
  }
}

/**
 * Builds the semantic validator for a single CustomFieldValue.value, given
 * the field's DB row (type + current options). This is a FACTORY, not a
 * static schema, because the valid shape depends on data loaded from the
 * database — a static discriminated union cannot express "this JSON must be
 * one of these specific strings loaded at runtime". The single mandatory
 * call site is custom-fields.service.ts#setTaskCustomFieldValue (and the
 * stale-value re-check in listTaskCustomFieldValues).
 */
export function buildCustomFieldValueSchema(field: {
  type: CustomFieldType;
  options: string[];
}): z.ZodType<unknown> {
  switch (field.type) {
    case "text":
      return z.string().trim().min(1, "Value is required. Delete the field value to clear it.").max(
        MAX_CUSTOM_FIELD_TEXT_LENGTH,
        `Text values must be at most ${MAX_CUSTOM_FIELD_TEXT_LENGTH} characters.`,
      );
    case "number":
      return z.number({ invalid_type_error: "Value must be a number." }).finite("Value must be a finite number.");
    case "date":
      return z
        .string({ invalid_type_error: "Value must be a date string (YYYY-MM-DD)." })
        .refine(isPlainDateString, "Value must be a valid date in YYYY-MM-DD format.");
    case "select":
      return z
        .string({ invalid_type_error: "Value must be a string." })
        .refine((v) => field.options.includes(v), "That option isn't valid for this field.");
    case "multi_select":
      return z
        .array(z.string(), { invalid_type_error: "Value must be an array of strings." })
        .min(1, "At least one option is required. Delete the field value to clear it.")
        .max(field.options.length || 1, "Too many options selected.")
        .refine((values) => values.every((v) => field.options.includes(v)), "That option isn't valid for this field.")
        .refine((values) => !hasDuplicates(values), "Options must not contain duplicates.");
    case "checkbox":
      return z.boolean({ invalid_type_error: "Value must be a boolean." });
    case "url": {
      return z
        .string({ invalid_type_error: "Value must be a URL string." })
        .trim()
        .max(MAX_CUSTOM_FIELD_URL_LENGTH, `URL values must be at most ${MAX_CUSTOM_FIELD_URL_LENGTH} characters.`)
        .refine((v) => {
          const protocol = parseUrlProtocol(v);
          return protocol !== null && ALLOWED_URL_PROTOCOLS.has(protocol);
        }, "Value must be a valid http(s) URL.");
    }
    default: {
      const _exhaustive: never = field.type;
      throw new Error(`Unhandled custom field type: ${String(_exhaustive)}`);
    }
  }
}
