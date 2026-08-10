import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../../lib/api.js";
import DkimKeyCard from "./DkimKeyCard.js";
import RateLimitFields from "./RateLimitFields.js";
import ServiceStatusCard from "./ServiceStatusCard.js";
import QueueStatusCard from "./QueueStatusCard.js";
import DeliveryErrorLog from "./DeliveryErrorLog.js";
import DnsSetupPanel from "./DnsSetupPanel.js";
import Port25Check from "./Port25Check.js";
import type {
  ApplyOutcome,
  DkimKeyGenerationResult,
  PostfixConfigView,
  PostfixQueueResult,
  PostfixStatusResult,
  SelfHostedAvailability,
} from "./types.js";

const BYTES_PER_MB = 1024 * 1024;

/**
 * Self-hosted Postfix settings + operational card stack. `updatePostfixConfigSchema`
 * (packages/shared/src/dto/postfix-mail.ts) is a `.strict()` full-replace
 * schema — every PATCH must resend every required field, not just the one
 * the admin just touched — so all editable fields (domain/hostname/sender/
 * reply-to/DKIM selector/DKIM signing/rate limits) live in ONE shared form
 * state here, even though they're rendered across several visually
 * separate `ph-card` sections (Self-hosted settings, DKIM, Rate limits)
 * per the design brief's card stack. The DKIM "sign outgoing mail"
 * checkbox applies immediately (mirrors ExternalSmtpSection's enabled
 * toggle precedent) rather than waiting for the big Save button, since
 * it's the more natural mental model for a checkbox next to a live key.
 */
