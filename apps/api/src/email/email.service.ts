import nodemailer, { type Transporter } from "nodemailer";
import { HEADER_UNSAFE_RE, type NotificationType } from "@projecthub/shared";
import { logger } from "../core/logger.js";
import { decryptSecret } from "../core/secret-box.js";
import { env } from "../config/env.js";
import { getPlatformEmailConfigRow } from "./platform-email-config.service.js";
import { getPostfixConfigRow } from "./postfix-config.service.js";
import { renderBrandedEmail } from "./branded-template.js";

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

export interface NotificationEmailInput {
  recipientEmail: string;
  recipientDisplayName: string;
  type: NotificationType;
  actorDisplayName?: string;
  taskTitle: string;
  projectName: string;
  dueDate?: Date;
  link: string;
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

/**
 * Subject/body copy per NotificationType, keyed as a `Record<NotificationType,
 * ...>` (not a partial map) so a 4th NotificationType fails to compile here
 * until it's given a template — same compile-time-exhaustiveness pattern as
 * NOTIFICATION_PREF_FIELD in notifications.service.ts. `comment_reply` has a
 * template for compile-completeness even though no call site triggers it yet
 * (pre-existing, unrelated, out-of-scope gap — see notification-email.ts).
 */
const NOTIFICATION_EMAIL_TEMPLATES: Record<
  NotificationType,
  (input: NotificationEmailInput) => { subject: string; body: string }
> = {
  mention: (input) => ({
    subject: `${input.actorDisplayName} mentioned you in a comment`,
    body: `Hi ${input.recipientDisplayName},

${input.actorDisplayName} mentioned you in a comment on "${input.taskTitle}" in ${input.projectName}.

View it:
${input.link}

— ProjectHub`,
  }),
  task_assigned: (input) => ({
    subject: `You were assigned to "${input.taskTitle}"`,
    body: `Hi ${input.recipientDisplayName},

${input.actorDisplayName} assigned you to "${input.taskTitle}" in ${input.projectName}.

View it:
${input.link}

— ProjectHub`,
  }),
  comment_reply: (input) => ({
    subject: `${input.actorDisplayName} replied to your comment`,
    body: `Hi ${input.recipientDisplayName},

${input.actorDisplayName} replied to your comment on "${input.taskTitle}" in ${input.projectName}.

View it:
${input.link}

— ProjectHub`,
  }),
  due_date_soon: (input) => ({
    subject: `"${input.taskTitle}" is due soon`,
    body: `Hi ${input.recipientDisplayName},

Your task "${input.taskTitle}" in ${input.projectName} is due ${input.dueDate?.toLocaleString() ?? "soon"}.

View it:
${input.link}

— ProjectHub`,
  }),
};

function buildNotificationEmail(input: NotificationEmailInput): { subject: string; body: string } {
  return NOTIFICATION_EMAIL_TEMPLATES[input.type](input);
}

function buildTestEmail(): { subject: string; body: string } {
  return {
    subject: "ProjectHub test email",
    body: "This is a test email from ProjectHub to verify your SMTP configuration is working. If you received this, your email setup is correct.",
  };
}

interface ResolvedTransport {
  transporter: Transporter;
  from: string; // `"Name" <addr>` or bare addr
  replyTo?: string;
  cacheKey: string; // e.g. "smtp:<updatedAt ms>" or "postfix:<updatedAt ms>"
}

// Keyed on a cache key derived from the active config row's `updatedAt`
// (prefixed by which mode produced it) rather than a plain
// invalidate-on-write flag, so every process (including future
// multi-replica deployments) converges on its very next send with no
// cross-process coordination needed — a pure in-memory invalidate-on-write
// cache would be silently wrong under multi-process deployment. The mode
// prefix matters too: switching MODES must also invalidate the cache, since
// a same-millisecond `updatedAt` collision across the two different config
// tables would otherwise risk serving a stale transport from the wrong mode.
let cached: ResolvedTransport | null = null;

/** For same-process immediacy after a config write, and for test teardown. */
export function invalidateEmailTransportCache(): void {
  if (cached) {
    cached.transporter.close();
    cached = null;
  }
}

/**
 * Builds a `"Name" <addr>` (or bare addr) From header value. `fromName` is
 * validated at the write layer against HEADER_UNSAFE_RE (rejects quotes,
 * angle brackets, CR/LF) for both PlatformEmailConfig.fromName and
 * self-hosted PlatformPostfixConfig.senderName — this strip is deliberate
 * belt-and-suspenders defense-in-depth on top of that, not the primary
 * control, in case a value predates that validation or reaches this
 * function via any other path in the future.
 */
function formatFrom(fromAddress: string, fromName: string | null): string {
  if (!fromName) return fromAddress;
  const safeName = fromName.replace(HEADER_UNSAFE_RE, "");
  return safeName ? `"${safeName}" <${fromAddress}>` : fromAddress;
}

/**
 * Mode-aware. Returns null when email is unconfigured/disabled (SMTP mode)
 * or when self-hosted mode is enabled but not successfully applied/
 * reachable — EVERY one of these falls back to the dev console transport
 * (see deliverEmail), never to the other mode's relay path: sending from
 * the wrong domain/credentials silently would be worse than not sending
 * at all.
 */
async function resolveTransport(): Promise<ResolvedTransport | null> {
  const postfix = await getPostfixConfigRow();
  if (postfix?.enabled) {
    if (postfix.lastApplyOk !== true) {
      logger.error(
        { lastApplyError: postfix.lastApplyError },
        "Self-hosted Postfix mode is enabled but its last apply did not succeed. " +
          "Falling back to the dev console transport until the configuration is successfully re-applied.",
      );
      return null;
    }
    if (!env.MAIL_CONTROL_SMTP_HOST) {
      logger.error(
        {},
        "Self-hosted Postfix mode is enabled but MAIL_CONTROL_SMTP_HOST is not set on this API instance. " +
          "Falling back to the dev console transport.",
      );
      return null;
    }

    const cacheKey = `postfix:${postfix.updatedAt.getTime()}`;
    if (cached && cached.cacheKey === cacheKey) {
      return cached;
    }
    if (cached) {
      cached.transporter.close();
      cached = null;
    }

    try {
      const transporter = nodemailer.createTransport({
        host: env.MAIL_CONTROL_SMTP_HOST,
        port: env.MAIL_CONTROL_SMTP_PORT,
        secure: false,
        ignoreTLS: true,
      });

      const resolved: ResolvedTransport = {
        transporter,
        from: formatFrom(`no-reply@${postfix.sendingDomain}`, postfix.senderName),
        replyTo: postfix.replyToAddress ?? undefined,
        cacheKey,
      };
      cached = resolved;
      return resolved;
    } catch (err) {
      logger.error(
        { err },
        "Could not construct the self-hosted Postfix SMTP transport. Falling back to the dev console transport.",
      );
      return null;
    }
  }

  const row = await getPlatformEmailConfigRow();
  if (!row || !row.enabled) {
    return null;
  }

  const cacheKey = `smtp:${row.updatedAt.getTime()}`;
  if (cached && cached.cacheKey === cacheKey) {
    return cached;
  }

  if (cached) {
    cached.transporter.close();
    cached = null;
  }

  let password: string | undefined;
  if (row.passwordCiphertext !== null) {
    try {
      password = decryptSecret(row.passwordCiphertext);
    } catch (err) {
      logger.error(
        { err },
        "Could not decrypt the stored SMTP password (likely because APP_SECRET was rotated since it was saved). " +
          "Falling back to the dev console transport — re-enter the SMTP password in Platform Settings.",
      );
      return null;
    }
  }

  const securityOptions =
    row.security === "tls"
      ? { secure: true }
      : row.security === "starttls"
        ? { secure: false, requireTLS: true }
        : { secure: false, ignoreTLS: true }; // "none" — deliberate: without ignoreTLS,
  // nodemailer opportunistically STARTTLSes anyway.

  try {
    const transporter = nodemailer.createTransport({
      host: row.host,
      port: row.port,
      ...securityOptions,
      ...(row.username !== null ? { auth: { user: row.username, pass: password } } : {}),
    });

    const resolved: ResolvedTransport = {
      transporter,
      from: formatFrom(row.fromAddress, row.fromName),
      cacheKey,
    };
    cached = resolved;
    return resolved;
  } catch (err) {
    logger.error(
      { err },
      "Could not construct the SMTP transport from the saved Platform Settings configuration. " +
        "Falling back to the dev console transport — check the SMTP host/port/security settings.",
    );
    return null;
  }
}

interface DeliverEmailInput {
  to: string;
  subject: string;
  body: string;
}

/**
 * Reusable email delivery primitive shared by every "send an email" call
 * site in this codebase. When email is not configured/enabled (the default
 * for self-hosters who haven't set it up in Platform Settings yet), this
 * falls back to a "console" dev transport that logs the full message in a
 * clearly-visible structured form so flows that depend on email
 * (invitations, password reset, notifications) can be exercised end-to-end
 * without real email. When configured and enabled, the message is actually
 * sent via nodemailer.
 */
async function deliverEmail(input: DeliverEmailInput): Promise<void> {
  const resolved = await resolveTransport();
  if (!resolved) {
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
    const { html, text } = renderBrandedEmail({ subject: input.subject, body: input.body });
    await resolved.transporter.sendMail({
      from: resolved.from,
      to: input.to,
      ...(resolved.replyTo ? { replyTo: resolved.replyTo } : {}),
      subject: input.subject,
      text,
      html,
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

export async function sendNotificationEmail(input: NotificationEmailInput): Promise<void> {
  const { subject, body } = buildNotificationEmail(input);
  await deliverEmail({ to: input.recipientEmail, subject, body });
}

/**
 * Sends via the currently-saved config, awaited (not fire-and-forget) so
 * POST /api/platform/email-config/test can surface the raw SMTP error to
 * the admin. Used only by that route.
 */
export async function sendTestEmail(recipientEmail: string): Promise<void> {
  const { subject, body } = buildTestEmail();
  await deliverEmail({ to: recipientEmail, subject, body });
}
