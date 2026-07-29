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
  createCategoryAs,
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
  let categoryId: string;
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
    const category = await createCategoryAs(owner, workspaceId, projectId, "Default");
    categoryId = category.id;

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

  function joinRoom(
    socket: ClientSocket,
    event: "join:workspace" | "join:project" | "join:category",
    payload: Record<string, string>,
  ) {
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
      const joinedCategory = await joinRoom(memberSocket, "join:category", { categoryId });
      expect(joinedCategory).toBe(true);

      // Sanity check: before removal, a REST mutation's broadcast reaches
      // the member's socket (task.created is emitted to the category's
      // room — see realtime.ts#emitToCategory).
      const firstTaskEvent = waitForEvent<{ title: string }>(memberSocket, "task.created");
      const createRes = await owner.post(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks`,
        { title: "Task before removal" },
      );
      expect(createRes.statusCode).toBe(201);
      const received = await firstTaskEvent;
      expect(received?.title).toBe("Task before removal");

      // Remove the member from the workspace via REST.
      const memberUserId = await getMemberUserId(owner, workspaceId, "rt-member@example.com");
      const removeRes = await owner.delete(`/api/workspaces/${workspaceId}/members/${memberUserId}`);
      expect(removeRes.statusCode).toBe(200);

      // A subsequent REST mutation's broadcast must NOT reach the removed
      // member's still-open socket (neither the project room nor the
      // category room).
      const secondTaskEvent = waitForEvent<{ title: string }>(memberSocket, "task.created");
      const createRes2 = await owner.post(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${categoryId}/tasks`,
        { title: "Task after removal" },
      );
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
    const privateProjectCategory = await createCategoryAs(owner, workspaceId, privateProjectId, "Default");
    const privateProjectCategoryId = privateProjectCategory.id;

    const socket = await connectAs(demotable);
    try {
      const joinedProject = await joinRoom(socket, "join:project", { projectId: privateProjectId });
      expect(joinedProject).toBe(true);
      const joinedCategory = await joinRoom(socket, "join:category", { categoryId: privateProjectCategoryId });
      expect(joinedCategory).toBe(true);

      const demotedUserId = await getMemberUserId(owner, workspaceId, "rt-demote@example.com");
      const demoteRes = await owner.patch(`/api/workspaces/${workspaceId}/members/${demotedUserId}/role`, {
        roleKey: "VIEWER",
      });
      expect(demoteRes.statusCode).toBe(200);

      const taskEvent = waitForEvent<{ title: string }>(socket, "task.created");
      const createRes = await owner.post(
        `/api/workspaces/${workspaceId}/projects/${privateProjectId}/categories/${privateProjectCategoryId}/tasks`,
        { title: "Task after demotion" },
      );
      expect(createRes.statusCode).toBe(201);
      const received = await taskEvent;
      expect(received).toBeNull();
    } finally {
      socket.disconnect();
    }
  });

  it("a socket that can't access a private category never receives that category's task/column events, even while still in the parent project's room", async () => {
    const privateCategory = await createCategoryAs(owner, workspaceId, projectId, "Private Room Category", {
      visibility: "private",
    });
    const privateCategoryId = privateCategory.id;

    const categoryMember = await inviteAndAccept(app, owner, workspaceId, "rt-category-member@example.com", "MEMBER");
    const categoryMemberUserId = await getMemberUserId(owner, workspaceId, "rt-category-member@example.com");
    const addRes = await owner.post(
      `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${privateCategoryId}/members`,
      { userId: categoryMemberUserId },
    );
    expect(addRes.statusCode).toBe(201);

    const socket = await connectAs(categoryMember);
    try {
      const joinedProject = await joinRoom(socket, "join:project", { projectId });
      expect(joinedProject).toBe(true);
      const joinedCategory = await joinRoom(socket, "join:category", { categoryId: privateCategoryId });
      expect(joinedCategory).toBe(true);

      // Sanity check: while still a category member, the event reaches them.
      const firstEvent = waitForEvent<{ title: string }>(socket, "task.created");
      const createRes = await owner.post(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${privateCategoryId}/tasks`,
        { title: "Visible while a member" },
      );
      expect(createRes.statusCode).toBe(201);
      expect((await firstEvent)?.title).toBe("Visible while a member");

      // Remove their CategoryMembership — they remain a member of the
      // parent project/workspace (still in the project's room), but must
      // be evicted from the category's room and stop receiving its events.
      const removeRes = await owner.delete(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${privateCategoryId}/members/${categoryMemberUserId}`,
      );
      expect(removeRes.statusCode).toBe(200);

      const secondEvent = waitForEvent<{ title: string }>(socket, "task.created");
      const createRes2 = await owner.post(
        `/api/workspaces/${workspaceId}/projects/${projectId}/categories/${privateCategoryId}/tasks`,
        { title: "Invisible after removal" },
      );
      expect(createRes2.statusCode).toBe(201);
      expect(await secondEvent).toBeNull();
    } finally {
      socket.disconnect();
    }
  });
});
