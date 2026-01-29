import { existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.ts";

/**
 * Get the filesystem path for a document blob.
 * Documents are organized by type and sharded by ID prefix.
 */
export function getDocumentPath(documentId: string): string {
  const parts = documentId.split(":");
  let prefix = "doc";
  let localId = documentId;

  if (parts.length > 1) {
    prefix = parts[0]!;
    localId = parts.slice(1).join(":");
  }

  // Shard by first 2 characters of the local ID
  const shard = localId.substring(0, 2);

  return join(config.dataDir, "documents", prefix, shard, localId);
}

/**
 * Ensure the directory for a document exists.
 */
export function ensureDocumentDir(documentId: string): void {
  const path = getDocumentPath(documentId);
  mkdirSync(dirname(path), { recursive: true });
}

/**
 * Write document data to filesystem.
 */
export async function writeDocument(
  documentId: string,
  data: Uint8Array,
): Promise<void> {
  ensureDocumentDir(documentId);
  const path = getDocumentPath(documentId);
  await Bun.write(path, data);
}

/**
 * Read document data from filesystem.
 */
export async function readDocument(
  documentId: string,
): Promise<Uint8Array | null> {
  const path = getDocumentPath(documentId);

  if (!existsSync(path)) {
    return null;
  }

  const file = Bun.file(path);
  const buffer = await file.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Delete document data from filesystem.
 */
export function deleteDocumentFile(documentId: string): boolean {
  const path = getDocumentPath(documentId);

  if (!existsSync(path)) {
    return false;
  }

  unlinkSync(path);
  return true;
}

/**
 * Get the size of a document on disk.
 */
export function getDocumentFileSize(documentId: string): number {
  const path = getDocumentPath(documentId);

  if (!existsSync(path)) {
    return 0;
  }

  return statSync(path).size;
}
