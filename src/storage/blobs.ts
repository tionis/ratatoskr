import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { config } from "../config.ts";

/**
 * Get the filesystem path for a blob.
 * Blobs are sharded by the first 2 characters of their hash.
 */
export function getBlobPath(hash: string): string {
  if (!hash || hash.length < 2) {
    throw new Error(`Invalid blob hash: ${hash}`);
  }

  const shard = hash.substring(0, 2);
  return join(config.dataDir, "blobs", shard, hash);
}

/**
 * Ensure the directory for a blob exists.
 */
export function ensureBlobDir(hash: string): void {
  const path = getBlobPath(hash);
  mkdirSync(dirname(path), { recursive: true });
}

/**
 * Write blob data to filesystem.
 */
export async function writeBlob(hash: string, data: Uint8Array): Promise<void> {
  ensureBlobDir(hash);
  const path = getBlobPath(hash);
  await Bun.write(path, data);
}

/**
 * Read blob data from filesystem.
 */
export async function readBlob(hash: string): Promise<Uint8Array | null> {
  const path = getBlobPath(hash);

  if (!existsSync(path)) {
    return null;
  }

  const file = Bun.file(path);
  const buffer = await file.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Check if a blob exists on disk.
 */
export function blobExists(hash: string): boolean {
  const path = getBlobPath(hash);
  return existsSync(path);
}

/**
 * Delete blob data from filesystem.
 */
export function deleteBlobFile(hash: string): boolean {
  const path = getBlobPath(hash);

  if (!existsSync(path)) {
    return false;
  }

  unlinkSync(path);
  return true;
}

/**
 * Get the size of a blob on disk.
 */
export function getBlobFileSize(hash: string): number {
  const path = getBlobPath(hash);

  if (!existsSync(path)) {
    return 0;
  }

  return statSync(path).size;
}

// Chunked upload operations

/**
 * Get the directory path for a chunked upload.
 */
export function getUploadChunksDir(uploadId: string): string {
  return join(config.dataDir, "blob-chunks", uploadId);
}

/**
 * Get the path for a specific chunk.
 */
export function getChunkPath(uploadId: string, chunkIndex: number): string {
  return join(getUploadChunksDir(uploadId), String(chunkIndex));
}

/**
 * Ensure the chunks directory for an upload exists.
 */
export function ensureUploadChunksDir(uploadId: string): void {
  mkdirSync(getUploadChunksDir(uploadId), { recursive: true });
}

/**
 * Write a chunk to disk.
 */
export async function writeChunk(
  uploadId: string,
  chunkIndex: number,
  data: Uint8Array,
): Promise<void> {
  ensureUploadChunksDir(uploadId);
  const path = getChunkPath(uploadId, chunkIndex);
  await Bun.write(path, data);
}

/**
 * Read a chunk from disk.
 */
export async function readChunk(
  uploadId: string,
  chunkIndex: number,
): Promise<Uint8Array | null> {
  const path = getChunkPath(uploadId, chunkIndex);

  if (!existsSync(path)) {
    return null;
  }

  const file = Bun.file(path);
  const buffer = await file.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Check if a chunk exists.
 */
export function chunkExists(uploadId: string, chunkIndex: number): boolean {
  const path = getChunkPath(uploadId, chunkIndex);
  return existsSync(path);
}

/**
 * Get all received chunk indices for an upload.
 */
export function getReceivedChunks(uploadId: string): number[] {
  const dir = getUploadChunksDir(uploadId);

  if (!existsSync(dir)) {
    return [];
  }

  const files = readdirSync(dir);
  return files.map((f) => Number.parseInt(f, 10)).sort((a, b) => a - b);
}

/**
 * Delete all chunks for an upload.
 */
export function deleteUploadChunks(uploadId: string): boolean {
  const dir = getUploadChunksDir(uploadId);

  if (!existsSync(dir)) {
    return false;
  }

  rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * Assemble chunks into a final blob.
 * Returns the assembled data as a Uint8Array.
 */
export async function assembleChunks(
  uploadId: string,
  totalChunks: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let totalSize = 0;

  for (let i = 0; i < totalChunks; i++) {
    const chunk = await readChunk(uploadId, i);
    if (!chunk) {
      throw new Error(`Missing chunk ${i} for upload ${uploadId}`);
    }
    chunks.push(chunk);
    totalSize += chunk.length;
  }

  // Concatenate all chunks
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }

  return result;
}

/**
 * Compute SHA-256 hash of data.
 */
export async function computeHash(data: Uint8Array): Promise<string> {
  // Create a new ArrayBuffer to ensure compatibility with crypto.subtle.digest
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
