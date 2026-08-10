import { useEffect, useState, type FormEvent } from "react";
import { SMTP_SECURITY_MODES, type SmtpSecurityMode } from "@projecthub/shared";
import { api, ApiError } from "../../../lib/api.js";
import CopyableCode from "./CopyableCode.js";

// Straight port of MailDeliveryPanel.tsx's original body (itself a straight
// port of the deleted apps/web/src/pages/platform/PlatformEmailSettingsPage.tsx)
// into its own file, per the two-mode restructuring — see
// MailDeliveryPanel.tsx's header comment. No copy/behavior changes other
// than: (1) the `onChanged` callback, so the parent panel's Enabled/Disabled
// badge stays in sync after a save/toggle without this section needing to
// know anything about mode-switching; (2) the test-send result now surfaces
// the new `detail` field (see platform-email.routes.ts's polished test
// response shape) instead of just a generic message.

interface PlatformEmailConfigView {
  enabled: boolean;
  host: string;
  port: number;
  security: SmtpSecurityMode;
  username: string | null;
  hasPassword: boolean;
  fromAddress: string;
  fromName: string | null;
  updatedAt: string;
  updatedByDisplayName: string | null;
}

const SECURITY_LABEL: Record<SmtpSecurityMode, string> = {
  starttls: "STARTTLS",
  tls: "TLS",
  none: "None",
};

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

/** Appends the new test-response `detail` (code/command/SMTP response code) to an error message, when present. */
function describeTestFailure(
  error: string | undefined,
  detail: { code?: string; command?: string; responseCode?: number } | undefined,
): string {
  const base = error ?? "Failed to send the test email.";
  if (!detail) return base;
  const parts: string[] = [];
  if (detail.code) parts.push(`\`${detail.code}\``);
  if (detail.responseCode !== undefined) parts.push(`SMTP ${detail.responseCode}`);
  if (detail.command) parts.push(`during ${detail.command}`);
  return parts.length > 0 ? `${base} (${parts.join(" / ")})` : base;
}

