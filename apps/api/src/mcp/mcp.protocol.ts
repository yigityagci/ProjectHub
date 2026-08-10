/**
 * A hand-rolled, minimal implementation of the JSON-RPC 2.0 envelope and the
 * subset of the Model Context Protocol needed for a STATELESS, tools-only
 * server (see mcp.routes.ts's module doc comment for why this is hand-rolled
 * rather than built on `@modelcontextprotocol/sdk` — zero new npm
 * dependencies is a deliberate architectural constraint for this feature).
 *
 * Deliberately NOT implemented: outputSchema/structuredContent, resources,
 * prompts, logging, completions, SSE, Mcp-Session-Id. This server MAY return
 * `application/json` instead of an SSE stream, and skips session ids
 * entirely, both allowed by the MCP spec's "stateless server" mode.
 */

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/** Standard JSON-RPC 2.0 error codes used by this server. */
export const JSON_RPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

export function jsonRpcResult(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}

export function jsonRpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

/**
 * MCP protocol-version negotiation: echo the client's requested version if
 * it's one this server supports, otherwise return this server's own latest
 * supported version — NEVER hard-error on a version mismatch, mirroring the
 * spec's guidance that a server should still attempt to respond usably.
 */
export const LATEST_PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED_PROTOCOL_VERSIONS = [LATEST_PROTOCOL_VERSION, "2025-03-26", "2024-11-05"];

export function negotiateProtocolVersion(requested: unknown): string {
  if (typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return requested;
  }
  return LATEST_PROTOCOL_VERSION;
}

export interface ToolContentBlock {
  type: "text";
  text: string;
}

export interface ToolCallResult {
  content: ToolContentBlock[];
  isError?: boolean;
}

/** A successful tool call result: the serialized data as a single text block. */
export function toolSuccessResult(data: unknown): ToolCallResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

/**
 * A FAILED tool call, surfaced as HTTP 200 with `isError: true` inside the
 * JSON-RPC result — never as a JSON-RPC protocol-level error — so a
 * permission/validation/version-conflict failure reaches the model as
 * retryable tool feedback, not a transport-level fault.
 */
export function toolErrorResult(message: string, data?: unknown): ToolCallResult {
  return {
    content: [{ type: "text", text: data !== undefined ? JSON.stringify({ message, ...toObject(data) }) : message }],
    isError: true,
  };
}

function toObject(data: unknown): Record<string, unknown> {
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : { data };
}

/**
 * Thrown from within a tool's `run` function for a business-level failure
 * that the model should be able to see and retry against (currently: an
 * optimistic-concurrency version conflict on update_task/move_task) —
 * caught by the JSON-RPC dispatcher (mcp.routes.ts) and converted into a
 * tool-level `isError` result, never a JSON-RPC protocol-level error.
 */
export class ToolFailure extends Error {
  readonly data?: unknown;

  constructor(message: string, data?: unknown) {
    super(message);
    this.name = "ToolFailure";
    this.data = data;
  }
}
