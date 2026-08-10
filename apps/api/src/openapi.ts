import type { FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

export async function registerOpenApi(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      info: {
        title: "ProjectHub API",
        description: "Phase 1: Auth, Workspaces, and RBAC foundation for ProjectHub.",
        version: "0.1.0",
      },
      components: {
        securitySchemes: {
          sessionCookie: {
            type: "apiKey",
            in: "cookie",
            name: "ph_session",
          },
          agentToken: {
            type: "http",
            scheme: "bearer",
            description: "AgentToken bearer credential for the MCP server (POST /api/mcp).",
          },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });
}
