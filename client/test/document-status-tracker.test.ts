/**
 * Tests for DocumentStatusTracker.
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  type DocumentStatusEntry,
  type DocumentStatusListener,
  DocumentStatusTracker,
} from "../src/offline/document-status-tracker.ts";
import { deleteDatabase } from "./helpers/test-utils.ts";

const TEST_DB_NAME = "test-status-tracker";

describe("DocumentStatusTracker", () => {
  let tracker: DocumentStatusTracker;

  beforeEach(async () => {
    await deleteDatabase(TEST_DB_NAME);
    tracker = new DocumentStatusTracker(TEST_DB_NAME);
  });

  afterEach(async () => {
    tracker.close();
    await deleteDatabase(TEST_DB_NAME);
  });

  describe("setStatus()", () => {
    test("creates new status entry", async () => {
      await tracker.setStatus("doc:1", "local");

      const status = await tracker.getStatus("doc:1");
      expect(status).toBeDefined();
      expect(status!.documentId).toBe("doc:1");
      expect(status!.status).toBe("local");
      expect(status!.serverRegistered).toBe(false);
      expect(status!.createdAt).toBeDefined();
    });

    test("updates existing status", async () => {
      await tracker.setStatus("doc:1", "local");
      await tracker.setStatus("doc:1", "syncing");

      const status = await tracker.getStatus("doc:1");
      expect(status!.status).toBe("syncing");
    });

    test("preserves createdAt on update", async () => {
      await tracker.setStatus("doc:1", "local");
      const first = await tracker.getStatus("doc:1");

      await tracker.setStatus("doc:1", "syncing");
      const second = await tracker.getStatus("doc:1");

      expect(second!.createdAt).toBe(first!.createdAt);
    });

    test("preserves serverRegistered on update without override", async () => {
      await tracker.setStatus("doc:1", "local", { serverRegistered: true });
      await tracker.setStatus("doc:1", "syncing");

      const status = await tracker.getStatus("doc:1");
      expect(status!.serverRegistered).toBe(true);
    });

    test("allows overriding serverRegistered", async () => {
      await tracker.setStatus("doc:1", "local", { serverRegistered: true });
      await tracker.setStatus("doc:1", "local", { serverRegistered: false });

      const status = await tracker.getStatus("doc:1");
      expect(status!.serverRegistered).toBe(false);
    });

    test("sets lastSyncAttempt", async () => {
      const timestamp = new Date().toISOString();
      await tracker.setStatus("doc:1", "syncing", {
        lastSyncAttempt: timestamp,
      });

      const status = await tracker.getStatus("doc:1");
      expect(status!.lastSyncAttempt).toBe(timestamp);
    });

    test("sets error message", async () => {
      await tracker.setStatus("doc:1", "local", { error: "Network error" });

      const status = await tracker.getStatus("doc:1");
      expect(status!.error).toBe("Network error");
    });

    test("clears error on new status without error", async () => {
      await tracker.setStatus("doc:1", "local", { error: "Old error" });
      await tracker.setStatus("doc:1", "syncing");

      const status = await tracker.getStatus("doc:1");
      expect(status!.error).toBeUndefined();
    });

    test("notifies listeners on status change", async () => {
      const listener = mock(() => {});
      tracker.subscribe(listener);

      await tracker.setStatus("doc:1", "local");

      expect(listener).toHaveBeenCalledTimes(1);
      const [docId, entry] = listener.mock.calls[0];
      expect(docId).toBe("doc:1");
      expect(entry.status).toBe("local");
    });
  });

  describe("getStatus()", () => {
    test("returns undefined for non-existent document", async () => {
      const status = await tracker.getStatus("nonexistent");
      expect(status).toBeUndefined();
    });

    test("returns cached value on second call", async () => {
      await tracker.setStatus("doc:1", "local");

      // First call populates cache
      const first = await tracker.getStatus("doc:1");
      // Second call should return cached value
      const second = await tracker.getStatus("doc:1");

      expect(first).toEqual(second);
    });

    test("reads from database when not cached", async () => {
      await tracker.setStatus("doc:1", "local");

      // Clear cache
      tracker.clearCache();

      // Should read from database
      const status = await tracker.getStatus("doc:1");
      expect(status!.documentId).toBe("doc:1");
    });
  });

  describe("markServerRegistered()", () => {
    test("sets status to synced and serverRegistered to true", async () => {
      await tracker.setStatus("doc:1", "local");
      await tracker.markServerRegistered("doc:1");

      const status = await tracker.getStatus("doc:1");
      expect(status!.status).toBe("synced");
      expect(status!.serverRegistered).toBe(true);
    });

    test("creates new entry if document does not exist", async () => {
      await tracker.markServerRegistered("doc:new");

      const status = await tracker.getStatus("doc:new");
      expect(status!.status).toBe("synced");
      expect(status!.serverRegistered).toBe(true);
    });
  });

  describe("getByStatus()", () => {
    test("returns documents with matching status", async () => {
      await tracker.setStatus("doc:1", "local");
      await tracker.setStatus("doc:2", "syncing");
      await tracker.setStatus("doc:3", "local");
      await tracker.setStatus("doc:4", "synced");

      const local = await tracker.getByStatus("local");
      expect(local).toHaveLength(2);
      expect(local.map((d) => d.documentId)).toContain("doc:1");
      expect(local.map((d) => d.documentId)).toContain("doc:3");
    });

    test("returns empty array when no matches", async () => {
      await tracker.setStatus("doc:1", "local");

      const syncing = await tracker.getByStatus("syncing");
      expect(syncing).toHaveLength(0);
    });

    test("updates cache for returned entries", async () => {
      await tracker.setStatus("doc:1", "local");
      tracker.clearCache();

      await tracker.getByStatus("local");

      // Should now be cached
      const status = await tracker.getStatus("doc:1");
      expect(status).toBeDefined();
    });
  });

  describe("getUnregistered()", () => {
    test("returns documents not registered on server", async () => {
      await tracker.setStatus("doc:1", "local", { serverRegistered: false });
      await tracker.setStatus("doc:2", "synced", { serverRegistered: true });
      await tracker.setStatus("doc:3", "syncing", { serverRegistered: false });

      const unregistered = await tracker.getUnregistered();
      expect(unregistered).toHaveLength(2);
      expect(unregistered.map((d) => d.documentId)).toContain("doc:1");
      expect(unregistered.map((d) => d.documentId)).toContain("doc:3");
    });

    test("returns empty array when all registered", async () => {
      await tracker.setStatus("doc:1", "synced", { serverRegistered: true });

      const unregistered = await tracker.getUnregistered();
      expect(unregistered).toHaveLength(0);
    });

    test("updates cache for returned entries", async () => {
      await tracker.setStatus("doc:1", "local", { serverRegistered: false });
      tracker.clearCache();

      await tracker.getUnregistered();

      // Should now be cached
      const status = await tracker.getStatus("doc:1");
      expect(status).toBeDefined();
    });
  });

  describe("subscribe() / unsubscribe", () => {
    test("listener receives status updates", async () => {
      const events: Array<[string, DocumentStatusEntry]> = [];
      tracker.subscribe((docId, entry) => {
        events.push([docId, entry]);
      });

      await tracker.setStatus("doc:1", "local");
      await tracker.setStatus("doc:1", "syncing");
      await tracker.setStatus("doc:2", "local");

      expect(events).toHaveLength(3);
      expect(events[0][0]).toBe("doc:1");
      expect(events[0][1].status).toBe("local");
      expect(events[1][1].status).toBe("syncing");
      expect(events[2][0]).toBe("doc:2");
    });

    test("unsubscribe stops notifications", async () => {
      const events: string[] = [];
      const unsubscribe = tracker.subscribe((docId) => {
        events.push(docId);
      });

      await tracker.setStatus("doc:1", "local");
      unsubscribe();
      await tracker.setStatus("doc:2", "local");

      expect(events).toHaveLength(1);
      expect(events[0]).toBe("doc:1");
    });

    test("multiple listeners all receive updates", async () => {
      const events1: string[] = [];
      const events2: string[] = [];

      tracker.subscribe((docId) => events1.push(docId));
      tracker.subscribe((docId) => events2.push(docId));

      await tracker.setStatus("doc:1", "local");

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
    });

    test("listener errors do not affect other listeners", async () => {
      const events: string[] = [];
      const originalError = console.error;
      console.error = () => {}; // Suppress expected error output

      try {
        tracker.subscribe(() => {
          throw new Error("Listener error");
        });
        tracker.subscribe((docId) => events.push(docId));

        await tracker.setStatus("doc:1", "local");

        expect(events).toHaveLength(1);
      } finally {
        console.error = originalError;
      }
    });
  });

  describe("clearCache()", () => {
    test("forces database read on next getStatus", async () => {
      await tracker.setStatus("doc:1", "local");

      // Modify directly in DB (simulate external change)
      // For this test, we just verify cache is cleared
      tracker.clearCache();

      // This should read from DB
      const status = await tracker.getStatus("doc:1");
      expect(status).toBeDefined();
    });
  });

  describe("removeStatus()", () => {
    test("removes document status", async () => {
      await tracker.setStatus("doc:1", "local");
      await tracker.removeStatus("doc:1");

      const status = await tracker.getStatus("doc:1");
      expect(status).toBeUndefined();
    });

    test("removes from cache", async () => {
      await tracker.setStatus("doc:1", "local");
      await tracker.removeStatus("doc:1");

      // Even without DB access, should return undefined due to cache removal
      const status = await tracker.getStatus("doc:1");
      expect(status).toBeUndefined();
    });

    test("succeeds for non-existent document", async () => {
      // Should not throw
      await tracker.removeStatus("nonexistent");
    });

    test("does not affect other documents", async () => {
      await tracker.setStatus("doc:1", "local");
      await tracker.setStatus("doc:2", "syncing");

      await tracker.removeStatus("doc:1");

      expect(await tracker.getStatus("doc:1")).toBeUndefined();
      expect(await tracker.getStatus("doc:2")).toBeDefined();
    });
  });

  describe("close()", () => {
    test("clears cache and listeners", () => {
      const events: string[] = [];
      tracker.subscribe((docId) => events.push(docId));

      tracker.close();

      // After close, listeners should be cleared
      // (cannot verify directly, but close should not throw)
    });

    test("can be called multiple times", () => {
      tracker.close();
      tracker.close();
      // Should not throw
    });
  });

  describe("persistence", () => {
    test("data persists after close and reopen", async () => {
      await tracker.setStatus("doc:1", "local", { serverRegistered: false });
      tracker.close();

      const newTracker = new DocumentStatusTracker(TEST_DB_NAME);
      const status = await newTracker.getStatus("doc:1");

      expect(status).toBeDefined();
      expect(status!.status).toBe("local");
      newTracker.close();
    });
  });
});
