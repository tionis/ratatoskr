/**
 * Pending operations queue for offline document registration.
 *
 * Stores operations that need server interaction in IndexedDB and
 * processes them with exponential backoff retry.
 */

export type OperationType = "register_document";

export interface PendingOperation {
  id: string;
  type: OperationType;
  documentId: string;
  payload: {
    type?: string;
    expiresAt?: string;
  };
  createdAt: string;
  attempts: number;
  lastAttempt?: string;
  nextRetry?: string;
  error?: string;
}

export type OperationProcessor = (
  operation: PendingOperation
) => Promise<{ success: boolean; error?: string }>;

const DB_NAME = "ratatoskr";
const DB_VERSION = 2;
const QUEUE_STORE = "pending_operations";

const MAX_RETRY_ATTEMPTS = 10;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 60000;

export class PendingOperationsQueue {
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;
  private processing = false;
  private processor: OperationProcessor | null = null;

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
        reject(new Error(`Failed to open IndexedDB: ${request.error?.message}`));
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create chunks store for automerge document data
        if (!db.objectStoreNames.contains("chunks")) {
          db.createObjectStore("chunks", { keyPath: "key" });
        }

        // Create document status store
        if (!db.objectStoreNames.contains("document_status")) {
          const store = db.createObjectStore("document_status", { keyPath: "documentId" });
          store.createIndex("status", "status", { unique: false });
          store.createIndex("serverRegistered", "serverRegistered", { unique: false });
        }

        // Create pending operations store
        if (!db.objectStoreNames.contains(QUEUE_STORE)) {
          const store = db.createObjectStore(QUEUE_STORE, { keyPath: "id" });
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
   * Set the operation processor function.
   */
  setProcessor(processor: OperationProcessor): void {
    this.processor = processor;
  }

  /**
   * Enqueue a document registration operation.
   */
  async enqueueDocumentRegistration(
    documentId: string,
    options: { type?: string; expiresAt?: string } = {}
  ): Promise<void> {
    const operation: PendingOperation = {
      id: crypto.randomUUID(),
      type: "register_document",
      documentId,
      payload: {
        type: options.type,
        expiresAt: options.expiresAt,
      },
      createdAt: new Date().toISOString(),
      attempts: 0,
    };

    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(QUEUE_STORE, "readwrite");
      const store = transaction.objectStore(QUEUE_STORE);
      const request = store.add(operation);

      request.onerror = () => {
        reject(new Error(`Failed to enqueue operation: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  /**
   * Get all pending operations.
   */
  async getPendingOperations(): Promise<PendingOperation[]> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(QUEUE_STORE, "readonly");
      const store = transaction.objectStore(QUEUE_STORE);
      const index = store.index("createdAt");
      const request = index.getAll();

      request.onerror = () => {
        reject(new Error(`Failed to get pending operations: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        resolve(request.result as PendingOperation[]);
      };
    });
  }

  /**
   * Get operations that are ready to retry.
   */
  async getRetryableOperations(): Promise<PendingOperation[]> {
    const operations = await this.getPendingOperations();
    const now = new Date().toISOString();

    return operations.filter((op) => {
      // Never retried, or retry time has passed
      if (!op.nextRetry) return true;
      return op.nextRetry <= now;
    });
  }

  /**
   * Update operation after attempt.
   */
  private async updateOperation(operation: PendingOperation): Promise<void> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(QUEUE_STORE, "readwrite");
      const store = transaction.objectStore(QUEUE_STORE);
      const request = store.put(operation);

      request.onerror = () => {
        reject(new Error(`Failed to update operation: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  /**
   * Remove a completed operation.
   */
  async removeOperation(operationId: string): Promise<void> {
    const db = await this.getDb();

    return new Promise((resolve, reject) => {
      const transaction = db.transaction(QUEUE_STORE, "readwrite");
      const store = transaction.objectStore(QUEUE_STORE);
      const request = store.delete(operationId);

      request.onerror = () => {
        reject(new Error(`Failed to remove operation: ${request.error?.message}`));
      };

      request.onsuccess = () => {
        resolve();
      };
    });
  }

  /**
   * Remove all operations for a document.
   */
  async removeOperationsForDocument(documentId: string): Promise<void> {
    const operations = await this.getPendingOperations();
    const toRemove = operations.filter((op) => op.documentId === documentId);

    for (const op of toRemove) {
      await this.removeOperation(op.id);
    }
  }

  /**
   * Calculate next retry time with exponential backoff.
   */
  private calculateNextRetry(attempts: number): string {
    const delay = Math.min(
      BASE_RETRY_DELAY_MS * Math.pow(2, attempts),
      MAX_RETRY_DELAY_MS
    );
    const jitter = Math.random() * delay * 0.1; // 10% jitter
    return new Date(Date.now() + delay + jitter).toISOString();
  }

  /**
   * Process all pending operations.
   */
  async processQueue(): Promise<{ processed: number; failed: number }> {
    if (this.processing) {
      return { processed: 0, failed: 0 };
    }

    if (!this.processor) {
      throw new Error("No operation processor set");
    }

    this.processing = true;
    let processed = 0;
    let failed = 0;

    try {
      const operations = await this.getRetryableOperations();

      for (const operation of operations) {
        // Skip if max retries exceeded
        if (operation.attempts >= MAX_RETRY_ATTEMPTS) {
          failed++;
          continue;
        }

        // Update attempt count
        operation.attempts++;
        operation.lastAttempt = new Date().toISOString();

        try {
          const result = await this.processor(operation);

          if (result.success) {
            await this.removeOperation(operation.id);
            processed++;
          } else {
            operation.error = result.error;
            operation.nextRetry = this.calculateNextRetry(operation.attempts);
            await this.updateOperation(operation);
            failed++;
          }
        } catch (error) {
          operation.error = error instanceof Error ? error.message : "Unknown error";
          operation.nextRetry = this.calculateNextRetry(operation.attempts);
          await this.updateOperation(operation);
          failed++;
        }
      }
    } finally {
      this.processing = false;
    }

    return { processed, failed };
  }

  /**
   * Check if currently processing.
   */
  isProcessing(): boolean {
    return this.processing;
  }

  /**
   * Get queue length.
   */
  async getQueueLength(): Promise<number> {
    const operations = await this.getPendingOperations();
    return operations.length;
  }

  /**
   * Check if there's a pending operation for a document.
   */
  async hasPendingOperation(documentId: string): Promise<boolean> {
    const operations = await this.getPendingOperations();
    return operations.some((op) => op.documentId === documentId);
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
    this.processor = null;
  }
}
