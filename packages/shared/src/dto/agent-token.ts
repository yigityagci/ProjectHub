import { z } from "zod";

/**
 * Self-service creation of an AgentToken (see apps/api/src/auth/
 * agent-token.service.ts) — the bearer credential a user generates from
 * their own Account/Security settings to connect an MCP-compatible AI
 * client (Claude Desktop, Cursor, etc.) to ProjectHub. `label` is REQUIRED
 * (unlike createRegistrationTokenSchema's optional `label`): there is no
 * acceptable fallback for a missing client name when the activity feed
 * needs to render "via <label>" for every AI-assisted action.
 */
export const createAgentTokenSchema = z
  .object({
    label: z.string().trim().min(1, "A label is required.").max(100, "Label must be 100 characters or fewer."),
  })
  .strict();
export type CreateAgentTokenInput = z.infer<typeof createAgentTokenSchema>;
