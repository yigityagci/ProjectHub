/**
 * Rate-limit fields for the self-hosted Postfix settings form. Each field
 * pairs a plain-language label with a small monospace caption showing the
 * REAL underlying Postfix parameter name — see
 * updatePostfixConfigSchema (packages/shared/src/dto/postfix-mail.ts) for
 * the exact min/max ranges enforced server-side, mirrored here as the
 * input `min`/`max` so client-side validation never falls out of sync
 * with what the server will actually accept.
 *
 * Unlike the design brief's illustrative caption wording ("Leave blank to
 * use Postfix's default"), these three fields are NOT optional in
 * updatePostfixConfigSchema — every save sends a concrete number — so the
 * inputs are always pre-filled with a value (Postfix's own out-of-the-box
 * defaults when no config has been saved yet) rather than ever rendering
 * blank.
 */
export default function RateLimitFields({
  rateDelaySeconds,
  onRateDelaySecondsChange,
  concurrencyLimit,
  onConcurrencyLimitChange,
  messageSizeLimitMb,
  onMessageSizeLimitMbChange,
  disabled,
}: {
  rateDelaySeconds: string;
  onRateDelaySecondsChange: (value: string) => void;
  concurrencyLimit: string;
  onConcurrencyLimitChange: (value: string) => void;
  messageSizeLimitMb: string;
  onMessageSizeLimitMbChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <>
      <div className="ph-field">
        <label htmlFor="pfRateDelay">
          Minimum delay Postfix waits between messages sent to the same destination domain (seconds)
        </label>
        <input
          id="pfRateDelay"
          type="number"
          min={0}
          max={3600}
          value={rateDelaySeconds}
          onChange={(e) => onRateDelaySecondsChange(e.target.value)}
          disabled={disabled}
          required
        />
        <span className="ph-mono-caption">smtp_destination_rate_delay — 0 to 3600, default 0 (no delay)</span>
      </div>
      <div className="ph-field">
        <label htmlFor="pfConcurrencyLimit">Maximum simultaneous deliveries Postfix makes to the same destination domain</label>
        <input
          id="pfConcurrencyLimit"
          type="number"
          min={1}
          max={100}
          value={concurrencyLimit}
          onChange={(e) => onConcurrencyLimitChange(e.target.value)}
          disabled={disabled}
          required
        />
        <span className="ph-mono-caption">smtp_destination_concurrency_limit — 1 to 100, default 20</span>
      </div>
      <div className="ph-field">
        <label htmlFor="pfMessageSizeLimit">Maximum size of a single outgoing message, including attachments (MB)</label>
        <input
          id="pfMessageSizeLimit"
          type="number"
          min={1}
          max={100}
          value={messageSizeLimitMb}
          onChange={(e) => onMessageSizeLimitMbChange(e.target.value)}
          disabled={disabled}
          required
        />
        <span className="ph-mono-caption">message_size_limit — 1 to 100 MB, default 10 MB</span>
      </div>
    </>
  );
}
