import { Resolver } from "node:dns/promises";
import { logger } from "../core/logger.js";

/**
 * Best-effort DNS verification for self-hosted Postfix's A/SPF/DKIM/DMARC
 * records, plus PTR guidance. Deliberately lives in the API container, NOT
 * the mail-control listener: DNS resolution against the public internet is
 * not a Postfix operation, and adding it as a 7th listener op would expand
 * the closed 6-op set the security architecture depends on (see
 * apps/mail-control's doc comments). This module NEVER throws — every
 * individual check independently degrades to `{ present: false, error }`
 * so one flaky/slow resolver never breaks the whole response.
 */

const LOOKUP_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("DNS lookup timed out")), ms);
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function newResolver(): Resolver {
  const resolver = new Resolver();
  resolver.setServers(["1.1.1.1", "8.8.8.8"]);
  return resolver;
}

async function resolveA(hostname: string): Promise<string[]> {
  const resolver = newResolver();
  return withTimeout(resolver.resolve4(hostname), LOOKUP_TIMEOUT_MS);
}

async function resolveTxt(hostname: string): Promise<string[]> {
  const resolver = newResolver();
  const records = await withTimeout(resolver.resolveTxt(hostname), LOOKUP_TIMEOUT_MS);
  return records.map((chunks) => chunks.join(""));
}

async function resolvePtr(ip: string): Promise<string[]> {
  const resolver = newResolver();
  return withTimeout(resolver.reverse(ip), LOOKUP_TIMEOUT_MS);
}

/** Best-effort discovery of this server's public IPv4 address, for the A/PTR record guidance. */
async function detectPublicIpv4(): Promise<string | null> {
  try {
    const resolver = newResolver();
    // A well-known "what's my IP" DNS trick (OpenDNS resolver1's
    // myip.opendns.com A record). Best-effort only — failure here just
    // means the `a`/`ptr` sections render without a concrete address.
    const addrs = await withTimeout(resolver.resolve4("myip.opendns.com"), LOOKUP_TIMEOUT_MS);
    return addrs[0] ?? null;
  } catch (err) {
    logger.debug({ err }, "Could not best-effort detect this server's public IPv4 address");
    return null;
  }
}

function reverseIpv4(ip: string): string {
  return `${ip.split(".").reverse().join(".")}.in-addr.arpa`;
}

interface DnsCheckInput {
  sendingDomain: string;
  mailHostname: string;
  dkimSelector: string;
  dkimPublicKey: string | null;
}

export interface DnsCheckResult {
  bestEffort: true;
  checkedAt: string;
  records: {
    a: { name: string; type: "A"; value: string | null };
    spf: { name: string; type: "TXT"; value: string };
    dkim: { name: string; type: "TXT"; value: string | null };
    dmarc: { name: string; type: "TXT"; value: string };
    ptr: { name: string; type: "PTR"; value: string };
  };
  checks: {
    a: { present: boolean; resolved: string[]; ok: boolean; note: string };
    spf: { present: boolean; record: string | null; ok: boolean; note: string };
    dkim: { present: boolean; record: string | null; ok: boolean; note: string };
    dmarc: { present: boolean; record: string | null; policy: string | null; ok: boolean; note: string };
    ptr: { present: boolean; resolved: string[]; ok: boolean; note: string };
  };
}

