import { join } from "node:path";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { authRoutes } from "./api/auth.ts";
import { blobRoutes } from "./api/blobs.ts";
import { documentRoutes } from "./api/documents.ts";
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
    bodyLimit: 11 * 1024 * 1024, // 11 MB — slightly above max chunk size (10 MB) to allow for encoding overhead
  });

  // Add content type parser for binary uploads
  server.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, payload, done) => {
      done(null, payload);
    },
  );

  // Allow all origins — this is a sync API server, not a website.
  // Auth is token-based (Authorization header), not cookie-based,
  // so CORS provides no security benefit and only blocks legitimate apps.
  await server.register(cors, {
    origin: true,
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

  // Serve client library at root
  server.get("/ratatoskr-client.js", async (_request, reply) => {
    if (hasEmbeddedFiles()) {
      const file = getEmbeddedFile("lib/ratatoskr-client.js");
      if (!file) {
        return reply.status(404).send({ error: "Not found" });
      }
      const content = await file.arrayBuffer();
      return reply
        .header("Content-Type", "application/javascript; charset=utf-8")
        .send(Buffer.from(content));
    }

    // In dev mode, use sendFile (relies on fastify-static root set to src/ui)
    return reply.sendFile("lib/ratatoskr-client.js");
  });

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
  await server.register(blobRoutes, { prefix: "/api/v1/blobs" });
  await server.register(documentRoutes, { prefix: "/api/v1/documents" });

  // WebSocket sync endpoint
  server.register(async (fastify) => {
    fastify.get("/sync", { websocket: true }, syncHandler);
  });

  // Start background tasks
  startCleanupJob();

  return server;
}
