import nodemailer, { type Transporter } from "nodemailer";
import { logger } from "../core/logger.js";
import { env } from "../config/env.js";

export interface InvitationEmailInput {
  inviterName: string;
  invitedEmail: string;
  workspaceName: string;
  invitationLink: string;
}

export interface PasswordResetEmailInput {
  recipientEmail: string;
  resetLink: string;
  ttlHours: number;
}

const DEFAULT_FROM_ADDRESS = "ProjectHub <no-reply@projecthub.local>";

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

function buildPasswordResetEmail(input: PasswordResetEmailInput): { subject: string; body: string } {
  const subject = "Reset your ProjectHub password";
  const hourWord = input.ttlHours === 1 ? "hour" : "hours";
  const body = `Hi ${input.recipientEmail},

We received a request to reset the password for your ProjectHub account.

Reset your password:
${input.resetLink}

This link expires in ${input.ttlHours} ${hourWord} and can only be used once.

If you didn't request this, ignore this email — your password is unchanged.

— ProjectHub`;
  return { subject, body };
}

let cachedTransporter: Transporter | null = null;

function getTransporter(): Transporter {
  if (!cachedTransporter) {
    // nodemailer supports a standard SMTP connection-URL string
    // (e.g. smtp://user:pass@host:587) directly as transport config.
    cachedTransporter = nodemailer.createTransport(env.SMTP_URL);
  }
  return cachedTransporter;
}

interface DeliverEmailInput {
  to: string;
  subject: string;
  body: string;
}

/**
 * Reusable email delivery primitive shared by every "send an email" call
 * site in this codebase. When SMTP_URL is not configured (the default for
 * self-hosters who haven't wired up SMTP yet), this falls back to a
 * "console" dev transport that logs the full message in a clearly-visible
 * structured form so flows that depend on email (invitations, password
 * reset) can be exercised end-to-end without real email. When SMTP_URL is
 * set, the message is actually sent via nodemailer.
 */
async function deliverEmail(input: DeliverEmailInput): Promise<void> {
  if (!env.SMTP_URL) {
    // eslint-disable-next-line no-console
    console.log("\n================ ProjectHub Dev Mail Transport ================");
    // eslint-disable-next-line no-console
    console.log(`To: ${input.to}`);
    // eslint-disable-next-line no-console
    console.log(`Subject: ${input.subject}`);
    // eslint-disable-next-line no-console
    console.log("---");
    // eslint-disable-next-line no-console
    console.log(input.body);
    // eslint-disable-next-line no-console
    console.log("=================================================================\n");
    logger.info({ to: input.to, subject: input.subject }, "Dev mail transport: email logged");
    return;
  }

  try {
    const transporter = getTransporter();
    await transporter.sendMail({
      from: env.SMTP_FROM ?? DEFAULT_FROM_ADDRESS,
      to: input.to,
      subject: input.subject,
      text: input.body,
    });
    logger.info({ to: input.to, subject: input.subject }, "Email sent via SMTP transport");
  } catch (err) {
    logger.error({ err, to: input.to, subject: input.subject }, "Failed to send email via SMTP transport");
    // Non-critical path: don't crash the process on a transient SMTP
    // error, but do let the caller know it failed so it can decide
    // whether to treat it as fatal.
    throw err;
  }
}

export async function sendInvitationEmail(input: InvitationEmailInput): Promise<void> {
  const { subject, body } = buildInvitationEmail(input);
  await deliverEmail({ to: input.invitedEmail, subject, body });
}

export async function sendPasswordResetEmail(input: PasswordResetEmailInput): Promise<void> {
  const { subject, body } = buildPasswordResetEmail(input);
  await deliverEmail({ to: input.recipientEmail, subject, body });
}
