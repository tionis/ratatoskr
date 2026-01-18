import { join } from "node:path";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { authRoutes } from "./api/auth.ts";
import { documentRoutes } from "./api/documents.ts";
import type { Config } from "./config.ts";
import { startCleanupJob } from "./lib/cleanup.ts";
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

  // Serve static UI files
  await server.register(fastifyStatic, {
    root: join(import.meta.dir, "ui"),
    prefix: "/ui/",
  });

  // Redirect root to UI
  server.get("/", async (_request, reply) => {
    return reply.redirect("/ui/index.html");
  });

  // Serve docs at /docs
  server.get("/docs", async (_request, reply) => {
    return reply.sendFile("docs.html");
  });

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

  // Start background tasks
  startCleanupJob();

  return server;
}
