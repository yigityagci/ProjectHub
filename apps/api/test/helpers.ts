import crypto from "node:crypto";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import type { RoleKey } from "@projecthub/shared";
import { buildServer } from "../src/server.js";
import { prisma } from "../src/core/prisma.js";
import { redis } from "../src/core/redis.js";
import { hashPassword } from "../src/auth/password.js";
import { createWorkspace } from "../src/workspaces/workspaces.service.js";
import { generateRegistrationToken } from "../src/auth/registration-token.service.js";

/**
 * The scheduler is stopped by default (see server.ts#BuildServerOptions) --
 * tests that specifically exercise scheduler/handler behavior (recurring
 * tasks, due-date reminders, the scheduler module's own contract) drive it
 * manually via runOnce()/register(), or opt back into the real interval
 * with `createTestApp({ startScheduler: true })`.
 */
export async function createTestApp(options: { startScheduler?: boolean } = {}): Promise<FastifyInstance> {
  const app = await buildServer({ startScheduler: options.startScheduler ?? false });
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
      "activity_events",
      "invitations",
      "registration_tokens",
      "notifications",
      "mentions",
      "comments",
      "attachments",
      "task_dependencies",
      "task_labels",
      "custom_field_values",
      "custom_field_definitions",
      "labels",
      "task_assignees",
      "tasks",
      "milestones",
      "board_columns",
      "category_memberships",
      "task_categories",
      "project_memberships",
      "projects",
      "workspace_memberships",
      "role_permissions",
      "roles",
      "workspaces",
      "platform_email_configs",
      "platform_postfix_configs",
      "agent_tokens",
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
  put(url: string, payload?: unknown) {
    return this.request({ method: "PUT", url, payload });
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

/**
 * Starts a real TCP listener for `app` (Fastify's `inject()` used elsewhere
 * in this suite never opens a real socket, which is fine for REST but not
 * for the Socket.IO real-time layer — a real `socket.io-client` needs an
 * actual port to connect to). Returns the ephemeral port assigned.
 */
export async function listenEphemeral(app: FastifyInstance): Promise<number> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") {
    throw new Error("Could not determine the ephemeral test server port.");
  }
  return address.port;
}

/** Formats a TestClient's cookie jar as a raw `Cookie` request header value. */
export function cookieHeaderFor(client: TestClient): string {
  return cookieHeader(client.cookies as CookieJar);
}

/**
 * Builds a `multipart/form-data` request body (single `file` field) for use
 * with `TestClient.request({ method: "POST", url, payload, headers })`,
 * exercising the real @fastify/multipart parser end-to-end (rather than
 * mocking it away). Hand-rolled rather than via the `form-data` npm package
 * so the payload is a single, already-materialized Buffer (what
 * `light-my-request`/`inject()` expects), with no stream-timing surprises.
 */
export function buildMultipartUpload(opts: {
  filename: string;
  contentType: string;
  data: Buffer;
}): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----ProjectHubTestBoundary${crypto.randomBytes(8).toString("hex")}`;
  const header = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${opts.filename}"\r\n` +
      `Content-Type: ${opts.contentType}\r\n\r\n`,
    "utf8",
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const payload = Buffer.concat([header, opts.data, footer]);
  return { payload, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}

export const VALID_PASSWORD = "Str0ng!Passw0rd#";

const BOOTSTRAP_WORKSPACE_SLUG = "ph-test-registration-bootstrap";
const BOOTSTRAP_OWNER_EMAIL = "ph-test-registration-bootstrap-owner@example.com";

/**
 * Registration now requires a valid, unconsumed registration token (see
 * registration-token.service.ts) — real callers get one from an
 * OWNER/ADMIN's Manage Team tab. Test helpers need a fresh one for nearly
 * every simulated registration across this whole suite, so rather than
 * making every test file manage its own bootstrap workspace, this lazily
 * creates (and, after a resetDatabase() truncate, transparently recreates)
 * one persistent "system bootstrap" workspace+owner directly via Prisma/the
 * real service layer, then mints a fresh single-use token from it per call —
 * mirroring exactly what an OWNER would do via
 * POST /api/workspaces/:id/registration-tokens, just skipping the HTTP hop
 * since this is test scaffolding, not the thing under test.
 *
 * NOTE: redeeming a registration token now also joins the redeemer to the
 * token's workspace with its role (see auth.service.ts's registerUser), so
 * every user created via getFreshRegistrationToken/registerAndLogin ends up
 * an incidental member of this "Registration Bootstrap" workspace too, at
 * whatever role was requested (default MEMBER). This is harmless for tests
 * that only care about a workspace they create themselves afterward, but
 * matters for anything asserting exact membership/workspace counts.
 */
