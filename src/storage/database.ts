import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  ACLEntry,
  BlobClaim,
  BlobMetadata,
  BlobUpload,
  DocumentBlobClaim,
  DocumentMetadata,
  User,
} from "../lib/types.ts";

let db: Database;

export function getDb(): Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase first.");
  }
  return db;
}

export async function initDatabase(dataDir: string): Promise<void> {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "ratatoskr.db");

  db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  runMigrations();
}

function runMigrations(): void {
  const migrations = [
    // Initial schema
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT,
      name TEXT,
      quota_max_documents INTEGER DEFAULT 10000,
      quota_max_document_size INTEGER DEFAULT 10485760,
      quota_max_total_storage INTEGER DEFAULT 1073741824,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,

    `CREATE TABLE IF NOT EXISTS api_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      scopes TEXT,
      last_used_at TEXT,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,

    `CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id),
      automerge_id TEXT,
      type TEXT,
      size INTEGER DEFAULT 0,
      expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,

    `CREATE TABLE IF NOT EXISTS acl_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      principal TEXT NOT NULL,
      permission TEXT NOT NULL,
      UNIQUE(document_id, principal)
    )`,

    `CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id)`,
    `CREATE INDEX IF NOT EXISTS idx_acl_principal ON acl_entries(principal)`,
    `CREATE INDEX IF NOT EXISTS idx_documents_expires ON documents(expires_at) WHERE expires_at IS NOT NULL`,
  ];

  for (const sql of migrations) {
    db.exec(sql);
  }

  // Migration: Add automerge_id column if it doesn't exist (may fail if already exists)
  try {
    db.exec(`ALTER TABLE documents ADD COLUMN automerge_id TEXT`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_documents_automerge ON documents(automerge_id) WHERE automerge_id IS NOT NULL`,
    );
  } catch {
    // Column already exists, ignore
  }

  // Migration: Add KV store table
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, namespace, key)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_kv_namespace ON kv_store(user_id, namespace)`,
  );

  // Migration: Add blob quota columns to users table
  try {
    db.exec(
      `ALTER TABLE users ADD COLUMN quota_max_blob_storage INTEGER DEFAULT 5368709120`,
    ); // 5 GB
  } catch {
    // Column already exists
  }
  try {
    db.exec(
      `ALTER TABLE users ADD COLUMN quota_max_blob_size INTEGER DEFAULT 1073741824`,
    ); // 1 GB
  } catch {
    // Column already exists
  }

  // Migration: Add blob tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS blobs (
      hash TEXT PRIMARY KEY,
      size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      released_at TEXT
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_blobs_released ON blobs(released_at) WHERE released_at IS NOT NULL`,
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS blob_claims (
      blob_hash TEXT NOT NULL REFERENCES blobs(hash) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (blob_hash, user_id)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_blob_claims_user ON blob_claims(user_id)`,
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS document_blob_claims (
      blob_hash TEXT NOT NULL REFERENCES blobs(hash) ON DELETE CASCADE,
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      owner_id TEXT NOT NULL REFERENCES users(id),
      claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (blob_hash, document_id)
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_document_blob_claims_owner ON document_blob_claims(owner_id)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_document_blob_claims_document ON document_blob_claims(document_id)`,
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS blob_uploads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expected_hash TEXT,
      expected_size INTEGER NOT NULL,
      mime_type TEXT NOT NULL,
      chunk_size INTEGER NOT NULL,
      chunks_received INTEGER DEFAULT 0,
      total_chunks INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL
    )
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_blob_uploads_user ON blob_uploads(user_id)`,
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_blob_uploads_expires ON blob_uploads(expires_at)`,
  );
}

// User operations
export function createUser(user: {
  id: string;
  email?: string | null;
  name?: string | null;
}): User {
  const stmt = getDb().prepare(`
    INSERT INTO users (id, email, name)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      name = excluded.name,
      updated_at = datetime('now')
    RETURNING *
  `);

  const row = stmt.get(
    user.id,
    user.email ?? null,
    user.name ?? null,
  ) as Record<string, unknown>;
  return rowToUser(row);
}

export function getUser(id: string): User | null {
  const stmt = getDb().prepare("SELECT * FROM users WHERE id = ?");
  const row = stmt.get(id) as Record<string, unknown> | undefined;
  return row ? rowToUser(row) : null;
}

export function updateUser(
  id: string,
  updates: Partial<{
    email: string | null;
    name: string | null;
    quotaMaxDocuments: number;
    quotaMaxDocumentSize: number;
    quotaMaxTotalStorage: number;
    quotaMaxBlobStorage: number;
    quotaMaxBlobSize: number;
  }>,
): User | null {
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  if (updates.email !== undefined) {
    fields.push("email = ?");
    values.push(updates.email);
  }
  if (updates.name !== undefined) {
    fields.push("name = ?");
    values.push(updates.name);
  }
  if (updates.quotaMaxDocuments !== undefined) {
    fields.push("quota_max_documents = ?");
    values.push(updates.quotaMaxDocuments);
  }
  if (updates.quotaMaxDocumentSize !== undefined) {
    fields.push("quota_max_document_size = ?");
    values.push(updates.quotaMaxDocumentSize);
  }
  if (updates.quotaMaxTotalStorage !== undefined) {
    fields.push("quota_max_total_storage = ?");
    values.push(updates.quotaMaxTotalStorage);
  }
  if (updates.quotaMaxBlobStorage !== undefined) {
    fields.push("quota_max_blob_storage = ?");
    values.push(updates.quotaMaxBlobStorage);
  }
  if (updates.quotaMaxBlobSize !== undefined) {
    fields.push("quota_max_blob_size = ?");
    values.push(updates.quotaMaxBlobSize);
  }

  if (fields.length === 0) {
    return getUser(id);
  }

  fields.push("updated_at = datetime('now')");
  values.push(id);

  const stmt = getDb().prepare(`
    UPDATE users SET ${fields.join(", ")} WHERE id = ? RETURNING *
  `);

  const row = stmt.get(...values) as Record<string, unknown> | undefined;
  return row ? rowToUser(row) : null;
}

function rowToUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    email: row.email as string | null,
    name: row.name as string | null,
    quotaMaxDocuments: row.quota_max_documents as number,
    quotaMaxDocumentSize: row.quota_max_document_size as number,
    quotaMaxTotalStorage: row.quota_max_total_storage as number,
    quotaMaxBlobStorage: (row.quota_max_blob_storage as number) ?? 5368709120,
    quotaMaxBlobSize: (row.quota_max_blob_size as number) ?? 1073741824,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

// Document operations
export function createDocument(doc: {
  id: string;
  ownerId: string;
  type?: string;
  automergeId?: string;
}): DocumentMetadata {
  const stmt = getDb().prepare(`
    INSERT INTO documents (id, owner_id, type, automerge_id)
    VALUES (?, ?, ?, ?)
    RETURNING *
  `);

  const row = stmt.get(
    doc.id,
    doc.ownerId,
    doc.type ?? null,
    doc.automergeId ?? null,
  ) as Record<string, unknown>;
  return rowToDocument(row);
}

export function getDocument(id: string): DocumentMetadata | null {
  const stmt = getDb().prepare("SELECT * FROM documents WHERE id = ?");
  const row = stmt.get(id) as Record<string, unknown> | undefined;
  return row ? rowToDocument(row) : null;
}

export function getDocumentByAutomergeId(
  automergeId: string,
): DocumentMetadata | null {
  const stmt = getDb().prepare(
    "SELECT * FROM documents WHERE automerge_id = ?",
  );
  const row = stmt.get(automergeId) as Record<string, unknown> | undefined;
  return row ? rowToDocument(row) : null;
}

export function deleteDocument(id: string): boolean {
  const stmt = getDb().prepare("DELETE FROM documents WHERE id = ?");
  const result = stmt.run(id);
  return result.changes > 0;
}

export function getDocumentsByOwner(ownerId: string): DocumentMetadata[] {
  const stmt = getDb().prepare("SELECT * FROM documents WHERE owner_id = ?");
  const rows = stmt.all(ownerId) as Record<string, unknown>[];
  return rows.map(rowToDocument);
}

export function updateDocumentSize(id: string, size: number): void {
  const stmt = getDb().prepare(`
    UPDATE documents SET size = ?, updated_at = datetime('now')
    WHERE id = ?
  `);
  stmt.run(size, id);
}

export function updateDocumentType(id: string, type: string): void {
  const stmt = getDb().prepare(`
    UPDATE documents SET type = ?, updated_at = datetime('now')
    WHERE id = ?
  `);
  stmt.run(type, id);
}

export function updateDocumentExpiration(
  id: string,
  expiresAt: Date | null,
): void {
  const stmt = getDb().prepare(`
    UPDATE documents SET expires_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `);
  stmt.run(expiresAt?.toISOString() ?? null, id);
}

function rowToDocument(row: Record<string, unknown>): DocumentMetadata {
  return {
    id: row.id as string,
    ownerId: row.owner_id as string,
    automergeId: (row.automerge_id as string) ?? null,
    type: row.type as string,
    size: row.size as number,
    expiresAt: row.expires_at ? new Date(row.expires_at as string) : null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

// ACL operations
export function setDocumentACL(documentId: string, acl: ACLEntry[]): void {
  const db = getDb();

  db.prepare("DELETE FROM acl_entries WHERE document_id = ?").run(documentId);

  const insertStmt = db.prepare(`
    INSERT INTO acl_entries (document_id, principal, permission)
    VALUES (?, ?, ?)
  `);

  for (const entry of acl) {
    insertStmt.run(documentId, entry.principal, entry.permission);
  }
}

export function getDocumentACL(documentId: string): ACLEntry[] {
  const stmt = getDb().prepare(`
    SELECT principal, permission FROM acl_entries WHERE document_id = ?
  `);
  const rows = stmt.all(documentId) as {
    principal: string;
    permission: string;
  }[];
  return rows.map((row) => ({
    principal: row.principal,
    permission: row.permission as "read" | "write",
  }));
}

// Quota helpers
export function getUserDocumentCount(userId: string): number {
  const stmt = getDb().prepare(
    "SELECT COUNT(*) as count FROM documents WHERE owner_id = ?",
  );
  const row = stmt.get(userId) as { count: number };
  return row.count;
}

export function getUserTotalStorage(userId: string): number {
  const stmt = getDb().prepare(
    "SELECT COALESCE(SUM(size), 0) as total FROM documents WHERE owner_id = ?",
  );
  const row = stmt.get(userId) as { total: number };
  return row.total;
}

// Find documents accessible by user (through ACL)
export function getAccessibleDocuments(userId: string): DocumentMetadata[] {
  const stmt = getDb().prepare(`
    SELECT DISTINCT d.* FROM documents d
    JOIN acl_entries a ON a.document_id = d.id
    WHERE a.principal = ? OR a.principal = 'public'
  `);
  const rows = stmt.all(userId) as Record<string, unknown>[];
  return rows.map(rowToDocument);
}

export function getExpiredDocuments(): string[] {
  const stmt = getDb().prepare(
    "SELECT id FROM documents WHERE datetime(expires_at) < datetime('now')",
  );
  const rows = stmt.all() as { id: string }[];
  return rows.map((r) => r.id);
}

export function deleteExpiredTokens(): number {
  const stmt = getDb().prepare(
    "DELETE FROM api_tokens WHERE datetime(expires_at) < datetime('now')",
  );
  const result = stmt.run();
  return result.changes;
}

// KV Store operations
export interface KVEntry {
  namespace: string;
  key: string;
  value: string;
  createdAt: Date;
  updatedAt: Date;
}

export function kvGet(
  userId: string,
  namespace: string,
  key: string,
): string | null {
  const stmt = getDb().prepare(
    "SELECT value FROM kv_store WHERE user_id = ? AND namespace = ? AND key = ?",
  );
  const row = stmt.get(userId, namespace, key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function kvSet(
  userId: string,
  namespace: string,
  key: string,
  value: string,
): void {
  const stmt = getDb().prepare(`
    INSERT INTO kv_store (user_id, namespace, key, value)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, namespace, key) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now')
  `);
  stmt.run(userId, namespace, key, value);
}

export function kvDelete(
  userId: string,
  namespace: string,
  key: string,
): boolean {
  const stmt = getDb().prepare(
    "DELETE FROM kv_store WHERE user_id = ? AND namespace = ? AND key = ?",
  );
  const result = stmt.run(userId, namespace, key);
  return result.changes > 0;
}

export function kvList(userId: string, namespace: string): KVEntry[] {
  const stmt = getDb().prepare(
    "SELECT namespace, key, value, created_at, updated_at FROM kv_store WHERE user_id = ? AND namespace = ?",
  );
  const rows = stmt.all(userId, namespace) as Record<string, unknown>[];
  return rows.map((row) => ({
    namespace: row.namespace as string,
    key: row.key as string,
    value: row.value as string,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  }));
}

// Blob operations
function rowToBlob(row: Record<string, unknown>): BlobMetadata {
  return {
    hash: row.hash as string,
    size: row.size as number,
    mimeType: row.mime_type as string,
    createdAt: new Date(row.created_at as string),
    releasedAt: row.released_at ? new Date(row.released_at as string) : null,
  };
}

export function createBlob(blob: {
  hash: string;
  size: number;
  mimeType: string;
}): BlobMetadata {
  const stmt = getDb().prepare(`
    INSERT INTO blobs (hash, size, mime_type)
    VALUES (?, ?, ?)
    RETURNING *
  `);
  const row = stmt.get(blob.hash, blob.size, blob.mimeType) as Record<
    string,
    unknown
  >;
  return rowToBlob(row);
}

export function getBlob(hash: string): BlobMetadata | null {
  const stmt = getDb().prepare("SELECT * FROM blobs WHERE hash = ?");
  const row = stmt.get(hash) as Record<string, unknown> | undefined;
  return row ? rowToBlob(row) : null;
}

export function deleteBlob(hash: string): boolean {
  const stmt = getDb().prepare("DELETE FROM blobs WHERE hash = ?");
  const result = stmt.run(hash);
  return result.changes > 0;
}

export function setBlobReleased(hash: string, released: boolean): void {
  const stmt = getDb().prepare(`
    UPDATE blobs SET released_at = ?
    WHERE hash = ?
  `);
  stmt.run(released ? new Date().toISOString() : null, hash);
}

export function getReleasedBlobs(olderThan: Date): BlobMetadata[] {
  const stmt = getDb().prepare(`
    SELECT * FROM blobs
    WHERE released_at IS NOT NULL
    AND datetime(released_at) < datetime(?)
  `);
  const rows = stmt.all(olderThan.toISOString()) as Record<string, unknown>[];
  return rows.map(rowToBlob);
}

// Blob claim operations
export function createBlobClaim(blobHash: string, userId: string): BlobClaim {
  // First, clear released_at since the blob now has a claimer
  setBlobReleased(blobHash, false);

  const stmt = getDb().prepare(`
    INSERT INTO blob_claims (blob_hash, user_id)
    VALUES (?, ?)
    ON CONFLICT(blob_hash, user_id) DO UPDATE SET claimed_at = claimed_at
    RETURNING *
  `);
  const row = stmt.get(blobHash, userId) as Record<string, unknown>;
  return {
    blobHash: row.blob_hash as string,
    userId: row.user_id as string,
    claimedAt: new Date(row.claimed_at as string),
  };
}

export function getBlobClaim(
  blobHash: string,
  userId: string,
): BlobClaim | null {
  const stmt = getDb().prepare(
    "SELECT * FROM blob_claims WHERE blob_hash = ? AND user_id = ?",
  );
  const row = stmt.get(blobHash, userId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    blobHash: row.blob_hash as string,
    userId: row.user_id as string,
    claimedAt: new Date(row.claimed_at as string),
  };
}

export function deleteBlobClaim(blobHash: string, userId: string): boolean {
  const stmt = getDb().prepare(
    "DELETE FROM blob_claims WHERE blob_hash = ? AND user_id = ?",
  );
  const result = stmt.run(blobHash, userId);

  if (result.changes > 0) {
    // Check if blob has any remaining claims
    updateBlobReleasedStatus(blobHash);
  }

  return result.changes > 0;
}

export function getUserBlobClaims(userId: string): BlobClaim[] {
  const stmt = getDb().prepare(
    "SELECT * FROM blob_claims WHERE user_id = ? ORDER BY claimed_at DESC",
  );
  const rows = stmt.all(userId) as Record<string, unknown>[];
  return rows.map((row) => ({
    blobHash: row.blob_hash as string,
    userId: row.user_id as string,
    claimedAt: new Date(row.claimed_at as string),
  }));
}

export function getBlobClaimCount(blobHash: string): number {
  const userClaimsStmt = getDb().prepare(
    "SELECT COUNT(*) as count FROM blob_claims WHERE blob_hash = ?",
  );
  const docClaimsStmt = getDb().prepare(
    "SELECT COUNT(*) as count FROM document_blob_claims WHERE blob_hash = ?",
  );

  const userCount = (userClaimsStmt.get(blobHash) as { count: number }).count;
  const docCount = (docClaimsStmt.get(blobHash) as { count: number }).count;

  return userCount + docCount;
}

function updateBlobReleasedStatus(blobHash: string): void {
  const claimCount = getBlobClaimCount(blobHash);
  if (claimCount === 0) {
    setBlobReleased(blobHash, true);
  }
}

// Document blob claim operations
export function createDocumentBlobClaim(
  blobHash: string,
  documentId: string,
  ownerId: string,
): DocumentBlobClaim {
  // First, clear released_at since the blob now has a claimer
  setBlobReleased(blobHash, false);

  const stmt = getDb().prepare(`
    INSERT INTO document_blob_claims (blob_hash, document_id, owner_id)
    VALUES (?, ?, ?)
    ON CONFLICT(blob_hash, document_id) DO UPDATE SET claimed_at = claimed_at
    RETURNING *
  `);
  const row = stmt.get(blobHash, documentId, ownerId) as Record<
    string,
    unknown
  >;
  return {
    blobHash: row.blob_hash as string,
    documentId: row.document_id as string,
    ownerId: row.owner_id as string,
    claimedAt: new Date(row.claimed_at as string),
  };
}

export function getDocumentBlobClaim(
  blobHash: string,
  documentId: string,
): DocumentBlobClaim | null {
  const stmt = getDb().prepare(
    "SELECT * FROM document_blob_claims WHERE blob_hash = ? AND document_id = ?",
  );
  const row = stmt.get(blobHash, documentId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  return {
    blobHash: row.blob_hash as string,
    documentId: row.document_id as string,
    ownerId: row.owner_id as string,
    claimedAt: new Date(row.claimed_at as string),
  };
}

export function deleteDocumentBlobClaim(
  blobHash: string,
  documentId: string,
): boolean {
  const stmt = getDb().prepare(
    "DELETE FROM document_blob_claims WHERE blob_hash = ? AND document_id = ?",
  );
  const result = stmt.run(blobHash, documentId);

  if (result.changes > 0) {
    // Check if blob has any remaining claims
    updateBlobReleasedStatus(blobHash);
  }

  return result.changes > 0;
}

export function getDocumentBlobClaims(documentId: string): DocumentBlobClaim[] {
  const stmt = getDb().prepare(
    "SELECT * FROM document_blob_claims WHERE document_id = ? ORDER BY claimed_at DESC",
  );
  const rows = stmt.all(documentId) as Record<string, unknown>[];
  return rows.map((row) => ({
    blobHash: row.blob_hash as string,
    documentId: row.document_id as string,
    ownerId: row.owner_id as string,
    claimedAt: new Date(row.claimed_at as string),
  }));
}

// Blob quota helpers
export function getUserBlobStorageUsed(userId: string): number {
  // User claims
  const userClaimsStmt = getDb().prepare(`
    SELECT COALESCE(SUM(b.size), 0) as total
    FROM blob_claims bc
    JOIN blobs b ON b.hash = bc.blob_hash
    WHERE bc.user_id = ?
  `);
  const userTotal = (userClaimsStmt.get(userId) as { total: number }).total;

  // Document claims (for documents this user owns)
  const docClaimsStmt = getDb().prepare(`
    SELECT COALESCE(SUM(b.size), 0) as total
    FROM document_blob_claims dbc
    JOIN blobs b ON b.hash = dbc.blob_hash
    WHERE dbc.owner_id = ?
  `);
  const docTotal = (docClaimsStmt.get(userId) as { total: number }).total;

  return userTotal + docTotal;
}

export function getUserClaimedBlobs(
  userId: string,
  limit = 100,
  offset = 0,
): { blobs: (BlobMetadata & { claimedAt: Date })[]; total: number } {
  const countStmt = getDb().prepare(
    "SELECT COUNT(*) as count FROM blob_claims WHERE user_id = ?",
  );
  const total = (countStmt.get(userId) as { count: number }).count;

  const stmt = getDb().prepare(`
    SELECT b.*, bc.claimed_at as claim_claimed_at
    FROM blobs b
    JOIN blob_claims bc ON bc.blob_hash = b.hash
    WHERE bc.user_id = ?
    ORDER BY bc.claimed_at DESC
    LIMIT ? OFFSET ?
  `);
  const rows = stmt.all(userId, limit, offset) as Record<string, unknown>[];

  return {
    blobs: rows.map((row) => ({
      ...rowToBlob(row),
      claimedAt: new Date(row.claim_claimed_at as string),
    })),
    total,
  };
}

// Blob upload session operations
function rowToBlobUpload(row: Record<string, unknown>): BlobUpload {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    expectedHash: row.expected_hash as string | null,
    expectedSize: row.expected_size as number,
    mimeType: row.mime_type as string,
    chunkSize: row.chunk_size as number,
    chunksReceived: row.chunks_received as number,
    totalChunks: row.total_chunks as number,
    createdAt: new Date(row.created_at as string),
    expiresAt: new Date(row.expires_at as string),
  };
}

export function createBlobUpload(upload: {
  id: string;
  userId: string;
  expectedHash?: string;
  expectedSize: number;
  mimeType: string;
  chunkSize: number;
  totalChunks: number;
  expiresAt: Date;
}): BlobUpload {
  const stmt = getDb().prepare(`
    INSERT INTO blob_uploads (id, user_id, expected_hash, expected_size, mime_type, chunk_size, total_chunks, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *
  `);
  const row = stmt.get(
    upload.id,
    upload.userId,
    upload.expectedHash ?? null,
    upload.expectedSize,
    upload.mimeType,
    upload.chunkSize,
    upload.totalChunks,
    upload.expiresAt.toISOString(),
  ) as Record<string, unknown>;
  return rowToBlobUpload(row);
}

export function getBlobUpload(id: string): BlobUpload | null {
  const stmt = getDb().prepare("SELECT * FROM blob_uploads WHERE id = ?");
  const row = stmt.get(id) as Record<string, unknown> | undefined;
  return row ? rowToBlobUpload(row) : null;
}

export function updateBlobUploadChunksReceived(
  id: string,
  chunksReceived: number,
): void {
  const stmt = getDb().prepare(
    "UPDATE blob_uploads SET chunks_received = ? WHERE id = ?",
  );
  stmt.run(chunksReceived, id);
}

export function deleteBlobUpload(id: string): boolean {
  const stmt = getDb().prepare("DELETE FROM blob_uploads WHERE id = ?");
  const result = stmt.run(id);
  return result.changes > 0;
}

export function getExpiredBlobUploads(): BlobUpload[] {
  const stmt = getDb().prepare(
    "SELECT * FROM blob_uploads WHERE datetime(expires_at) < datetime('now')",
  );
  const rows = stmt.all() as Record<string, unknown>[];
  return rows.map(rowToBlobUpload);
}

export function getUserBlobUploads(userId: string): BlobUpload[] {
  const stmt = getDb().prepare(
    "SELECT * FROM blob_uploads WHERE user_id = ? ORDER BY created_at DESC",
  );
  const rows = stmt.all(userId) as Record<string, unknown>[];
  return rows.map(rowToBlobUpload);
}
