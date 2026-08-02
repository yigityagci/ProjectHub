import { z } from "zod";
import { roleKeySchema } from "./workspace.js";

/**
 * Generating a registration token needs the role the redeeming user will
 * join this workspace with (mirrors createInvitationSchema's roleKey) plus
 * the auth context (workspaceId from the URL, createdById from the
 * session). `label` is an optional human-readable note for the generator's
 * own future reference (e.g. "for the design team offsite"), never shown
 * to the redeeming user.
 */
export const createRegistrationTokenSchema = z
  .object({
    roleKey: roleKeySchema,
    label: z.string().trim().max(200).optional(),
  })
  .strict();
export type CreateRegistrationTokenInput = z.infer<typeof createRegistrationTokenSchema>;