export default function SelfHostedPostfixSection({
  userEmail,
  initialConfig,
  selfHosted,
  onConfigChange,
}: {
  userEmail: string;
  initialConfig: PostfixConfigView | null;
  selfHosted: SelfHostedAvailability | null;
  onConfigChange: (config: PostfixConfigView) => void;
}) {
  const [config, setConfig] = useState<PostfixConfigView | null>(initialConfig);

  const [enabled, setEnabled] = useState(initialConfig?.enabled ?? false);
  const [sendingDomain, setSendingDomain] = useState(initialConfig?.sendingDomain ?? "");
  const [mailHostname, setMailHostname] = useState(initialConfig?.mailHostname ?? "");
  const [senderName, setSenderName] = useState(initialConfig?.senderName ?? "ProjectHub");
  const [replyToAddress, setReplyToAddress] = useState(initialConfig?.replyToAddress ?? "");
  const [dkimSelector, setDkimSelector] = useState(initialConfig?.dkimSelector ?? "projecthub");
  const [dkimSigningEnabled, setDkimSigningEnabled] = useState(initialConfig?.dkimSigningEnabled ?? false);
  const [rateDelaySeconds, setRateDelaySeconds] = useState(String(initialConfig?.destinationRateDelaySeconds ?? 0));
  const [concurrencyLimit, setConcurrencyLimit] = useState(String(initialConfig?.destinationConcurrencyLimit ?? 20));
  const [messageSizeLimitMb, setMessageSizeLimitMb] = useState(
    String(Math.round((initialConfig?.messageSizeLimitBytes ?? 10 * BYTES_PER_MB) / BYTES_PER_MB)),
  );

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyOutcome | null>(null);
  const [applyResultAppliesTo, setApplyResultAppliesTo] = useState(false);

  const [togglingSigning, setTogglingSigning] = useState(false);
  const [signingToggleError, setSigningToggleError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testSuccess, setTestSuccess] = useState<string | null>(null);

  const [status, setStatus] = useState<PostfixStatusResult | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [queue, setQueue] = useState<PostfixQueueResult | null>(null);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState<string | null>(null);

  const hasSavedConfig = config !== null;

  function buildPayload(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      enabled,
      sendingDomain: sendingDomain.trim().toLowerCase(),
      mailHostname: mailHostname.trim().toLowerCase(),
      senderName: senderName.trim(),
      replyToAddress: replyToAddress.trim() ? replyToAddress.trim().toLowerCase() : null,
      dkimSelector: dkimSelector.trim().toLowerCase(),
      dkimSigningEnabled,
      destinationRateDelaySeconds: Number(rateDelaySeconds),
      destinationConcurrencyLimit: Number(concurrencyLimit),
      messageSizeLimitBytes: Math.round(Number(messageSizeLimitMb) * BYTES_PER_MB),
      ...overrides,
    };
  }

  async function handleSaveSettings(e: FormEvent) {
    e.preventDefault();
    setSaveError(null);
    setSaveSuccess(null);
    setApplyResult(null);
    setSaving(true);
    const willBeEnabled = enabled;
    try {
      const payload = buildPayload();
      const res = await api.patch<{ config: PostfixConfigView; apply: ApplyOutcome }>(
        "/api/platform/postfix-config",
        payload,
      );
      setConfig(res.config);
      onConfigChange(res.config);
      setSaveSuccess("Self-hosted settings saved.");
      setApplyResult(res.apply);
      setApplyResultAppliesTo(willBeEnabled);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not save the self-hosted configuration.");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleSigningEnabled(next: boolean) {
    setSigningToggleError(null);
    setTogglingSigning(true);
    const previous = dkimSigningEnabled;
    setDkimSigningEnabled(next);
    try {
      const payload = buildPayload({ dkimSigningEnabled: next });
      const res = await api.patch<{ config: PostfixConfigView; apply: ApplyOutcome }>(
        "/api/platform/postfix-config",
        payload,
      );
      setConfig(res.config);
      onConfigChange(res.config);
    } catch (err) {
      setDkimSigningEnabled(previous);
      setSigningToggleError(err instanceof ApiError ? err.message : "Could not update DKIM signing.");
    } finally {
      setTogglingSigning(false);
    }
  }

  function handleDkimGenerated(dkim: DkimKeyGenerationResult) {
    if (!config) return;
    const updated: PostfixConfigView = {
      ...config,
      hasDkimKey: true,
      dkimGeneratedAt: dkim.generatedAt,
      dkimSelector: dkim.selector,
      dkimKeyBits: dkim.keyBits,
      // Rotation always forces signing back off server-side until the new
      // DNS record is republished — see storeDkimKey's doc comment.
      dkimSigningEnabled: false,
    };
    setConfig(updated);
    setDkimSelector(dkim.selector);
    setDkimSigningEnabled(false);
    onConfigChange(updated);
  }

  async function handleTestEmail() {
    setTestError(null);
    setTestSuccess(null);
    setTesting(true);
    try {
      // Same anti-abuse rule as the SMTP test route this mirrors (see
      // postfix-config.routes.ts's test-email handler's doc comment): the
      // recipient is ALWAYS the caller's own account email server-side,
      // never client-supplied — there is nothing meaningful to send in
      // the request body.
      const res = await api.post<{ ok: boolean; error?: string; sender?: string }>(
        "/api/platform/postfix-config/test-email",
      );
      if (res.ok) {
        setTestSuccess(`Test email sent to ${userEmail}.`);
      } else {
        setTestError(res.error ?? "Failed to send the test email.");
      }
    } catch (err) {
      setTestError(err instanceof ApiError ? err.message : "Failed to send the test email.");
    } finally {
      setTesting(false);
    }
  }

  async function fetchStatus() {
    setStatusError(null);
    setStatusLoading(true);
    try {
      const res = await api.get<PostfixStatusResult>("/api/platform/postfix-config/status");
      setStatus(res);
    } catch (err) {
      setStatusError(err instanceof ApiError ? err.message : "Could not check service status.");
    } finally {
      setStatusLoading(false);
    }
  }

  async function fetchQueue() {
    setQueueError(null);
    setQueueLoading(true);
    try {
      const res = await api.get<PostfixQueueResult>("/api/platform/postfix-config/queue");
      setQueue(res);
    } catch (err) {
      setQueueError(err instanceof ApiError ? err.message : "Could not load queue status.");
    } finally {
      setQueueLoading(false);
    }
  }

  useEffect(() => {
    fetchStatus().catch(() => undefined);
    fetchQueue().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requiredFieldsFilled = sendingDomain.trim() !== "" && mailHostname.trim() !== "" && senderName.trim() !== "";
  const liveSenderAddress = sendingDomain.trim() ? `no-reply@${sendingDomain.trim().toLowerCase()}` : "no-reply@<domain>";

  return (
    <>
      <form onSubmit={handleSaveSettings}>
        <div className="ph-card ph-card-wide" style={{ marginTop: "1rem" }}>
          <h1 style={{ fontSize: "1rem" }}>Self-hosted settings</h1>
          <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
            ProjectHub runs its own Postfix mail server for you (see the shipped docker-compose deployment's
            `postfix` service). Configure the domain and hostname it should send as below.
          </p>

          {saveError && <div className="ph-alert ph-alert-error">{saveError}</div>}
          {saveSuccess && <div className="ph-alert ph-alert-success">{saveSuccess}</div>}
          {applyResultAppliesTo &&
            applyResult &&
            (applyResult.ok ? (
              <div className="ph-alert ph-alert-success">
                Applied to Postfix successfully.
                {applyResult.warnings && applyResult.warnings.length > 0 ? ` Warnings: ${applyResult.warnings.join("; ")}` : ""}
              </div>
            ) : (
              <div className="ph-alert ph-alert-warning">
                Settings saved, but applying them to Postfix failed: {applyResult.error ?? "Unknown error."}
              </div>
            ))}

          <label style={{ display: "flex", alignItems: "flex-start", gap: "0.6rem", margin: "0.5rem 0 1rem" }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={saving} />
            <span>
              <strong>{enabled ? "Self-hosted Postfix will be the active mail delivery path" : "Self-hosted Postfix is currently inactive"}</strong>
              <div className="ph-subtitle" style={{ margin: 0 }}>
                Only one mail delivery mode routes real mail at a time. Save to apply this change.
              </div>
            </span>
          </label>

          <div className="ph-field">
            <label htmlFor="pfSendingDomain">Sending domain</label>
            <input
              id="pfSendingDomain"
              value={sendingDomain}
              onChange={(e) => setSendingDomain(e.target.value)}
              placeholder="e.g., example.com"
              disabled={saving}
              required
            />
          </div>
          <div className="ph-field">
            <label htmlFor="pfMailHostname">Mail hostname</label>
            <input
              id="pfMailHostname"
              value={mailHostname}
              onChange={(e) => setMailHostname(e.target.value)}
              placeholder="e.g., mail.example.com"
              disabled={saving}
              required
            />
          </div>
          <div className="ph-field">
            <label htmlFor="pfSenderName">Sender name</label>
            <input
              id="pfSenderName"
              value={senderName}
              onChange={(e) => setSenderName(e.target.value)}
              placeholder="e.g., ProjectHub"
              disabled={saving}
              required
            />
          </div>
          <div className="ph-field">
            <label htmlFor="pfSenderAddress">Sender address</label>
            <input
              id="pfSenderAddress"
              value={liveSenderAddress}
              readOnly
              onFocus={(e) => e.target.select()}
              style={{ opacity: 0.7 }}
            />
            <div className="ph-subtitle" style={{ margin: "0.25rem 0 0" }}>
              Always <code>no-reply@&lt;sending domain&gt;</code> in self-hosted mode — not editable.
            </div>
          </div>
          <div className="ph-field">
            <label htmlFor="pfReplyTo">Reply-To (optional)</label>
            <input
              id="pfReplyTo"
              type="email"
              value={replyToAddress}
              onChange={(e) => setReplyToAddress(e.target.value)}
              placeholder="e.g., support@example.com"
              disabled={saving}
            />
          </div>

          <button className="ph-button" type="submit" disabled={saving || !requiredFieldsFilled} style={{ width: "auto" }}>
            {saving ? "Saving..." : "Save self-hosted settings"}
          </button>
        </div>

        <div className="ph-card ph-card-wide" style={{ marginTop: "1.5rem" }}>
          <h1 style={{ fontSize: "1rem" }}>Rate limits</h1>
          <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
            Controls how aggressively Postfix sends outgoing mail. The defaults are sensible for most setups.
          </p>
          <RateLimitFields
            rateDelaySeconds={rateDelaySeconds}
            onRateDelaySecondsChange={setRateDelaySeconds}
            concurrencyLimit={concurrencyLimit}
            onConcurrencyLimitChange={setConcurrencyLimit}
            messageSizeLimitMb={messageSizeLimitMb}
            onMessageSizeLimitMbChange={setMessageSizeLimitMb}
            disabled={saving}
          />
          <button className="ph-button ph-button-secondary" type="submit" disabled={saving || !requiredFieldsFilled} style={{ width: "auto" }}>
            {saving ? "Saving..." : "Save rate limits"}
          </button>
        </div>
      </form>

      <DkimKeyCard
        config={config}
        disabled={!hasSavedConfig}
        dkimSigningEnabled={dkimSigningEnabled}
        onToggleSigningEnabled={handleToggleSigningEnabled}
        togglingSigning={togglingSigning}
        toggleError={signingToggleError}
        onGenerated={handleDkimGenerated}
      />

      <div className="ph-card ph-card-wide" style={{ marginTop: "1.5rem" }}>
        <h1 style={{ fontSize: "1rem" }}>Test email</h1>
        <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
          Send a test email to your own account address ({userEmail}) through self-hosted Postfix, using the
          currently saved configuration above, to confirm it actually delivers.
        </p>
        {testError && <div className="ph-alert ph-alert-error">{testError}</div>}
        {testSuccess && <div className="ph-alert ph-alert-success">{testSuccess}</div>}
        <button
          type="button"
          className="ph-button"
          style={{ width: "auto" }}
          disabled={testing || !hasSavedConfig}
          onClick={handleTestEmail}
        >
          {testing ? "Sending..." : "Send test email"}
        </button>
        {!hasSavedConfig && (
          <p className="ph-subtitle" style={{ margin: "0.5rem 0 0" }}>
            Save the self-hosted settings above before sending a test email.
          </p>
        )}
      </div>

      <ServiceStatusCard status={status} loading={statusLoading} error={statusError} config={config} onRefresh={fetchStatus} />

      <DeliveryErrorLog queue={queue} loading={queueLoading} error={queueError} />

      <QueueStatusCard queue={queue} loading={queueLoading} error={queueError} onRefresh={fetchQueue} />

      <DnsSetupPanel hasConfig={hasSavedConfig} />

      <Port25Check outboundSmtp={status?.outboundSmtp} loading={statusLoading} error={statusError} onRunCheck={fetchStatus} />
    </>
  );
}
