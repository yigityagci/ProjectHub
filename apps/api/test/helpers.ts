import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { buildServer } from "../src/server.js";
import { prisma } from "../src/core/prisma.js";
import { redis } from "../src/core/redis.js";

export async function createTestApp(): Promise<FastifyInstance> {
  const app = await buildServer();
  await app.ready();
  return app;
}

/**
 * Truncates every Phase 1 table between tests so each test starts from a
 * clean, isolated database state. CASCADE handles FK ordering.
 */
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "audit_log_entries",
      "invitations",
      "workspace_memberships",
      "role_permissions",
      "roles",
      "workspaces",
      "sessions",
      "users"
    RESTART IDENTITY CASCADE;
  `);
}

export async function closeTestApp(app: FastifyInstance): Promise<void> {
  await app.close();
}

export async function disconnectAll(): Promise<void> {
  await prisma.$disconnect();
  redis.disconnect();
}

interface CookieJar {
  [name: string]: string;
}

function parseSetCookies(response: LightMyRequestResponse, jar: CookieJar): void {
  for (const cookie of response.cookies) {
    jar[cookie.name] = cookie.value;
  }
}

function cookieHeader(jar: CookieJar): string {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}

/**
 * A tiny stateful HTTP client on top of Fastify's inject() that behaves
 * like a browser: it remembers cookies across requests and automatically
 * attaches the CSRF double-submit header on mutating requests once a
 * ph_csrf cookie has been set (mirroring what the real frontend does by
 * reading the non-httpOnly CSRF cookie value).
 */
export class TestClient {
  private jar: CookieJar = {};

  constructor(private readonly app: FastifyInstance) {}

  get cookies(): Readonly<CookieJar> {
    return this.jar;
  }

  async request(opts: InjectOptions): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = { ...(opts.headers as Record<string, string> | undefined) };

    const cookieStr = cookieHeader(this.jar);
    if (cookieStr) headers.cookie = cookieStr;

    const method = (opts.method ?? "GET").toString().toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS" && this.jar["ph_csrf"]) {
      headers["x-csrf-token"] = this.jar["ph_csrf"];
    }

    const response = await this.app.inject({ ...opts, headers });
    parseSetCookies(response, this.jar);
    return response;
  }

  get(url: string) {
    return this.request({ method: "GET", url });
  }
  post(url: string, payload?: unknown) {
    return this.request({ method: "POST", url, payload });
  }
  patch(url: string, payload?: unknown) {
    return this.request({ method: "PATCH", url, payload });
  }
  delete(url: string) {
    return this.request({ method: "DELETE", url });
  }

  clearSessionCookie(): void {
    delete this.jar["ph_session"];
  }
}

export function freshClient(app: FastifyInstance): TestClient {
  return new TestClient(app);
}

export const VALID_PASSWORD = "Str0ng!Passw0rd#";

export interface SetupResult {
  client: TestClient;
  email: string;
  displayName: string;
}

export async function completeSetup(app: FastifyInstance, email = "admin@example.com"): Promise<SetupResult> {
  const client = freshClient(app);
  const res = await client.post("/api/setup", {
    email,
    password: VALID_PASSWORD,
    displayName: "First Admin",
  });
  if (res.statusCode !== 201) {
    throw new Error(`Setup failed: ${res.statusCode} ${res.body}`);
  }
  return { client, email, displayName: "First Admin" };
}

export async function registerAndLogin(
  app: FastifyInstance,
  email: string,
  displayName = "Test User",
): Promise<TestClient> {
  const anon = freshClient(app);
  const regRes = await anon.post("/api/auth/register", {
    email,
    password: VALID_PASSWORD,
    displayName,
  });
  if (regRes.statusCode !== 201) {
    throw new Error(`Register failed: ${regRes.statusCode} ${regRes.body}`);
  }

  const client = freshClient(app);
  const loginRes = await client.post("/api/auth/login", { email, password: VALID_PASSWORD });
  if (loginRes.statusCode !== 200) {
    throw new Error(`Login failed: ${loginRes.statusCode} ${loginRes.body}`);
  }
  return client;
}

export interface CreatedWorkspace {
  id: string;
  name: string;
  slug: string;
}

export async function createWorkspaceAs(
  client: TestClient,
  name: string,
  slug: string,
): Promise<CreatedWorkspace> {
  const res = await client.post("/api/workspaces", { name, slug });
  if (res.statusCode !== 201) {
    throw new Error(`Create workspace failed: ${res.statusCode} ${res.body}`);
  }
  return res.json().workspace;
}

/**
 * Runs `action` while capturing everything written via console.log, and
 * extracts the invitation token from the dev mail transport's logged
 * accept link (`.../invite/accept?token=<rawToken>`). This mirrors how an
 * operator running without real SMTP would retrieve the token in Phase 1.
 */
export async function captureInvitationToken(action: () => Promise<unknown>): Promise<string> {
  const logs: string[] = [];
  const original = console.log;
  // eslint-disable-next-line no-console
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    await action();
  } finally {
    console.log = original;
  }
  const joined = logs.join("\n");
  const match = joined.match(/invite\/accept\?token=([A-Za-z0-9_-]+)/);
  if (!match || !match[1]) {
    throw new Error(`Could not find invitation token in dev mail transport output:\n${joined}`);
  }
  return match[1];
}
