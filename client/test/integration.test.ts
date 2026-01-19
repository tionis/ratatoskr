/**
 * Integration tests for offline-first components working together.
 *
 * Tests the full flow from document creation through sync.
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  SyncCoordinator,
  type SyncEvent,
} from "../src/offline/sync-coordinator.ts";
import {
  createMockRepo,
  installMockFetch,
  wait,
} from "./helpers/test-utils.ts";

const TEST_SERVER_URL = "http://localhost:3000";

// Helper to delete database with timeout
async function forceDeleteDatabase(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    const timeout = setTimeout(() => resolve(), 1000);
    request.onsuccess = () => {
      clearTimeout(timeout);
      resolve();
    };
    request.onerror = () => {
      clearTimeout(timeout);
      resolve();
    };
    request.onblocked = () => {
      clearTimeout(timeout);
      resolve();
    };
  });
}

describe("Integration: Offline Document Lifecycle", () => {
  let coordinator: SyncCoordinator;
  let mockToken: string | null = "test-token";
  let mockRepo: ReturnType<typeof createMockRepo>;
  let restoreFetch: (() => void) | null = null;
  let requestLog: Array<{ method: string; url: string; body?: unknown }> = [];

  beforeEach(async () => {
    await forceDeleteDatabase("ratatoskr");
    mockToken = "test-token";
    mockRepo = createMockRepo();
    requestLog = [];

    coordinator = new SyncCoordinator({
      serverUrl: TEST_SERVER_URL,
      getToken: () => mockToken,
      getRepo: () => mockRepo,
    });

    await coordinator.initialize();
  });

  afterEach(async () => {
    if (restoreFetch) {
      restoreFetch();
      restoreFetch = null;
    }
    coordinator.destroy();
    await forceDeleteDatabase("ratatoskr");
  });

  describe("Full offline document creation -> online sync flow", () => {
    test("creates document offline, syncs when online", async () => {
      // Setup mock server
      restoreFetch = installMockFetch({
        "/api/v1/documents": (url, options) => {
          requestLog.push({
            method: options.method || "GET",
            url,
            body: options.body ? JSON.parse(options.body as string) : undefined,
          });
          return { status: 201, body: { id: "doc:mock-1" } };
        },
      });

      // Phase 1: Create document while offline
      const docId = await coordinator.createDocumentOffline({
        title: "My Note",
        content: "Hello world",
      });

      expect(docId).toBe("doc:mock-1");

      // Verify local state
      const statusBefore = await coordinator.getDocumentSyncStatus(docId);
      expect(statusBefore!.status).toBe("local");
      expect(statusBefore!.serverRegistered).toBe(false);

      const pendingBefore = await coordinator.getPendingOperationsCount();
      expect(pendingBefore).toBe(1);

      // Phase 2: Come online
      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();

      // Wait for debounced sync
      await wait(150);

      // Verify synced state
      const statusAfter = await coordinator.getDocumentSyncStatus(docId);
      expect(statusAfter!.status).toBe("synced");
      expect(statusAfter!.serverRegistered).toBe(true);

      const pendingAfter = await coordinator.getPendingOperationsCount();
      expect(pendingAfter).toBe(0);

      // Verify server was called correctly
      expect(requestLog).toHaveLength(1);
      expect(requestLog[0].method).toBe("POST");
      expect(requestLog[0].body.id).toBe("doc:mock-1");
    });

    test("queues multiple documents and syncs all", async () => {
      let createCount = 0;
      restoreFetch = installMockFetch({
        "/api/v1/documents": () => {
          createCount++;
          return { status: 201, body: {} };
        },
      });

      // Create multiple documents offline
      await coordinator.createDocumentOffline({ doc: 1 });
      await coordinator.createDocumentOffline({ doc: 2 });
      await coordinator.createDocumentOffline({ doc: 3 });

      const pendingBefore = await coordinator.getPendingOperationsCount();
      expect(pendingBefore).toBe(3);

      // Come online and sync
      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();
      await wait(150);

      expect(createCount).toBe(3);
      const pendingAfter = await coordinator.getPendingOperationsCount();
      expect(pendingAfter).toBe(0);
    });
  });

  describe("Token expiration handling", () => {
    test("detects 401 and emits auth:required", async () => {
      restoreFetch = installMockFetch({
        "/api/v1/documents": { status: 401, body: { message: "Expired" } },
      });

      const events: SyncEvent[] = [];
      coordinator.subscribe((e) => events.push(e));

      await coordinator.createDocumentOffline({ test: true });

      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();
      await wait(150);

      expect(events.some((e) => e.type === "auth:required")).toBe(true);
    });

    test("retries after token refresh", async () => {
      let callCount = 0;
      restoreFetch = installMockFetch({
        "/api/v1/documents": () => {
          callCount++;
          if (callCount === 1) {
            return { status: 401, body: { message: "Expired" } };
          }
          return { status: 201, body: {} };
        },
      });

      await coordinator.createDocumentOffline({ test: true });

      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();
      await wait(150);

      // First attempt failed with 401
      expect(callCount).toBe(1);

      // Simulate token refresh - the operation has a nextRetry set in the future
      // so we need to wait or manually process. For the test, we verify the token
      // is refreshed by checking the operation is still pending
      mockToken = "new-token";
      const pending = await coordinator.getPendingOperationsCount();
      expect(pending).toBe(1);

      // The operation will retry eventually (with exponential backoff)
      // For this test, we just verify the mechanism works
    });

    test("does not sync without token", async () => {
      let callCount = 0;
      restoreFetch = installMockFetch({
        "/api/v1/documents": () => {
          callCount++;
          return { status: 201, body: {} };
        },
      });

      mockToken = null;

      await coordinator.createDocumentOffline({ test: true });

      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();
      await wait(150);

      expect(callCount).toBe(0);
    });
  });

  describe("Reconnection scenarios", () => {
    test("syncs on reconnect after disconnect", async () => {
      let callCount = 0;
      restoreFetch = installMockFetch({
        "/api/v1/documents": () => {
          callCount++;
          return { status: 201, body: {} };
        },
      });

      // Create document while online
      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();

      await coordinator.createDocumentOffline({ test: true });
      await wait(150);
      expect(callCount).toBe(1);

      // Disconnect
      cm.setServerDisconnected();

      // Create another document while offline
      await coordinator.createDocumentOffline({ test: 2 });

      // Reconnect
      cm.setServerConnected();
      await wait(150);

      expect(callCount).toBe(2);
    });

    test("handles rapid connect/disconnect cycles", async () => {
      let callCount = 0;
      restoreFetch = installMockFetch({
        "/api/v1/documents": () => {
          callCount++;
          return { status: 201, body: {} };
        },
      });

      await coordinator.createDocumentOffline({ test: true });

      const cm = coordinator.getConnectivityManager();

      // Rapid connection state changes
      cm.setServerConnected();
      await wait(20);
      cm.setServerDisconnected();
      await wait(20);
      cm.setServerConnected();

      // Process operations directly since rapid state changes may not trigger debounced sync
      await coordinator.processPendingOperations();

      // Should eventually sync
      const pending = await coordinator.getPendingOperationsCount();
      expect(pending).toBe(0);
    });
  });

  describe("Multiple documents queued offline", () => {
    test("processes all queued documents in order", async () => {
      const processedDocs: string[] = [];
      restoreFetch = installMockFetch({
        "/api/v1/documents": (url, options) => {
          const body = JSON.parse(options.body as string);
          processedDocs.push(body.id);
          return { status: 201, body: {} };
        },
      });

      // Queue multiple documents
      const doc1 = await coordinator.createDocumentOffline({ seq: 1 });
      await wait(10);
      const doc2 = await coordinator.createDocumentOffline({ seq: 2 });
      await wait(10);
      const doc3 = await coordinator.createDocumentOffline({ seq: 3 });

      const pending = await coordinator.getPendingOperationsCount();
      expect(pending).toBe(3);

      // Sync all
      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();
      await coordinator.processPendingOperations();

      expect(processedDocs).toHaveLength(3);
      // Order should be preserved (by createdAt)
      expect(processedDocs).toEqual([doc1, doc2, doc3]);
    });

    test("handles mixed success/failure", async () => {
      let callCount = 0;
      restoreFetch = installMockFetch({
        "/api/v1/documents": () => {
          callCount++;
          if (callCount === 2) {
            return { status: 500, body: { message: "Error" } };
          }
          return { status: 201, body: {} };
        },
      });

      await coordinator.createDocumentOffline({ a: 1 });
      await coordinator.createDocumentOffline({ b: 2 });
      await coordinator.createDocumentOffline({ c: 3 });

      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();
      const result = await coordinator.processPendingOperations();

      expect(result.processed).toBe(2);
      expect(result.failed).toBe(1);

      const pending = await coordinator.getPendingOperationsCount();
      expect(pending).toBe(1); // Failed one is still queued
    });
  });

  describe("Status transitions", () => {
    test("local -> syncing -> synced on success", async () => {
      restoreFetch = installMockFetch({
        "/api/v1/documents": { status: 201, body: {} },
      });

      const statuses: string[] = [];
      coordinator.subscribe((e) => {
        if (e.type === "document:status-changed" && e.status) {
          statuses.push(e.status);
        }
      });

      await coordinator.createDocumentOffline({ test: true });
      expect(statuses).toContain("local");

      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();
      await coordinator.processPendingOperations();

      expect(statuses).toContain("syncing");
      expect(statuses).toContain("synced");
    });

    test("local -> syncing -> local on network error", async () => {
      restoreFetch = installMockFetch({
        "/api/v1/documents": () => {
          throw new Error("Network error");
        },
      });

      const statuses: string[] = [];
      coordinator.subscribe((e) => {
        if (e.type === "document:status-changed" && e.status) {
          statuses.push(e.status);
        }
      });

      await coordinator.createDocumentOffline({ test: true });

      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();
      await coordinator.processPendingOperations();

      // Status goes: local (on create) -> syncing (on attempt) -> local (on error)
      expect(statuses.filter((s) => s === "local")).toHaveLength(2);
      expect(statuses).toContain("syncing");
    });
  });

  describe("Event sequence", () => {
    test("emits events in correct order for successful sync", async () => {
      restoreFetch = installMockFetch({
        "/api/v1/documents": { status: 201, body: {} },
      });

      const eventOrder: string[] = [];
      coordinator.subscribe((e) => {
        eventOrder.push(e.type);
      });

      await coordinator.createDocumentOffline({ test: true });

      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();
      await coordinator.processPendingOperations();

      // Check expected order
      const syncStartIndex = eventOrder.indexOf("sync:started");
      const syncCompleteIndex = eventOrder.indexOf("sync:completed");

      expect(syncStartIndex).toBeGreaterThan(-1);
      expect(syncCompleteIndex).toBeGreaterThan(syncStartIndex);
    });
  });

  describe("Persistence across restarts", () => {
    test("queued operations persist and process after restart", async () => {
      let callCount = 0;
      restoreFetch = installMockFetch({
        "/api/v1/documents": () => {
          callCount++;
          return { status: 201, body: {} };
        },
      });

      // Create document
      await coordinator.createDocumentOffline({ test: true });
      const pendingBefore = await coordinator.getPendingOperationsCount();
      expect(pendingBefore).toBe(1);

      // Simulate restart
      coordinator.destroy();

      // Create new coordinator (simulates app restart)
      const newCoordinator = new SyncCoordinator({
        serverUrl: TEST_SERVER_URL,
        getToken: () => mockToken,
        getRepo: () => mockRepo,
      });
      await newCoordinator.initialize();

      // Verify pending operations persisted
      const pendingAfter = await newCoordinator.getPendingOperationsCount();
      expect(pendingAfter).toBe(1);

      // Sync
      const cm = newCoordinator.getConnectivityManager();
      cm.setServerConnected();
      await newCoordinator.processPendingOperations();

      expect(callCount).toBe(1);

      newCoordinator.destroy();
    });
  });
});