export default function ExternalSmtpSection({
  userEmail,
  onChanged,
}: {
  userEmail: string;
  onChanged?: () => void;
}) {
  const [config, setConfig] = useState<PlatformEmailConfigView | null>(null);
  const [loaded, setLoaded] = useState(false);

  const [host, setHost] = useState("");
  const [port, setPort] = useState("587");
  const [security, setSecurity] = useState<SmtpSecurityMode>("starttls");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [fromName, setFromName] = useState("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);

  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testSuccess, setTestSuccess] = useState<string | null>(null);

  async function loadConfig() {
    try {
      const res = await api.get<{ config: PlatformEmailConfigView | null }>("/api/platform/email-config");
      setConfig(res.config);
      if (res.config) {
        setHost(res.config.host);
        setPort(String(res.config.port));
        setSecurity(res.config.security);
        setUsername(res.config.username ?? "");
        setFromAddress(res.config.fromAddress);
        setFromName(res.config.fromName ?? "");
      }
    } catch {
      // Non-critical: the form simply starts empty/unconfigured.
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    loadConfig().catch(() => undefined);
  }, []);

  const requiredFieldsFilled = host.trim() !== "" && port.trim() !== "" && fromAddress.trim() !== "";

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaveError(null);
    setSaveSuccess(null);
    setSaving(true);
    try {
      const res = await api.patch<{ config: PlatformEmailConfigView }>("/api/platform/email-config", {
        enabled: config?.enabled ?? false,
        host: host.trim(),
        port: Number(port),
        security,
        username: username.trim() ? username.trim() : null,
        ...(password ? { password } : {}),
        fromAddress: fromAddress.trim(),
        fromName: fromName.trim() ? fromName.trim() : null,
      });
      setConfig(res.config);
      setPassword("");
      setSaveSuccess("Configuration saved.");
      onChanged?.();
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not save the email configuration.");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleEnabled(nextEnabled: boolean) {
    if (!config) return;
    setToggleError(null);
    setTogglingEnabled(true);
    try {
      const res = await api.patch<{ config: PlatformEmailConfigView }>("/api/platform/email-config", {
        enabled: nextEnabled,
        host: config.host,
        port: config.port,
        security: config.security,
        username: config.username,
        fromAddress: config.fromAddress,
        fromName: config.fromName,
      });
      setConfig(res.config);
      onChanged?.();
    } catch (err) {
      setToggleError(err instanceof ApiError ? err.message : "Could not update the enabled status.");
    } finally {
      setTogglingEnabled(false);
    }
  }

  async function handleTestEmail() {
    setTestError(null);
    setTestSuccess(null);
    setTesting(true);
    try {
      const res = await api.post<{
        ok: boolean;
        error?: string;
        detail?: { code?: string; command?: string; responseCode?: number };
      }>("/api/platform/email-config/test");
      if (res.ok) {
        setTestSuccess(`Test email sent to ${userEmail}.`);
      } else {
        setTestError(describeTestFailure(res.error, res.detail));
      }
    } catch (err) {
      setTestError(err instanceof ApiError ? err.message : "Failed to send the test email.");
    } finally {
      setTesting(false);
    }
  }

  const domain = config?.fromAddress.split("@")[1]?.trim() || "example.com";
  const exampleFromAddress = config?.fromAddress || "no-reply@example.com";

  if (!loaded) {
    return <p>Loading...</p>;
  }

  return (
    <>
      <div className="ph-card ph-card-wide" style={{ marginTop: "1rem" }}>
        <h1 style={{ fontSize: "1rem" }}>SMTP connection settings</h1>
        <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
          ProjectHub connects to an outgoing mail server (SMTP relay) to send system emails. You can use a
          transactional email provider like SendGrid, Mailgun, or AWS SES, or connect to your own mail server.
        </p>

        {saveError && <div className="ph-alert ph-alert-error">{saveError}</div>}
        {saveSuccess && <div className="ph-alert ph-alert-success">{saveSuccess}</div>}

        <form onSubmit={handleSave}>
          <div className="ph-field">
            <label htmlFor="smtpHost">SMTP Host</label>
            <input
              id="smtpHost"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="e.g., smtp.sendgrid.net"
              disabled={saving}
              required
            />
          </div>
          <div className="ph-field">
            <label htmlFor="smtpPort">SMTP Port</label>
            <input
              id="smtpPort"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="e.g., 587"
              disabled={saving}
              required
            />
          </div>
          <div className="ph-field">
            <label htmlFor="smtpSecurity">Security</label>
            <select
              id="smtpSecurity"
              value={security}
              onChange={(e) => setSecurity(e.target.value as SmtpSecurityMode)}
              disabled={saving}
            >
              {SMTP_SECURITY_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {SECURITY_LABEL[mode]}
                </option>
              ))}
            </select>
          </div>
          <div className="ph-field">
            <label htmlFor="smtpUsername">Username</label>
            <input
              id="smtpUsername"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g., apikey (leave blank for an unauthenticated relay)"
              disabled={saving}
            />
          </div>
          <div className="ph-field">
            <label htmlFor="smtpPassword">Password</label>
            <input
              id="smtpPassword"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={config?.hasPassword ? "•••••••• (unchanged)" : "SMTP password"}
              disabled={saving}
              autoComplete="new-password"
            />
            <div className="ph-subtitle" style={{ margin: "0.25rem 0 0" }}>
              {config?.hasPassword
                ? `Set on ${formatDateTime(config.updatedAt)}. After saving, you will not be able to view this password — you can only replace it by entering a new one above.`
                : "After saving, you will not be able to view this password — you can only replace it."}
            </div>
          </div>
          <div className="ph-field">
            <label htmlFor="smtpFromAddress">From Address</label>
            <input
              id="smtpFromAddress"
              type="email"
              value={fromAddress}
              onChange={(e) => setFromAddress(e.target.value)}
              placeholder="e.g., no-reply@example.com"
              disabled={saving}
              required
            />
          </div>
          <div className="ph-field">
            <label htmlFor="smtpFromName">From Name (optional)</label>
            <input
              id="smtpFromName"
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              placeholder="e.g., ProjectHub"
              disabled={saving}
            />
          </div>
          <button
            className="ph-button"
            type="submit"
            disabled={saving || !requiredFieldsFilled}
            style={{ width: "auto" }}
          >
            {saving ? "Saving..." : "Save configuration"}
          </button>
        </form>
      </div>

      <div className="ph-card ph-card-wide" style={{ marginTop: "1.5rem" }}>
        <h1 style={{ fontSize: "1rem" }}>Service status</h1>
        {toggleError && <div className="ph-alert ph-alert-error">{toggleError}</div>}
        <label
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: "0.6rem",
            margin: "0.5rem 0 0.9rem",
            opacity: config ? 1 : 0.6,
          }}
        >
          <input
            type="checkbox"
            checked={config?.enabled ?? false}
            disabled={!config || togglingEnabled}
            onChange={(e) => handleToggleEnabled(e.target.checked)}
          />
          <span>
            <strong>{config?.enabled ? "Email is ON" : "Email is currently OFF"}</strong>
            <div className="ph-subtitle" style={{ margin: 0 }}>
              {config
                ? "Toggling this takes effect immediately."
                : "Save a configuration below before enabling email."}
            </div>
          </span>
        </label>
        <p className="ph-subtitle" style={{ margin: 0 }}>
          When enabled, ProjectHub automatically sends emails for: member invitations to workspaces, password
          reset links, and task assignments and mentions. When disabled, the app continues to work normally —
          these events just won't generate emails.
        </p>
      </div>

      <div className="ph-card ph-card-wide" style={{ marginTop: "1.5rem" }}>
        <h1 style={{ fontSize: "1rem" }}>Test configuration</h1>
        <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
          Send a test email to your own account address ({userEmail}) using the currently saved configuration
          above, to confirm it actually delivers.
        </p>
        {testError && <div className="ph-alert ph-alert-error">{testError}</div>}
        {testSuccess && <div className="ph-alert ph-alert-success">{testSuccess}</div>}
        <button
          type="button"
          className="ph-button"
          style={{ width: "auto" }}
          disabled={testing || !config}
          onClick={handleTestEmail}
        >
          {testing ? "Sending..." : "Send test email"}
        </button>
      </div>

      <details className="ph-card ph-card-wide" style={{ marginTop: "1.5rem" }} open>
        <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: "1rem" }}>
          DNS &amp; deliverability guidance
        </summary>

        <div style={{ marginTop: "0.9rem" }}>
          <p>
            To maximize email deliverability (ensuring your emails don't land in spam), you need to add DNS
            records to your domain that verify ProjectHub's emails come from you. This prevents impersonation
            and tells mail servers to trust your emails.
          </p>
          <p>
            The records below are examples for the domain '{domain}' sending from '{exampleFromAddress}'.
            Replace '{domain}' with your actual domain when you set them up.
          </p>
          <p>
            DNS changes can take 24–48 hours to propagate globally. You can check your records using tools
            like MXToolbox or your DNS provider's web interface.
          </p>

          <h2 style={{ fontSize: "0.95rem" }}>SPF – Sender Policy Framework</h2>
          <p>
            SPF is a TXT record that tells mail servers: "These servers are authorized to send emails from my
            domain."
          </p>
          <p>Example for {domain} using a transactional email provider:</p>
          <CopyableCode value={`Host (Name): ${domain}\nType: TXT\nValue: v=spf1 include:sendgrid.net ~all`} />
          <p>
            Explanation:
            <br />
            • <code>v=spf1</code> — SPF version 1
            <br />
            • <code>include:sendgrid.net</code> — Authorizes SendGrid's servers (replace with your SMTP
            provider's SPF include)
            <br />
            • <code>~all</code> — Softfail (recommended): tells mail servers to accept your emails even if they
            don't match, but mark them as suspicious. Safe, lets you test without breaking delivery.
            <br />• <code>-all</code> — Hardfail (stricter): rejects emails that don't match. Only use this
            after testing.
          </p>
          <p>If you're sending from multiple providers, combine them in one SPF record:</p>
          <CopyableCode value="v=spf1 include:sendgrid.net include:mailgun.org ~all" />
          <p>(You cannot have multiple TXT SPF records for the same domain — merge them into one.)</p>

          <h2 style={{ fontSize: "0.95rem" }}>DKIM – DomainKeys Identified Mail</h2>
          <p>
            DKIM adds a cryptographic signature to your emails proving they weren't forged. The signature is
            validated using a public key stored in your DNS.
          </p>
          <p>
            ProjectHub is an SMTP client — it doesn't generate or sign emails with DKIM keys. Instead, your
            SMTP relay/provider does. You need to get the DKIM key from them and add it to your DNS.
          </p>
          <p>
            Steps:
            <br />
            1. Go to your SMTP provider's dashboard (SendGrid, Mailgun, etc.)
            <br />
            2. Find "DKIM keys", "Domain verification", or "DNS records" section
            <br />
            3. Copy the DKIM record they provide (it looks like the example below)
            <br />
            4. Add it to your DNS
          </p>
          <p>Example DKIM record from SendGrid (for domain {domain}):</p>
          <CopyableCode
            value={`Host (Name): s1._domainkey.${domain}\nType: TXT\nValue: v=DKIM1; k=rsa; p=MIGfMA0GCSq... (long Base64-encoded public key)`}
          />
          <p>
            Each SMTP provider has different selectors and keys. The example above uses 's1' as the selector;
            yours might be 'default', 'selector1', or something else. Always get the exact value from your
            provider.
          </p>
          <p>
            If you're self-hosting your own mail server, use the "Self-hosted Postfix" mode above instead —
            ProjectHub generates and manages DKIM keys for you there.
          </p>

          <h2 style={{ fontSize: "0.95rem" }}>
            DMARC – Domain-based Message Authentication, Reporting &amp; Conformance
          </h2>
          <p>
            DMARC tells mail servers what to do with emails that fail SPF or DKIM checks. It also sends you
            reports about authentication failures so you can monitor deliverability.
          </p>
          <p>DMARC record for {domain}:</p>
          <CopyableCode
            value={`Host (Name): _dmarc.${domain}\nType: TXT\nValue: v=DMARC1; p=none; rua=mailto:dmarc-reports@${domain}`}
          />
          <p>
            Explanation:
            <br />
            • <code>v=DMARC1</code> — DMARC version 1
            <br />• <code>p=none</code> — Policy: don't reject or quarantine, just monitor and report
            (recommended for testing)
            <br />
            &nbsp;&nbsp;• <code>p=quarantine</code> — Put suspicious emails in spam folder (stricter)
            <br />
            &nbsp;&nbsp;• <code>p=reject</code> — Reject suspicious emails entirely (strictest; only after full
            testing)
            <br />• <code>rua=mailto:dmarc-reports@{domain}</code> — Send you weekly aggregate reports (set to
            an email you monitor)
          </p>
          <p>
            Recommended workflow:
            <br />
            1. Start with <code>p=none</code> to observe what happens
            <br />
            2. After a few days, review the DMARC reports (watch for legitimate emails that fail)
            <br />
            3. Once confident, upgrade to <code>p=quarantine</code>, then <code>p=reject</code>
          </p>
          <p>This prevents accidentally blocking legitimate emails while you're setting up.</p>

          <h2 style={{ fontSize: "0.95rem" }}>PTR Records – Reverse DNS (Advanced, Usually Not Needed)</h2>
          <p>
            PTR records (reverse DNS) map IP addresses back to hostnames. Some mail servers check them to
            reduce spam.
          </p>
          <p>
            Important: PTR records are only relevant if you're running your own mail server on a dedicated IP.
            If you're using a transactional email provider like SendGrid or Mailgun, they handle PTR for you —
            skip this. If you're using Self-hosted Postfix mode, see that mode's DNS setup panel instead.
          </p>
          <p>For most ProjectHub users on this mode, this section doesn't apply.</p>

          <h2 style={{ fontSize: "0.95rem" }}>Verifying your setup</h2>
          <p>
            To verify your setup is working:
            <br />
            1. Save your SMTP configuration in ProjectHub
            <br />
            2. Use the "Send test email" button above to send yourself a verification email
            <br />
            3. Check your inbox (and spam folder) — delivery confirms your setup is working
            <br />
            4. Monitor your mail server logs and DMARC reports for any issues
          </p>
          <p>
            Resources:
            <br />
            • MXToolbox (mxtoolbox.com) — Check SPF, DKIM, DMARC records
            <br />
            • Your SMTP provider's documentation — For exact DKIM values and SPF includes
            <br />• Your DNS provider's help docs — For how to add/edit TXT records
          </p>
          <p className="ph-subtitle">Questions? Contact your hosting provider or SMTP provider's support.</p>
        </div>
      </details>
    </>
  );
}
