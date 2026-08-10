/**
 * Fixed, hardcoded ProjectHub-branded HTML email shell. Used in BOTH mail
 * delivery modes (external SMTP and self-hosted Postfix) — this is
 * deliberately NOT a template-customization system (out of scope by
 * product requirement): there is exactly one shell, and it wraps whatever
 * plaintext `body` each of the 7 existing template functions in
 * email.service.ts already produces.
 *
 * SECURITY-CRITICAL: task titles, display names, workspace/project names,
 * and inviter names are user-controlled and already flow into these
 * bodies today (see email.service.ts's NOTIFICATION_EMAIL_TEMPLATES etc).
 * The ENTIRE assembled plaintext body is HTML-escaped exactly once here —
 * never per-field at each call site — so there is exactly one place that
 * can be missed, and it isn't missed.
 */

const HTML_ESCAPE_RE = /[&<>"']/g;
const HTML_ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(input: string): string {
  return input.replace(HTML_ESCAPE_RE, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

// Deliberately http(s)-only: a line that entirely matches this becomes a
// styled CTA anchor. `javascript:`/`data:`/anything else can NEVER become
// an href this way, by construction (not by denylisting those schemes).
const CTA_LINE_RE = /^https?:\/\/\S+$/;

/**
 * Splits the (already escaped) body into paragraphs on blank lines, and
 * turns any paragraph that is ENTIRELY a bare http(s) URL into a styled
 * button-like anchor. Everything else renders as an ordinary paragraph
 * with line breaks preserved via <br>.
 */
function renderBodyHtml(escapedBody: string): string {
  const paragraphs = escapedBody.split(/\n\s*\n/);
  return paragraphs
    .map((paragraph) => {
      const trimmed = paragraph.trim();
      // CTA_LINE_RE is tested against the escaped text. Escaping never
      // introduces or removes a leading "http(s)://", so this check is
      // equivalent to testing the raw line, but operates on already-safe
      // text so the anchor's href/text below need no further escaping.
      if (CTA_LINE_RE.test(trimmed)) {
        return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr><td style="border-radius:6px;background-color:#4f46e5;">
          <a href="${trimmed}" style="display:inline-block;padding:12px 24px;color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:14px;font-weight:bold;text-decoration:none;border-radius:6px;">${trimmed}</a>
        </td></tr></table>`;
      }
      return `<p style="margin:0 0 16px 0;color:#1f2937;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;">${paragraph.replace(/\n/g, "<br>")}</p>`;
    })
    .join("\n");
}

export interface RenderBrandedEmailInput {
  subject: string;
  body: string;
}

export interface RenderedEmail {
  html: string;
  text: string;
}

/**
 * `text` is byte-identical to the plaintext this feature has always
 * produced (dev-console transport and text-only mail clients are
 * unaffected). `html` is a fixed, hardcoded, inline-styled, table-based
 * shell wrapping the same content, HTML-escaped exactly once.
 */
export function renderBrandedEmail(input: RenderBrandedEmailInput): RenderedEmail {
  const escapedSubject = escapeHtml(input.subject);
  const escapedBody = escapeHtml(input.body);
  const bodyHtml = renderBodyHtml(escapedBody);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapedSubject}</title>
</head>
<body style="margin:0;padding:0;background-color:#f3f4f6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f3f4f6;padding:32px 0;">
<tr>
<td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="width:480px;max-width:90%;background-color:#ffffff;border-radius:8px;overflow:hidden;">
<tr>
<td style="background-color:#111827;padding:20px 32px;">
<span style="color:#ffffff;font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:bold;letter-spacing:0.5px;">ProjectHub</span>
</td>
</tr>
<tr>
<td style="padding:32px;">
${bodyHtml}
</td>
</tr>
<tr>
<td style="padding:20px 32px;background-color:#f9fafb;border-top:1px solid #e5e7eb;">
<span style="color:#9ca3af;font-family:Arial,Helvetica,sans-serif;font-size:12px;">Sent by ProjectHub</span>
</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;

  return { html, text: input.body };
}
