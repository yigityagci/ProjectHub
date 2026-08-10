import crypto from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import { AppError, ForbiddenError } from "../core/errors.js";
import { requireAuth, requireCsrf, requireAgentTokenAuth } from "../rbac/guards.js";
import { runToolGuards } from "./mcp.guard-chain.js";
import { MCP_TOOLS, findMcpTool } from "./mcp.tools.js";
import {
  jsonRpcResult,
  jsonRpcError,
  JSON_RPC_ERRORS,
  negotiateProtocolVersion,
  toolErrorResult,
  ToolFailure,
  type JsonRpcRequest,
  type JsonRpcId,
} from "./mcp.protocol.js";

/**
 * ProjectHub's MCP server — mounted under /api/mcp in the SAME Fastify
 * process as every REST route, reusing buildServer()'s guards/rate-limiting
 * (see server.ts). This is a hand-rolled implementation of the MCP spec's
 * STATELESS Streamable HTTP transport subset: no session ids, no SSE, POST
 * may respond with a single `application/json` body instead of an event
 * stream, and GET/DELETE (which would otherwise open/close an SSE stream or
 * terminate a session) simply 405, since this server offers neither.
 *
 * Deliberately hand-rolled rather than built on `@modelcontextprotocol/sdk`:
 * that SDK pulls in express/cors/express-rate-limit/eventsource/ajv/
 * pkce-challenge/raw-body and assumes sticky sessions this deployment
 * doesn't have — see the architecture handoff's Decision A. Zero new npm
 * dependencies were added for this feature.
 */

/**
 * DNS-rebinding defense (per the MCP spec's Streamable HTTP transport
 * requirements): if the request has an Origin header, it must be in the
 * SAME allowlist the existing CORS configuration already uses — never a
 * second, hand-maintained list. Non-browser MCP clients (Claude Desktop,
 * Cursor, curl, ...) typically send no Origin header at all, so absence is
 * allowed.
 */
async function requireAllowedMcpOrigin(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const origin = req.headers.origin;
  if (!origin) return;
  const allowlist = env.CORS_ORIGIN.split(",").map((o) => o.trim());
  if (!allowlist.includes(origin)) {
    throw new ForbiddenError("This origin is not allowed to call the MCP endpoint.");
  }
}

/**
 * Rate-limits /api/mcp per PRESENTED BEARER TOKEN, not per IP — this
 * middleware runs pre-preHandler (before resolveAgentToken has had a chance
 * to run), so it hashes the raw `Authorization` header value itself. This
 * prevents one shared egress IP (many users behind the same NAT/proxy) from
 * letting a single compromised token exhaust every other user's budget, and
 * vice versa. Reuses the login rate limit's numeric envelope rather than
 * inventing a dedicated env var for v1.
 */
const MCP_RATE_LIMIT = {
  max: env.RATE_LIMIT_LOGIN_MAX,
  timeWindow: `${env.RATE_LIMIT_LOGIN_WINDOW_MINUTES} minutes`,
  keyGenerator: (req: FastifyRequest): string => {
    const header = req.headers.authorization;
    if (typeof header === "string" && header.length > 0) {
      return `mcp:${crypto.createHash("sha256").update(header).digest("hex")}`;
    }
    return `mcp-ip:${req.ip}`;
  },
};

function methodNotAllowed(reply: FastifyReply, message: string) {
  return reply.code(405).send({ error: { code: "METHOD_NOT_ALLOWED", message } });
}

