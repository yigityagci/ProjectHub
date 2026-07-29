import { io, type Socket } from "socket.io-client";

// Same base-URL convention as lib/api.ts: empty in local dev (proxied by
// Vite), baked in at build time for Docker deployments.
const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

let socket: Socket | null = null;

/**
 * Lazily creates a single shared Socket.IO connection, authenticated via
 * the same `ph_session` cookie as every REST call (the browser attaches it
 * automatically because `withCredentials` is set) — there is no separate
 * real-time auth token. Safe to call repeatedly; returns the same instance.
 */
export function getSocket(): Socket {
  if (!socket) {
    socket = io(API_BASE || undefined, {
      path: "/socket.io",
      withCredentials: true,
      autoConnect: true,
    });
  }
  return socket;
}

export function joinWorkspaceRoom(workspaceId: string): void {
  getSocket().emit("join:workspace", { workspaceId });
}

export function joinProjectRoom(projectId: string): void {
  getSocket().emit("join:project", { projectId });
}

export function leaveProjectRoom(projectId: string): void {
  getSocket().emit("leave:project", { projectId });
}

// Category rooms carry every task/column mutation event scoped to that
// category ONLY (see apps/api/src/realtime/realtime.ts#emitToCategory) — a
// user who can see the parent project overall but not a specific (possibly
// private) category never receives its live events unless they've also
// joined this room.
export function joinCategoryRoom(categoryId: string): void {
  getSocket().emit("join:category", { categoryId });
}

export function leaveCategoryRoom(categoryId: string): void {
  getSocket().emit("leave:category", { categoryId });
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}
