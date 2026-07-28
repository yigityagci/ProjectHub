export interface ApiErrorBody {
  error: { code: string; message: string; requestId?: string };
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
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
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
    throw new ApiError(res.status, err.error?.code ?? "UNKNOWN", err.error?.message ?? "Something went wrong.");
  }

  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  delete: <T>(path: string) => request<T>("DELETE", path),
};

// Ensure a CSRF cookie exists before the first mutating request (e.g. on
// app load, before login). Login/setup also (re)issue it on success.
export async function ensureCsrfCookie(): Promise<void> {
  if (!readCookie("ph_csrf")) {
    await api.get("/api/auth/csrf").catch(() => undefined);
  }
}
