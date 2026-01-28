import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createSessionToken } from "../src/auth/tokens.ts";
import { config } from "../src/config.ts";
import { createServer } from "../src/server.ts";
import { blobExists, computeHash } from "../src/storage/blobs.ts";
import {
  createDocument,
  createUser,
  getBlobClaim,
  initDatabase,
  updateUser,
} from "../src/storage/database.ts";

const TEST_DIR = join(process.cwd(), `.test-api-blobs-${Date.now()}`);

// Mock config
config.dataDir = TEST_DIR;

let server: FastifyInstance;
let authToken: string;
let authToken2: string;
const userId = "test-user-blobs";
const userId2 = "test-user-blobs-2";

// Counter for unique data generation
let dataCounter = 0;

// Helper to create unique test data
function createTestData(size: number): Uint8Array {
  const data = new Uint8Array(size);
  const seed = dataCounter++;
  for (let i = 0; i < size; i++) {
    data[i] = (i + seed) % 256;
  }
  return data;
}

// Helper to perform chunked upload
async function uploadBlob(
  token: string,
  data: Uint8Array,
  mimeType = "application/octet-stream",
  expectedHash?: string,
): Promise<{
  hash: string;
  size: number;
  mimeType: string;
  deduplicated: boolean;
}> {
  const chunkSize = 1024 * 1024; // 1MB chunks for testing

  // Init upload
  const initRes = await server.inject({
    method: "POST",
    url: "/api/v1/blobs/upload/init",
    headers: { Authorization: `Bearer ${token}` },
    payload: {
      size: data.length,
      mimeType,
      expectedHash,
      chunkSize,
    },
  });

  if (initRes.statusCode !== 200) {
    throw new Error(`Init failed: ${initRes.body}`);
  }

  const { uploadId, totalChunks } = initRes.json();

  // Upload chunks
  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, data.length);
    const chunk = data.slice(start, end);

    const chunkRes = await server.inject({
      method: "PUT",
      url: `/api/v1/blobs/upload/${uploadId}/chunk/${i}`,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
      },
      payload: Buffer.from(chunk),
    });

    if (chunkRes.statusCode !== 200) {
      throw new Error(`Chunk ${i} failed: ${chunkRes.body}`);
    }
  }

  // Complete upload
  const completeRes = await server.inject({
    method: "POST",
    url: `/api/v1/blobs/upload/${uploadId}/complete`,
    headers: { Authorization: `Bearer ${token}` },
  });

  if (completeRes.statusCode !== 200) {
    throw new Error(`Complete failed: ${completeRes.body}`);
  }

  return completeRes.json();
}

beforeAll(async () => {
  await initDatabase(TEST_DIR);

  // Create users with blob quotas
  createUser({ id: userId, name: "Blob User" });
  createUser({ id: userId2, name: "Blob User 2" });

  // Set quotas (10MB storage, 5MB max blob size)
  updateUser(userId, {
    quotaMaxBlobStorage: 10 * 1024 * 1024,
    quotaMaxBlobSize: 5 * 1024 * 1024,
  });
  updateUser(userId2, {
    quotaMaxBlobStorage: 10 * 1024 * 1024,
    quotaMaxBlobSize: 5 * 1024 * 1024,
  });

  authToken = createSessionToken(userId);
  authToken2 = createSessionToken(userId2);
  server = await createServer(config);
});

