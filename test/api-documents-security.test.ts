import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createSessionToken } from "../src/auth/tokens.ts";
import { config } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import {
  createUser,
  initDatabase,
  updateUser,
} from "../src/storage/database.ts";

const TEST_DIR = join(
  process.cwd(),
  `.test-api-documents-security-${Date.now()}`,
);

config.dataDir = TEST_DIR;

let server: FastifyInstance;
let user1Token: string;
let user2Token: string;

beforeAll(async () => {
  await initDatabase(TEST_DIR);
  createUser({ id: "security-user-1", name: "Security User 1" });
  createUser({ id: "security-user-2", name: "Security User 2" });
  user1Token = createSessionToken("security-user-1");
  user2Token = createSessionToken("security-user-2");
  server = await createServer(config);
});

afterAll(async () => {
  if (server) await server.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Documents API security rules", () => {
  test("rejects invalid document IDs", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/documents",
      headers: { Authorization: `Bearer ${user1Token}` },
      payload: { id: "../escape" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_request");
  });

  test("rejects app document creation via generic endpoint", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/v1/documents",
      headers: { Authorization: `Bearer ${user1Token}` },
      payload: { id: "app:manual", type: "app:notes" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_request");
  });

  test("enforces app documents as owner-only and non-shareable", async () => {
    const appDocRes = await server.inject({
      method: "GET",
      url: "/api/v1/documents/app/com.example.notes",
      headers: { Authorization: `Bearer ${user1Token}` },
    });
    expect(appDocRes.statusCode).toBe(200);

    const appDocId = appDocRes.json().documentId as string;

    const otherUserRead = await server.inject({
      method: "GET",
      url: `/api/v1/documents/${appDocId}`,
      headers: { Authorization: `Bearer ${user2Token}` },
    });
    expect(otherUserRead.statusCode).toBe(403);

    const aclUpdate = await server.inject({
      method: "PUT",
      url: `/api/v1/documents/${appDocId}/acl`,
      headers: { Authorization: `Bearer ${user1Token}` },
      payload: {
        acl: [{ principal: "security-user-2", permission: "read" }],
      },
    });
    expect(aclUpdate.statusCode).toBe(400);
    expect(aclUpdate.json().error).toBe("invalid_request");
  });

  test("does not expose ACL details to non-owner document readers", async () => {
    const create = await server.inject({
      method: "POST",
      url: "/api/v1/documents",
      headers: { Authorization: `Bearer ${user1Token}` },
      payload: {
        id: "doc:acl-visibility",
        acl: [{ principal: "security-user-2", permission: "read" }],
      },
    });
    expect(create.statusCode).toBe(200);

    const readAsSharedUser = await server.inject({
      method: "GET",
      url: "/api/v1/documents/doc:acl-visibility",
      headers: { Authorization: `Bearer ${user2Token}` },
    });
    expect(readAsSharedUser.statusCode).toBe(200);
    expect(readAsSharedUser.json().acl).toBeUndefined();
  });

  test("rejects duplicate automerge IDs across documents", async () => {
    const first = await server.inject({
      method: "POST",
      url: "/api/v1/documents",
      headers: { Authorization: `Bearer ${user1Token}` },
      payload: { id: "doc:first", automergeId: "dup-automerge-id" },
    });
    expect(first.statusCode).toBe(200);

    const second = await server.inject({
      method: "POST",
      url: "/api/v1/documents",
      headers: { Authorization: `Bearer ${user1Token}` },
      payload: { id: "doc:second", automergeId: "dup-automerge-id" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("conflict");
  });

  test("enforces max document size on REST content updates", async () => {
    updateUser("security-user-1", { quotaMaxDocumentSize: 128 });

    const create = await server.inject({
      method: "POST",
      url: "/api/v1/documents",
      headers: { Authorization: `Bearer ${user1Token}` },
      payload: { id: "doc:quota-content" },
    });
    expect(create.statusCode).toBe(200);

    const update = await server.inject({
      method: "PUT",
      url: "/api/v1/documents/doc:quota-content/content",
      headers: { Authorization: `Bearer ${user1Token}` },
      payload: {
        text: "x".repeat(5000),
      },
    });

    expect(update.statusCode).toBe(403);
    expect(update.json().error).toBe("quota_exceeded");
    expect(update.json().quota).toBe("maxDocumentSize");
  });
});
