import type { BulkTaskAction, BulkTaskErrorCode } from "@projecthub/shared";
import type { Task } from "../pages/task-types.js";

export interface ApiErrorBody {
  error: { code: string; message: string; requestId?: string };
}

/**
 * Discriminated request shape for `POST {categoryBase}/tasks/bulk`, kept 1:1
 * with `bulkTaskActionSchema` (packages/shared/src/dto/task.ts) — each
 * variant is `.strict()` server-side, so sending an extra field (e.g.
 * `versions` on `assign`) is a 422, not a silently-ignored no-op.
 */
export type BulkTaskActionInput =
  | { action: "move"; taskIds: string[]; versions: Record<string, number>; columnId: string }
  | { action: "setPriority"; taskIds: string[]; versions: Record<string, number>; priority: Task["priority"] }
  | { action: "assign"; taskIds: string[]; userId: string }
  | { action: "unassign"; taskIds: string[]; userId: string }
  | { action: "addLabel"; taskIds: string[]; labelId: string }
  | { action: "removeLabel"; taskIds: string[]; labelId: string }
  | { action: "delete"; taskIds: string[] };

export type BulkTaskItemResult =
  | { taskId: string; status: "success"; task: Task | null }
  | { taskId: string; status: "error"; code: BulkTaskErrorCode; message: string; currentTask: Task | null };

export interface BulkTaskActionResponse {
  action: BulkTaskAction;
  results: BulkTaskItemResult[];
  summary: { requested: number; succeeded: number; failed: number };
}

// The API's base URL as reachable from the browser. In local development
// this is left empty so requests stay relative (`/api/...`) and are
// forwarded to the API by Vite's dev server proxy (see vite.config.ts). In
// a production/Docker deployment, the web static files and the API are
// served from different origins/ports, so this must be baked in at build
// time via VITE_API_URL (see apps/web/Dockerfile and docker-compose.yml,
// where it defaults to the same value as the API's own APP_URL).
const API_BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

export class ApiError extends Error {
  code: string;
  status: number;
  // The full parsed JSON response body, when present. Some error responses
  // carry additional fields beyond `error` (e.g. the 409 VERSION_CONFLICT
  // response's `currentTask`), which callers can read from here.
  body?: unknown;
  constructor(status: number, code: string, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function readCookie(name: string): string | undefined {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : undefined;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const csrf = readCookie("ph_csrf");
  if (csrf && method !== "GET") headers["X-CSRF-Token"] = csrf;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    credentials: "include",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : {};

  if (!res.ok) {
    const err = json as ApiErrorBody;
    throw new ApiError(
      res.status,
      err.error?.code ?? "UNKNOWN",
      err.error?.message ?? "Something went wrong.",
      json,
    );
  }

  return json as T;
}

/**
 * Multipart file upload. Deliberately bypasses `request()` above (no
 * `Content-Type: application/json` / JSON.stringify) since the browser must
 * set its own multipart boundary header when given a FormData body.
 */
async function uploadFile<T>(path: string, file: File): Promise<T> {
  const headers: Record<string, string> = {};
  const csrf = readCookie("ph_csrf");
  if (csrf) headers["X-CSRF-Token"] = csrf;

  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers,
    credentials: "include",
    body: formData,
  });

  const text = await res.text();
  const json = text ? JSON.parse(text) : {};

  if (!res.ok) {
    const err = json as ApiErrorBody;
    throw new ApiError(res.status, err.error?.code ?? "UNKNOWN", err.error?.message ?? "Upload failed.", json);
  }

  return json as T;
}

/** Downloads a binary attachment as a Blob (used to trigger a browser save). */
async function downloadFile(path: string): Promise<Blob> {
  const res = await fetch(`${API_BASE}${path}`, { method: "GET", credentials: "include" });
  if (!res.ok) {
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    const err = json as ApiErrorBody;
    throw new ApiError(res.status, err.error?.code ?? "UNKNOWN", err.error?.message ?? "Download failed.", json);
  }
  return res.blob();
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  delete: <T>(path: string) => request<T>("DELETE", path),
  upload: <T>(path: string, file: File) => uploadFile<T>(path, file),
  download: (path: string) => downloadFile(path),
  // `categoryBase` is the caller's already-built
  // `/api/workspaces/:workspaceId/projects/:projectId/categories/:categoryId`
  // prefix (see KanbanBoardPage's `base`) — this always resolves 200 once
  // past whole-request validation/permission (see BulkTaskActionResponse),
  // so a thrown ApiError here always means a whole-request failure
  // (422/403/404), never a per-task one.
  bulkTaskAction: (categoryBase: string, input: BulkTaskActionInput) =>
    request<BulkTaskActionResponse>("POST", `${categoryBase}/tasks/bulk`, input),
};

// Ensure a CSRF cookie exists before the first mutating request (e.g. on
// app load, before login). Login/setup also (re)issue it on success.
export async function ensureCsrfCookie(): Promise<void> {
  if (!readCookie("ph_csrf")) {
    await api.get("/api/auth/csrf").catch(() => undefined);
  }
}
