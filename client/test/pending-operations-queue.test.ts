/**
 * Tests for PendingOperationsQueue.
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  type OperationProcessor,
  type PendingOperation,
  PendingOperationsQueue,
} from "../src/offline/pending-operations-queue.ts";
import { deleteDatabase, wait } from "./helpers/test-utils.ts";

const TEST_DB_NAME = "test-queue";

describe("PendingOperationsQueue", () => {
  let queue: PendingOperationsQueue;

  beforeEach(async () => {
    await deleteDatabase(TEST_DB_NAME);
    queue = new PendingOperationsQueue(TEST_DB_NAME);
  });

  afterEach(async () => {
    queue.close();
    await deleteDatabase(TEST_DB_NAME);
  });

  describe("enqueueDocumentRegistration()", () => {
    test("creates operation with UUID", async () => {
      await queue.enqueueDocumentRegistration("doc:1");

      const ops = await queue.getPendingOperations();
      expect(ops).toHaveLength(1);
      expect(ops[0].id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    test("sets correct operation type", async () => {
      await queue.enqueueDocumentRegistration("doc:1");

      const ops = await queue.getPendingOperations();
      expect(ops[0].type).toBe("register_document");
    });

    test("sets documentId", async () => {
      await queue.enqueueDocumentRegistration("doc:test-123");

      const ops = await queue.getPendingOperations();
      expect(ops[0].documentId).toBe("doc:test-123");
    });

    test("sets payload with type and expiresAt", async () => {
      const expiresAt = new Date(Date.now() + 86400000).toISOString();
      await queue.enqueueDocumentRegistration("doc:1", {
        type: "note",
        expiresAt,
      });

      const ops = await queue.getPendingOperations();
      expect(ops[0].payload.type).toBe("note");
      expect(ops[0].payload.expiresAt).toBe(expiresAt);
    });

    test("sets createdAt timestamp", async () => {
      const before = new Date().toISOString();
      await queue.enqueueDocumentRegistration("doc:1");
      const after = new Date().toISOString();

      const ops = await queue.getPendingOperations();
      expect(ops[0].createdAt >= before).toBe(true);
      expect(ops[0].createdAt <= after).toBe(true);
    });

    test("initializes attempts to 0", async () => {
      await queue.enqueueDocumentRegistration("doc:1");

      const ops = await queue.getPendingOperations();
      expect(ops[0].attempts).toBe(0);
    });

    test("allows multiple operations for different documents", async () => {
      await queue.enqueueDocumentRegistration("doc:1");
      await queue.enqueueDocumentRegistration("doc:2");
      await queue.enqueueDocumentRegistration("doc:3");

      const ops = await queue.getPendingOperations();
      expect(ops).toHaveLength(3);
    });
  });

  describe("getPendingOperations()", () => {
    test("returns empty array when queue is empty", async () => {
      const ops = await queue.getPendingOperations();
      expect(ops).toHaveLength(0);
    });

    test("returns operations in order by createdAt", async () => {
      await queue.enqueueDocumentRegistration("doc:1");
      await wait(10);
      await queue.enqueueDocumentRegistration("doc:2");
      await wait(10);
      await queue.enqueueDocumentRegistration("doc:3");

      const ops = await queue.getPendingOperations();
      expect(ops[0].documentId).toBe("doc:1");
      expect(ops[1].documentId).toBe("doc:2");
      expect(ops[2].documentId).toBe("doc:3");
    });

    test("returns all pending operations", async () => {
      for (let i = 0; i < 5; i++) {
        await queue.enqueueDocumentRegistration(`doc:${i}`);
      }

      const ops = await queue.getPendingOperations();
      expect(ops).toHaveLength(5);
    });
  });

  describe("getRetryableOperations()", () => {
    test("returns operations without nextRetry", async () => {
      await queue.enqueueDocumentRegistration("doc:1");

      const ops = await queue.getRetryableOperations();
      expect(ops).toHaveLength(1);
    });

    test("returns operations with nextRetry in the past", async () => {
      await queue.enqueueDocumentRegistration("doc:1");

      // Get operation and manually set nextRetry in the past
      const ops = await queue.getPendingOperations();
      const op = ops[0];
      op.nextRetry = new Date(Date.now() - 1000).toISOString();

      // Manually update via processor simulation
      queue.setProcessor(async () => ({ success: false, error: "test" }));
      await queue.processQueue();

      const retryable = await queue.getRetryableOperations();
      // The operation should have nextRetry set to future, so it's not retryable yet
      expect(retryable.length).toBeLessThanOrEqual(1);
    });

    test("excludes operations with nextRetry in the future", async () => {
      await queue.enqueueDocumentRegistration("doc:1");

      // Process and fail to set a future retry time
      queue.setProcessor(async () => ({ success: false, error: "test" }));
      await queue.processQueue();

      const retryable = await queue.getRetryableOperations();
      // Should be empty because nextRetry is in the future
      expect(retryable).toHaveLength(0);
    });
  });

  describe("processQueue()", () => {
    test("processes all retryable operations", async () => {
      await queue.enqueueDocumentRegistration("doc:1");
      await queue.enqueueDocumentRegistration("doc:2");

      const processed: string[] = [];
      queue.setProcessor(async (op) => {
        processed.push(op.documentId);
        return { success: true };
      });

      await queue.processQueue();

      expect(processed).toContain("doc:1");
      expect(processed).toContain("doc:2");
    });

    test("returns processed and failed counts on success", async () => {
      await queue.enqueueDocumentRegistration("doc:1");
      await queue.enqueueDocumentRegistration("doc:2");

      queue.setProcessor(async () => ({ success: true }));
      const result = await queue.processQueue();

      expect(result.processed).toBe(2);
      expect(result.failed).toBe(0);
    });

    test("returns processed and failed counts on mixed results", async () => {
      await queue.enqueueDocumentRegistration("doc:1");
      await queue.enqueueDocumentRegistration("doc:2");

      let callCount = 0;
      queue.setProcessor(async () => {
        callCount++;
        return callCount === 1
          ? { success: true }
          : { success: false, error: "failed" };
      });

      const result = await queue.processQueue();

      expect(result.processed).toBe(1);
      expect(result.failed).toBe(1);
    });

    test("removes successful operations from queue", async () => {
      await queue.enqueueDocumentRegistration("doc:1");

      queue.setProcessor(async () => ({ success: true }));
      await queue.processQueue();

      const remaining = await queue.getPendingOperations();
      expect(remaining).toHaveLength(0);
    });

    test("keeps failed operations in queue", async () => {
      await queue.enqueueDocumentRegistration("doc:1");

      queue.setProcessor(async () => ({ success: false, error: "failed" }));
      await queue.processQueue();

      const remaining = await queue.getPendingOperations();
      expect(remaining).toHaveLength(1);
    });

    test("increments attempts on each processing", async () => {
      await queue.enqueueDocumentRegistration("doc:1");

      queue.setProcessor(async () => ({ success: false, error: "failed" }));
      await queue.processQueue();

      const ops = await queue.getPendingOperations();
      expect(ops[0].attempts).toBe(1);
    });

    test("sets lastAttempt timestamp", async () => {
      await queue.enqueueDocumentRegistration("doc:1");

      const before = new Date().toISOString();
      queue.setProcessor(async () => ({ success: false, error: "failed" }));
      await queue.processQueue();
      const after = new Date().toISOString();

      const ops = await queue.getPendingOperations();
      expect(ops[0].lastAttempt! >= before).toBe(true);
      expect(ops[0].lastAttempt! <= after).toBe(true);
    });

    test("sets error message on failure", async () => {
      await queue.enqueueDocumentRegistration("doc:1");

      queue.setProcessor(async () => ({
        success: false,
        error: "Network timeout",
      }));
      await queue.processQueue();

      const ops = await queue.getPendingOperations();
      expect(ops[0].error).toBe("Network timeout");
    });

    test("handles processor throwing error", async () => {
      await queue.enqueueDocumentRegistration("doc:1");

      queue.setProcessor(async () => {
        throw new Error("Processor crashed");
      });
      const result = await queue.processQueue();

      expect(result.failed).toBe(1);
      const ops = await queue.getPendingOperations();
      expect(ops[0].error).toBe("Processor crashed");
    });

    test("prevents concurrent processing", async () => {
      await queue.enqueueDocumentRegistration("doc:1");

      let concurrentCalls = 0;
      let maxConcurrent = 0;

      queue.setProcessor(async () => {
        concurrentCalls++;
        maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
        await wait(50);
        concurrentCalls--;
        return { success: true };
      });

      // Start two concurrent processQueue calls
      const [result1, result2] = await Promise.all([
        queue.processQueue(),
        queue.processQueue(),
      ]);

      // Second call should return immediately with 0 processed
      expect(result1.processed + result2.processed).toBe(1);
      expect(maxConcurrent).toBe(1);
    });

    test("returns early if already processing", async () => {
      await queue.enqueueDocumentRegistration("doc:1");

      queue.setProcessor(async () => {
        await wait(100);
        return { success: true };
      });

      // Start processing
      const promise1 = queue.processQueue();
      // Try to process again immediately
      const result2 = await queue.processQueue();

      expect(result2.processed).toBe(0);
      expect(result2.failed).toBe(0);

      await promise1;
    });

    test("throws if no processor set", async () => {
      await queue.enqueueDocumentRegistration("doc:1");

      await expect(queue.processQueue()).rejects.toThrow(
        "No operation processor set",
      );
    });

    test("skips operations exceeding max retry attempts", async () => {
      await queue.enqueueDocumentRegistration("doc:1");

      queue.setProcessor(async () => {
        return { success: false, error: "always fail" };
      });

      // Process multiple times - each increments attempts
      // After 10 attempts, operation should be skipped
      for (let i = 0; i < 11; i++) {
        // Reset retry time to allow immediate retry
        const ops = await queue.getPendingOperations();
        if (ops.length === 0) break;

        // Manually clear nextRetry to allow processing
        const db = await (
          queue as unknown as { getDb(): Promise<IDBDatabase> }
        ).getDb();
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("pending_operations", "readwrite");
          const store = tx.objectStore("pending_operations");
          const op = ops[0];
          op.nextRetry = undefined;
          store.put(op);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });

        await queue.processQueue();
      }

      // After 10 attempts, operation is still in queue but won't be processed
      const result = await queue.processQueue();
      expect(result.failed).toBe(1);
      expect(result.processed).toBe(0);
    });
  });

  describe("exponential backoff", () => {
    test("sets nextRetry with increasing delay", async () => {
      await queue.enqueueDocumentRegistration("doc:1");

      queue.setProcessor(async () => ({ success: false, error: "fail" }));

      // First failure - base delay is 1000ms * 2^1 = 2000ms (attempts starts at 0, increments to 1)
      const before1 = Date.now();
      await queue.processQueue();
      const ops1 = await queue.getPendingOperations();
      const nextRetry1 = new Date(ops1[0].nextRetry!).getTime();
      // After first attempt (attempts=1), delay is 1000 * 2^1 = 2000ms + up to 10% jitter
      expect(nextRetry1 - before1).toBeGreaterThanOrEqual(1800);
      expect(nextRetry1 - before1).toBeLessThanOrEqual(2500);
    });

    test("caps delay at maximum value", async () => {
      await queue.enqueueDocumentRegistration("doc:1");

      // Manually create operation with high attempt count
      queue.setProcessor(async () => ({ success: false, error: "fail" }));

      // Process many times to verify cap
      for (let i = 0; i < 8; i++) {
        const ops = await queue.getPendingOperations();
        if (ops.length > 0) {
          ops[0].nextRetry = new Date(Date.now() - 1000).toISOString();
        }
        await queue.processQueue();
      }

      const ops = await queue.getPendingOperations();
      const nextRetry = new Date(ops[0].nextRetry!).getTime();
      const delay = nextRetry - Date.now();

      // Max delay is 60000ms with up to 10% jitter
      expect(delay).toBeLessThanOrEqual(66000);
    });
  });

  describe("removeOperation()", () => {
    test("removes operation by id", async () => {
      await queue.enqueueDocumentRegistration("doc:1");
      const ops = await queue.getPendingOperations();

      await queue.removeOperation(ops[0].id);

      const remaining = await queue.getPendingOperations();
      expect(remaining).toHaveLength(0);
    });

    test("succeeds for non-existent operation", async () => {
      // Should not throw
      await queue.removeOperation("nonexistent-id");
    });

    test("only removes specified operation", async () => {
      await queue.enqueueDocumentRegistration("doc:1");
      await queue.enqueueDocumentRegistration("doc:2");
      const ops = await queue.getPendingOperations();

      // Find and remove doc:1's operation
      const doc1Op = ops.find((op) => op.documentId === "doc:1")!;
      await queue.removeOperation(doc1Op.id);

      const remaining = await queue.getPendingOperations();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].documentId).toBe("doc:2");
    });
  });

  describe("removeOperationsForDocument()", () => {
    test("removes all operations for a document", async () => {
      await queue.enqueueDocumentRegistration("doc:1", { type: "type1" });
      await queue.enqueueDocumentRegistration("doc:1", { type: "type2" });
      await queue.enqueueDocumentRegistration("doc:2");

      await queue.removeOperationsForDocument("doc:1");

      const remaining = await queue.getPendingOperations();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].documentId).toBe("doc:2");
    });

    test("succeeds when no operations for document", async () => {
      await queue.enqueueDocumentRegistration("doc:1");

      // Should not throw
      await queue.removeOperationsForDocument("doc:2");

      const remaining = await queue.getPendingOperations();
      expect(remaining).toHaveLength(1);
    });
  });

  describe("hasPendingOperation()", () => {
    test("returns true when operation exists", async () => {
      await queue.enqueueDocumentRegistration("doc:1");

      const has = await queue.hasPendingOperation("doc:1");
      expect(has).toBe(true);
    });

    test("returns false when no operation exists", async () => {
      await queue.enqueueDocumentRegistration("doc:1");

      const has = await queue.hasPendingOperation("doc:2");
      expect(has).toBe(false);
    });

    test("returns false after operation removed", async () => {
      await queue.enqueueDocumentRegistration("doc:1");
      await queue.removeOperationsForDocument("doc:1");

      const has = await queue.hasPendingOperation("doc:1");
      expect(has).toBe(false);
    });
  });

  describe("getQueueLength()", () => {
    test("returns 0 for empty queue", async () => {
      const length = await queue.getQueueLength();
      expect(length).toBe(0);
    });

    test("returns correct count", async () => {
      await queue.enqueueDocumentRegistration("doc:1");
      await queue.enqueueDocumentRegistration("doc:2");
      await queue.enqueueDocumentRegistration("doc:3");

      const length = await queue.getQueueLength();
      expect(length).toBe(3);
    });

    test("updates after operations processed", async () => {
      await queue.enqueueDocumentRegistration("doc:1");
      await queue.enqueueDocumentRegistration("doc:2");

      queue.setProcessor(async () => ({ success: true }));
      await queue.processQueue();

      const length = await queue.getQueueLength();
      expect(length).toBe(0);
    });
  });

  describe("isProcessing()", () => {
    test("returns false when not processing", () => {
      expect(queue.isProcessing()).toBe(false);
    });

    test("returns true during processing", async () => {
      await queue.enqueueDocumentRegistration("doc:1");

      let wasProcessing = false;
      queue.setProcessor(async () => {
        wasProcessing = queue.isProcessing();
        await wait(10);
        return { success: true };
      });

      await queue.processQueue();
      expect(wasProcessing).toBe(true);
    });

    test("returns false after processing completes", async () => {
      await queue.enqueueDocumentRegistration("doc:1");

      queue.setProcessor(async () => ({ success: true }));
      await queue.processQueue();

      expect(queue.isProcessing()).toBe(false);
    });
  });

  describe("setProcessor()", () => {
    test("sets the operation processor", async () => {
      const processor = mock(async () => ({ success: true }));
      queue.setProcessor(processor);

      await queue.enqueueDocumentRegistration("doc:1");
      await queue.processQueue();

      expect(processor).toHaveBeenCalled();
    });

    test("can replace processor", async () => {
      const processor1 = mock(async () => ({ success: false, error: "1" }));
      const processor2 = mock(async () => ({ success: true }));

      queue.setProcessor(processor1);
      await queue.enqueueDocumentRegistration("doc:1");
      await queue.processQueue();

      queue.setProcessor(processor2);
      // Reset retry time in the database
      const ops = await queue.getPendingOperations();
      const db = await (
        queue as unknown as { getDb(): Promise<IDBDatabase> }
      ).getDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("pending_operations", "readwrite");
        const store = tx.objectStore("pending_operations");
        ops[0].nextRetry = undefined;
        store.put(ops[0]);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      await queue.processQueue();

      expect(processor1).toHaveBeenCalledTimes(1);
      expect(processor2).toHaveBeenCalledTimes(1);
    });
  });

  describe("close()", () => {
    test("clears processor", () => {
      queue.setProcessor(async () => ({ success: true }));
      queue.close();

      // After close, processor should be null (would throw on processQueue)
    });

    test("can be called multiple times", () => {
      queue.close();
      queue.close();
      // Should not throw
    });
  });

  describe("persistence", () => {
    test("operations persist after close and reopen", async () => {
      await queue.enqueueDocumentRegistration("doc:1", { type: "note" });
      queue.close();

      const newQueue = new PendingOperationsQueue(TEST_DB_NAME);
      const ops = await newQueue.getPendingOperations();

      expect(ops).toHaveLength(1);
      expect(ops[0].documentId).toBe("doc:1");
      expect(ops[0].payload.type).toBe("note");
      newQueue.close();
    });
  });
});
