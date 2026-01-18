import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createSessionToken } from "../src/auth/tokens.ts";
import { config } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { createUser, initDatabase } from "../src/storage/database.ts";

const TEST_DIR = join(process.cwd(), `.test-api-export-${Date.now()}`);

// Mock config
config.dataDir = TEST_DIR;
// Ensure other config values are present to avoid validation errors if createServer mostly uses config for middleware setup, checking defaults is good

let server: FastifyInstance;
let authToken: string;
const userId = "test-user-export";

beforeAll(async () => {
  // Initialize DB
  await initDatabase(TEST_DIR);

  // Create user
  createUser({ id: userId, name: "Export User", email: "export@example.com" });

  // Generate token
  authToken = createSessionToken(userId);

  // Start server
  server = await createServer(config);
});

afterAll(async () => {
  if (server) await server.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

test("API Export/Import > should create, update content, and export document", async () => {
  const docId = "doc:export-test";

  // 1. Create Document
  const createRes = await server.inject({
    method: "POST",
    url: "/api/v1/documents",
    headers: { Authorization: `Bearer ${authToken}` },
    payload: { id: docId, type: "notes" },
  });
  expect(createRes.statusCode).toBe(200);

  // 2. Update Content (PUT /content)
  const newContent = { title: "Hello World", count: 42 };
  const updateRes = await server.inject({
    method: "PUT",
    url: `/api/v1/documents/${docId}/content`,
    headers: { Authorization: `Bearer ${authToken}` },
    payload: newContent,
  });
  expect(updateRes.statusCode).toBe(200);
  expect(updateRes.json().success).toBe(true);

  // 3. Export JSON (GET /export?format=json)
  const exportJsonRes = await server.inject({
    method: "GET",
    url: `/api/v1/documents/${docId}/export?format=json`,
    headers: { Authorization: `Bearer ${authToken}` },
  });
  expect(exportJsonRes.statusCode).toBe(200);
  const jsonContent = exportJsonRes.json();
  expect(jsonContent.title).toBe("Hello World");
  expect(jsonContent.count).toBe(42);

  // 4. Export Binary (GET /export?format=binary)
  const exportBinRes = await server.inject({
    method: "GET",
    url: `/api/v1/documents/${docId}/export?format=binary`,
    headers: { Authorization: `Bearer ${authToken}` },
  });
  expect(exportBinRes.statusCode).toBe(200);
  expect(exportBinRes.headers["content-type"]).toBe("application/octet-stream");
  expect(exportBinRes.rawPayload.length).toBeGreaterThan(0);
});
