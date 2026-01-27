import { join } from "node:path";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { authRoutes } from "./api/auth.ts";
import { documentRoutes } from "./api/documents.ts";
import { kvRoutes } from "./api/kv.ts";
import type { Config } from "./config.ts";
import { startCleanupJob } from "./lib/cleanup.ts";
import {
  getContentType,
  getEmbeddedFile,
  hasEmbeddedFiles,
} from "./lib/embedded-files.ts";
import { syncHandler } from "./sync/handler.ts";

export async function createServer(_config: Config) {
  const server = Fastify({
    logger: true,
  });

  // Register plugins
  await server.register(cors, {
    origin: true, // TODO: Configure allowed origins
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  });

  await server.register(cookie);

  await server.register(websocket);

  // Serve static UI files
  // When running as a compiled binary, serve from embedded files
  // Otherwise, serve from the filesystem
  if (hasEmbeddedFiles()) {
    // Serve embedded UI files
    server.get("/ui/*", async (request, reply) => {
      const path = (request.params as { "*": string })["*"];
      const file = getEmbeddedFile(path);

      if (!file) {
        return reply.status(404).send({ error: "Not found" });
      }

      const content = await file.arrayBuffer();
      return reply
        .header("Content-Type", getContentType(path))
        .send(Buffer.from(content));
    });

    // Serve docs.html from embedded files
    server.get("/docs", async (_request, reply) => {
      const file = getEmbeddedFile("docs.html");
      if (!file) {
        return reply.status(404).send({ error: "Not found" });
      }
      const content = await file.arrayBuffer();
      return reply
        .header("Content-Type", "text/html; charset=utf-8")
        .send(Buffer.from(content));
    });
  } else {
    // Serve from filesystem (development mode)
    await server.register(fastifyStatic, {
      root: join(import.meta.dir, "ui"),
      prefix: "/ui/",
    });

    // Serve docs at /docs
    server.get("/docs", async (_request, reply) => {
      return reply.sendFile("docs.html");
    });
  }

  // Redirect root to UI
  server.get("/", async (_request, reply) => {
    return reply.redirect("/ui/index.html");
  });

  // Health check
  server.get("/health", async () => {
    return { status: "ok" };
  });

  // Register API routes
  await server.register(authRoutes, { prefix: "/api/v1/auth" });
  await server.register(documentRoutes, { prefix: "/api/v1/documents" });
  await server.register(kvRoutes, { prefix: "/api/v1/kv" });

  // WebSocket sync endpoint
  server.register(async (fastify) => {
    fastify.get("/sync", { websocket: true }, syncHandler);
  });

  // Start background tasks
  startCleanupJob();

  return server;
}
