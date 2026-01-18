import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../src/config.ts";
import { cleanupExpiredItems } from "../src/lib/cleanup.ts";
import {
  createDocument,
  createUser,
  getDb,
  getDocument,
  initDatabase,
  updateDocumentExpiration,
} from "../src/storage/database.ts";
import { getDocumentPath } from "../src/storage/documents.ts";

const TEST_DIR = join(process.cwd(), `.test-cleanup-${Date.now()}`);

beforeAll(async () => {
  // Setup temp environment
  config.dataDir = TEST_DIR;
  await initDatabase(TEST_DIR);

  // Create a user for testing
  createUser({ id: "test-user", name: "Test User" });
});

afterAll(() => {
  // Cleanup temp environment
  rmSync(TEST_DIR, { recursive: true, force: true });
});

test("Cleanup Job > should remove expired tokens and documents", () => {
  const db = getDb();

  // 1. Setup Tokens
  // Create expired token
  db.prepare(`
    INSERT INTO api_tokens (id, user_id, name, token_hash, expires_at)
    VALUES ('token-expired', 'test-user', 'Expired Token', 'hash1', ?)
  `).run(new Date(Date.now() - 3600000).toISOString());

  // Create valid token
  db.prepare(`
    INSERT INTO api_tokens (id, user_id, name, token_hash, expires_at)
    VALUES ('token-valid', 'test-user', 'Valid Token', 'hash2', ?)
  `).run(new Date(Date.now() + 3600000).toISOString());

  // 2. Setup Documents
  // Create expired document
  const expiredDoc = createDocument({
    id: "doc:expired",
    ownerId: "test-user",
  });
  updateDocumentExpiration(expiredDoc.id, new Date(Date.now() - 3600000)); // 1 hour ago

  // Create file for expired document
  const expiredPath = getDocumentPath(expiredDoc.id);
  // Ensure dir exists
  mkdirSync(join(expiredPath, ".."), { recursive: true });
  writeFileSync(expiredPath, "expired content");

  // Create valid document
  const validDoc = createDocument({ id: "doc:valid", ownerId: "test-user" });
  updateDocumentExpiration(validDoc.id, new Date(Date.now() + 3600000)); // 1 hour future

  // Create file for valid document
  const validPath = getDocumentPath(validDoc.id);
  mkdirSync(join(validPath, ".."), { recursive: true });
  writeFileSync(validPath, "valid content");

  // Create valid document with no expiration
  const permanentDoc = createDocument({
    id: "doc:permanent",
    ownerId: "test-user",
  });
  const permanentPath = getDocumentPath(permanentDoc.id);
  mkdirSync(join(permanentPath, ".."), { recursive: true });
  writeFileSync(permanentPath, "permanent content");

  // 3. Run Cleanup
  const result = cleanupExpiredItems();

  // 4. Assertions
  expect(result.tokensDeleted).toBe(1);
  expect(result.documentsDeleted).toBe(1);

  // Check Tokens
  const tokens = db.prepare("SELECT id FROM api_tokens").all() as {
    id: string;
  }[];
  const tokenIds = tokens.map((t) => t.id);
  expect(tokenIds).toContain("token-valid");
  expect(tokenIds).not.toContain("token-expired");

  // Check Documents in DB
  const docExpired = getDocument("doc:expired");
  const docValid = getDocument("doc:valid");
  const docPermanent = getDocument("doc:permanent");

  expect(docExpired).toBeNull();
  expect(docValid).not.toBeNull();
  expect(docPermanent).not.toBeNull();

  // Check Documents on Filesystem
  expect(existsSync(expiredPath)).toBe(false);
  expect(existsSync(validPath)).toBe(true);
  expect(existsSync(permanentPath)).toBe(true);
});
