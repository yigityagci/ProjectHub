import { z } from "zod";

/**
 * Instance-wide outbound email configuration (see
 * apps/api/src/email/platform-email-config.service.ts). This is a
 * DIFFERENT axis from workspace RBAC — gated by User.isPlatformAdmin, not
 * any workspace permission — so, deliberately, none of this appears in
 * permissions.ts's workspace-role-scoped catalog.
 */
export const SMTP_SECURITY_MODES = ["none", "starttls", "tls"] as const;
export type SmtpSecurityMode = (typeof SMTP_SECURITY_MODES)[number];
export const smtpSecuritySchema = z.enum(SMTP_SECURITY_MODES);

export const updatePlatformEmailConfigSchema = z
  .object({
    enabled: z.boolean(),
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65535),
    security: smtpSecuritySchema,
    username: z.string().trim().max(255).nullable().optional(),
    // undefined = keep existing stored password; null = clear it
    // (unauthenticated relay); string = replace it. The API never returns
    // this field in any response — see PlatformEmailConfigView.hasPassword.
    password: z.string().min(1).max(1024).nullable().optional(),
    fromAddress: z.string().trim().email().max(320),
    fromName: z.string().trim().max(120).nullable().optional(),
  })
  .strict();
export type UpdatePlatformEmailConfigInput = z.infer<typeof updatePlatformEmailConfigSchema>;
