import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import {
  createTestApp,
  resetDatabase,
  closeTestApp,
  disconnectAll,
  registerAndLogin,
  createWorkspaceAs,
  inviteAndAccept,
  getMemberUserId,
  listenEphemeral,
  cookieHeaderFor,
  type TestClient,
} from "./helpers.js";

/**
 * Required, non-negotiable real-time test: a user who is removed from (or
 * demoted within) a workspace must immediately stop receiving further
 * real-time events for it — mirroring the "permission changes take effect
 * immediately" guarantee already proven for sessions in Phase 1. This test
 * exercises a real Socket.IO client against a real TCP listener (unlike the
 * rest of this suite, which uses Fastify's `inject()`), since the real-time
 * layer cannot be exercised through `inject()`.
 */
describe("Real-time room eviction on membership removal/demotion", () => {
  let app: FastifyInstance;
  let owner: TestClient;
  let member: TestClient;
  let workspaceId: string;
  let projectId: string;
  let baseUrl: string;

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();

    owner = await registerAndLogin(app, "rt-owner@example.com");
    const ws = await createWorkspaceAs(owner, "Realtime Workspace", "realtime-workspace");
    workspaceId = ws.id;

    const projectRes = await owner.post(`/api/workspaces/${workspaceId}/projects`, {
      name: "Realtime Project",
    });
    projectId = projectRes.json().project.id;

    member = await inviteAndAccept(app, owner, workspaceId, "rt-member@example.com", "MEMBER");

    const port = await listenEphemeral(app);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await closeTestApp(app);
    await disconnectAll();
  });

  function connectAs(client: TestClient): Promise<ClientSocket> {
    return new Promise((resolve, reject) => {
      const socket = ioClient(baseUrl, {
        path: "/socket.io",
        transports: ["websocket", "polling"],
        extraHeaders: { Cookie: cookieHeaderFor(client) },
        forceNew: true,
      });
      socket.once("connect", () => resolve(socket));
      socket.once("connect_error", (err) => reject(err));
    });
  }

  function joinRoom(socket: ClientSocket, event: "join:workspace" | "join:project", payload: Record<string, string>) {
    return new Promise<boolean>((resolve) => {
      socket.emit(event, payload, (ok: boolean) => resolve(ok));
    });
  }

  function waitForEvent<T>(socket: ClientSocket, event: string, timeoutMs = 1500): Promise<T | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        socket.off(event, onEvent);
        resolve(null);
      }, timeoutMs);
      function onEvent(payload: T) {
        clearTimeout(timer);
        socket.off(event, onEvent);
        resolve(payload);
      }
      socket.on(event, onEvent);
    });
  }

  it("a removed workspace member stops receiving workspace/project room events immediately", async () => {
    const memberSocket = await connectAs(member);
    try {
      const joinedWorkspace = await joinRoom(memberSocket, "join:workspace", { workspaceId });
      expect(joinedWorkspace).toBe(true);
      const joinedProject = await joinRoom(memberSocket, "join:project", { projectId });
      expect(joinedProject).toBe(true);

      // Sanity check: before removal, a REST mutation's broadcast reaches
      // the member's socket.
      const firstTaskEvent = waitForEvent<{ title: string }>(memberSocket, "task.created");
      const createRes = await owner.post(`/api/workspaces/${workspaceId}/projects/${projectId}/tasks`, {
        title: "Task before removal",
      });
      expect(createRes.statusCode).toBe(201);
      const received = await firstTaskEvent;
      expect(received?.title).toBe("Task before removal");

      // Remove the member from the workspace via REST.
      const memberUserId = await getMemberUserId(owner, workspaceId, "rt-member@example.com");
      const removeRes = await owner.delete(`/api/workspaces/${workspaceId}/members/${memberUserId}`);
      expect(removeRes.statusCode).toBe(200);

      // A subsequent REST mutation's broadcast must NOT reach the removed
      // member's still-open socket.
      const secondTaskEvent = waitForEvent<{ title: string }>(memberSocket, "task.created");
      const createRes2 = await owner.post(`/api/workspaces/${workspaceId}/projects/${projectId}/tasks`, {
        title: "Task after removal",
      });
      expect(createRes2.statusCode).toBe(201);
      const receivedAfterRemoval = await secondTaskEvent;
      expect(receivedAfterRemoval).toBeNull();
    } finally {
      memberSocket.disconnect();
    }
  });

  it("a demoted-to-VIEWER member loses access to a private project's room immediately", async () => {
    // Re-invite the same email under a fresh membership for this test.
    const demotable = await inviteAndAccept(app, owner, workspaceId, "rt-demote@example.com", "PROJECT_MANAGER");

    const privateProjectRes = await owner.post(`/api/workspaces/${workspaceId}/projects`, {
      name: "Private Realtime Project",
      visibility: "private",
    });
    const privateProjectId = privateProjectRes.json().project.id;

    const socket = await connectAs(demotable);
    try {
      const joinedProject = await joinRoom(socket, "join:project", { projectId: privateProjectId });
      expect(joinedProject).toBe(true);

      const demotedUserId = await getMemberUserId(owner, workspaceId, "rt-demote@example.com");
      const demoteRes = await owner.patch(`/api/workspaces/${workspaceId}/members/${demotedUserId}/role`, {
        roleKey: "VIEWER",
      });
      expect(demoteRes.statusCode).toBe(200);

      const taskEvent = waitForEvent<{ title: string }>(socket, "task.created");
      const createRes = await owner.post(
        `/api/workspaces/${workspaceId}/projects/${privateProjectId}/tasks`,
        { title: "Task after demotion" },
      );
      expect(createRes.statusCode).toBe(201);
      const received = await taskEvent;
      expect(received).toBeNull();
    } finally {
      socket.disconnect();
    }
  });
});
