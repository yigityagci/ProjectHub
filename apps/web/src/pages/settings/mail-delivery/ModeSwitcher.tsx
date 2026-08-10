import type { MailDeliveryMode, SelfHostedAvailability } from "./types.js";

/**
 * Two radio-cards styled after AppearanceTab.tsx's theme picker (a
 * <label> wrapping a radio input + <strong> title + .ph-subtitle
 * description), each with a trailing badge — "Recommended" on External
 * SMTP (reuses .ph-badge-status-active's green tint) and "Advanced" on
 * Self-hosted Postfix (reuses .ph-badge-stale's amber tint). Selecting a
 * card is purely a local UI choice (see MailDeliveryPanel.tsx's Flow A
 * doc comment) — nothing is sent to the API until the active section's
 * own Save button is used.
 */
export default function ModeSwitcher({
  selected,
  onChange,
  selfHosted,
}: {
  selected: MailDeliveryMode;
  onChange: (mode: MailDeliveryMode) => void;
  selfHosted: SelfHostedAvailability | null;
}) {
  const postfixAvailable = selfHosted?.available ?? false;
  const postfixDescription = postfixAvailable
    ? "Run your own Postfix mail server with DKIM signing, rate limiting, and built-in DNS/queue diagnostics."
    : selfHosted?.detail ?? "Checking availability...";

  return (
    <div style={{ display: "grid", gap: "0.7rem", margin: "0.5rem 0 1.25rem" }} role="radiogroup" aria-label="Mail delivery mode">
      <label
        className={`ph-mail-mode-card${selected === "smtp" ? " ph-mail-mode-card-selected" : ""}`}
      >
        <input
          type="radio"
          name="mailDeliveryMode"
          checked={selected === "smtp"}
          onChange={() => onChange("smtp")}
          style={{ marginTop: "0.2rem" }}
        />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            <strong>External SMTP</strong>
            <span className="ph-badge ph-badge-status-active">Recommended</span>
          </span>
          <div className="ph-subtitle" style={{ margin: "0.2rem 0 0" }}>
            Connect to an outgoing mail server or transactional email provider (SendGrid, Mailgun, AWS SES, your own
            SMTP relay, etc.).
          </div>
        </span>
      </label>

      <label
        className={`ph-mail-mode-card${selected === "postfix" ? " ph-mail-mode-card-selected" : ""}${
          postfixAvailable ? "" : " ph-mail-mode-card-disabled"
        }`}
      >
        <input
          type="radio"
          name="mailDeliveryMode"
          checked={selected === "postfix"}
          disabled={!postfixAvailable}
          onChange={() => onChange("postfix")}
          style={{ marginTop: "0.2rem" }}
        />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexWrap: "wrap" }}>
            <strong>Self-hosted Postfix</strong>
            <span className="ph-badge ph-badge-stale">Advanced</span>
          </span>
          <div className="ph-subtitle" style={{ margin: "0.2rem 0 0" }}>
            {postfixDescription}
          </div>
        </span>
      </label>
    </div>
  );
}
