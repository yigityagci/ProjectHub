import { logger } from "../core/logger.js";
import { env } from "../config/env.js";

export interface InvitationEmailInput {
  inviterName: string;
  invitedEmail: string;
  workspaceName: string;
  invitationLink: string;
}

function buildInvitationEmail(input: InvitationEmailInput): { subject: string; body: string } {
  const subject = `${input.inviterName} invited you to ProjectHub workspace: ${input.workspaceName}`;
  const body = `Hi ${input.invitedEmail},

${input.inviterName} has invited you to join their ProjectHub workspace.

Workspace: ${input.workspaceName}

Accept this invitation:
${input.invitationLink}

This invitation expires in 7 days.

If you don't have a ProjectHub account yet, you'll be able to create one after accepting the invitation.

Questions? Contact your workspace administrator.

— ProjectHub`;
  return { subject, body };
}

/**
 * Email delivery abstraction. When SMTP_URL is not configured (the
 * default for self-hosters who haven't wired up SMTP yet), this falls
 * back to a "console" dev transport that logs the full message,
 * including the invitation link/token, in a clearly-visible structured
 * form so the flow can be exercised end-to-end without real email.
 */
export async function sendInvitationEmail(input: InvitationEmailInput): Promise<void> {
  const { subject, body } = buildInvitationEmail(input);

  if (!env.SMTP_URL) {
    // eslint-disable-next-line no-console
    console.log("\n================ ProjectHub Dev Mail Transport ================");
    // eslint-disable-next-line no-console
    console.log(`To: ${input.invitedEmail}`);
    // eslint-disable-next-line no-console
    console.log(`Subject: ${subject}`);
    // eslint-disable-next-line no-console
    console.log("---");
    // eslint-disable-next-line no-console
    console.log(body);
    // eslint-disable-next-line no-console
    console.log("=================================================================\n");
    logger.info({ to: input.invitedEmail, subject }, "Dev mail transport: invitation email logged");
    return;
  }

  // Real SMTP wiring is intentionally out of scope for Phase 1; this
  // abstraction is where a real transport (e.g. nodemailer) would plug in.
  logger.warn(
    "SMTP_URL is set but no real SMTP transport is implemented in Phase 1; falling back to console log.",
  );
  // eslint-disable-next-line no-console
  console.log(`[email:${input.invitedEmail}] ${subject}\n${body}`);
}
