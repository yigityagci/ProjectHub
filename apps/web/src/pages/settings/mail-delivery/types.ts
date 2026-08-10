// Frontend-side mirrors of the Pass 1 backend response shapes for the
// self-hosted Postfix mail-delivery surfaces (apps/api/src/email/
// postfix-config.routes.ts, mail-control.client.ts, dns-check.service.ts).
// Deliberately duplicated here rather than imported from the API package —
// this codebase's settings tabs consistently define their own local view
// types next to the component that consumes them (see e.g.
// MailDeliveryPanel.tsx's original PlatformEmailConfigView) rather than
// sharing wire-shape types across the API/web boundary.

export type MailDeliveryMode = "smtp" | "postfix";

/** Exactly serializePostfixConfig()'s return shape — see postfix-config.service.ts. */
export interface PostfixConfigView {
  enabled: boolean;
  sendingDomain: string;
  mailHostname: string;
  senderName: string;
  replyToAddress: string | null;
  senderAddress: string;
  dkimSelector: string;
  dkimKeyBits: number;
  dkimSigningEnabled: boolean;
  hasDkimKey: boolean;
  dkimPublicKey: string | null;
  dkimGeneratedAt: string | null;
  destinationRateDelaySeconds: number;
  destinationConcurrencyLimit: number;
  messageSizeLimitBytes: number;
  lastAppliedAt: string | null;
  lastApplyOk: boolean | null;
  lastApplyError: string | null;
  updatedAt: string;
  updatedByDisplayName: string | null;
}

export type SelfHostedAvailabilityReason = "ok" | "not_configured" | "unreachable" | "unauthorized";

/** GET /api/platform/mail-delivery's `selfHosted` field. */
export interface SelfHostedAvailability {
  available: boolean;
  reason: SelfHostedAvailabilityReason;
  detail: string;
  checkedAt: string;
}

/** The `apply` sub-object returned by PATCH /postfix-config and POST /postfix-config/apply. */
export interface ApplyOutcome {
  ok: boolean;
  error?: string;
  warnings?: string[];
}

/** GET /api/platform/postfix-config/status — also IS the port-25 check (see `outboundSmtp`). */
export interface PostfixStatusResult {
  ok: boolean;
  processes?: Record<string, string>;
  postfixVersion?: string;
  appliedConfig?: Record<string, unknown>;
  outboundSmtp?: {
    checked: boolean;
    reachable: boolean;
    target: string | null;
    latencyMs: number | null;
    error: string | null;
    bestEffort: true;
    checkedAt: string;
  };
  checkedAt?: string;
  error?: string;
}

/** GET /api/platform/postfix-config/queue */
export interface PostfixQueueResult {
  ok: boolean;
  counts?: {
    total: number;
    active: number;
    deferred: number;
    hold: number;
    incoming: number;
    maildrop: number;
  };
  oldestArrivalAt?: string | null;
  recentErrors?: Array<{ queueId: string; arrivalAt: string; recipient: string; reason: string }>;
  truncated?: boolean;
  checkedAt?: string;
  error?: string;
}

export interface DnsCheckRecordEntry {
  name: string;
  type: string;
  value: string | null;
}

/** GET /api/platform/postfix-config/dns-check */
export interface DnsCheckResult {
  bestEffort: true;
  checkedAt: string;
  records: {
    a: DnsCheckRecordEntry;
    spf: DnsCheckRecordEntry;
    dkim: DnsCheckRecordEntry;
    dmarc: DnsCheckRecordEntry;
    ptr: DnsCheckRecordEntry;
  };
  checks: {
    a: { present: boolean; resolved: string[]; ok: boolean; note: string };
    spf: { present: boolean; record: string | null; ok: boolean; note: string };
    dkim: { present: boolean; record: string | null; ok: boolean; note: string };
    dmarc: { present: boolean; record: string | null; policy: string | null; ok: boolean; note: string };
    ptr: { present: boolean; resolved: string[]; ok: boolean; note: string };
  };
}

/** POST /api/platform/postfix-config/dkim-key's `dkim` field. */
export interface DkimKeyGenerationResult {
  selector: string;
  keyBits: number;
  generatedAt: string;
  dnsRecord: { name: string; type: string; value: string; chunkedValue: string[] };
}
