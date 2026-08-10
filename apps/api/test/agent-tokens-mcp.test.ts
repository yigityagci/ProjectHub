import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import {
  createTestApp,
  resetDatabase,
  closeTestApp,
  disconnectAll,
  registerAndLogin,
  createWorkspaceAs,
  createProjectAs,
  createCategoryAs,
  inviteAndAccept,
  listenEphemeral,
  cookieHeaderFor,
  type TestClient,
} from "./helpers.js";
import { prisma } from "../src/core/prisma.js";

interface AgentTokenSummary {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** Mints a fresh AgentToken for an already-logged-in session client. */
async function generateAgentToken(
  client: TestClient,
  label: string,
): Promise<{ agentToken: AgentTokenSummary; rawToken: string }> {
  const res = await client.post("/api/auth/me/agent-tokens", { label });
  if (res.statusCode !== 201) {
    throw new Error(`generateAgentToken failed: ${res.statusCode} ${res.body}`);
  }
  return res.json();
}

/** Raw JSON-RPC call against POST /api/mcp using a bearer AgentToken — bypasses TestClient entirely so no cookie/CSRF header is ever attached. */
function mcpCall(
  app: FastifyInstance,
  rawToken: string,
  method: string,
  params?: Record<string, unknown>,
  opts: { id?: number | string | null; extraHeaders?: Record<string, string> } = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: "/api/mcp",
    headers: { authorization: `Bearer ${rawToken}`, ...opts.extraHeaders },
    payload: { jsonrpc: "2.0", id: opts.id ?? 1, method, ...(params !== undefined ? { params } : {}) },
  });
}

