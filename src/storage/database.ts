import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ACLEntry, DocumentMetadata, User } from "../lib/types.ts";

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

function rowToUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    email: row.email as string | null,
    name: row.name as string | null,
    quotaMaxDocuments: row.quota_max_documents as number,
    quotaMaxDocumentSize: row.quota_max_document_size as number,
    quotaMaxTotalStorage: row.quota_max_total_storage as number,
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
