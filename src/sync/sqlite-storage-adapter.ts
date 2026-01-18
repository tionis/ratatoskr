/**
 * SQLite-backed storage adapter for automerge-repo.
 *
 * This replaces the filesystem-based adapter to avoid inode exhaustion
 * issues when storing many documents with incremental changes.
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  Chunk,
  StorageAdapterInterface,
  StorageKey,
} from "@automerge/automerge-repo";
import { isEphemeralId } from "./ephemeral.ts";

/**
 * Key separator for storage keys.
 * Using Unit Separator (ASCII 31) which is designed for this purpose
 * and won't appear in normal text or document IDs.
 */
const KEY_SEPARATOR = "\u001f";

/**
 * SQLite storage adapter that stores automerge-repo chunks in a database.
 *
 * Keys are stored as a normalized string (joined with Unit Separator)
 * and data is stored as a blob.
 */
export class SqliteStorageAdapter implements StorageAdapterInterface {
  private db: Database;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, "automerge.db");

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");

    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        key TEXT PRIMARY KEY,
        data BLOB NOT NULL
      )
    `);

    // Index for prefix queries (loadRange)
    // SQLite can use the primary key index for LIKE 'prefix%' queries
  }

  /**
   * Convert a storage key array to a string for database storage.
   * Uses Unit Separator (ASCII 31) since it won't appear in valid keys.
   */
  private keyToString(key: StorageKey): string {
    return key.join(KEY_SEPARATOR);
  }

  /**
   * Convert a stored key string back to a storage key array.
   */
  private stringToKey(str: string): StorageKey {
    return str.split(KEY_SEPARATOR);
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    const docId = key[0];
    if (docId && isEphemeralId(docId)) {
      return undefined;
    }

    const keyStr = this.keyToString(key);
    const stmt = this.db.prepare("SELECT data FROM chunks WHERE key = ?");
    const row = stmt.get(keyStr) as { data: Uint8Array } | undefined;

    return row?.data;
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    const docId = key[0];
    if (docId && isEphemeralId(docId)) {
      return;
    }

    const keyStr = this.keyToString(key);
    const stmt = this.db.prepare(`
      INSERT INTO chunks (key, data) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET data = excluded.data
    `);
    stmt.run(keyStr, data);
  }

  async remove(key: StorageKey): Promise<void> {
    const docId = key[0];
    if (docId && isEphemeralId(docId)) {
      return;
    }

    const keyStr = this.keyToString(key);
    const stmt = this.db.prepare("DELETE FROM chunks WHERE key = ?");
    stmt.run(keyStr);
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    if (keyPrefix.length === 0) {
      return [];
    }

    const docId = keyPrefix[0];
    if (docId && isEphemeralId(docId)) {
      return [];
    }

    const prefixStr = this.keyToString(keyPrefix);
    // Match exact key OR keys that start with prefix + separator
    const stmt = this.db.prepare(
      "SELECT key, data FROM chunks WHERE key = ? OR key GLOB ?",
    );
    const rows = stmt.all(prefixStr, `${prefixStr}${KEY_SEPARATOR}*`) as {
      key: string;
      data: Uint8Array;
    }[];

    return rows.map((row) => ({
      key: this.stringToKey(row.key),
      data: row.data,
    }));
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    if (keyPrefix.length === 0) {
      return;
    }

    const docId = keyPrefix[0];
    if (docId && isEphemeralId(docId)) {
      return;
    }

    const prefixStr = this.keyToString(keyPrefix);
    const stmt = this.db.prepare(
      "DELETE FROM chunks WHERE key = ? OR key GLOB ?",
    );
    stmt.run(prefixStr, `${prefixStr}${KEY_SEPARATOR}*`);
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}
