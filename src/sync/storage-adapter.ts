/**
 * Automerge-repo storage adapter backed by the filesystem.
 *
 * Storage keys are arrays like ["documentId", "snapshot", "hash"] or
 * ["documentId", "incremental", "hash"]. We store these as files in a
 * directory structure.
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  Chunk,
  StorageAdapterInterface,
  StorageKey,
} from "@automerge/automerge-repo";
import { config } from "../config.ts";
import { isEphemeralId } from "./ephemeral.ts";

/**
 * Convert a storage key to a filesystem path.
 * Keys like ["docId", "snapshot", "hash"] become "docId/snapshot/hash"
 */
function keyToPath(key: StorageKey): string {
  // Shard by first 2 chars of document ID to avoid too many files in one dir
  const [docId, ...rest] = key;
  if (!docId) {
    throw new Error("Storage key must have at least one element");
  }

  const shard = docId.substring(0, 2);
  return join(config.dataDir, "automerge", shard, docId, ...rest);
}

/**
 * Ensure the directory for a path exists.
 */
function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Recursively get all files under a directory.
 */
function getAllFiles(dir: string, prefix: string[] = []): string[][] {
  if (!existsSync(dir)) {
    return [];
  }

  const results: string[][] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const newPrefix = [...prefix, entry.name];
    if (entry.isDirectory()) {
      results.push(...getAllFiles(join(dir, entry.name), newPrefix));
    } else {
      results.push(newPrefix);
    }
  }

  return results;
}

export class RatatoskrStorageAdapter implements StorageAdapterInterface {
  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    // Don't persist ephemeral documents
    const docId = key[0];
    if (docId && isEphemeralId(docId)) {
      return undefined;
    }

    const path = keyToPath(key);

    if (!existsSync(path)) {
      return undefined;
    }

    const file = Bun.file(path);
    const buffer = await file.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    // Don't persist ephemeral documents
    const docId = key[0];
    if (docId && isEphemeralId(docId)) {
      return;
    }

    const path = keyToPath(key);
    ensureDir(path);
    await Bun.write(path, data);
  }

  async remove(key: StorageKey): Promise<void> {
    // Don't persist ephemeral documents
    const docId = key[0];
    if (docId && isEphemeralId(docId)) {
      return;
    }

    const path = keyToPath(key);

    if (existsSync(path)) {
      unlinkSync(path);
    }
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    if (keyPrefix.length === 0) {
      return [];
    }

    const [docId, ...restPrefix] = keyPrefix;
    if (!docId) {
      return [];
    }

    const shard = docId.substring(0, 2);
    const baseDir = join(config.dataDir, "automerge", shard, docId);

    // Get all files under the base directory
    const allFiles = getAllFiles(
      restPrefix.length > 0 ? join(baseDir, ...restPrefix) : baseDir,
      restPrefix,
    );

    const chunks: Chunk[] = [];

    for (const filePath of allFiles) {
      const key = [docId, ...filePath];
      const data = await this.load(key);
      chunks.push({ key, data });
    }

    return chunks;
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    const chunks = await this.loadRange(keyPrefix);

    for (const chunk of chunks) {
      await this.remove(chunk.key);
    }
  }
}
