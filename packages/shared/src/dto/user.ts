import { z } from "zod";
import { displayNameSchema } from "./auth.js";
import type { NotificationType } from "./notification.js";

/**
 * Locale is persisted for real (column + endpoint + selector) but not yet
 * applied to any UI string — see docs/PHASES.md for this known limitation.
 * Ship with a single supported value; adding a second locale later is just
 * appending to this tuple.
 */
export const SUPPORTED_LOCALES = ["en"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
export const localeSchema = z.enum(SUPPORTED_LOCALES);

/**
 * Rendered into an <img src> on the frontend — restricted to http/https so a
 * `javascript:`/`data:` URI can never be stored as an avatar (a plain
 * `.url()` alone would accept those).
 */
export const avatarUrlSchema = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
    message: "Avatar URL must start with http:// or https://.",
  });

/**
 * Load-bearing type-level assertion: if NOTIFICATION_TYPES ever gains a 4th
 * member, this object literal fails to compile until every key below (and
 * notificationPreferencesPatchSchema's shape) is updated to match — a new
 * notification type can never silently ship without a Settings gate for it.
 */
const _notificationPrefKeysCoverCatalog: Record<NotificationType, true> = {
  mention: true,
  task_assigned: true,
  comment_reply: true,
};
void _notificationPrefKeysCoverCatalog;

export const notificationPreferencesPatchSchema = z
  .object({
    mention: z.boolean(),
    task_assigned: z.boolean(),
    comment_reply: z.boolean(),
  })
  .partial()
  .strict();
export type NotificationPreferencesPatch = z.infer<typeof notificationPreferencesPatchSchema>;

export const accessibilityPreferencesPatchSchema = z
  .object({
    reduceMotion: z.boolean(),
    largerText: z.boolean(),
  })
  .partial()
  .strict();
export type AccessibilityPreferencesPatch = z.infer<typeof accessibilityPreferencesPatchSchema>;

export const updateProfileSchema = z
  .object({
    displayName: displayNameSchema,
    avatarUrl: avatarUrlSchema.nullable(),
  })
  .partial()
  .strict();
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const updatePreferencesSchema = z
  .object({
    notifications: notificationPreferencesPatchSchema,
    locale: localeSchema,
    accessibility: accessibilityPreferencesPatchSchema,
  })
  .partial()
  .strict();
export type UpdatePreferencesInput = z.infer<typeof updatePreferencesSchema>;
