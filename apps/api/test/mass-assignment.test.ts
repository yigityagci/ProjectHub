import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  createTestApp,
  resetDatabase,
  closeTestApp,
  disconnectAll,
  registerAndLogin,
  createWorkspaceAs,
  type TestClient,
} from "./helpers.js";
import { prisma } from "../src/core/prisma.js";

describe("Mass-assignment / ID-manipulation protection", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let workspaceId: string;
  let otherWorkspaceId: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();

    owner = await registerAndLogin(app, "owner@example.com");
    const ws = await createWorkspaceAs(owner, "Main Workspace", "main-workspace");
    workspaceId = ws.id;

    const other = await registerAndLogin(app, "other-owner@example.com");
    const otherWs = await createWorkspaceAs(other, "Other Workspace", "other-workspace");
    otherWorkspaceId = otherWs.id;
  });
  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  it("ignores a client-supplied ownerId/id/workspaceId when creating a workspace", async () => {
    const res = await owner.post("/api/workspaces", {
      name: "Sneaky",
      slug: "sneaky",
      ownerId: "not-a-real-user-id",
      id: "11111111-1111-1111-1111-111111111111",
      workspaceId: otherWorkspaceId,
    } as unknown as Record<string, unknown>);

    // Strict Zod schema rejects unknown keys outright.
    expect(res.statusCode).toBe(422);
  });

  it("does not allow a client-supplied role to escalate on registration/login", async () => {
    const res = await owner.post("/api/auth/register", {
      email: "escalate@example.com",
      password: "Str0ng!Passw0rd#",
      displayName: "Escalate",
      isPlatformAdmin: true,
      role: "OWNER",
    } as unknown as Record<string, unknown>);
    // Strict schema also rejects unexpected fields here.
    expect(res.statusCode).toBe(422);

    const created = await prisma.user.findUnique({ where: { email: "escalate@example.com" } });
    expect(created).toBeNull();
  });

  it("a crafted body workspaceId does not let a request act on a different workspace", async () => {
    // Even though the body references otherWorkspaceId, the workspaceId in
    // the URL is what's authorized against — the server never trusts a
    // body-supplied workspaceId.
    const res = await owner.patch(`/api/workspaces/${workspaceId}`, {
      name: "Renamed Main",
      workspaceId: otherWorkspaceId,
    } as unknown as Record<string, unknown>);
    expect(res.statusCode).toBe(422); // rejected by strict schema

    const otherWs = await prisma.workspace.findUnique({ where: { id: otherWorkspaceId } });
    expect(otherWs?.name).toBe("Other Workspace");
  });

  it("crafted role-change body cannot smuggle extra fields", async () => {
    // The route validates the body before ever resolving the target user,
    // so any placeholder userId in the URL is sufficient to prove the
    // strict-schema rejection happens.
    const res = await owner.patch(`/api/workspaces/${workspaceId}/members/some-user-id/role`, {
      roleKey: "ADMIN",
      permissions: ["audit.view"],
      workspaceId: otherWorkspaceId,
    } as unknown as Record<string, unknown>);
    expect(res.statusCode).toBe(422);
  });
});
