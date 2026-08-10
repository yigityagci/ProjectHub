import { z } from "zod";

/**
 * Self-hosted Postfix mail delivery — shared validation for
 * PATCH /api/platform/postfix-config and POST /api/platform/postfix-config/dkim-key.
 *
 * These regexes/schemas are DELIBERATELY duplicated (not shared as a
 * dependency) by apps/mail-control/src/validate.ts, which re-implements the
 * exact same rules from scratch — see that file's header comment for why:
 * the mail-control listener must independently re-validate every value it
 * receives, and importing this module there would make "re-validation" a
 * tautology.
 */

// RFC1123 hostname, >=2 labels, lowercased, no trailing dot, no underscore,
// not an IP literal (the final label must be alphabetic), total <=253.
export const HOSTNAME_RE =
  /^(?=.{1,253}$)(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.(?!-)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$/;

export const DKIM_SELECTOR_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const MAIL_LOCALPART_RE = /^[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?$/i;

// Defense-in-depth denylist applied to every free-text field that ends up
// somewhere in an email header (From display name, Reply-To). Blocks the
// characters that make header injection / envelope confusion possible.
export const HEADER_UNSAFE_RE = /[\r\n\0<>,;:"\\]/;

export const updatePostfixConfigSchema = z
  .object({
    enabled: z.boolean(),
    sendingDomain: z
      .string()
      .trim()
      .toLowerCase()
      .max(253)
      .regex(HOSTNAME_RE, "Enter a valid domain, e.g. example.com."),
    mailHostname: z
      .string()
      .trim()
      .toLowerCase()
      .max(253)
      .regex(HOSTNAME_RE, "Enter a valid hostname, e.g. mail.example.com."),
    senderName: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((v) => !HEADER_UNSAFE_RE.test(v), "The sender name cannot contain quotes, angle brackets, or line breaks."),
    // undefined = keep existing stored value; null = clear it; string = set it.
    replyToAddress: z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .refine(
        (v) =>
          !HEADER_UNSAFE_RE.test(v) &&
          MAIL_LOCALPART_RE.test(v.split("@")[0] ?? "") &&
          HOSTNAME_RE.test(v.split("@")[1] ?? ""),
        "Enter a valid Reply-To email address.",
      )
      .nullable()
      .optional(),
    dkimSelector: z.string().trim().toLowerCase().max(63).regex(DKIM_SELECTOR_RE).optional(),
    dkimSigningEnabled: z.boolean().optional(),
    destinationRateDelaySeconds: z.number().int().min(0).max(3600),
    destinationConcurrencyLimit: z.number().int().min(1).max(100),
    messageSizeLimitBytes: z.number().int().min(1_048_576).max(104_857_600),
  })
  .strict();
export type UpdatePostfixConfigInput = z.infer<typeof updatePostfixConfigSchema>;

export const generateDkimKeySchema = z
  .object({
    keyBits: z.union([z.literal(2048), z.literal(4096)]),
  })
  .strict();
export type GenerateDkimKeyInput = z.infer<typeof generateDkimKeySchema>;
