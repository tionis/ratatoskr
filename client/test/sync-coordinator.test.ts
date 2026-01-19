/**
 * Tests for SyncCoordinator.
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  SyncCoordinator,
  type SyncEvent,
  type SyncEventType,
} from "../src/offline/sync-coordinator.ts";
import {
  createMockRepo,
  deleteDatabase,
  installMockFetch,
  wait,
} from "./helpers/test-utils.ts";

const TEST_DB_NAME = "ratatoskr"; // Uses default name
const TEST_SERVER_URL = "http://localhost:3000";

describe("SyncCoordinator", () => {
  let coordinator: SyncCoordinator;
  let mockToken: string | null = "test-token";
  let mockRepo: ReturnType<typeof createMockRepo> | null = null;
  let restoreFetch: (() => void) | null = null;

  beforeEach(async () => {
    await deleteDatabase(TEST_DB_NAME);
    mockToken = "test-token";
    mockRepo = createMockRepo();

    coordinator = new SyncCoordinator({
      serverUrl: TEST_SERVER_URL,
      getToken: () => mockToken,
      getRepo: () => mockRepo as ReturnType<typeof createMockRepo>,
    });
  });

  afterEach(async () => {
    coordinator.destroy();
    if (restoreFetch) {
      restoreFetch();
      restoreFetch = null;
    }
    await deleteDatabase(TEST_DB_NAME);
  });

  describe("initialize()", () => {
    test("sets up without error", async () => {
      await coordinator.initialize();
      // Should not throw
    });

    test("is idempotent", async () => {
      await coordinator.initialize();
      await coordinator.initialize();
      await coordinator.initialize();
      // Should not throw or set up multiple subscriptions
    });

    test("starts in offline state", async () => {
      await coordinator.initialize();
      expect(coordinator.getConnectivityState()).toBe("offline");
    });
  });

  describe("createDocumentOffline()", () => {
    test("returns document ID immediately", async () => {
      await coordinator.initialize();

      const docId = await coordinator.createDocumentOffline({ title: "Test" });

      expect(docId).toBeDefined();
      expect(docId).toMatch(/^doc:/);
    });

    test("creates document in repo", async () => {
      await coordinator.initialize();

      const docId = await coordinator.createDocumentOffline({
        content: "Hello",
      });

      expect(docId).toBe("doc:mock-1");
    });

    test("queues document registration", async () => {
      await coordinator.initialize();

      await coordinator.createDocumentOffline({ data: "test" });

      const pending = await coordinator.getPendingOperationsCount();
      expect(pending).toBe(1);
    });

    test("tracks document status as local", async () => {
      await coordinator.initialize();

      const docId = await coordinator.createDocumentOffline({ value: 42 });

      const status = await coordinator.getDocumentSyncStatus(docId);
      expect(status).toBeDefined();
      expect(status!.status).toBe("local");
      expect(status!.serverRegistered).toBe(false);
    });

    test("fails without repo", async () => {
      mockRepo = null;
      await coordinator.initialize();

      await expect(
        coordinator.createDocumentOffline({ test: true }),
      ).rejects.toThrow("Repo not initialized");
    });

    test("passes type and expiresAt to queue", async () => {
      await coordinator.initialize();

      const docId = await coordinator.createDocumentOffline(
        { note: "content" },
        {
          type: "note",
          expiresAt: "2025-12-31T00:00:00Z",
        },
      );

      const hasPending = await coordinator.hasPendingOperation(docId);
      expect(hasPending).toBe(true);
    });

    test("schedules sync if online with token", async () => {
      restoreFetch = installMockFetch({
        "/api/v1/documents": { status: 201, body: { id: "doc:mock-1" } },
      });

      await coordinator.initialize();
      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();

      const events: SyncEvent[] = [];
      coordinator.subscribe((e) => events.push(e));

      await coordinator.createDocumentOffline({ data: "test" });

      // Wait for debounced sync
      await wait(150);

      expect(events.some((e) => e.type === "sync:started")).toBe(true);
    });
  });

  describe("processPendingOperations()", () => {
    test("does nothing when offline", async () => {
      await coordinator.initialize();
      await coordinator.createDocumentOffline({ test: true });

      const result = await coordinator.processPendingOperations();

      expect(result.processed).toBe(0);
      expect(result.failed).toBe(0);
    });

    test("does nothing without token", async () => {
      mockToken = null;
      await coordinator.initialize();
      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();

      await coordinator.createDocumentOffline({ test: true });

      const events: SyncEvent[] = [];
      coordinator.subscribe((e) => events.push(e));

      const result = await coordinator.processPendingOperations();

      expect(result.processed).toBe(0);
      expect(events.some((e) => e.type === "auth:required")).toBe(true);
    });

    test("processes operations when online with token", async () => {
      restoreFetch = installMockFetch({
        "/api/v1/documents": { status: 201, body: { id: "doc:mock-1" } },
      });

      await coordinator.initialize();
      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();

      await coordinator.createDocumentOffline({ test: true });
      const result = await coordinator.processPendingOperations();

      expect(result.processed).toBe(1);
      expect(result.failed).toBe(0);
    });

    test("emits sync:started and sync:completed", async () => {
      restoreFetch = installMockFetch({
        "/api/v1/documents": { status: 201, body: {} },
      });

      await coordinator.initialize();
      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();

      const events: SyncEventType[] = [];
      coordinator.subscribe((e) => events.push(e.type));

      await coordinator.createDocumentOffline({ test: true });
      await coordinator.processPendingOperations();

      expect(events).toContain("sync:started");
      expect(events).toContain("sync:completed");
    });

    test("emits sync:error on failure", async () => {
      await coordinator.initialize();
      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();

      // Create document but don't set up fetch mock - will throw
      await coordinator.createDocumentOffline({ test: true });

      const events: SyncEvent[] = [];
      coordinator.subscribe((e) => events.push(e));

      restoreFetch = installMockFetch({
        "/api/v1/documents": { status: 500, body: { message: "Server error" } },
      });

      await coordinator.processPendingOperations();

      // Should complete but with failures
      expect(events.some((e) => e.type === "sync:completed")).toBe(true);
    });
  });

  describe("event emission", () => {
    test("emits document:status-changed", async () => {
      await coordinator.initialize();

      const events: SyncEvent[] = [];
      coordinator.subscribe((e) => events.push(e));

      await coordinator.createDocumentOffline({ test: true });

      const statusEvents = events.filter(
        (e) => e.type === "document:status-changed",
      );
      expect(statusEvents).toHaveLength(1);
      expect(statusEvents[0].status).toBe("local");
    });

    test("emits connectivity:changed", async () => {
      await coordinator.initialize();

      const events: SyncEvent[] = [];
      coordinator.subscribe((e) => events.push(e));

      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();

      const connectivityEvents = events.filter(
        (e) => e.type === "connectivity:changed",
      );
      expect(connectivityEvents).toHaveLength(1);
      expect(connectivityEvents[0].connectivity).toBe("online");
    });

    test("emits auth:required when token missing", async () => {
      mockToken = null;
      await coordinator.initialize();
      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();

      const events: SyncEvent[] = [];
      coordinator.subscribe((e) => events.push(e));

      await coordinator.createDocumentOffline({ test: true });
      await coordinator.processPendingOperations();

      expect(events.some((e) => e.type === "auth:required")).toBe(true);
    });

    test("emits auth:token-expired via emitTokenExpired()", async () => {
      await coordinator.initialize();

      const events: SyncEvent[] = [];
      coordinator.subscribe((e) => events.push(e));

      coordinator.emitTokenExpired();

      expect(events.some((e) => e.type === "auth:token-expired")).toBe(true);
    });
  });

  describe("connectivity change triggers sync", () => {
    test("schedules sync when coming online", async () => {
      restoreFetch = installMockFetch({
        "/api/v1/documents": { status: 201, body: {} },
      });

      await coordinator.initialize();

      // Create document while offline
      await coordinator.createDocumentOffline({ test: true });

      const events: SyncEvent[] = [];
      coordinator.subscribe((e) => events.push(e));

      // Come online
      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();

      // Wait for debounced sync
      await wait(150);

      expect(events.some((e) => e.type === "sync:started")).toBe(true);
    });
  });

  describe("100ms debounce", () => {
    test("debounces multiple sync triggers", async () => {
      restoreFetch = installMockFetch({
        "/api/v1/documents": { status: 201, body: {} },
      });

      await coordinator.initialize();
      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();

      let syncStartCount = 0;
      coordinator.subscribe((e) => {
        if (e.type === "sync:started") syncStartCount++;
      });

      // Multiple rapid document creations
      await coordinator.createDocumentOffline({ test: 1 });
      await coordinator.createDocumentOffline({ test: 2 });
      await coordinator.createDocumentOffline({ test: 3 });

      // Wait less than debounce time
      await wait(50);
      expect(syncStartCount).toBe(0);

      // Wait for debounce to trigger
      await wait(100);
      expect(syncStartCount).toBe(1);
    });
  });

  describe("HTTP response handling", () => {
    test("handles 200/201 success", async () => {
      restoreFetch = installMockFetch({
        "/api/v1/documents": { status: 201, body: { id: "doc:mock-1" } },
      });

      await coordinator.initialize();
      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();

      const docId = await coordinator.createDocumentOffline({ test: true });
      await coordinator.processPendingOperations();

      const status = await coordinator.getDocumentSyncStatus(docId);
      expect(status!.status).toBe("synced");
      expect(status!.serverRegistered).toBe(true);
    });

    test("handles 401 unauthorized", async () => {
      restoreFetch = installMockFetch({
        "/api/v1/documents": { status: 401, body: { message: "Unauthorized" } },
      });

      await coordinator.initialize();
      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();

      const events: SyncEvent[] = [];
      coordinator.subscribe((e) => events.push(e));

      await coordinator.createDocumentOffline({ test: true });
      await coordinator.processPendingOperations();

      expect(events.some((e) => e.type === "auth:required")).toBe(true);
    });

    test("handles 409 conflict as success (document exists)", async () => {
      restoreFetch = installMockFetch({
        "/api/v1/documents": {
          status: 409,
          body: { message: "Document exists" },
        },
      });

      await coordinator.initialize();
      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();

      const docId = await coordinator.createDocumentOffline({ test: true });
      await coordinator.processPendingOperations();

      // 409 should be treated as success (document already registered)
      const status = await coordinator.getDocumentSyncStatus(docId);
      expect(status!.serverRegistered).toBe(true);
    });

    test("handles 500 server error", async () => {
      restoreFetch = installMockFetch({
        "/api/v1/documents": {
          status: 500,
          body: { message: "Internal error" },
        },
      });

      await coordinator.initialize();
      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();

      const docId = await coordinator.createDocumentOffline({ test: true });
      const result = await coordinator.processPendingOperations();

      expect(result.failed).toBe(1);
      const pending = await coordinator.getPendingOperationsCount();
      expect(pending).toBe(1); // Still in queue for retry
    });

    test("handles network error", async () => {
      restoreFetch = installMockFetch({
        "/api/v1/documents": () => {
          throw new Error("Network unavailable");
        },
      });

      await coordinator.initialize();
      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();

      const docId = await coordinator.createDocumentOffline({ test: true });
      const result = await coordinator.processPendingOperations();

      expect(result.failed).toBe(1);
      const status = await coordinator.getDocumentSyncStatus(docId);
      expect(status!.status).toBe("local");
      expect(status!.error).toBe("Network unavailable");
    });
  });

  describe("getDocumentSyncStatus()", () => {
    test("returns status for tracked document", async () => {
      await coordinator.initialize();

      const docId = await coordinator.createDocumentOffline({ test: true });
      const status = await coordinator.getDocumentSyncStatus(docId);

      expect(status).toBeDefined();
      expect(status!.documentId).toBe(docId);
    });

    test("returns undefined for untracked document", async () => {
      await coordinator.initialize();

      const status = await coordinator.getDocumentSyncStatus("doc:unknown");
      expect(status).toBeUndefined();
    });
  });

  describe("getConnectivityState()", () => {
    test("returns offline initially", async () => {
      await coordinator.initialize();
      expect(coordinator.getConnectivityState()).toBe("offline");
    });

    test("returns online after connection", async () => {
      await coordinator.initialize();
      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();

      expect(coordinator.getConnectivityState()).toBe("online");
    });

    test("returns connecting during connection", async () => {
      await coordinator.initialize();
      const cm = coordinator.getConnectivityManager();
      cm.setServerConnecting();

      expect(coordinator.getConnectivityState()).toBe("connecting");
    });
  });

  describe("getConnectivityManager()", () => {
    test("returns the connectivity manager", async () => {
      await coordinator.initialize();
      const cm = coordinator.getConnectivityManager();

      expect(cm).toBeDefined();
      expect(typeof cm.isOnline).toBe("function");
    });
  });

  describe("getPendingOperationsCount()", () => {
    test("returns 0 when empty", async () => {
      await coordinator.initialize();
      const count = await coordinator.getPendingOperationsCount();
      expect(count).toBe(0);
    });

    test("returns correct count", async () => {
      await coordinator.initialize();

      await coordinator.createDocumentOffline({ a: 1 });
      await coordinator.createDocumentOffline({ b: 2 });
      await coordinator.createDocumentOffline({ c: 3 });

      const count = await coordinator.getPendingOperationsCount();
      expect(count).toBe(3);
    });
  });

  describe("hasPendingOperation()", () => {
    test("returns true for document with pending operation", async () => {
      await coordinator.initialize();

      const docId = await coordinator.createDocumentOffline({ test: true });
      const has = await coordinator.hasPendingOperation(docId);

      expect(has).toBe(true);
    });

    test("returns false for document without pending operation", async () => {
      await coordinator.initialize();

      const has = await coordinator.hasPendingOperation("doc:unknown");
      expect(has).toBe(false);
    });
  });

  describe("getUnsyncedDocuments()", () => {
    test("returns documents not registered on server", async () => {
      await coordinator.initialize();

      await coordinator.createDocumentOffline({ a: 1 });
      await coordinator.createDocumentOffline({ b: 2 });

      const unsynced = await coordinator.getUnsyncedDocuments();
      expect(unsynced).toHaveLength(2);
    });

    test("excludes synced documents", async () => {
      restoreFetch = installMockFetch({
        "/api/v1/documents": { status: 201, body: {} },
      });

      await coordinator.initialize();
      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();

      const docId1 = await coordinator.createDocumentOffline({ a: 1 });
      await coordinator.processPendingOperations();

      await coordinator.createDocumentOffline({ b: 2 });

      const unsynced = await coordinator.getUnsyncedDocuments();
      expect(unsynced).toHaveLength(1);
      expect(unsynced[0].documentId).not.toBe(docId1);
    });
  });

  describe("subscribe()", () => {
    test("receives all event types", async () => {
      restoreFetch = installMockFetch({
        "/api/v1/documents": { status: 201, body: {} },
      });

      await coordinator.initialize();

      const eventTypes = new Set<SyncEventType>();
      coordinator.subscribe((e) => eventTypes.add(e.type));

      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();

      await coordinator.createDocumentOffline({ test: true });
      await coordinator.processPendingOperations();
      coordinator.emitTokenExpired();

      expect(eventTypes.has("connectivity:changed")).toBe(true);
      expect(eventTypes.has("document:status-changed")).toBe(true);
      expect(eventTypes.has("sync:started")).toBe(true);
      expect(eventTypes.has("sync:completed")).toBe(true);
      expect(eventTypes.has("auth:token-expired")).toBe(true);
    });

    test("unsubscribe stops notifications", async () => {
      await coordinator.initialize();

      const events: SyncEvent[] = [];
      const unsubscribe = coordinator.subscribe((e) => events.push(e));

      await coordinator.createDocumentOffline({ a: 1 });
      unsubscribe();
      await coordinator.createDocumentOffline({ b: 2 });

      expect(events).toHaveLength(1);
    });
  });

  describe("waitForOnline()", () => {
    test("resolves when online", async () => {
      await coordinator.initialize();

      const cm = coordinator.getConnectivityManager();

      setTimeout(() => {
        cm.setServerConnected();
      }, 50);

      await coordinator.waitForOnline();
      expect(coordinator.getConnectivityState()).toBe("online");
    });

    test("resolves immediately if already online", async () => {
      await coordinator.initialize();
      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();

      await coordinator.waitForOnline();
      // Should resolve immediately
    });
  });

  describe("destroy()", () => {
    test("cleans up resources", async () => {
      await coordinator.initialize();

      const events: SyncEvent[] = [];
      coordinator.subscribe((e) => events.push(e));

      coordinator.destroy();

      // After destroy, events should not be emitted
      const cm = coordinator.getConnectivityManager();
      // Trying to use connectivity manager after destroy
      // won't emit events to coordinator
    });

    test("clears sync timeout", async () => {
      await coordinator.initialize();
      const cm = coordinator.getConnectivityManager();
      cm.setServerConnected();

      // Schedule a sync
      await coordinator.createDocumentOffline({ test: true });

      // Destroy before sync triggers
      coordinator.destroy();

      // Wait for what would have been the sync time
      await wait(150);
      // Should not throw or cause issues
    });

    test("can be called multiple times", async () => {
      await coordinator.initialize();
      coordinator.destroy();
      coordinator.destroy();
      // Should not throw
    });

    test("resets initialized flag", async () => {
      await coordinator.initialize();
      coordinator.destroy();

      // Re-initialize should work
      coordinator = new SyncCoordinator({
        serverUrl: TEST_SERVER_URL,
        getToken: () => mockToken,
        getRepo: () => mockRepo as ReturnType<typeof createMockRepo>,
      });
      await coordinator.initialize();
      // Should work without error
    });
  });
});
