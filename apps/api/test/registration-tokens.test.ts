import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createTestApp,
  resetDatabase,
  closeTestApp,
  disconnectAll,
  registerAndLogin,
  createWorkspaceAs,
  inviteAndAccept,
  freshClient,
  VALID_PASSWORD,
  type TestClient,
} from "./helpers.js";
import { prisma } from "../src/core/prisma.js";

interface RegistrationTokenSummary {
  id: string;
  label: string | null;
  roleKey: string;
  roleName: string;
  createdAt: string;
  expiresAt: string;
}

describe("Registration token management (Manage Team)", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let workspaceId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    owner = await registerAndLogin(app, "rt-owner@example.com");
    const ws = await createWorkspaceAs(owner, "Registration Token Co", "registration-token-co");
    workspaceId = ws.id;
  });
  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  it("OWNER can generate a token; the raw token is returned only from that response, never from GET", async () => {
    const res = await owner.post(`/api/workspaces/${workspaceId}/registration-tokens`, {
      label: "For the design offsite",
      roleKey: "MEMBER",
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { registrationToken: RegistrationTokenSummary; rawToken: string };
    expect(body.rawToken).toBeTruthy();
    expect(body.rawToken.length).toBeGreaterThanOrEqual(32);
    expect(body.registrationToken.label).toBe("For the design offsite");
    expect(body.registrationToken.roleKey).toBe("MEMBER");
    expect(res.body).not.toContain("tokenHash");

    const listRes = await owner.get(`/api/workspaces/${workspaceId}/registration-tokens`);
    expect(listRes.statusCode).toBe(200);
    expect(listRes.body).not.toContain(body.rawToken);

    const row = await prisma.registrationToken.findUnique({ where: { id: body.registrationToken.id } });
    expect(row).not.toBeNull();
    expect(row!.tokenHash).not.toBe(body.rawToken);
  });

  it("GET lists tokens newest-first with resolved createdBy/usedBy display info and computed-friendly status fields", async () => {
    const genRes = await owner.post(`/api/workspaces/${workspaceId}/registration-tokens`, {
      roleKey: "MEMBER",
    });
    expect(genRes.statusCode).toBe(201);
    const { rawToken } = genRes.json() as { rawToken: string };

    const listRes = await owner.get(`/api/workspaces/${workspaceId}/registration-tokens`);
    expect(listRes.statusCode).toBe(200);
    const tokens = listRes.json().registrationTokens as Array<{
      id: string;
      createdByEmail: string;
      roleKey: string;
      roleName: string;
      usedAt: string | null;
      usedByEmail: string | null;
      revokedAt: string | null;
    }>;
    expect(tokens.length).toBeGreaterThanOrEqual(1);
    expect(tokens[0]!.createdByEmail).toBe("rt-owner@example.com");
    expect(tokens[0]!.roleKey).toBe("MEMBER");
    expect(tokens[0]!.usedAt).toBeNull();
    expect(tokens[0]!.usedByEmail).toBeNull();
    expect(tokens[0]!.revokedAt).toBeNull();

    // Consuming it via the real registration flow should be reflected here.
    const registerRes = await freshClient(app).post("/api/auth/register", {
      email: "rt-consumer@example.com",
      password: VALID_PASSWORD,
      displayName: "RT Consumer",
      registrationToken: rawToken,
    });
    expect(registerRes.statusCode).toBe(201);

    const listAfter = await owner.get(`/api/workspaces/${workspaceId}/registration-tokens`);
    const tokenAfter = (listAfter.json().registrationTokens as Array<{
      id: string;
      usedAt: string | null;
      usedByEmail: string | null;
    }>).find((t) => t.id === tokens[0]!.id)!;
    expect(tokenAfter.usedAt).not.toBeNull();
    expect(tokenAfter.usedByEmail).toBe("rt-consumer@example.com");
  });

  it("redeeming a token joins the workspace with the token's role", async () => {
    const genRes = await owner.post(`/api/workspaces/${workspaceId}/registration-tokens`, {
      roleKey: "PROJECT_MANAGER",
    });
    const { rawToken } = genRes.json() as { rawToken: string };

    const registerRes = await freshClient(app).post("/api/auth/register", {
      email: "rt-role-consumer@example.com",
      password: VALID_PASSWORD,
      displayName: "RT Role Consumer",
      registrationToken: rawToken,
    });
    expect(registerRes.statusCode).toBe(201);
    expect(registerRes.json().workspace.id).toBe(workspaceId);
    expect(registerRes.json().role).toBe("PROJECT_MANAGER");

    const membership = await prisma.workspaceMembership.findFirst({
      where: { workspaceId, user: { email: "rt-role-consumer@example.com" } },
      include: { role: true },
    });
    expect(membership).not.toBeNull();
    expect(membership!.role.key).toBe("PROJECT_MANAGER");
  });

  it("a caller cannot generate a token for a role higher than their own rank", async () => {
    const admin = await inviteAndAccept(app, owner, workspaceId, "rt-rank-admin@example.com", "ADMIN");
    const res = await admin.post(`/api/workspaces/${workspaceId}/registration-tokens`, {
      roleKey: "OWNER",
    });
    expect(res.statusCode).toBe(403);
  });

  it("revoking an active token works, and it no longer counts as valid for registration", async () => {
    const genRes = await owner.post(`/api/workspaces/${workspaceId}/registration-tokens`, {
      roleKey: "MEMBER",
    });
    const { registrationToken, rawToken } = genRes.json() as {
      registrationToken: RegistrationTokenSummary;
      rawToken: string;
    };

    const revokeRes = await owner.post(
      `/api/workspaces/${workspaceId}/registration-tokens/${registrationToken.id}/revoke`,
    );
    expect(revokeRes.statusCode).toBe(200);

    const registerRes = await freshClient(app).post("/api/auth/register", {
      email: "rt-revoked-attempt@example.com",
      password: VALID_PASSWORD,
      displayName: "Should Fail",
      registrationToken: rawToken,
    });
    expect(registerRes.statusCode).toBe(404);
  });

  it("revoking an already-used token is rejected with a conflict", async () => {
    const genRes = await owner.post(`/api/workspaces/${workspaceId}/registration-tokens`, {
      roleKey: "MEMBER",
    });
    const { registrationToken, rawToken } = genRes.json() as {
      registrationToken: RegistrationTokenSummary;
      rawToken: string;
    };

    const registerRes = await freshClient(app).post("/api/auth/register", {
      email: "rt-already-used@example.com",
      password: VALID_PASSWORD,
      displayName: "Already Used",
      registrationToken: rawToken,
    });
    expect(registerRes.statusCode).toBe(201);

    const revokeRes = await owner.post(
      `/api/workspaces/${workspaceId}/registration-tokens/${registrationToken.id}/revoke`,
    );
    expect(revokeRes.statusCode).toBe(409);
  });

  it("revoking a nonexistent token id 404s", async () => {
    const res = await owner.post(
      `/api/workspaces/${workspaceId}/registration-tokens/11111111-1111-1111-1111-111111111111/revoke`,
    );
    expect(res.statusCode).toBe(404);
  });

  it("only OWNER/ADMIN can generate or revoke tokens — a plain MEMBER is forbidden from both", async () => {
    const member = await inviteAndAccept(
      app,
      owner,
      workspaceId,
      "rt-plain-member@example.com",
      "MEMBER",
    );

    const generateRes = await member.post(`/api/workspaces/${workspaceId}/registration-tokens`, {});
    expect(generateRes.statusCode).toBe(403);

    const listRes = await member.get(`/api/workspaces/${workspaceId}/registration-tokens`);
    expect(listRes.statusCode).toBe(403);

    const ownerGenRes = await owner.post(`/api/workspaces/${workspaceId}/registration-tokens`, {
      roleKey: "MEMBER",
    });
    const { registrationToken } = ownerGenRes.json() as { registrationToken: RegistrationTokenSummary };
    const revokeRes = await member.post(
      `/api/workspaces/${workspaceId}/registration-tokens/${registrationToken.id}/revoke`,
    );
    expect(revokeRes.statusCode).toBe(403);
  });

  it("an ADMIN (not just OWNER) can generate and revoke tokens", async () => {
    const admin = await inviteAndAccept(app, owner, workspaceId, "rt-admin@example.com", "ADMIN");

    const generateRes = await admin.post(`/api/workspaces/${workspaceId}/registration-tokens`, {
      roleKey: "MEMBER",
    });
    expect(generateRes.statusCode).toBe(201);
    const { registrationToken } = generateRes.json() as { registrationToken: RegistrationTokenSummary };

    const revokeRes = await admin.post(
      `/api/workspaces/${workspaceId}/registration-tokens/${registrationToken.id}/revoke`,
    );
    expect(revokeRes.statusCode).toBe(200);
  });
});
