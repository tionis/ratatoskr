/**
 * Tests for IndexedDBStorageAdapter.
 */

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IndexedDBStorageAdapter } from "../src/storage/indexeddb-storage-adapter.ts";
import { deleteDatabase } from "./helpers/test-utils.ts";

const TEST_DB_NAME = "test-storage";

describe("IndexedDBStorageAdapter", () => {
  let adapter: IndexedDBStorageAdapter;

  beforeEach(async () => {
    await deleteDatabase(TEST_DB_NAME);
    adapter = new IndexedDBStorageAdapter(TEST_DB_NAME);
  });

  afterEach(async () => {
    adapter.close();
    await deleteDatabase(TEST_DB_NAME);
  });

  describe("load()", () => {
    test("returns undefined for non-existent key", async () => {
      const result = await adapter.load(["doc", "nonexistent"]);
      expect(result).toBeUndefined();
    });

    test("returns data for existing key", async () => {
      const data = new Uint8Array([1, 2, 3, 4, 5]);
      await adapter.save(["doc", "test"], data);

      const result = await adapter.load(["doc", "test"]);
      expect(result).toEqual(data);
    });

    test("returns Uint8Array for loaded data", async () => {
      const data = new Uint8Array([10, 20, 30]);
      await adapter.save(["key"], data);

      const result = await adapter.load(["key"]);
      expect(result).toBeInstanceOf(Uint8Array);
    });

    test("handles empty key array", async () => {
      const data = new Uint8Array([1, 2, 3]);
      await adapter.save([], data);

      const result = await adapter.load([]);
      expect(result).toEqual(data);
    });

    test("handles single segment key", async () => {
      const data = new Uint8Array([5, 6, 7]);
      await adapter.save(["single"], data);

      const result = await adapter.load(["single"]);
      expect(result).toEqual(data);
    });

    test("handles multi-segment key", async () => {
      const data = new Uint8Array([8, 9, 10]);
      await adapter.save(["a", "b", "c", "d"], data);

      const result = await adapter.load(["a", "b", "c", "d"]);
      expect(result).toEqual(data);
    });
  });

  describe("save()", () => {
    test("saves new entry", async () => {
      const data = new Uint8Array([1, 2, 3]);
      await adapter.save(["new", "key"], data);

      const result = await adapter.load(["new", "key"]);
      expect(result).toEqual(data);
    });

    test("overwrites existing entry", async () => {
      const data1 = new Uint8Array([1, 2, 3]);
      const data2 = new Uint8Array([4, 5, 6]);

      await adapter.save(["key"], data1);
      await adapter.save(["key"], data2);

      const result = await adapter.load(["key"]);
      expect(result).toEqual(data2);
    });

    test("saves empty Uint8Array", async () => {
      const data = new Uint8Array([]);
      await adapter.save(["empty"], data);

      const result = await adapter.load(["empty"]);
      expect(result).toEqual(data);
    });

    test("saves large data", async () => {
      const data = new Uint8Array(10000);
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256;
      }

      await adapter.save(["large"], data);
      const result = await adapter.load(["large"]);
      expect(result).toEqual(data);
    });

    test("handles concurrent saves to different keys", async () => {
      const data1 = new Uint8Array([1]);
      const data2 = new Uint8Array([2]);
      const data3 = new Uint8Array([3]);

      await Promise.all([
        adapter.save(["key1"], data1),
        adapter.save(["key2"], data2),
        adapter.save(["key3"], data3),
      ]);

      expect(await adapter.load(["key1"])).toEqual(data1);
      expect(await adapter.load(["key2"])).toEqual(data2);
      expect(await adapter.load(["key3"])).toEqual(data3);
    });
  });

  describe("remove()", () => {
    test("removes existing key", async () => {
      const data = new Uint8Array([1, 2, 3]);
      await adapter.save(["key"], data);

      await adapter.remove(["key"]);
      const result = await adapter.load(["key"]);
      expect(result).toBeUndefined();
    });

    test("succeeds for non-existent key", async () => {
      // Should not throw
      await adapter.remove(["nonexistent"]);
    });

    test("only removes specified key", async () => {
      const data1 = new Uint8Array([1]);
      const data2 = new Uint8Array([2]);

      await adapter.save(["key1"], data1);
      await adapter.save(["key2"], data2);

      await adapter.remove(["key1"]);

      expect(await adapter.load(["key1"])).toBeUndefined();
      expect(await adapter.load(["key2"])).toEqual(data2);
    });
  });

  describe("loadRange()", () => {
    test("returns matching entries for prefix", async () => {
      await adapter.save(["doc", "1", "data"], new Uint8Array([1]));
      await adapter.save(["doc", "1", "meta"], new Uint8Array([2]));
      await adapter.save(["doc", "2", "data"], new Uint8Array([3]));

      const results = await adapter.loadRange(["doc", "1"]);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.key)).toContainEqual(["doc", "1", "data"]);
      expect(results.map((r) => r.key)).toContainEqual(["doc", "1", "meta"]);
    });

    test("returns empty array when no matches", async () => {
      await adapter.save(["other", "key"], new Uint8Array([1]));

      const results = await adapter.loadRange(["doc"]);
      expect(results).toHaveLength(0);
    });

    test("returns exact prefix match", async () => {
      await adapter.save(["doc"], new Uint8Array([1]));
      await adapter.save(["doc", "child"], new Uint8Array([2]));

      const results = await adapter.loadRange(["doc"]);
      expect(results).toHaveLength(2);
    });

    test("does not return partial prefix matches", async () => {
      await adapter.save(["document"], new Uint8Array([1]));
      await adapter.save(["doc", "child"], new Uint8Array([2]));

      const results = await adapter.loadRange(["doc"]);
      // Should not match "document" as it's not a child of "doc"
      expect(results).toHaveLength(1);
      expect(results[0].key).toEqual(["doc", "child"]);
    });

    test("returns data as Uint8Array", async () => {
      await adapter.save(["prefix", "key"], new Uint8Array([1, 2, 3]));

      const results = await adapter.loadRange(["prefix"]);
      expect(results[0].data).toBeInstanceOf(Uint8Array);
      expect(results[0].data).toEqual(new Uint8Array([1, 2, 3]));
    });

    test("handles empty prefix", async () => {
      await adapter.save([], new Uint8Array([1]));
      await adapter.save(["", "child"], new Uint8Array([2]));

      // Empty prefix matches keys that are exactly empty or have empty as first segment
      const results = await adapter.loadRange([]);
      expect(results.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("removeRange()", () => {
    test("removes all matching entries", async () => {
      await adapter.save(["doc", "1", "data"], new Uint8Array([1]));
      await adapter.save(["doc", "1", "meta"], new Uint8Array([2]));
      await adapter.save(["doc", "2", "data"], new Uint8Array([3]));

      await adapter.removeRange(["doc", "1"]);

      expect(await adapter.load(["doc", "1", "data"])).toBeUndefined();
      expect(await adapter.load(["doc", "1", "meta"])).toBeUndefined();
      expect(await adapter.load(["doc", "2", "data"])).toEqual(
        new Uint8Array([3]),
      );
    });

    test("preserves non-matching entries", async () => {
      await adapter.save(["keep", "this"], new Uint8Array([1]));
      await adapter.save(["remove", "this"], new Uint8Array([2]));

      await adapter.removeRange(["remove"]);

      expect(await adapter.load(["keep", "this"])).toEqual(new Uint8Array([1]));
      expect(await adapter.load(["remove", "this"])).toBeUndefined();
    });

    test("succeeds when no matches", async () => {
      await adapter.save(["other"], new Uint8Array([1]));

      // Should not throw
      await adapter.removeRange(["nonexistent"]);

      expect(await adapter.load(["other"])).toEqual(new Uint8Array([1]));
    });

    test("removes exact prefix match", async () => {
      await adapter.save(["prefix"], new Uint8Array([1]));
      await adapter.save(["prefix", "child"], new Uint8Array([2]));

      await adapter.removeRange(["prefix"]);

      expect(await adapter.load(["prefix"])).toBeUndefined();
      expect(await adapter.load(["prefix", "child"])).toBeUndefined();
    });
  });

  describe("close()", () => {
    test("closes database connection", () => {
      adapter.close();
      // After close, adapter should still work by reopening
      // This is implementation-dependent behavior
    });

    test("can be called multiple times", () => {
      adapter.close();
      adapter.close();
      // Should not throw
    });

    test("adapter works after reopening", async () => {
      const data = new Uint8Array([1, 2, 3]);
      await adapter.save(["key"], data);

      adapter.close();

      // Create new adapter and verify data persists
      const newAdapter = new IndexedDBStorageAdapter(TEST_DB_NAME);
      const result = await newAdapter.load(["key"]);
      expect(result).toEqual(data);
      newAdapter.close();
    });
  });

  describe("database initialization", () => {
    test("creates database on first access", async () => {
      const freshAdapter = new IndexedDBStorageAdapter("fresh-db");
      await freshAdapter.save(["test"], new Uint8Array([1]));

      const result = await freshAdapter.load(["test"]);
      expect(result).toEqual(new Uint8Array([1]));
      freshAdapter.close();
      await deleteDatabase("fresh-db");
    });

    test("reuses existing database connection", async () => {
      // First operation opens the database
      await adapter.save(["key1"], new Uint8Array([1]));
      // Second operation should reuse the connection
      await adapter.save(["key2"], new Uint8Array([2]));

      expect(await adapter.load(["key1"])).toEqual(new Uint8Array([1]));
      expect(await adapter.load(["key2"])).toEqual(new Uint8Array([2]));
    });

    test("handles concurrent initialization", async () => {
      const freshAdapter = new IndexedDBStorageAdapter("concurrent-db");

      // Multiple operations before DB is fully opened
      const [r1, r2, r3] = await Promise.all([
        freshAdapter.load(["key1"]),
        freshAdapter.save(["key2"], new Uint8Array([2])),
        freshAdapter.load(["key3"]),
      ]);

      expect(r1).toBeUndefined();
      expect(r3).toBeUndefined();
      expect(await freshAdapter.load(["key2"])).toEqual(new Uint8Array([2]));

      freshAdapter.close();
      await deleteDatabase("concurrent-db");
    });
  });
});
