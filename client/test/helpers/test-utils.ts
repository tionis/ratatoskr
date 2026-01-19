/**
 * Shared test utilities for offline components.
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach } from "bun:test";
import type { DocumentStatusEntry } from "../../src/offline/document-status-tracker.ts";
import type { PendingOperation } from "../../src/offline/pending-operations-queue.ts";

// Re-export fake-indexeddb for explicit access if needed
export { IDBKeyRange, indexedDB } from "fake-indexeddb";

/**
 * Clear all IndexedDB databases.
 * Call this in beforeEach/afterEach to ensure clean state.
 */
export async function clearAllDatabases(): Promise<void> {
  const databases = await indexedDB.databases();
  for (const db of databases) {
    if (db.name) {
      indexedDB.deleteDatabase(db.name);
    }
  }
}

/**
 * Delete a specific database by name.
 */
export function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      // Force close and retry
      resolve();
    };
  });
}

/**
 * Setup hooks for IndexedDB tests.
 * Returns a cleanup function that should be called in afterEach.
 */
export function setupIndexedDBTests(): void {
  beforeEach(async () => {
    await clearAllDatabases();
  });

  afterEach(async () => {
    await clearAllDatabases();
  });
}

/**
 * Create a mock pending operation.
 */
export function createMockOperation(
  overrides: Partial<PendingOperation> = {},
): PendingOperation {
  return {
    id: crypto.randomUUID(),
    type: "register_document",
    documentId: `doc:${crypto.randomUUID()}`,
    payload: {},
    createdAt: new Date().toISOString(),
    attempts: 0,
    ...overrides,
  };
}

/**
 * Create a mock document status entry.
 */
export function createMockStatusEntry(
  overrides: Partial<DocumentStatusEntry> = {},
): DocumentStatusEntry {
  return {
    documentId: `doc:${crypto.randomUUID()}`,
    status: "local",
    serverRegistered: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Mock fetch responses.
 */
interface MockFetchResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface MockFetchConfig {
  [key: string]:
    | MockFetchResponse
    | ((
        url: string,
        options: RequestInit,
      ) => MockFetchResponse | Promise<MockFetchResponse>);
}

/**
 * Create a mock fetch function.
 */
export function createMockFetch(config: MockFetchConfig): typeof fetch {
  const originalFetch = globalThis.fetch;

  const mockFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = init?.method || "GET";
    const key = `${method} ${url}`;

    // Find matching config
    let responseConfig = config[key] || config[url] || config["*"];

    if (!responseConfig) {
      // Try pattern matching (e.g., "POST /api/v1/documents")
      for (const pattern of Object.keys(config)) {
        if (url.includes(pattern) || key.includes(pattern)) {
          responseConfig = config[pattern];
          break;
        }
      }
    }

    if (!responseConfig) {
      throw new Error(`No mock configured for: ${key}`);
    }

    // If it's a function, call it
    const response =
      typeof responseConfig === "function"
        ? await responseConfig(url, init || {})
        : responseConfig;

    return new Response(
      response.body !== undefined ? JSON.stringify(response.body) : null,
      {
        status: response.status,
        headers: {
          "Content-Type": "application/json",
          ...response.headers,
        },
      },
    );
  };

  // Store original for restoration
  (mockFetch as unknown as { original: typeof fetch }).original = originalFetch;

  return mockFetch as typeof fetch;
}

/**
 * Install a mock fetch globally and return a restore function.
 */
export function installMockFetch(config: MockFetchConfig): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = createMockFetch(config);
  return () => {
    globalThis.fetch = original;
  };
}

/**
 * Create a mock Repo object.
 */
export function createMockRepo(
  overrides: Partial<{
    create: <T>() => {
      documentId: string;
      change: (fn: (doc: T) => void) => void;
    };
    find: (id: string) => { documentId: string };
  }> = {},
) {
  let docCounter = 0;

  return {
    create: <T>() => ({
      documentId: `doc:mock-${++docCounter}`,
      change: (_fn: (doc: T) => void) => {
        // No-op for testing
      },
    }),
    find: (id: string) => ({
      documentId: id,
    }),
    ...overrides,
  };
}

/**
 * Wait for a specified number of milliseconds.
 */
export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for all pending promises to resolve.
 */
export async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