afterAll(async () => {
  if (server) await server.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("Blob Upload API", () => {
  test("should upload a small blob", async () => {
    const data = createTestData(1000);
    const expectedHash = await computeHash(data);

    const result = await uploadBlob(
      authToken,
      data,
      "text/plain",
      expectedHash,
    );

    expect(result.hash).toBe(expectedHash);
    expect(result.size).toBe(1000);
    expect(result.mimeType).toBe("text/plain");
    expect(result.deduplicated).toBe(false);

    // Verify blob exists on disk
    expect(blobExists(result.hash)).toBe(true);

    // Verify claim was created
    const claim = getBlobClaim(result.hash, userId);
    expect(claim).not.toBeNull();
  });

  test("should upload a multi-chunk blob", async () => {
    const data = createTestData(2.5 * 1024 * 1024); // 2.5MB
    const expectedHash = await computeHash(data);

    const result = await uploadBlob(authToken, data);

    expect(result.hash).toBe(expectedHash);
    expect(result.size).toBe(data.length);
    expect(result.deduplicated).toBe(false);
  });

  test("should deduplicate identical blobs", async () => {
    // Create identical data for both uploads
    const data = new Uint8Array(500);
    for (let i = 0; i < 500; i++) {
      data[i] = (i * 7) % 256; // Fixed pattern
    }

    // First upload
    const result1 = await uploadBlob(authToken, data);
    expect(result1.deduplicated).toBe(false);

    // Second upload by different user with same data
    const data2 = new Uint8Array(500);
    for (let i = 0; i < 500; i++) {
      data2[i] = (i * 7) % 256; // Same fixed pattern
    }

    const result2 = await uploadBlob(authToken2, data2);
    expect(result2.hash).toBe(result1.hash);
    expect(result2.deduplicated).toBe(true);

    // Both users should have claims
    expect(getBlobClaim(result1.hash, userId)).not.toBeNull();
    expect(getBlobClaim(result1.hash, userId2)).not.toBeNull();
  });

  test("should reject upload exceeding max blob size", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/blobs/upload/init",
      headers: { Authorization: `Bearer ${authToken}` },
      payload: {
        size: 6 * 1024 * 1024, // 6MB, exceeds 5MB limit
        mimeType: "application/octet-stream",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("blob_too_large");
  });

  test("should reject hash mismatch", async () => {
    const data = createTestData(100);
    const wrongHash = "0".repeat(64);

    // Init with wrong expected hash
    const initRes = await server.inject({
      method: "POST",
      url: "/api/v1/blobs/upload/init",
      headers: { Authorization: `Bearer ${authToken}` },
      payload: {
        size: data.length,
        mimeType: "text/plain",
        expectedHash: wrongHash,
      },
    });

    const { uploadId } = initRes.json();

    // Upload chunk
    await server.inject({
      method: "PUT",
      url: `/api/v1/blobs/upload/${uploadId}/chunk/0`,
      headers: {
        Authorization: `Bearer ${authToken}`,
        "Content-Type": "application/octet-stream",
      },
      payload: Buffer.from(data),
    });

    // Complete should fail
    const completeRes = await server.inject({
      method: "POST",
      url: `/api/v1/blobs/upload/${uploadId}/complete`,
      headers: { Authorization: `Bearer ${authToken}` },
    });

    expect(completeRes.statusCode).toBe(400);
    expect(completeRes.json().error).toBe("hash_mismatch");
  });

  test("should cancel upload", async () => {
    const initRes = await server.inject({
      method: "POST",
      url: "/api/v1/blobs/upload/init",
      headers: { Authorization: `Bearer ${authToken}` },
      payload: {
        size: 1000,
        mimeType: "text/plain",
      },
    });

    const { uploadId } = initRes.json();

    // Cancel
    const cancelRes = await server.inject({
      method: "DELETE",
      url: `/api/v1/blobs/upload/${uploadId}`,
      headers: { Authorization: `Bearer ${authToken}` },
    });

    expect(cancelRes.statusCode).toBe(204);

    // Try to complete - should fail
    const completeRes = await server.inject({
      method: "POST",
      url: `/api/v1/blobs/upload/${uploadId}/complete`,
      headers: { Authorization: `Bearer ${authToken}` },
    });

    expect(completeRes.statusCode).toBe(404);
  });

  test("should reject chunk from wrong user", async () => {
    const initRes = await server.inject({
      method: "POST",
      url: "/api/v1/blobs/upload/init",
      headers: { Authorization: `Bearer ${authToken}` },
      payload: {
        size: 1000,
        mimeType: "text/plain",
      },
    });

    const { uploadId } = initRes.json();

    // Try to upload chunk as different user
    const chunkRes = await server.inject({
      method: "PUT",
      url: `/api/v1/blobs/upload/${uploadId}/chunk/0`,
      headers: {
        Authorization: `Bearer ${authToken2}`,
        "Content-Type": "application/octet-stream",
      },
      payload: Buffer.from(createTestData(1000)),
    });

    expect(chunkRes.statusCode).toBe(403);
  });

  test("should require authentication for upload", async () => {
    const res = await server.inject({
      method: "POST",
      url: "/api/v1/blobs/upload/init",
      payload: {
        size: 1000,
        mimeType: "text/plain",
      },
    });

    expect(res.statusCode).toBe(401);
  });
});

describe("Blob Download API", () => {
  let testBlobHash: string;

  beforeAll(async () => {
    const data = createTestData(2000);
    const result = await uploadBlob(authToken, data, "image/png");
    testBlobHash = result.hash;
  });

  test("should download a blob", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/api/v1/blobs/${testBlobHash}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["content-length"]).toBe("2000");
    expect(res.headers.etag).toBe(`"${testBlobHash}"`);
    expect(res.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  test("should support range requests", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/api/v1/blobs/${testBlobHash}`,
      headers: { Range: "bytes=0-99" },
    });

    expect(res.statusCode).toBe(206);
    expect(res.headers["content-range"]).toBe(`bytes 0-99/2000`);
    expect(res.headers["content-length"]).toBe("100");
  });

  test("should return 404 for non-existent blob", async () => {
    const fakeHash = "a".repeat(64);
    const res = await server.inject({
      method: "GET",
      url: `/api/v1/blobs/${fakeHash}`,
    });

    expect(res.statusCode).toBe(404);
  });

  test("should check blob existence with HEAD", async () => {
    const res = await server.inject({
      method: "HEAD",
      url: `/api/v1/blobs/${testBlobHash}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["content-length"]).toBe("2000");
  });

  test("should allow anonymous download", async () => {
    // No auth header
    const res = await server.inject({
      method: "GET",
      url: `/api/v1/blobs/${testBlobHash}`,
    });

    expect(res.statusCode).toBe(200);
  });
});

describe("Blob Claims API", () => {
  let sharedBlobHash: string;

  beforeAll(async () => {
    const data = createTestData(3000);
    const result = await uploadBlob(authToken, data);
    sharedBlobHash = result.hash;
  });

  test("should claim an existing blob", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/v1/blobs/${sharedBlobHash}/claim`,
      headers: { Authorization: `Bearer ${authToken2}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().hash).toBe(sharedBlobHash);
    expect(res.json().size).toBe(3000);

    // Verify claim exists
    expect(getBlobClaim(sharedBlobHash, userId2)).not.toBeNull();
  });

  test("should reject duplicate claim", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/v1/blobs/${sharedBlobHash}/claim`,
      headers: { Authorization: `Bearer ${authToken2}` },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("already_claimed");
  });

  test("should release a claim", async () => {
    const res = await server.inject({
      method: "DELETE",
      url: `/api/v1/blobs/${sharedBlobHash}/claim`,
      headers: { Authorization: `Bearer ${authToken2}` },
    });

    expect(res.statusCode).toBe(204);

    // Verify claim is gone
    expect(getBlobClaim(sharedBlobHash, userId2)).toBeNull();
  });

  test("should return 404 when releasing non-existent claim", async () => {
    const res = await server.inject({
      method: "DELETE",
      url: `/api/v1/blobs/${sharedBlobHash}/claim`,
      headers: { Authorization: `Bearer ${authToken2}` },
    });

    expect(res.statusCode).toBe(404);
  });

  test("should return 404 when claiming non-existent blob", async () => {
    const fakeHash = "b".repeat(64);
    const res = await server.inject({
      method: "POST",
      url: `/api/v1/blobs/${fakeHash}/claim`,
      headers: { Authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(404);
  });

  test("should require authentication for claims", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/v1/blobs/${sharedBlobHash}/claim`,
    });

    expect(res.statusCode).toBe(401);
  });
});

