import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { authRoutes } from "./api/auth.ts";
import { documentRoutes } from "./api/documents.ts";
import type { Config } from "./config.ts";
import { syncHandler } from "./sync/handler.ts";

export async function createServer(_config: Config) {
  const server = Fastify({
    logger: true,
  });

  // Register plugins
  await server.register(cors, {
    origin: true, // TODO: Configure allowed origins
    credentials: true,
  });

  await server.register(cookie);

  await server.register(websocket);

  // Health check
  server.get("/health", async () => {
    return { status: "ok" };
  });

  // Register API routes
  await server.register(authRoutes, { prefix: "/api/v1/auth" });
  await server.register(documentRoutes, { prefix: "/api/v1/documents" });

  // WebSocket sync endpoint
  server.register(async (fastify) => {
    fastify.get("/sync", { websocket: true }, syncHandler);
  });

  return server;
}
