/**
 * Document status tracker for tracking sync state of documents.
 *
 * Persists document status in IndexedDB so it survives browser sessions.
 */

export type DocumentSyncStatus = "local" | "syncing" | "synced";

export interface DocumentStatusEntry {
  documentId: string;
  status: DocumentSyncStatus;
  serverRegistered: boolean;
  createdAt: string;
  lastSyncAttempt?: string;
  error?: string;
}

export type DocumentStatusListener = (
  documentId: string,
  status: DocumentStatusEntry,
) => void;

const DB_NAME = "ratatoskr";
const DB_VERSION = 2;
const STATUS_STORE = "document_status";

export class DocumentStatusTracker {
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;
  private listeners: Set<DocumentStatusListener> = new Set();
  private cache: Map<string, DocumentStatusEntry> = new Map();

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

        // Create chunks store for automerge document data (from storage adapter)
        if (!db.objectStoreNames.contains("chunks")) {
          db.createObjectStore("chunks", { keyPath: "key" });
        }

        // Create document status store
        if (!db.objectStoreNames.contains(STATUS_STORE)) {
          const store = db.createObjectStore(STATUS_STORE, {
            keyPath: "documentId",
          });
          store.createIndex("status", "status", { unique: false });
          store.createIndex("serverRegistered", "serverRegistered", {
            unique: false,
          });
        }

        // Create pending operations store (for queue)
        if (!db.objectStoreNames.contains("pending_operations")) {
          const store = db.createObjectStore("pending_operations", {
            keyPath: "id",
          });
          store.createIndex("createdAt", "createdAt", { unique: false });
          store.createIndex("type", "type", { unique: false });
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
   * Set document status.
   */
  async setStatus(
    documentId: string,
    status: DocumentSyncStatus,
    options: Partial<Omit<DocumentStatusEntry, "documentId" | "status">> = {},
  ): Promise<void> {
    const db = await this.getDb();
    const existing = await this.getStatus(documentId);

    const entry: DocumentStatusEntry = {
      documentId,
      status,
      serverRegistered:
        options.serverRegistered ?? existing?.serverRegistered ?? false,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      lastSyncAttempt: options.lastSyncAttempt ?? existing?.lastSyncAttempt,
      error: options.error,
    };

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STATUS_STORE, "readwrite");
      const store = transaction.objectStore(STATUS_STORE);
      const request = store.put(entry);

      request.onerror = () => {
        reject(
          new Error(`Failed to set document status: ${request.error?.message}`),
        );
      };

      request.onsuccess = () => {
        this.cache.set(documentId, entry);
        this.notifyListeners(documentId, entry);
        resolve();
      };
    });
  }

  /**
   * Get document status.
   */
  async getStatus(
    documentId: string,
  ): Promise<DocumentStatusEntry | undefined> {
    // Check cache first
    if (this.cache.has(documentId)) {
      return this.cache.get(documentId);
    }

    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STATUS_STORE, "readonly");
      const store = transaction.objectStore(STATUS_STORE);
      const request = store.get(documentId);

      request.onerror = () => {
        reject(
          new Error(`Failed to get document status: ${request.error?.message}`),
        );
      };

      request.onsuccess = () => {
        const entry = request.result as DocumentStatusEntry | undefined;
        if (entry) {
          this.cache.set(documentId, entry);
        }
        resolve(entry);
      };
    });
  }

  /**
   * Mark document as registered on server.
   */
  async markServerRegistered(documentId: string): Promise<void> {
    await this.setStatus(documentId, "synced", { serverRegistered: true });
  }

  /**
   * Get all documents with a specific status.
   */
  async getByStatus(
    status: DocumentSyncStatus,
  ): Promise<DocumentStatusEntry[]> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STATUS_STORE, "readonly");
      const store = transaction.objectStore(STATUS_STORE);
      const index = store.index("status");
      const request = index.getAll(status);

      request.onerror = () => {
        reject(
          new Error(
            `Failed to get documents by status: ${request.error?.message}`,
          ),
        );
      };

      request.onsuccess = () => {
        const entries = request.result as DocumentStatusEntry[];
        // Update cache
        for (const entry of entries) {
          this.cache.set(entry.documentId, entry);
        }
        resolve(entries);
      };
    });
  }

  /**
   * Get all documents that are not registered on the server.
   */
  async getUnregistered(): Promise<DocumentStatusEntry[]> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STATUS_STORE, "readonly");
      const store = transaction.objectStore(STATUS_STORE);
      const request = store.openCursor();
      const results: DocumentStatusEntry[] = [];

      request.onerror = () => {
        reject(
          new Error(
            `Failed to get unregistered documents: ${request.error?.message}`,
          ),
        );
      };

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const entry = cursor.value as DocumentStatusEntry;
          if (!entry.serverRegistered) {
            results.push(entry);
            this.cache.set(entry.documentId, entry);
          }
          cursor.continue();
        } else {
          resolve(results);
        }
      };
    });
  }

  /**
   * Remove document status (e.g., when document is deleted).
   */
  async removeStatus(documentId: string): Promise<void> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STATUS_STORE, "readwrite");
      const store = transaction.objectStore(STATUS_STORE);
      const request = store.delete(documentId);

      request.onerror = () => {
        reject(
          new Error(
            `Failed to remove document status: ${request.error?.message}`,
          ),
        );
      };

      request.onsuccess = () => {
        this.cache.delete(documentId);
        resolve();
      };
    });
  }

  private notifyListeners(
    documentId: string,
    entry: DocumentStatusEntry,
  ): void {
    for (const listener of this.listeners) {
      try {
        listener(documentId, entry);
      } catch (error) {
        console.error("Error in document status listener:", error);
      }
    }
  }

  /**
   * Subscribe to document status changes.
   */
  subscribe(listener: DocumentStatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Clear all cached data.
   */
  clearCache(): void {
    this.cache.clear();
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
    this.listeners.clear();
    this.cache.clear();
  }
}
