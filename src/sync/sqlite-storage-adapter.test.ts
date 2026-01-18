import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { SqliteStorageAdapter } from "./sqlite-storage-adapter.ts";

const TEST_DATA_DIR = join(import.meta.dir, "../../.test-data");

describe("SqliteStorageAdapter", () => {
  let adapter: SqliteStorageAdapter;

  beforeEach(() => {
    // Clean up any existing test data
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
    adapter = new SqliteStorageAdapter(TEST_DATA_DIR);
  });

  afterEach(() => {
    adapter.close();
    rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  });

  describe("save and load", () => {
    test("should save and load a single chunk", async () => {
      const key = ["doc:123", "snapshot", "abc"];
      const data = new Uint8Array([1, 2, 3, 4, 5]);

      await adapter.save(key, data);
      const loaded = await adapter.load(key);

      expect(loaded).toEqual(data);
    });

    test("should return undefined for non-existent key", async () => {
      const loaded = await adapter.load(["doc:123", "snapshot", "nonexistent"]);
      expect(loaded).toBeUndefined();
    });

    test("should overwrite existing data on save", async () => {
      const key = ["doc:123", "snapshot", "abc"];
      const data1 = new Uint8Array([1, 2, 3]);
      const data2 = new Uint8Array([4, 5, 6, 7]);

      await adapter.save(key, data1);
      await adapter.save(key, data2);
      const loaded = await adapter.load(key);

      expect(loaded).toEqual(data2);
    });

    test("should handle empty data", async () => {
      const key = ["doc:123", "snapshot", "empty"];
      const data = new Uint8Array([]);

      await adapter.save(key, data);
      const loaded = await adapter.load(key);

      expect(loaded).toEqual(data);
    });

    test("should handle large data", async () => {
      const key = ["doc:123", "snapshot", "large"];
      const data = new Uint8Array(1024 * 1024); // 1 MB
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256;
      }

      await adapter.save(key, data);
      const loaded = await adapter.load(key);

      expect(loaded).toEqual(data);
    });
  });

  describe("remove", () => {
    test("should remove an existing chunk", async () => {
      const key = ["doc:123", "snapshot", "abc"];
      const data = new Uint8Array([1, 2, 3]);

      await adapter.save(key, data);
      await adapter.remove(key);
      const loaded = await adapter.load(key);

      expect(loaded).toBeUndefined();
    });

    test("should not throw when removing non-existent key", async () => {
      await expect(
        adapter.remove(["doc:123", "snapshot", "nonexistent"]),
      ).resolves.toBeUndefined();
    });
  });

  describe("loadRange", () => {
    test("should load all chunks with matching prefix", async () => {
      await adapter.save(["doc:123", "snapshot", "a"], new Uint8Array([1]));
      await adapter.save(["doc:123", "snapshot", "b"], new Uint8Array([2]));
      await adapter.save(["doc:123", "incremental", "c"], new Uint8Array([3]));
      await adapter.save(["doc:456", "snapshot", "d"], new Uint8Array([4]));

      const chunks = await adapter.loadRange(["doc:123", "snapshot"]);

      expect(chunks.length).toBe(2);
      expect(chunks.map((c) => c.key)).toContainEqual([
        "doc:123",
        "snapshot",
        "a",
      ]);
      expect(chunks.map((c) => c.key)).toContainEqual([
        "doc:123",
        "snapshot",
        "b",
      ]);
    });

    test("should load all chunks for a document", async () => {
      await adapter.save(["doc:123", "snapshot", "a"], new Uint8Array([1]));
      await adapter.save(["doc:123", "incremental", "b"], new Uint8Array([2]));
      await adapter.save(["doc:456", "snapshot", "c"], new Uint8Array([3]));

      const chunks = await adapter.loadRange(["doc:123"]);

      expect(chunks.length).toBe(2);
      expect(chunks.map((c) => c.key)).toContainEqual([
        "doc:123",
        "snapshot",
        "a",
      ]);
      expect(chunks.map((c) => c.key)).toContainEqual([
        "doc:123",
        "incremental",
        "b",
      ]);
    });

    test("should return empty array for non-matching prefix", async () => {
      await adapter.save(["doc:123", "snapshot", "a"], new Uint8Array([1]));

      const chunks = await adapter.loadRange(["doc:999"]);

      expect(chunks).toEqual([]);
    });

    test("should return empty array for empty prefix", async () => {
      await adapter.save(["doc:123", "snapshot", "a"], new Uint8Array([1]));

      const chunks = await adapter.loadRange([]);

      expect(chunks).toEqual([]);
    });

    test("should match exact key when prefix equals full key", async () => {
      await adapter.save(["doc:123", "snapshot", "a"], new Uint8Array([1]));
      await adapter.save(["doc:123", "snapshot", "ab"], new Uint8Array([2]));

      const chunks = await adapter.loadRange(["doc:123", "snapshot", "a"]);

      // Should only match exact key, not "ab"
      expect(chunks.length).toBe(1);
      expect(chunks[0]?.key).toEqual(["doc:123", "snapshot", "a"]);
    });
  });

  describe("removeRange", () => {
    test("should remove all chunks with matching prefix", async () => {
      await adapter.save(["doc:123", "snapshot", "a"], new Uint8Array([1]));
      await adapter.save(["doc:123", "snapshot", "b"], new Uint8Array([2]));
      await adapter.save(["doc:123", "incremental", "c"], new Uint8Array([3]));
      await adapter.save(["doc:456", "snapshot", "d"], new Uint8Array([4]));

      await adapter.removeRange(["doc:123", "snapshot"]);

      expect(await adapter.load(["doc:123", "snapshot", "a"])).toBeUndefined();
      expect(await adapter.load(["doc:123", "snapshot", "b"])).toBeUndefined();
      expect(await adapter.load(["doc:123", "incremental", "c"])).toEqual(
        new Uint8Array([3]),
      );
      expect(await adapter.load(["doc:456", "snapshot", "d"])).toEqual(
        new Uint8Array([4]),
      );
    });

    test("should remove all chunks for a document", async () => {
      await adapter.save(["doc:123", "snapshot", "a"], new Uint8Array([1]));
      await adapter.save(["doc:123", "incremental", "b"], new Uint8Array([2]));
      await adapter.save(["doc:456", "snapshot", "c"], new Uint8Array([3]));

      await adapter.removeRange(["doc:123"]);

      expect(await adapter.load(["doc:123", "snapshot", "a"])).toBeUndefined();
      expect(await adapter.load(["doc:123", "incremental", "b"])).toBeUndefined();
      expect(await adapter.load(["doc:456", "snapshot", "c"])).toEqual(
        new Uint8Array([3]),
      );
    });

    test("should not throw for empty prefix", async () => {
      await expect(adapter.removeRange([])).resolves.toBeUndefined();
    });
  });

  describe("ephemeral documents", () => {
    test("should not save ephemeral documents", async () => {
      const key = ["eph:temp123", "snapshot", "a"];
      const data = new Uint8Array([1, 2, 3]);

      await adapter.save(key, data);
      const loaded = await adapter.load(key);

      expect(loaded).toBeUndefined();
    });

    test("should not load ephemeral documents", async () => {
      const loaded = await adapter.load(["eph:temp123", "snapshot", "a"]);
      expect(loaded).toBeUndefined();
    });

    test("should return empty for ephemeral loadRange", async () => {
      const chunks = await adapter.loadRange(["eph:temp123"]);
      expect(chunks).toEqual([]);
    });
  });

  describe("key edge cases", () => {
    test("should handle keys with special characters", async () => {
      const key = ["doc:with-dashes", "type:colons", "hash/slash"];
      const data = new Uint8Array([1, 2, 3]);

      await adapter.save(key, data);
      const loaded = await adapter.load(key);

      expect(loaded).toEqual(data);
    });

    test("should handle single-element keys", async () => {
      const key = ["doc:123"];
      const data = new Uint8Array([1, 2, 3]);

      await adapter.save(key, data);
      const loaded = await adapter.load(key);

      expect(loaded).toEqual(data);
    });

    test("should handle keys with empty strings", async () => {
      const key = ["doc:123", "", "hash"];
      const data = new Uint8Array([1, 2, 3]);

      await adapter.save(key, data);
      const loaded = await adapter.load(key);

      expect(loaded).toEqual(data);
    });
  });

  describe("concurrent operations", () => {
    test("should handle concurrent saves to different keys", async () => {
      const promises = [];
      for (let i = 0; i < 100; i++) {
        promises.push(
          adapter.save([`doc:${i}`, "snapshot", "data"], new Uint8Array([i])),
        );
      }
      await Promise.all(promises);

      for (let i = 0; i < 100; i++) {
        const loaded = await adapter.load([`doc:${i}`, "snapshot", "data"]);
        expect(loaded).toEqual(new Uint8Array([i]));
      }
    });
  });
});
