/**
 * IndexedDB storage adapter for automerge-repo.
 *
 * Provides persistent local storage for automerge documents in the browser.
 * Compatible with the StorageAdapterInterface from @automerge/automerge-repo.
 */

import type { StorageAdapterInterface } from "@automerge/automerge-repo";

export type StorageKey = string[];
export type Chunk = { key: StorageKey; data: Uint8Array | undefined };

const DB_NAME = "ratatoskr";
const DB_VERSION = 1;
const CHUNKS_STORE = "chunks";

export class IndexedDBStorageAdapter implements StorageAdapterInterface {
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(private dbName: string = DB_NAME) {}

  private async getDb(): Promise<IDBDatabase> {
    if (this.db) {
      return this.db;
    }

    if (this.dbPromise) {
      return this.dbPromise;
    }

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, DB_VERSION);

      request.onerror = () => {
        reject(
          new Error(`Failed to open IndexedDB: ${request.error?.message}`),
        );
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create chunks store for automerge document data
        if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
          db.createObjectStore(CHUNKS_STORE, { keyPath: "key" });
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve(this.db);
      };
    });

    return this.dbPromise;
  }

  /**
   * Convert a StorageKey array to a string for IndexedDB key.
   */
  private keyToString(key: StorageKey): string {
    return key.join("\x00");
  }

  /**
   * Convert a string key back to a StorageKey array.
   */
  private stringToKey(str: string): StorageKey {
    return str.split("\x00");
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    const db = await this.getDb();
    const keyStr = this.keyToString(key);

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(CHUNKS_STORE, "readonly");
      const store = transaction.objectStore(CHUNKS_STORE);
      const request = store.get(keyStr);

      request.onerror = () => {
        reject(
          new Error(`Failed to load from IndexedDB: ${request.error?.message}`),
        );
      };

      request.onsuccess = () => {
        const result = request.result;
        if (result?.data) {
          resolve(new Uint8Array(result.data));
        } else {
          resolve(undefined);
        }
      };
    });
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    const db = await this.getDb();
    const keyStr = this.keyToString(key);

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(CHUNKS_STORE, "readwrite");
      const store = transaction.objectStore(CHUNKS_STORE);
      const request = store.put({ key: keyStr, data: Array.from(data) });

      request.onerror = () => {
        reject(
          new Error(`Failed to save to IndexedDB: ${request.error?.message}`),
        );
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  async remove(key: StorageKey): Promise<void> {
    const db = await this.getDb();
    const keyStr = this.keyToString(key);

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(CHUNKS_STORE, "readwrite");
      const store = transaction.objectStore(CHUNKS_STORE);
      const request = store.delete(keyStr);

      request.onerror = () => {
        reject(
          new Error(
            `Failed to remove from IndexedDB: ${request.error?.message}`,
          ),
        );
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    const db = await this.getDb();
    const prefixStr = this.keyToString(keyPrefix);

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(CHUNKS_STORE, "readonly");
      const store = transaction.objectStore(CHUNKS_STORE);
      const request = store.openCursor();
      const results: Chunk[] = [];

      request.onerror = () => {
        reject(
          new Error(
            `Failed to load range from IndexedDB: ${request.error?.message}`,
          ),
        );
      };

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const storedKey = cursor.value.key as string;
          // Check if the key starts with the prefix
          if (
            storedKey === prefixStr ||
            storedKey.startsWith(`${prefixStr}\x00`)
          ) {
            results.push({
              key: this.stringToKey(storedKey),
              data: new Uint8Array(cursor.value.data),
            });
          }
          cursor.continue();
        } else {
          resolve(results);
        }
      };
    });
  }

  async removeRange(keyPrefix: StorageKey): Promise<void> {
    const db = await this.getDb();
    const prefixStr = this.keyToString(keyPrefix);

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(CHUNKS_STORE, "readwrite");
      const store = transaction.objectStore(CHUNKS_STORE);
      const request = store.openCursor();
      const deletePromises: Promise<void>[] = [];

      request.onerror = () => {
        reject(
          new Error(
            `Failed to remove range from IndexedDB: ${request.error?.message}`,
          ),
        );
      };

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const storedKey = cursor.value.key as string;
          if (
            storedKey === prefixStr ||
            storedKey.startsWith(`${prefixStr}\x00`)
          ) {
            const deleteRequest = cursor.delete();
            deletePromises.push(
              new Promise((res, rej) => {
                deleteRequest.onsuccess = () => res();
                deleteRequest.onerror = () => rej(deleteRequest.error);
              }),
            );
          }
          cursor.continue();
        } else {
          Promise.all(deletePromises)
            .then(() => resolve())
            .catch(reject);
        }
      };
    });
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.dbPromise = null;
    }
  }
}