describe("List Blobs API", () => {
  test("should list claimed blobs", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/blobs",
      headers: { Authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(Array.isArray(data.blobs)).toBe(true);
    expect(typeof data.total).toBe("number");
    expect(typeof data.quotaUsed).toBe("number");
    expect(typeof data.quotaLimit).toBe("number");
  });

  test("should support pagination", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/blobs?limit=1&offset=0",
      headers: { Authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.blobs.length).toBeLessThanOrEqual(1);
  });

  test("should require authentication", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/v1/blobs",
    });

    expect(res.statusCode).toBe(401);
  });
});

describe("Document Blob Claims API", () => {
  let docId: string;
  let docBlobHash: string;

  beforeAll(async () => {
    // Create a document
    const doc = createDocument({
      id: `doc:blob-test-${Date.now()}`,
      ownerId: userId,
    });
    docId = doc.id;

    // Upload a blob
    const data = createTestData(1500);
    const result = await uploadBlob(authToken, data);
    docBlobHash = result.hash;
  });

  test("should add document blob claim", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/v1/documents/${encodeURIComponent(docId)}/blobs/${docBlobHash}`,
      headers: { Authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().hash).toBe(docBlobHash);
  });

  test("should list document blobs", async () => {
    const res = await server.inject({
      method: "GET",
      url: `/api/v1/documents/${encodeURIComponent(docId)}/blobs`,
      headers: { Authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.blobs.length).toBeGreaterThan(0);
    expect(
      data.blobs.some((b: { hash: string }) => b.hash === docBlobHash),
    ).toBe(true);
  });

  test("should reject duplicate document blob claim", async () => {
    const res = await server.inject({
      method: "POST",
      url: `/api/v1/documents/${encodeURIComponent(docId)}/blobs/${docBlobHash}`,
      headers: { Authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(409);
  });

  test("should remove document blob claim", async () => {
    const res = await server.inject({
      method: "DELETE",
      url: `/api/v1/documents/${encodeURIComponent(docId)}/blobs/${docBlobHash}`,
      headers: { Authorization: `Bearer ${authToken}` },
    });

    expect(res.statusCode).toBe(204);

    // Verify it's gone
    const listRes = await server.inject({
      method: "GET",
      url: `/api/v1/documents/${encodeURIComponent(docId)}/blobs`,
      headers: { Authorization: `Bearer ${authToken}` },
    });

    const data = listRes.json();
    expect(
      data.blobs.some((b: { hash: string }) => b.hash === docBlobHash),
    ).toBe(false);
  });

  test("should require write permission for document blob claims", async () => {
    // User 2 doesn't have access to the document
    const res = await server.inject({
      method: "POST",
      url: `/api/v1/documents/${encodeURIComponent(docId)}/blobs/${docBlobHash}`,
      headers: { Authorization: `Bearer ${authToken2}` },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe("Quota Enforcement", () => {
  const quotaUserId = "quota-test-user";
  let quotaAuthToken: string;

  beforeAll(async () => {
    createUser({ id: quotaUserId, name: "Quota Test User" });
    // Small quota: 5KB storage, 2KB max blob
    updateUser(quotaUserId, {
      quotaMaxBlobStorage: 5 * 1024,
      quotaMaxBlobSize: 2 * 1024,
    });
    quotaAuthToken = createSessionToken(quotaUserId);
  });

  test("should enforce storage quota on upload", async () => {
    // Upload 2KB blob (within limits)
    const data1 = createTestData(2000);
    const result1 = await uploadBlob(quotaAuthToken, data1);
    expect(result1.size).toBe(2000);

    // Upload another 2KB blob (within limits)
    const data2 = createTestData(2000);
    const result2 = await uploadBlob(quotaAuthToken, data2);
    expect(result2.size).toBe(2000);

    // Try to upload 2KB more - should exceed 5KB quota
    const data3 = createTestData(2000);
    const initRes = await server.inject({
      method: "POST",
      url: "/api/v1/blobs/upload/init",
      headers: { Authorization: `Bearer ${quotaAuthToken}` },
      payload: {
        size: data3.length,
        mimeType: "application/octet-stream",
      },
    });

    expect(initRes.statusCode).toBe(402);
    expect(initRes.json().error).toBe("quota_exceeded");
  });

  test("should enforce quota on claim", async () => {
    // Upload a blob as user 1
    const data = createTestData(1900);
    const result = await uploadBlob(authToken, data);

    // Quota user tries to claim - should exceed their quota
    const res = await server.inject({
      method: "POST",
      url: `/api/v1/blobs/${result.hash}/claim`,
      headers: { Authorization: `Bearer ${quotaAuthToken}` },
    });

    expect(res.statusCode).toBe(402);
    expect(res.json().error).toBe("quota_exceeded");
  });
});
