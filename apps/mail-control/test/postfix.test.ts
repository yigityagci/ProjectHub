import { describe, expect, it } from "vitest";
import { buildPostconfArgs, parsePostfixCheckOutput, parseSupervisorStatus, parseQueueOutput } from "../src/postfix.js";
import type { ValidatedConfigPayload } from "../src/validate.js";

function samplePayload(overrides: Partial<ValidatedConfigPayload> = {}): ValidatedConfigPayload {
  return {
    sendingDomain: "example.com",
    mailHostname: "mail.example.com",
    senderName: "ProjectHub",
    replyToAddress: null,
    dkim: null,
    limits: {
      destinationRateDelaySeconds: 5,
      destinationConcurrencyLimit: 20,
      messageSizeLimitBytes: 10_485_760,
    },
    ...overrides,
  };
}

describe("buildPostconfArgs — config-generation-from-template", () => {
  it("maps every typed field to its hardcoded Postfix parameter, never a caller-named parameter", () => {
    const args = buildPostconfArgs(samplePayload(), "127.0.0.0/8 [::1]/128");
    const flat = args.map((a) => a.join(" "));

    expect(flat).toContainEqual(expect.stringContaining("myhostname=mail.example.com"));
    expect(flat).toContainEqual(expect.stringContaining("mydomain=example.com"));
    expect(flat).toContainEqual(expect.stringContaining("myorigin=$mydomain"));
    expect(flat).toContainEqual(expect.stringContaining("smtp_helo_name=$myhostname"));
    expect(flat).toContainEqual(expect.stringContaining("mydestination="));
    expect(flat).toContainEqual(expect.stringContaining("mynetworks=127.0.0.0/8 [::1]/128"));
    expect(flat).toContainEqual(expect.stringContaining("message_size_limit=10485760"));
    expect(flat).toContainEqual(expect.stringContaining("smtp_destination_rate_delay=5s"));
    expect(flat).toContainEqual(expect.stringContaining("smtp_destination_concurrency_limit=20"));
  });

  it("sets milters to empty when dkim is disabled/null", () => {
    const args = buildPostconfArgs(samplePayload({ dkim: null }), "127.0.0.0/8 [::1]/128");
    const flat = args.map((a) => a.join(" "));
    expect(flat).toContainEqual(expect.stringContaining("smtpd_milters="));
    expect(flat.some((l) => l.includes("smtpd_milters=inet:127.0.0.1:8891"))).toBe(false);
  });

  it("sets milters to the OpenDKIM socket when dkim.enabled is true", () => {
    const args = buildPostconfArgs(samplePayload({ dkim: { enabled: true, selector: "projecthub" } }), "127.0.0.0/8 [::1]/128");
    const flat = args.map((a) => a.join(" "));
    expect(flat).toContainEqual(expect.stringContaining("smtpd_milters=inet:127.0.0.1:8891"));
    expect(flat).toContainEqual(expect.stringContaining("non_smtpd_milters=inet:127.0.0.1:8891"));
  });

  it("every argv targets the staging directory, never the live /etc/postfix directly", () => {
    const args = buildPostconfArgs(samplePayload(), "127.0.0.0/8 [::1]/128");
    for (const argv of args) {
      expect(argv[0]).toBe("-c");
      expect(argv[1]).toBe("/etc/postfix.staging");
    }
  });
});

describe("parsePostfixCheckOutput", () => {
  it("is ok with no fatal/error lines", () => {
    const result = parsePostfixCheckOutput("postfix/postconf: warning: unused parameter: foo\n");
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });

  it("is not ok when a fatal: line is present", () => {
    const result = parsePostfixCheckOutput("postfix/postconf: fatal: bad parameter value\n");
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it("is not ok when an error: line is present", () => {
    const result = parsePostfixCheckOutput("postfix: error: something is wrong\n");
    expect(result.ok).toBe(false);
  });

  it("ignores blank lines", () => {
    const result = parsePostfixCheckOutput("\n\n  \n");
    expect(result.ok).toBe(true);
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

describe("parseSupervisorStatus", () => {
  it("parses a typical supervisorctl status block", () => {
    const output = ["postfix                          RUNNING   pid 12, uptime 0:01:02", "opendkim                         RUNNING   pid 13, uptime 0:01:02", "control                          RUNNING   pid 14, uptime 0:01:02"].join("\n");
    const statuses = parseSupervisorStatus(output);
    expect(statuses).toEqual({ postfix: "RUNNING", opendkim: "RUNNING", control: "RUNNING" });
  });

  it("handles a STOPPED/FATAL process", () => {
    const statuses = parseSupervisorStatus("opendkim                         FATAL     Exited too quickly\n");
    expect(statuses.opendkim).toBe("FATAL");
  });

  it("returns an empty object for empty output", () => {
    expect(parseSupervisorStatus("")).toEqual({});
  });
});

describe("parseQueueOutput", () => {
  it("counts entries by queue_name and extracts recipient errors", () => {
    const ndjson = [
      JSON.stringify({ queue_id: "AAA", arrival_time: 1000, queue_name: "deferred", recipients: [{ address: "a@b.com", delay_reason: "Connection timed out" }] }),
      JSON.stringify({ queue_id: "BBB", arrival_time: 2000, queue_name: "active", recipients: [{ address: "c@d.com" }] }),
    ].join("\n");
    const summary = parseQueueOutput(ndjson);
    expect(summary.counts.total).toBe(2);
    expect(summary.counts.deferred).toBe(1);
    expect(summary.counts.active).toBe(1);
    expect(summary.recentErrors).toHaveLength(1);
    expect(summary.recentErrors[0]?.recipient).toBe("a@b.com");
    expect(summary.oldestArrivalAt).toBe(new Date(1000 * 1000).toISOString());
    expect(summary.truncated).toBe(false);
  });

  it("skips unparseable lines rather than throwing", () => {
    const summary = parseQueueOutput("not json\n" + JSON.stringify({ queue_id: "X", queue_name: "hold" }));
    expect(summary.counts.total).toBe(1);
  });

  it("handles empty queue output", () => {
    const summary = parseQueueOutput("");
    expect(summary.counts.total).toBe(0);
    expect(summary.oldestArrivalAt).toBeNull();
  });
});