export async function registerMcpRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/api/mcp",
    {
      config: { rateLimit: MCP_RATE_LIMIT },
      // requireCsrf is deliberately kept here even though it's guaranteed to
      // no-op on this route (every caller that reaches requireAgentTokenAuth
      // authenticated via a bearer token, never a cookie) — this preserves
      // the codebase-wide invariant that every mutating route lists
      // requireCsrf in its preHandler chain, and exercises the real
      // exemption code path in production rather than hand-waving past it.
      preHandler: [requireAllowedMcpOrigin, requireAuth, requireCsrf, requireAgentTokenAuth],
    },
    async (req, reply) => {
      const body = req.body;

      // This server does not support JSON-RPC batching (an array body) —
      // reject outright, per the architecture handoff.
      if (Array.isArray(body)) {
        return reply
          .code(400)
          .send(jsonRpcError(null, JSON_RPC_ERRORS.INVALID_REQUEST, "Batch requests are not supported."));
      }
      if (typeof body !== "object" || body === null) {
        return reply
          .code(400)
          .send(jsonRpcError(null, JSON_RPC_ERRORS.INVALID_REQUEST, "Request body must be a JSON-RPC object."));
      }

      const rpc = body as JsonRpcRequest;
      const id: JsonRpcId = rpc.id ?? null;

      if (typeof rpc.method !== "string" || rpc.method.length === 0) {
        return reply.code(400).send(jsonRpcError(id, JSON_RPC_ERRORS.INVALID_REQUEST, "Missing method."));
      }

      // JSON-RPC/MCP notifications (no reply expected) — respond 202 with
      // an empty body, per convention, for ANY notifications/* method.
      if (rpc.method.startsWith("notifications/")) {
        return reply.code(202).send();
      }

      switch (rpc.method) {
        case "initialize": {
          const params = (rpc.params ?? {}) as Record<string, unknown>;
          return reply.send(
            jsonRpcResult(id, {
              protocolVersion: negotiateProtocolVersion(params.protocolVersion),
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "projecthub-mcp", version: "1.0.0" },
              instructions:
                "Call list_workspaces first to discover valid workspace ids, then narrow down via " +
                "list_projects -> list_categories -> list_columns/list_tasks before calling any task or " +
                "comment tool. Every write acts strictly within your own real ProjectHub permissions.",
            }),
          );
        }

        case "ping":
          return reply.send(jsonRpcResult(id, {}));

        case "tools/list":
          return reply.send(
            jsonRpcResult(id, {
              tools: MCP_TOOLS.map((tool) => ({
                name: tool.name,
                title: tool.title,
                description: tool.description,
                inputSchema: tool.inputSchema,
                annotations: tool.annotations,
              })),
            }),
          );

        case "tools/call": {
          const params = (rpc.params ?? {}) as { name?: unknown; arguments?: unknown };
          if (typeof params.name !== "string") {
            return reply.send(jsonRpcError(id, JSON_RPC_ERRORS.INVALID_PARAMS, "Missing tool name."));
          }

          const tool = findMcpTool(params.name);
          if (!tool) {
            return reply.send(jsonRpcError(id, JSON_RPC_ERRORS.INVALID_PARAMS, `Unknown tool: ${params.name}`));
          }

          const parsedArgs = tool.args.safeParse(params.arguments ?? {});
          if (!parsedArgs.success) {
            return reply.send(
              jsonRpcResult(id, toolErrorResult(parsedArgs.error.issues[0]?.message ?? "Invalid arguments.")),
            );
          }

          try {
            // Runs the REAL REST guards, against the REAL request, in the
            // same order the equivalent REST route would — see
            // mcp.guard-chain.ts. Any guard failure (401/403/404) is caught
            // below and surfaced as a tool-level `isError` result, never a
            // JSON-RPC protocol-level error or a transport-level fault.
            await runToolGuards(req, reply, tool.scope(parsedArgs.data), tool.permission);
            const result = await tool.run(req, reply, parsedArgs.data);
            return reply.send(jsonRpcResult(id, result));
          } catch (err) {
            if (err instanceof ToolFailure) {
              return reply.send(jsonRpcResult(id, toolErrorResult(err.message, err.data)));
            }
            if (err instanceof AppError) {
              return reply.send(jsonRpcResult(id, toolErrorResult(err.message)));
            }
            throw err;
          }
        }

        default:
          return reply.send(jsonRpcError(id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${rpc.method}`));
      }
    },
  );

  // Stateless server: no SSE stream to open (GET) and no session to
  // terminate (DELETE). Neither needs auth-gating — a bare 405 leaks
  // nothing an unauthenticated caller couldn't already infer from the spec.
  app.get("/api/mcp", async (_req, reply) => {
    return methodNotAllowed(reply, "This stateless MCP server offers no SSE stream on GET.");
  });
  app.delete("/api/mcp", async (_req, reply) => {
    return methodNotAllowed(reply, "This stateless MCP server has no session to terminate on DELETE.");
  });
}
