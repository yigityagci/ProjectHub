import type { FastifyInstance } from "fastify";
import { Server, type Socket } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { logger } from "../core/logger.js";
import { SESSION_COOKIE_NAME, resolveSession } from "../auth/session.js";
import { hasWorkspaceAccess, hasProjectAccess, hasCategoryAccess } from "./access.js";

export function workspaceRoom(workspaceId: string): string {
  return `workspace:${workspaceId}`;
}
export function projectRoom(projectId: string): string {
  return `project:${projectId}`;
}
export function categoryRoom(categoryId: string): string {
  return `category:${categoryId}`;
}
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

/**
 * Tiny cookie-header parser. Socket.IO's handshake doesn't go through
 * Fastify's request pipeline (and therefore not through @fastify/cookie), so
 * the raw `cookie` header is parsed by hand here. This intentionally reuses
 * the exact same session-lookup logic as the REST API
 * (auth/session.ts#resolveSession) — no parallel auth mechanism.
 */
function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

let io: Server | null = null;

/**
 * Initializes the push-only Socket.IO real-time layer on top of the
 * Fastify server's underlying HTTP server. Socket.IO never accepts
 * mutations here — clients may only request to join rooms (which is an
 * authorization check, not a write) and the server only ever emits events
 * after a REST mutation has already been authenticated, authorized,
 * validated, and persisted.
 */
export function initRealtime(app: FastifyInstance): Server {
  io = new Server(app.server, {
    path: "/socket.io",
    cors: {
      origin: env.CORS_ORIGIN.split(",").map((o) => o.trim()),
      credentials: true,
    },
  });

  // Dedicated pub/sub connections for the Redis adapter (fan-out across
  // multiple API processes), separate from the app's rate-limit Redis
  // client.
  const pubClient = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  const subClient = pubClient.duplicate();
  pubClient.on("error", (err) => logger.error({ err }, "Socket.IO redis pub client error"));
  subClient.on("error", (err) => logger.error({ err }, "Socket.IO redis sub client error"));
  io.adapter(createAdapter(pubClient, subClient));

  io.use(async (socket, next) => {
    try {
      const cookies = parseCookieHeader(socket.handshake.headers.cookie);
      const rawToken = cookies[SESSION_COOKIE_NAME];
      if (!rawToken) {
        next(new Error("Unauthorized"));
        return;
      }
      const session = await resolveSession(rawToken);
      if (!session) {
        next(new Error("Unauthorized"));
        return;
      }
      socket.data.userId = session.user.id;
      next();
    } catch (err) {
      logger.error({ err }, "Socket.IO auth middleware error");
      next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket: Socket) => {
    const userId = socket.data.userId as string;
    // Every authenticated socket automatically joins its own user-scoped
    // room, used to deliver Phase 4 notifications live.
    socket.join(userRoom(userId));

    socket.on("join:workspace", async (payload: { workspaceId?: string }, ack?: (ok: boolean) => void) => {
      const workspaceId = payload?.workspaceId;
      if (!workspaceId || !(await hasWorkspaceAccess(userId, workspaceId))) {
        ack?.(false);
        return;
      }
      await socket.join(workspaceRoom(workspaceId));
      ack?.(true);
    });

    socket.on("join:project", async (payload: { projectId?: string }, ack?: (ok: boolean) => void) => {
      const projectId = payload?.projectId;
      if (!projectId || !(await hasProjectAccess(userId, projectId))) {
        ack?.(false);
        return;
      }
      await socket.join(projectRoom(projectId));
      ack?.(true);
    });

    socket.on("join:category", async (payload: { categoryId?: string }, ack?: (ok: boolean) => void) => {
      const categoryId = payload?.categoryId;
      if (!categoryId || !(await hasCategoryAccess(userId, categoryId))) {
        ack?.(false);
        return;
      }
      await socket.join(categoryRoom(categoryId));
      ack?.(true);
    });

    socket.on("leave:workspace", (payload: { workspaceId?: string }) => {
      if (payload?.workspaceId) socket.leave(workspaceRoom(payload.workspaceId));
    });

    socket.on("leave:project", (payload: { projectId?: string }) => {
      if (payload?.projectId) socket.leave(projectRoom(payload.projectId));
    });

    socket.on("leave:category", (payload: { categoryId?: string }) => {
      if (payload?.categoryId) socket.leave(categoryRoom(payload.categoryId));
    });
  });

  app.addHook("onClose", async () => {
    io?.disconnectSockets(true);
    await io?.close();
    pubClient.disconnect();
    subClient.disconnect();
    io = null;
  });

  return io;
}

/** Returns the shared Socket.IO server instance, or null if not initialized (e.g. some unit tests). */
export function getIo(): Server | null {
  return io;
}

/**
 * Forces every currently-connected socket belonging to `userId` to
 * re-validate its `workspace:*` and `project:*` room memberships against
 * live data, evicting it from any room it can no longer access. Must be
 * called immediately after any mutation that could reduce a user's access
 * (workspace membership removal/demotion, project membership removal),
 * mirroring the "permission changes take effect immediately" guarantee from
 * Phase 1 sessions.
 */
export async function revalidateRoomsForUser(userId: string): Promise<void> {
  if (!io) return;
  const sockets = await io.in(userRoom(userId)).fetchSockets();
  for (const socket of sockets) {
    for (const room of socket.rooms) {
      if (room.startsWith("workspace:")) {
        const workspaceId = room.slice("workspace:".length);
        if (!(await hasWorkspaceAccess(userId, workspaceId))) {
          await socket.leave(room);
        }
      } else if (room.startsWith("project:")) {
        const projectId = room.slice("project:".length);
        if (!(await hasProjectAccess(userId, projectId))) {
          await socket.leave(room);
        }
      } else if (room.startsWith("category:")) {
        const categoryId = room.slice("category:".length);
        if (!(await hasCategoryAccess(userId, categoryId))) {
          await socket.leave(room);
        }
      }
    }
  }
}

export type BroadcastEvent =
  | "task.created"
  | "task.updated"
  | "task.moved"
  | "task.deleted"
  | "project.member.changed"
  | "category.member.changed"
  | "board.column.changed"
  | "comment.created"
  | "comment.deleted"
  | "attachment.created"
  | "attachment.deleted"
  | "notification.created"
  | "activity.created";

/** Broadcasts to every socket in a project's room. Never called before persistence. */
export function emitToProject(projectId: string, event: BroadcastEvent, payload: unknown): void {
  io?.to(projectRoom(projectId)).emit(event, payload);
}

/**
 * Broadcasts to every socket in a category's room. Task/column mutation
 * events (task.created/task.updated/task.moved/task.deleted/
 * board.column.changed) are emitted HERE ONLY (not also to the parent
 * project's room): a user who can see a project overall but not one of its
 * specific private categories must never receive that category's live
 * task/column events. Clients that need project-level board updates join
 * this room directly (per-category), the same way they already join a
 * project's room for project-level events.
 */
export function emitToCategory(categoryId: string, event: BroadcastEvent, payload: unknown): void {
  io?.to(categoryRoom(categoryId)).emit(event, payload);
}

/** Broadcasts to every socket in a workspace's room. Never called before persistence. */
export function emitToWorkspace(workspaceId: string, event: BroadcastEvent, payload: unknown): void {
  io?.to(workspaceRoom(workspaceId)).emit(event, payload);
}

/** Delivers a live event to a single user's own room (e.g. a new notification). */
export function emitToUser(userId: string, event: BroadcastEvent, payload: unknown): void {
  io?.to(userRoom(userId)).emit(event, payload);
}