export async function runDnsCheck(input: DnsCheckInput): Promise<DnsCheckResult> {
  const { sendingDomain, mailHostname, dkimSelector, dkimPublicKey } = input;
  const dkimName = `${dkimSelector}._domainkey.${sendingDomain}`;
  const dmarcName = `_dmarc.${sendingDomain}`;
  const spfExpected = `v=spf1 a:${mailHostname} -all`;
  const dkimExpected = dkimPublicKey ? `v=DKIM1; k=rsa; p=${dkimPublicKey}` : null;
  const dmarcExpected = `v=DMARC1; p=none; rua=mailto:postmaster@${sendingDomain}`;

  const [aSettled, spfSettled, dkimSettled, dmarcSettled, publicIp] = await Promise.allSettled([
    resolveA(mailHostname),
    resolveTxt(sendingDomain),
    resolveTxt(dkimName),
    resolveTxt(dmarcName),
    detectPublicIpv4(),
  ]).then(async (results) => {
    const ip = results[4].status === "fulfilled" ? results[4].value : await detectPublicIpv4().catch(() => null);
    return [results[0], results[1], results[2], results[3], ip] as const;
  });

  const aResolved = aSettled.status === "fulfilled" ? aSettled.value : [];
  const spfRecords = spfSettled.status === "fulfilled" ? spfSettled.value : [];
  const dkimRecords = dkimSettled.status === "fulfilled" ? dkimSettled.value : [];
  const dmarcRecords = dmarcSettled.status === "fulfilled" ? dmarcSettled.value : [];

  const spfRecord = spfRecords.find((r) => r.startsWith("v=spf1")) ?? null;
  const spfOk = Boolean(
    spfRecord && (spfRecord.includes(`a:${mailHostname}`) || spfRecord.includes("mx") || /ip4:/.test(spfRecord)),
  );

  const dkimRecord = dkimRecords.find((r) => r.startsWith("v=DKIM1")) ?? null;
  const dkimOk = Boolean(dkimRecord && dkimExpected && dkimRecord.replace(/\s+/g, " ").trim() === dkimExpected);

  const dmarcRecord = dmarcRecords.find((r) => r.startsWith("v=DMARC1")) ?? null;
  const dmarcPolicyMatch = dmarcRecord?.match(/p=([a-z]+)/i);
  const dmarcPolicy = dmarcPolicyMatch?.[1] ?? null;
  const dmarcOk = Boolean(dmarcRecord);

  let ptrResolved: string[] = [];
  const resolvedIp = aResolved[0] ?? publicIp ?? null;
  if (resolvedIp) {
    try {
      ptrResolved = await resolvePtr(resolvedIp);
    } catch (err) {
      logger.debug({ err }, "PTR lookup failed during self-hosted mail DNS check");
    }
  }
  const ptrOk = ptrResolved.includes(mailHostname);

  return {
    bestEffort: true,
    checkedAt: new Date().toISOString(),
    records: {
      a: { name: mailHostname, type: "A", value: publicIp },
      spf: { name: sendingDomain, type: "TXT", value: spfExpected },
      dkim: { name: dkimName, type: "TXT", value: dkimExpected },
      dmarc: { name: dmarcName, type: "TXT", value: dmarcExpected },
      ptr: { name: resolvedIp ? reverseIpv4(resolvedIp) : "<server public IPv4>", type: "PTR", value: mailHostname },
    },
    checks: {
      a: {
        present: aResolved.length > 0,
        resolved: aResolved,
        ok: aResolved.length > 0,
        note: aResolved.length > 0 ? "A record resolves." : "No A record found for the mail hostname.",
      },
      spf: {
        present: spfRecord !== null,
        record: spfRecord,
        ok: spfOk,
        note: spfOk
          ? "SPF record references the mail hostname."
          : spfRecord
            ? "SPF record found but does not reference this mail hostname."
            : "No SPF TXT record found.",
      },
      dkim: {
        present: dkimRecord !== null,
        record: dkimRecord,
        ok: dkimOk,
        note: dkimOk
          ? "Published DKIM key matches the stored key."
          : dkimRecord
            ? "Published DKIM record does not match the currently stored key — republish DNS after rotating."
            : "No DKIM TXT record found at the selector record name.",
      },
      dmarc: {
        present: dmarcRecord !== null,
        record: dmarcRecord,
        policy: dmarcPolicy,
        ok: dmarcOk,
        note: dmarcOk ? "DMARC record found." : "No DMARC TXT record found.",
      },
      ptr: {
        present: ptrResolved.length > 0,
        resolved: ptrResolved,
        ok: ptrOk,
        note: ptrOk
          ? "Reverse DNS matches the mail hostname."
          : "Reverse DNS (PTR) does not match — ask your hosting/network provider to set it, since this can't be configured from ProjectHub.",
      },
    },
  };
}
