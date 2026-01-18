import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { initDatabase, createUser } from "../src/storage/database.ts";
import { createSessionToken } from "../src/auth/tokens.ts";

const TEST_DIR = join(process.cwd(), ".test-api-type-" + Date.now());

// Mock config
config.dataDir = TEST_DIR;

let server: any;
let authToken: string;
const userId = "test-user-type";

beforeAll(async () => {
  await initDatabase(TEST_DIR);
  createUser({ id: userId, name: "Type User" });
  authToken = createSessionToken(userId);
  server = await createServer(config);
});

afterAll(async () => {
  if (server) await server.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

test("API Type Update > should update document type", async () => {
  const docId = "doc:type-test";

  // Create
  await server.inject({
    method: "POST",
    url: "/api/v1/documents",
    headers: { Authorization: `Bearer ${authToken}` },
    payload: { id: docId, type: "original" }
  });

  // Update Type
  const updateRes = await server.inject({
    method: "PUT",
    url: `/api/v1/documents/${docId}/type`,
    headers: { Authorization: `Bearer ${authToken}` },
    payload: { type: "updated" }
  });
  expect(updateRes.statusCode).toBe(200);
  expect(updateRes.json().type).toBe("updated");

  // Verify Get
  const getRes = await server.inject({
    method: "GET",
    url: `/api/v1/documents/${docId}`,
    headers: { Authorization: `Bearer ${authToken}` }
  });
  expect(getRes.json().type).toBe("updated");
});
