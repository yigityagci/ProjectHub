import { useState } from "react";

/**
 * Small copy-to-clipboard affordance for DNS/DKIM record values — moved
 * out of MailDeliveryPanel.tsx verbatim (it originally lived inline there)
 * so DnsSetupPanel.tsx and DkimKeyCard.tsx can reuse the exact same
 * read-only-block + Copy button pattern instead of duplicating it.
 */
export default function CopyableCode({ value }: { value: string }) {
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