function toolsCall(
  app: FastifyInstance,
  rawToken: string,
  name: string,
  args: Record<string, unknown>,
  opts: { extraHeaders?: Record<string, string> } = {},
): Promise<LightMyRequestResponse> {
  return mcpCall(app, rawToken, "tools/call", { name, arguments: args }, opts);
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

describe("Agent Tokens + MCP server", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let ownerId: string;
  let workspaceId: string;
  let projectId: string;
  let categoryId: string;
  let ownerRawToken: string;
  let ownerAgentTokenId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();

    owner = await registerAndLogin(app, "mcp-owner@example.com");
    const meRes = await owner.get("/api/auth/me");
    ownerId = meRes.json().user.id;

    const ws = await createWorkspaceAs(owner, "MCP Co", "mcp-co");
    workspaceId = ws.id;
    const project = await createProjectAs(owner, workspaceId, "MCP Project");
    projectId = project.id;
    const category = await createCategoryAs(owner, workspaceId, projectId, "MCP Category");
    categoryId = category.id;

    const generated = await generateAgentToken(owner, "Claude Desktop");
    ownerRawToken = generated.rawToken;
    ownerAgentTokenId = generated.agentToken.id;
  });

  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  describe("CSRF regression", () => {
    it("session cookie + Authorization: Bearer garbage-value + no CSRF header on a mutating REST route is REJECTED (no silent fallback to cookie auth)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspaceId}/projects`,
        headers: {
          cookie: cookieHeaderFor(owner),
          authorization: "Bearer garbage-value",
        },
        payload: { name: "Should never be created" },
      });
      expect(res.statusCode).toBe(401);

      const project = await prisma.project.findFirst({ where: { workspaceId, name: "Should never be created" } });
      expect(project).toBeNull();
    });

    it("session cookie + no bearer header + missing CSRF token on a mutating route still 401s (unchanged regression)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspaceId}/projects`,
        headers: { cookie: cookieHeaderFor(owner) },
        payload: { name: "Missing CSRF" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("a valid agent token + no CSRF header on a mutating MCP call succeeds (the actual exemption working)", async () => {
      const res = await toolsCall(app, ownerRawToken, "list_workspaces", {});
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.result.isError).toBeFalsy();
    });

    it("a valid agent token + a wrong CSRF header present anyway still succeeds (exemption isn't defeated by an incidental bad CSRF header)", async () => {
      const res = await toolsCall(app, ownerRawToken, "list_workspaces", {}, {
        extraHeaders: { "x-csrf-token": "totally-wrong-value" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.result.isError).toBeFalsy();
    });

    it("an expired agent token is rejected with 401", async () => {
      const { rawToken, agentToken } = await generateAgentToken(owner, "Expired Client");
      await prisma.agentToken.update({
        where: { id: agentToken.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const res = await toolsCall(app, rawToken, "list_workspaces", {});
      expect(res.statusCode).toBe(401);
    });

    it("a revoked agent token is rejected with 401", async () => {
      const { rawToken, agentToken } = await generateAgentToken(owner, "Revoked Client");
      const revokeRes = await owner.post(`/api/auth/me/agent-tokens/${agentToken.id}/revoke`);
      expect(revokeRes.statusCode).toBe(200);
      const res = await toolsCall(app, rawToken, "list_workspaces", {});
      expect(res.statusCode).toBe(401);
    });
  });

  describe("Cross-tier / cross-workspace rejection", () => {
    it("a tool call targeting a workspace the token's owner is not a member of is rejected, and writes nothing", async () => {
      const otherOwner = await registerAndLogin(app, "mcp-other-owner@example.com");
      const otherWs = await createWorkspaceAs(otherOwner, "Other Co", "mcp-other-co");
      const otherProject = await createProjectAs(otherOwner, otherWs.id, "Other Project");
      const otherCategory = await createCategoryAs(otherOwner, otherWs.id, otherProject.id, "Other Category");

      const listRes = await toolsCall(app, ownerRawToken, "list_projects", { workspaceId: otherWs.id });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().result.isError).toBe(true);

      const createRes = await toolsCall(app, ownerRawToken, "create_task", {
        workspaceId: otherWs.id,
        projectId: otherProject.id,
        categoryId: otherCategory.id,
        title: "Should never be written",
      });
      expect(createRes.statusCode).toBe(200);
      expect(createRes.json().result.isError).toBe(true);

      const written = await prisma.task.findFirst({ where: { title: "Should never be written" } });
      expect(written).toBeNull();
    });
  });

  describe("Immediate revocation", () => {
    it("a token works, then 401s on the very next call right after being revoked (no delay)", async () => {
      const { rawToken, agentToken } = await generateAgentToken(owner, "Immediate Revoke Client");

      const first = await toolsCall(app, rawToken, "list_workspaces", {});
      expect(first.statusCode).toBe(200);
      expect(first.json().result.isError).toBeFalsy();

      const revokeRes = await owner.post(`/api/auth/me/agent-tokens/${agentToken.id}/revoke`);
      expect(revokeRes.statusCode).toBe(200);

      const second = await toolsCall(app, rawToken, "list_workspaces", {});
      expect(second.statusCode).toBe(401);
    });
  });

  describe("actorId always the human", () => {
    it("a task created via the MCP create_task tool records actorId=human, viaAgentTokenId=token, payload.viaAgentLabel=label", async () => {
      const res = await toolsCall(app, ownerRawToken, "create_task", {
        workspaceId,
        projectId,
        categoryId,
        title: "Created via MCP",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.result.isError).toBeFalsy();
      const taskId = JSON.parse(body.result.content[0].text).task.id as string;

      const event = await prisma.activityEvent.findFirst({
        where: { type: "task_created", payload: { path: ["taskId"], equals: taskId } },
      });
      expect(event).not.toBeNull();
      expect(event!.actorId).toBe(ownerId);
      expect(event!.viaAgentTokenId).toBe(ownerAgentTokenId);
      expect((event!.payload as Record<string, unknown>).viaAgentLabel).toBe("Claude Desktop");
    });

    it("a task created via the ordinary REST route has viaAgentTokenId=null and no viaAgentLabel key at all", async () => {
      const res = await owner.post(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks`,
        { title: "Created via REST" },
      );
      expect(res.statusCode).toBe(201);
      const taskId = res.json().task.id as string;

      const event = await prisma.activityEvent.findFirst({
        where: { type: "task_created", payload: { path: ["taskId"], equals: taskId } },
      });
      expect(event).not.toBeNull();
      expect(event!.actorId).toBe(ownerId);
      expect(event!.viaAgentTokenId).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(event!.payload as object, "viaAgentLabel")).toBe(false);
    });
  });

  describe("Permission parity", () => {
    it("a VIEWER-role user's agent token is rejected (isError) from create_task/add_comment, but list_tasks still succeeds", async () => {
      const viewer = await inviteAndAccept(app, owner, workspaceId, "mcp-viewer@example.com", "VIEWER");
      const { rawToken: viewerToken } = await generateAgentToken(viewer, "Viewer Client");

      const createRes = await toolsCall(app, viewerToken, "create_task", {
        workspaceId,
        projectId,
        categoryId,
        title: "Viewer should not be able to create this",
      });
      expect(createRes.statusCode).toBe(200);
      expect(createRes.json().result.isError).toBe(true);

      const listRes = await toolsCall(app, viewerToken, "list_tasks", { workspaceId, projectId, categoryId });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json().result.isError).toBeFalsy();

      // A task to comment on, created by the owner.
      const taskRes = await owner.post(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks`,
        { title: "For viewer comment permission test" },
      );
      const taskId = taskRes.json().task.id as string;

      const commentRes = await toolsCall(app, viewerToken, "add_comment", {
        workspaceId,
        projectId,
        categoryId,
        taskId,
        body: "Viewer should not be able to comment",
      });
      expect(commentRes.statusCode).toBe(200);
      expect(commentRes.json().result.isError).toBe(true);
    });
  });

  describe("Deny list", () => {
    it("an agent token cannot mint another agent token", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/me/agent-tokens",
        headers: { authorization: `Bearer ${ownerRawToken}` },
        payload: { label: "Should be forbidden" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("an agent token cannot mint a registration token", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/workspaces/${workspaceId}/registration-tokens`,
        headers: { authorization: `Bearer ${ownerRawToken}` },
        payload: { roleKey: "MEMBER" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("an agent token cannot reach a platform-admin route, even one belonging to the platform admin", async () => {
      const adminClient = await registerAndLogin(app, "mcp-platform-admin@example.com");
      const meRes = await adminClient.get("/api/auth/me");
      await prisma.user.update({ where: { id: meRes.json().user.id }, data: { isPlatformAdmin: true } });
      const { rawToken: adminToken } = await generateAgentToken(adminClient, "Admin Client");

      const res = await app.inject({
        method: "GET",
        url: "/api/platform/email-config",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(403);
    });

    it("an agent token cannot reach the self-service password-change route", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/password/change",
        headers: { authorization: `Bearer ${ownerRawToken}` },
        payload: { currentPassword: "whatever", newPassword: "Whatever123!@#" },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("Token hygiene", () => {
    it("the self-service list never returns a raw token or a tokenHash field, and the stored hash matches sha256(raw) exactly", async () => {
      const { rawToken, agentToken } = await generateAgentToken(owner, "Hygiene Client");

      const listRes = await owner.get("/api/auth/me/agent-tokens");
      expect(listRes.statusCode).toBe(200);
      expect(listRes.body).not.toContain(rawToken);
      expect(listRes.body).not.toContain("tokenHash");

      const row = await prisma.agentToken.findUnique({ where: { id: agentToken.id } });
      expect(row).not.toBeNull();
      expect(row!.tokenHash).toBe(sha256Hex(rawToken));
      expect(row!.tokenHash).not.toBe(rawToken);
    });

    it("revoking a token that belongs to a different user returns 404, not 403", async () => {
      const otherUser = await registerAndLogin(app, "mcp-hygiene-other@example.com");
      const revokeRes = await otherUser.post(`/api/auth/me/agent-tokens/${ownerAgentTokenId}/revoke`);
      expect(revokeRes.statusCode).toBe(404);
    });
  });

  describe("MCP protocol conformance", () => {
    it("initialize returns a sane protocol version and capabilities", async () => {
      const res = await mcpCall(app, ownerRawToken, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(typeof body.result.protocolVersion).toBe("string");
      expect(body.result.capabilities.tools.listChanged).toBe(false);
      expect(typeof body.result.instructions).toBe("string");
    });

    it("tools/list returns exactly the 10 v1 tools", async () => {
      const res = await mcpCall(app, ownerRawToken, "tools/list", {});
      expect(res.statusCode).toBe(200);
      const names = res.json().result.tools.map((t: { name: string }) => t.name).sort();
      expect(names).toEqual(
        [
          "add_comment",
          "create_task",
          "list_categories",
          "list_columns",
          "list_comments",
          "list_projects",
          "list_tasks",
          "list_workspaces",
          "move_task",
          "update_task",
        ].sort(),
      );
    });

    it("calling an unknown tool name returns a graceful JSON-RPC error, not a crash", async () => {
      const res = await toolsCall(app, ownerRawToken, "delete_task", { workspaceId });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32602);
    });

    it("calling a real tool with invalid args returns HTTP 200 with isError:true, not a 500", async () => {
      const res = await toolsCall(app, ownerRawToken, "create_task", { workspaceId });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.result.isError).toBe(true);
    });

    it("GET and DELETE to /api/mcp both return 405", async () => {
      const getRes = await app.inject({ method: "GET", url: "/api/mcp" });
      expect(getRes.statusCode).toBe(405);
      const deleteRes = await app.inject({ method: "DELETE", url: "/api/mcp" });
      expect(deleteRes.statusCode).toBe(405);
    });

    it("a batched (array) JSON-RPC body is rejected with -32600 invalid request", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/mcp",
        headers: { authorization: `Bearer ${ownerRawToken}` },
        payload: [{ jsonrpc: "2.0", id: 1, method: "ping" }],
      });
      const body = res.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32600);
    });
  });

  describe("Realtime wiring", () => {
    it("creating a task via the MCP create_task tool emits the same task.created realtime event a REST call would", async () => {
      const port = await listenEphemeral(app);
      const baseUrl = `http://127.0.0.1:${port}`;
      const socket: ClientSocket = await new Promise((resolve, reject) => {
        const s = ioClient(baseUrl, {
          path: "/socket.io",
          transports: ["websocket", "polling"],
          extraHeaders: { Cookie: cookieHeaderFor(owner) },
          forceNew: true,
        });
        s.once("connect", () => resolve(s));
        s.once("connect_error", (err) => reject(err));
      });

      try {
        const joined = await new Promise<boolean>((resolve) => {
          socket.emit("join:category", { categoryId }, (ok: boolean) => resolve(ok));
        });
        expect(joined).toBe(true);

        const eventPromise = new Promise<{ title: string } | null>((resolve) => {
          const timer = setTimeout(() => resolve(null), 2000);
          socket.once("task.created", (payload: { title: string }) => {
            clearTimeout(timer);
            resolve(payload);
          });
        });

        const res = await toolsCall(app, ownerRawToken, "create_task", {
          workspaceId,
          projectId,
          categoryId,
          title: "Realtime via MCP",
        });
        expect(res.statusCode).toBe(200);
        expect(res.json().result.isError).toBeFalsy();

        const received = await eventPromise;
        expect(received?.title).toBe("Realtime via MCP");
      } finally {
        socket.disconnect();
      }
    });
  });
});