async function ensureBootstrapWorkspace(): Promise<{ workspaceId: string; ownerId: string }> {
  const existing = await prisma.workspace.findUnique({ where: { slug: BOOTSTRAP_WORKSPACE_SLUG } });
  if (existing) {
    const ownerMembership = await prisma.workspaceMembership.findFirst({
      where: { workspaceId: existing.id, role: { key: "OWNER" } },
    });
    if (ownerMembership) {
      return { workspaceId: existing.id, ownerId: ownerMembership.userId };
    }
  }

  const passwordHash = await hashPassword(VALID_PASSWORD);
  const owner = await prisma.user.create({
    data: {
      email: BOOTSTRAP_OWNER_EMAIL,
      passwordHash,
      displayName: "Registration Bootstrap",
    },
  });
  const workspace = await createWorkspace({
    name: "Registration Bootstrap",
    slug: BOOTSTRAP_WORKSPACE_SLUG,
    ownerId: owner.id,
  });
  return { workspaceId: workspace.id, ownerId: owner.id };
}

/** Mints a fresh, valid, single-use registration token for use in a `POST /api/auth/register` body. */
export async function getFreshRegistrationToken(roleKey: RoleKey = "MEMBER"): Promise<string> {
  const { workspaceId, ownerId } = await ensureBootstrapWorkspace();
  const { rawToken } = await generateRegistrationToken({ workspaceId, createdById: ownerId, roleKey });
  return rawToken;
}

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
  registrationTokenRole: RoleKey = "MEMBER",
): Promise<TestClient> {
  const anon = freshClient(app);
  const registrationToken = await getFreshRegistrationToken(registrationTokenRole);
  const regRes = await anon.post("/api/auth/register", {
    email,
    password: VALID_PASSWORD,
    displayName,
    registrationToken,
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
 * Invites `email` into `workspaceId` with `roleKey`, registers/logs in a new
 * user for that email, and accepts the invitation. Returns a logged-in
 * TestClient for that member.
 */
export async function inviteAndAccept(
  app: FastifyInstance,
  owner: TestClient,
  workspaceId: string,
  email: string,
  roleKey: string,
): Promise<TestClient> {
  const token = await captureInvitationToken(() =>
    owner.post(`/api/workspaces/${workspaceId}/invitations`, { email, roleKey }),
  );
  const member = await registerAndLogin(app, email);
  const acceptRes = await member.post(`/api/invitations/${token}/accept`);
  if (acceptRes.statusCode !== 200) {
    throw new Error(`Accept failed: ${acceptRes.statusCode} ${acceptRes.body}`);
  }
  return member;
}

export async function getMemberUserId(
  client: TestClient,
  workspaceId: string,
  email: string,
): Promise<string> {
  const res = await client.get(`/api/workspaces/${workspaceId}/members`);
  const members = res.json().members as Array<{ email: string; userId: string }>;
  const found = members.find((m) => m.email === email);
  if (!found) throw new Error(`member ${email} not found`);
  return found.userId;
}

export interface CreatedProject {
  id: string;
  name: string;
  status: string;
  visibility: string;
}

export async function createProjectAs(
  client: TestClient,
  workspaceId: string,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<CreatedProject> {
  const res = await client.post(`/api/workspaces/${workspaceId}/projects`, { name, ...extra });
  if (res.statusCode !== 201) {
    throw new Error(`Create project failed: ${res.statusCode} ${res.body}`);
  }
  return res.json().project;
}

export interface CreatedCategory {
  id: string;
  projectId: string;
  name: string;
  visibility: string;
}

/**
 * Every project starts with ZERO categories (see docs/PHASES.md) — this
 * helper mirrors the mandatory "create your first category" step the
 * frontend forces after project creation, used by every test that needs a
 * category-scoped board (columns/tasks) to exist.
 */
export async function createCategoryAs(
  client: TestClient,
  workspaceId: string,
  projectId: string,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<CreatedCategory> {
  const res = await client.post(`/api/workspaces/${workspaceId}/projects/${projectId}/categories`, {
    name,
    ...extra,
  });
  if (res.statusCode !== 201) {
    throw new Error(`Create category failed: ${res.statusCode} ${res.body}`);
  }
  return res.json().category;
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
