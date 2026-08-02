import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { SMTP_SECURITY_MODES, type SmtpSecurityMode } from "@projecthub/shared";
import { Brand } from "../../App.js";
import type { CurrentUser } from "../../App.js";
import { api, ApiError } from "../../lib/api.js";
import NotificationBell from "../../components/NotificationBell.js";
import ThemeToggle from "../../components/ThemeToggle.js";

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

/**
 * Small copy-to-clipboard affordance for DNS record values — mirrors
 * RegistrationTokensPanel.tsx's handleCopy pattern (read-only input +
 * "Copy"/"Copied" button) rather than inventing a new interaction.
 */
function CopyableCode({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", margin: "0.35rem 0 0.75rem" }}>
      <pre
        style={{
          flex: 1,
          margin: 0,
          padding: "0.5rem 0.65rem",
          background: "var(--ph-surface-2)",
          border: "1px solid var(--ph-border)",
          borderRadius: "8px",
          overflowX: "auto",
          whiteSpace: "pre",
          fontSize: "0.78rem",
        }}
      >
        <code>{value}</code>
      </pre>
      <button
        type="button"
        className="ph-button ph-button-secondary"
        style={{ width: "auto", flexShrink: 0, fontSize: "0.78rem", padding: "0.35rem 0.6rem" }}
        onClick={handleCopy}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export default function PlatformEmailSettingsPage({ user }: { user: CurrentUser }) {
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
      const res = await api.post<{ ok: boolean; error?: string }>("/api/platform/email-config/test");
      if (res.ok) {
        setTestSuccess(`Test email sent to ${user.email}.`);
      } else {
        setTestError(res.error ?? "Failed to send the test email.");
      }
    } catch (err) {
      setTestError(err instanceof ApiError ? err.message : "Failed to send the test email.");
    } finally {
      setTesting(false);
    }
  }

  const isEnabled = config?.enabled ?? false;
  const domain = config?.fromAddress.split("@")[1]?.trim() || "example.com";
  const exampleFromAddress = config?.fromAddress || "no-reply@example.com";

  return (
    <div className="ph-shell ph-shell-wide">
      <div className="ph-topbar ph-topbar-wide">
        <Brand />
        <div className="ph-topbar-actions">
          <ThemeToggle />
          <NotificationBell />
          <span style={{ fontSize: "0.9rem" }}>{user.displayName}</span>
        </div>
      </div>

      <div className="ph-page-wide">
        <div className="ph-breadcrumb">
          <Link to="/">Your workspaces</Link> / Platform Settings / Email
        </div>

        <div className="ph-page-header">
          <div>
            <h1 style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
              Email Configuration
              <span
                style={{
                  fontSize: "0.7rem",
                  fontWeight: 700,
                  padding: "0.2rem 0.55rem",
                  borderRadius: "999px",
                  background: isEnabled ? "rgba(22, 163, 74, 0.14)" : "rgba(217, 119, 6, 0.14)",
                  color: isEnabled ? "var(--ph-success)" : "var(--ph-warning)",
                  textTransform: "uppercase",
                  letterSpacing: "0.03em",
                }}
              >
                {isEnabled ? "Enabled" : "Disabled"}
              </span>
            </h1>
            <p className="ph-subtitle">
              {isEnabled
                ? "Invitations, password resets, task assignments, and mentions are sent by email."
                : "Disabled — invitations and task notifications will not be sent by email. The app continues to work normally."}
            </p>
          </div>
        </div>

        {!loaded ? (
          <p>Loading...</p>
        ) : (
          <>
            <div className="ph-card ph-card-wide">
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
                  checked={isEnabled}
                  disabled={!config || togglingEnabled}
                  onChange={(e) => handleToggleEnabled(e.target.checked)}
                />
                <span>
                  <strong>{isEnabled ? "Email is ON" : "Email is currently OFF"}</strong>
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
                Send a test email to your own account address ({user.email}) using the currently saved configuration
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
                  If you're self-hosting your own mail server (MTA), you'll need to generate DKIM keys yourself using
                  tools like OpenDKIM. This is advanced — most self-hosters use a transactional email provider
                  instead.
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
                  Important: PTR records are only relevant if you're running your own mail server (MTA) on a
                  dedicated IP. If you're using a transactional email provider like SendGrid or Mailgun, they handle
                  PTR for you — skip this.
                </p>
                <p>
                  If you are self-hosting an MTA:
                  <br />
                  • PTR is configured with your hosting/cloud provider (AWS, DigitalOcean, etc.), not in your DNS
                  zone
                  <br />
                  • Example: IP 192.0.2.1 → reverse DNS → mail.{domain}
                  <br />• Contact your hosting provider's support to request a PTR record setup
                </p>
                <p>For most ProjectHub self-hosters, this section doesn't apply.</p>

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
        )}
      </div>
    </div>
  );
}
