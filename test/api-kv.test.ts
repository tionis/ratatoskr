import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createSessionToken } from "../src/auth/tokens.ts";
import { config } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { createUser, initDatabase } from "../src/storage/database.ts";

const TEST_DIR = join(process.cwd(), `.test-api-kv-${Date.now()}`);

// Mock config
config.dataDir = TEST_DIR;

let server: FastifyInstance;
let authToken: string;
let authToken2: string;
const userId = "test-user-kv";
const userId2 = "test-user-kv-2";

beforeAll(async () => {
  await initDatabase(TEST_DIR);
  createUser({ id: userId, name: "KV User" });
  createUser({ id: userId2, name: "KV User 2" });
  authToken = createSessionToken(userId);
  authToken2 = createSessionToken(userId2);
  server = await createServer(config);
});

afterAll(async () => {
  if (server) await server.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("KV Store API", () => {
  test("should set and get a value", async () => {
    const namespace = "dev.test.app";
    const key = "root";
    const value = "automerge:abc123";

    // Set
    const setRes = await server.inject({
      method: "PUT",
      url: `/api/v1/kv/${namespace}/${key}`,
      headers: { Authorization: `Bearer ${authToken}` },
      payload: { value },
    });
    expect(setRes.statusCode).toBe(200);
    expect(setRes.json().value).toBe(value);

    // Get
    const getRes = await server.inject({
      method: "GET",
      url: `/api/v1/kv/${namespace}/${key}`,
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().value).toBe(value);
  });

  test("should return 404 for non-existent key", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/kv/dev.test.app/nonexistent",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  test("should update an existing value", async () => {
    const namespace = "dev.test.update";
    const key = "config";

    // Set initial value
    await server.inject({
      method: "PUT",
      url: `/api/v1/kv/${namespace}/${key}`,
      headers: { Authorization: `Bearer ${authToken}` },
      payload: { value: "initial" },
    });

    // Update
    const updateRes = await server.inject({
      method: "PUT",
      url: `/api/v1/kv/${namespace}/${key}`,
      headers: { Authorization: `Bearer ${authToken}` },
      payload: { value: "updated" },
    });
    expect(updateRes.statusCode).toBe(200);

    // Verify
    const getRes = await server.inject({
      method: "GET",
      url: `/api/v1/kv/${namespace}/${key}`,
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(getRes.json().value).toBe("updated");
  });

  test("should delete a value", async () => {
    const namespace = "dev.test.delete";
    const key = "toDelete";

    // Set
    await server.inject({
      method: "PUT",
      url: `/api/v1/kv/${namespace}/${key}`,
      headers: { Authorization: `Bearer ${authToken}` },
      payload: { value: "deleteme" },
    });

    // Delete
    const deleteRes = await server.inject({
      method: "DELETE",
      url: `/api/v1/kv/${namespace}/${key}`,
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(deleteRes.statusCode).toBe(204);

    // Verify gone
    const getRes = await server.inject({
      method: "GET",
      url: `/api/v1/kv/${namespace}/${key}`,
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(getRes.statusCode).toBe(404);
  });

  test("should return 404 when deleting non-existent key", async () => {
    const res = await server.inject({
      method: "DELETE",
      url: "/api/v1/kv/dev.test.app/nonexistent",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  test("should list all keys in namespace", async () => {
    const namespace = "dev.test.list";

    // Set multiple values
    await server.inject({
      method: "PUT",
      url: `/api/v1/kv/${namespace}/key1`,
      headers: { Authorization: `Bearer ${authToken}` },
      payload: { value: "value1" },
    });
    await server.inject({
      method: "PUT",
      url: `/api/v1/kv/${namespace}/key2`,
      headers: { Authorization: `Bearer ${authToken}` },
      payload: { value: "value2" },
    });

    // List
    const listRes = await server.inject({
      method: "GET",
      url: `/api/v1/kv/${namespace}`,
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(listRes.statusCode).toBe(200);

    const data = listRes.json();
    expect(data.namespace).toBe(namespace);
    expect(data.entries).toHaveLength(2);
    expect(data.entries.map((e: { key: string }) => e.key).sort()).toEqual([
      "key1",
      "key2",
    ]);
  });

  test("should isolate data between users", async () => {
    const namespace = "dev.test.isolated";
    const key = "secret";

    // User 1 sets a value
    await server.inject({
      method: "PUT",
      url: `/api/v1/kv/${namespace}/${key}`,
      headers: { Authorization: `Bearer ${authToken}` },
      payload: { value: "user1-secret" },
    });

    // User 2 can't see User 1's value
    const getRes = await server.inject({
      method: "GET",
      url: `/api/v1/kv/${namespace}/${key}`,
      headers: { Authorization: `Bearer ${authToken2}` },
    });
    expect(getRes.statusCode).toBe(404);

    // User 2 sets their own value
    await server.inject({
      method: "PUT",
      url: `/api/v1/kv/${namespace}/${key}`,
      headers: { Authorization: `Bearer ${authToken2}` },
      payload: { value: "user2-secret" },
    });

    // Both users see their own values
    const getRes1 = await server.inject({
      method: "GET",
      url: `/api/v1/kv/${namespace}/${key}`,
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(getRes1.json().value).toBe("user1-secret");

    const getRes2 = await server.inject({
      method: "GET",
      url: `/api/v1/kv/${namespace}/${key}`,
      headers: { Authorization: `Bearer ${authToken2}` },
    });
    expect(getRes2.json().value).toBe("user2-secret");
  });

  test("should reject invalid namespace", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/kv/123invalid/key",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_namespace");
  });

  test("should reject invalid key", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/kv/dev.test.app/123invalid",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_key");
  });

  test("should require authentication", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/kv/dev.test.app/key",
    });
    expect(res.statusCode).toBe(401);
  });
});
