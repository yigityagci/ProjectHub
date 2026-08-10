import { useEffect, useState } from "react";
import { api, ApiError } from "../../lib/api.js";
import ModeSwitcher from "./mail-delivery/ModeSwitcher.js";
import ExternalSmtpSection from "./mail-delivery/ExternalSmtpSection.js";
import SelfHostedPostfixSection from "./mail-delivery/SelfHostedPostfixSection.js";
import type { MailDeliveryMode, PostfixConfigView, SelfHostedAvailability } from "./mail-delivery/types.js";

/**
 * Owns the mode switcher + the persistent "advanced mode" warning callout
 * + delegates to whichever mode's section is currently selected. Selecting
 * a radio card is a purely local UI choice (Flow A in the design handoff)
 * — it only changes which section is displayed/editable; nothing is sent
 * to the API until that section's own Save action runs. The two saved
 * configs (SMTP / Postfix) persist independently; only one actually routes
 * real mail at a time, via `postfix.enabled` (see GET
 * /api/platform/mail-delivery's `mode` field, which is derived from
 * exactly that).
 *
 * Fetches the aggregate GET /api/platform/mail-delivery once up front (for
 * `mode`/`selfHosted`/the initial Postfix config) — ExternalSmtpSection
 * still self-fetches its own GET /api/platform/email-config, unchanged
 * from before this restructuring, since that endpoint isn't part of the
 * aggregate response's editable-form contract and this keeps that
 * section's behavior a true no-op diff from the pre-existing panel.
 */
export default function MailDeliveryPanel({ userEmail }: { userEmail: string }) {
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedMode, setSelectedMode] = useState<MailDeliveryMode>("smtp");
  const [activeMode, setActiveMode] = useState<MailDeliveryMode>("smtp");
  const [smtpActive, setSmtpActive] = useState(false);
  const [postfixConfig, setPostfixConfig] = useState<PostfixConfigView | null>(null);
  const [selfHosted, setSelfHosted] = useState<SelfHostedAvailability | null>(null);

  /**
   * Re-fetches everything the aggregate endpoint reports EXCEPT
   * `selectedMode` — an admin who deliberately switched the radio to
   * inspect/edit the mode that ISN'T currently active (e.g. viewing
   * External SMTP settings while Self-hosted Postfix remains the active
   * mode elsewhere) must not have that choice silently reverted out from
   * under them just because they saved something. Only the very first
   * load (below) seeds `selectedMode` from the server's `mode`.
   */
  async function refreshStatus() {
    try {
      const res = await api.get<{
        mode: MailDeliveryMode;
        smtp: { enabled: boolean } | null;
        postfix: PostfixConfigView | null;
        selfHosted: SelfHostedAvailability;
      }>("/api/platform/mail-delivery");
      setActiveMode(res.mode);
      setSmtpActive(res.smtp?.enabled ?? false);
      setPostfixConfig(res.postfix);
      setSelfHosted(res.selfHosted);
      setLoadError(null);
      return res;
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load mail delivery settings.");
      return null;
    }
  }

  useEffect(() => {
    // refreshStatus() catches its own errors internally and never rejects.
    refreshStatus()
      .then((res) => {
        if (res) setSelectedMode(res.mode);
      })
      .finally(() => setLoaded(true));
  }, []);

  function handlePostfixConfigChange(config: PostfixConfigView) {
    setPostfixConfig(config);
    setActiveMode(config.enabled ? "postfix" : smtpActive ? "smtp" : activeMode);
  }

  const isEnabled = activeMode === "postfix" ? (postfixConfig?.enabled ?? false) : smtpActive;

  return (
    <div className="ph-card ph-card-wide">
      <h1 style={{ fontSize: "1rem", display: "flex", alignItems: "center", gap: "0.6rem" }}>
        Mail Delivery
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
      <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
        {isEnabled
          ? `Invitations, password resets, task assignments, and mentions are sent by email (via ${
              activeMode === "postfix" ? "self-hosted Postfix" : "external SMTP"
            }).`
          : "Disabled — invitations and task notifications will not be sent by email. The app continues to work normally."}
      </p>

      {!loaded ? (
        <p>Loading...</p>
      ) : (
        <>
          {loadError && <div className="ph-alert ph-alert-error">{loadError}</div>}

          <ModeSwitcher selected={selectedMode} onChange={setSelectedMode} selfHosted={selfHosted} />

          {selectedMode === "postfix" && (
            <div className="ph-alert ph-alert-warning">
              Self-hosted Postfix is an advanced option. You are responsible for keeping this mail server
              reachable, its DNS records (SPF/DKIM/DMARC/PTR) correct, and its outbound port 25 access working —
              misconfiguration here can cause mail to silently fail to deliver. Use the diagnostics below (Service
              status, DNS setup, Port 25 check) to verify your setup before relying on it.
            </div>
          )}

          {selectedMode === "smtp" ? (
            <ExternalSmtpSection userEmail={userEmail} onChanged={refreshStatus} />
          ) : (
            <SelfHostedPostfixSection
              userEmail={userEmail}
              initialConfig={postfixConfig}
              selfHosted={selfHosted}
              onConfigChange={handlePostfixConfigChange}
            />
          )}
        </>
      )}
    </div>
  );
}
