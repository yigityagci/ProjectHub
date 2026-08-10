import { useState } from "react";
import { api, ApiError } from "../../../lib/api.js";
import type { DkimKeyGenerationResult, PostfixConfigView } from "./types.js";

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

/**
 * DKIM key generation card. Mirrors RegistrationTokensPanel.tsx's
 * `justGeneratedToken` one-time-reveal pattern EXACTLY (read-only input +
 * Copy button + bold "only shown once" warning) for the freshly generated
 * DNS TXT value — the API (POST /postfix-config/dkim-key) is the ONLY
 * endpoint that ever returns the DKIM public value; every later
 * GET /api/platform/mail-delivery only ever reports `hasDkimKey: true` +
 * `dkimGeneratedAt`, never the value again. This component holds that
 * reveal in local state only (`justGenerated`) — it is never persisted,
 * never re-derived from `config`, and disappears the moment this page is
 * left/reloaded.
 */
export default function DkimKeyCard({
  config,
  disabled,
  dkimSigningEnabled,
  onToggleSigningEnabled,
  togglingSigning,
  toggleError,
  onGenerated,
}: {
  config: PostfixConfigView | null;
  disabled: boolean;
  dkimSigningEnabled: boolean;
  onToggleSigningEnabled: (next: boolean) => void;
  togglingSigning: boolean;
  toggleError: string | null;
  onGenerated: (dkim: DkimKeyGenerationResult) => void;
}) {
  const [keyBits, setKeyBits] = useState<2048 | 4096>(2048);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [justGenerated, setJustGenerated] = useState<DkimKeyGenerationResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmingRegenerate, setConfirmingRegenerate] = useState(false);

  const hasKey = config?.hasDkimKey ?? false;

  async function handleGenerate() {
    setGenerateError(null);
    setGenerating(true);
    setCopied(false);
    try {
      const res = await api.post<{ dkim: DkimKeyGenerationResult }>("/api/platform/postfix-config/dkim-key", {
        keyBits,
      });
      setJustGenerated(res.dkim);
      setConfirmingRegenerate(false);
      onGenerated(res.dkim);
    } catch (err) {
      setGenerateError(err instanceof ApiError ? err.message : "Could not generate a DKIM key.");
    } finally {
      setGenerating(false);
    }
  }

  async function handleCopy() {
    if (!justGenerated) return;
    try {
      await navigator.clipboard.writeText(justGenerated.dnsRecord.value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="ph-card ph-card-wide" style={{ marginTop: "1.5rem" }}>
      <h1 style={{ fontSize: "1rem" }}>DKIM signing</h1>
      <p className="ph-subtitle" style={{ margin: "0 0 0.75rem" }}>
        DKIM adds a cryptographic signature to outgoing mail proving it wasn't forged. ProjectHub generates and
        stores the private key for you — you only ever need to publish the matching public key shown below as a
        DNS TXT record.
      </p>

      {generateError && <div className="ph-alert ph-alert-error">{generateError}</div>}

      {disabled ? (
        <div className="ph-empty-state">Save the sending domain and mail hostname below before generating a DKIM key.</div>
      ) : justGenerated ? (
        <div className="ph-alert ph-alert-success">
          <p style={{ marginTop: 0 }}>
            <strong>
              Copy this DKIM record now. For security, the value is only shown once — after you leave this page,
              ProjectHub will not display it again.
            </strong>
          </p>
          <p style={{ fontSize: "0.82rem", margin: "0 0 0.4rem" }}>
            Host (Name): <code>{justGenerated.dnsRecord.name}</code> · Type: <code>{justGenerated.dnsRecord.type}</code>
          </p>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <input readOnly value={justGenerated.dnsRecord.value} onFocus={(e) => e.target.select()} />
            <button type="button" className="ph-button-secondary" onClick={handleCopy}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          {justGenerated.dnsRecord.chunkedValue.length > 1 && (
            <p className="ph-subtitle" style={{ margin: "0.5rem 0 0" }}>
              Some DNS providers require splitting long TXT values into {justGenerated.dnsRecord.chunkedValue.length}{" "}
              quoted segments instead of one. If your provider rejects the single value above, split it at 255
              characters per segment.
            </p>
          )}
        </div>
      ) : hasKey ? (
        <>
          <p style={{ margin: "0 0 0.5rem" }}>
            DKIM key generated on {config?.dkimGeneratedAt ? formatDateTime(config.dkimGeneratedAt) : "unknown date"}{" "}
            ({config?.dkimKeyBits}-bit). Selector/host: <code>{config?.dkimSelector}._domainkey.{config?.sendingDomain}</code>
          </p>
          {confirmingRegenerate ? (
            <div className="ph-alert ph-alert-warning">
              <p style={{ marginTop: 0 }}>
                Regenerating creates a new key pair immediately. Mail signed with the old key will start failing
                DKIM checks as soon as you regenerate — update the DNS record below before your next send, not
                after.
              </p>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <button
                  type="button"
                  className="ph-button ph-button-secondary"
                  style={{ width: "auto" }}
                  disabled={generating}
                  onClick={() => setConfirmingRegenerate(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="ph-button"
                  style={{ width: "auto" }}
                  disabled={generating}
                  onClick={handleGenerate}
                >
                  {generating ? "Regenerating..." : "Yes, regenerate DKIM key"}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="ph-button ph-button-secondary"
              style={{ width: "auto" }}
              onClick={() => setConfirmingRegenerate(true)}
            >
              Regenerate DKIM key
            </button>
          )}
        </>
      ) : (
        <>
          <div className="ph-empty-state" style={{ marginBottom: "0.9rem" }}>
            No DKIM key generated yet.
          </div>
          <div className="ph-field">
            <label htmlFor="pfDkimKeyBits">Key size</label>
            <select id="pfDkimKeyBits" value={keyBits} onChange={(e) => setKeyBits(Number(e.target.value) as 2048 | 4096)}>
              <option value={2048}>2048-bit (recommended)</option>
              <option value={4096}>4096-bit</option>
            </select>
          </div>
          <button
            type="button"
            className="ph-button"
            style={{ width: "auto" }}
            disabled={generating}
            onClick={handleGenerate}
          >
            {generating ? "Generating..." : "Generate DKIM key"}
          </button>
        </>
      )}

      {toggleError && <div className="ph-alert ph-alert-error" style={{ marginTop: "1rem" }}>{toggleError}</div>}
      <label
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: "0.6rem",
          margin: "1rem 0 0",
          opacity: hasKey ? 1 : 0.6,
        }}
      >
        <input
          type="checkbox"
          checked={dkimSigningEnabled}
          disabled={!hasKey || togglingSigning || disabled}
          onChange={(e) => onToggleSigningEnabled(e.target.checked)}
        />
        <span>
          <strong>Sign outgoing mail with DKIM</strong>
          <div className="ph-subtitle" style={{ margin: 0 }}>
            {hasKey
              ? "Applies immediately once toggled."
              : "Generate a DKIM key above before enabling signing."}
          </div>
        </span>
      </label>
    </div>
  );
}
