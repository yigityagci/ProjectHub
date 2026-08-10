import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createServer, handleRequest } from "../src/index.js";
import { resetForTests as resetRateLimits, setLimitsForTests } from "../src/rate-limit.js";
import { resetForTests as resetMutex } from "../src/mutex.js";

const TOKEN = "a-test-token-that-is-at-least-32-characters-long";

let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  process.env.MAIL_CONTROL_TOKEN = TOKEN;
  resetRateLimits();
  resetMutex();
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  resetRateLimits();
  resetMutex();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function authHeaders(token = TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe("auth", () => {
  it("401s with no Authorization header", async () => {
    const res = await fetch(`${baseUrl}/v1/status`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHENTICATED");
  });

  it("401s with the wrong token (timingSafeEqual-based comparison)", async () => {
    const res = await fetch(`${baseUrl}/v1/status`, { headers: authHeaders("wrong-token-wrong-token-wrong-token") });
    expect(res.status).toBe(401);
  });

  it("401s with a token of a completely different length than expected", async () => {
    const res = await fetch(`${baseUrl}/v1/status`, { headers: authHeaders("short") });
    expect(res.status).toBe(401);
  });

  it("does not 401 with the correct token", async () => {
    const res = await fetch(`${baseUrl}/v1/reload`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).not.toBe(401);
  });
});

describe("unknown operations (closed 6-op set)", () => {
  it("404s an unknown path", async () => {
    const res = await fetch(`${baseUrl}/v1/does-not-exist`, { headers: authHeaders() });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("UNKNOWN_OPERATION");
  });

  it("404s a known path with the wrong method", async () => {
    const res = await fetch(`${baseUrl}/v1/config/apply`, { headers: authHeaders() }); // GET instead of POST
    expect(res.status).toBe(404);
  });

  it("404s the root path", async () => {
    const res = await fetch(`${baseUrl}/`, { headers: authHeaders() });
    expect(res.status).toBe(404);
  });

  it("ignores query strings — a known path+method with a query string still dispatches (not 404)", async () => {
    const res = await fetch(`${baseUrl}/v1/reload?foo=bar`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).not.toBe(404);
  });
});

describe("/healthz — not a 7th operation", () => {
  it("returns 200 {status:ok} when connecting from loopback (real local test connection)", async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 404 UNKNOWN_OPERATION (not 200) when the request does not originate from loopback", async () => {
    // Simulated via a fake req/res pair — a real non-loopback TCP peer
    // can't be produced from a same-machine test, so this exercises
    // handleRequest's dispatch logic directly against a controlled
    // req.socket.remoteAddress.
    const fakeReq = {
      method: "GET",
      url: "/healthz",
      headers: {},
      socket: { remoteAddress: "203.0.113.5" },
      on: () => fakeReq,
    } as unknown as http.IncomingMessage;

    let statusCode: number | undefined;
    let sentBody = "";
    const fakeRes = {
      writeHead(status: number) {
        statusCode = status;
        return fakeRes;
      },
      end(chunk?: string) {
        if (chunk) sentBody = chunk;
      },
    } as unknown as http.ServerResponse;

    await handleRequest(fakeReq, fakeRes);
    expect(statusCode).toBe(404);
    expect(JSON.parse(sentBody).error.code).toBe("UNKNOWN_OPERATION");
  });

  it("does not accept POST /healthz either", async () => {
    const res = await fetch(`${baseUrl}/healthz`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(404);
  });
});

describe("request size limits (independent of the API's own limits)", () => {
  it("413s up front when Content-Length exceeds the cap (declared header alone, before any body is read)", async () => {
    // Uses a raw http.request so the declared Content-Length header is
    // sent exactly as specified, rather than fetch recomputing it from
    // the real (small) body — this isolates the up-front, header-only
    // check from the mid-stream one (covered separately below).
    const res = await rawPostWithHeader(baseUrl, "/v1/test-email", "999999", "{}");
    expect(res?.status).toBe(413);
  });

  it("413s mid-stream when the actual body exceeds the cap despite no/absent Content-Length (chunked)", async () => {
    const res = await rawChunkedOversizedPost(baseUrl, "/v1/test-email");
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("rate limiting (independent of the API's own limiter)", () => {
  it("429s a read op after exceeding its window, and sets Retry-After", async () => {
    // Uses /v1/config/validate (opClass "read") with an intentionally
    // invalid (but fast, filesystem/network-free) body — the rate limiter
    // sits in front of body validation entirely, so the 422 the body
    // would otherwise produce is irrelevant to this test.
    setLimitsForTests({ read: { max: 3, windowMs: 60_000 } });
    const post = () =>
      fetch(`${baseUrl}/v1/config/validate`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: "{}",
      });
    for (let i = 0; i < 3; i++) {
      const res = await post();
      expect(res.status).not.toBe(429);
    }
    const limited = await post();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    const body = await limited.json();
    expect(body.error.code).toBe("RATE_LIMITED");
  });

  it("429s a mutating op after exceeding its (separate) window", async () => {
    setLimitsForTests({ mutating: { max: 2, windowMs: 60_000 } });
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${baseUrl}/v1/reload`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: "{}",
      });
      expect(res.status).not.toBe(429);
    }
    const limited = await fetch(`${baseUrl}/v1/reload`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: "{}",
    });
    expect(limited.status).toBe(429);
  });
});

describe("global mutating-op mutex", () => {
  it("409s a second mutating op while one is still in flight", async () => {
    const first = fetch(`${baseUrl}/v1/reload`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: "{}",
    });
    // Fire the second request without awaiting the first, so both are
    // in flight concurrently — this is the scenario the mutex exists for.
    const second = fetch(`${baseUrl}/v1/reload`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: "{}",
    });

    const [firstRes, secondRes] = await Promise.all([first, second]);
    const statuses = [firstRes.status, secondRes.status].sort();
    // Exactly one of the two should have been rejected with 409; the other
    // proceeds (and likely fails with 500 RELOAD_FAILED in this
    // no-real-Postfix test environment, which is fine — we only assert
    // the concurrency guard fired for the loser).
    expect(statuses).toContain(409);
  });
});

describe("content-type enforcement", () => {
  it("415s a non-JSON content-type on a POST op", async () => {
    const res = await fetch(`${baseUrl}/v1/reload`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(res.status).toBe(415);
  });
});

/** Raw http.request helper used where fetch's own Content-Length inference would defeat the "declared header" test. */
function rawPostWithHeader(base: string, path: string, contentLength: string, body: string): Promise<{ status: number } | undefined> {
  return new Promise((resolve) => {
    const url = new URL(base + path);
    const req = http.request(
      { hostname: url.hostname, port: url.port, path, method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "Content-Length": contentLength } },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
      },
    );
    req.on("error", () => resolve(undefined));
    req.end(body);
  });
}

/** Sends a chunked (no Content-Length), oversized body and returns the parsed JSON response. */
function rawChunkedOversizedPost(base: string, path: string): Promise<{ status: number; body: { error: { code: string } } }> {
  return new Promise((resolve, reject) => {
    const url = new URL(base + path);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, // no Content-Length -> chunked
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("error", () => {
      // The server may destroy the socket after responding; a late
      // ECONNRESET on the writer side is expected and not a test failure
      // as long as we already resolved via the response above.
    });

    const chunk = "a".repeat(8192);
    const totalNeeded = 40_000; // > 32768 MAX_BODY_BYTES
    let written = 0;
    const writeMore = () => {
      while (written < totalNeeded) {
        const ok = req.write(chunk);
        written += chunk.length;
        if (!ok) {
          req.once("drain", writeMore);
          return;
        }
      }
      req.end();
    };
    writeMore();
  });
}
