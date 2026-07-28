import { z } from "zod";
import { emailSchema } from "./auth.js";
import { roleKeySchema } from "./workspace.js";

export const createInvitationSchema = z
  .object({
    email: emailSchema,
    roleKey: roleKeySchema,
  })
  .strict();
export type CreateInvitationInput = z.infer<typeof createInvitationSchema>;

export const invitationTokenParamSchema = z.object({
  token: z.string().min(1),
});
