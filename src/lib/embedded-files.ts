/**
 * Helper module for serving embedded files in compiled binaries.
 *
 * When running as a compiled binary, UI files are embedded and served from memory.
 * When running in development, files are served from the filesystem.
 */

import { file } from "bun";

// This will be populated by the binary entry point when compiled
let embeddedFiles: Record<string, string> | null = null;

/**
 * Set the embedded files map (called from binary entry point).
 */
export function setEmbeddedFiles(files: Record<string, string>): void {
  embeddedFiles = files;
}

/**
 * Check if we're running as a compiled binary with embedded files.
 */
export function hasEmbeddedFiles(): boolean {
  return embeddedFiles !== null && Object.keys(embeddedFiles).length > 0;
}

/**
 * Get an embedded file by path.
 * Returns the Bun file handle if found, null otherwise.
 */
export function getEmbeddedFile(path: string): ReturnType<typeof file> | null {
  if (!embeddedFiles) return null;

  // Normalize path (remove leading slash if present)
  const normalizedPath = path.replace(/^\/+/, "");

  const filePath = embeddedFiles[normalizedPath];
  if (!filePath) return null;

  return file(filePath);
}

/**
 * Get the content type for a file based on extension.
 */
export function getContentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  const types: Record<string, string> = {
    html: "text/html; charset=utf-8",
    css: "text/css; charset=utf-8",
    js: "application/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    eot: "application/vnd.ms-fontobject",
    wasm: "application/wasm",
  };
  return types[ext ?? ""] ?? "application/octet-stream";
}

/**
 * List all embedded file paths.
 */
export function listEmbeddedFiles(): string[] {
  return embeddedFiles ? Object.keys(embeddedFiles) : [];
}
