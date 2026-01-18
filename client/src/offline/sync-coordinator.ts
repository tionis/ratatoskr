/**
 * Sync coordinator for orchestrating offline document creation and sync.
 *
 * Coordinates between connectivity manager, document status tracker,
 * and pending operations queue to provide seamless offline-first experience.
 */

import type { Repo } from "@automerge/automerge-repo";
import { ConnectivityManager, type ConnectivityState } from "./connectivity-manager.ts";
import { DocumentStatusTracker, type DocumentSyncStatus, type DocumentStatusEntry } from "./document-status-tracker.ts";
import { PendingOperationsQueue, type PendingOperation } from "./pending-operations-queue.ts";

export interface SyncCoordinatorOptions {
  serverUrl: string;
  getToken: () => string | null;
  getRepo: () => Repo | null;
}

export type SyncEventType =
  | "sync:started"
  | "sync:completed"
  | "sync:error"
  | "document:status-changed"
  | "connectivity:changed"
  | "auth:required"
  | "auth:token-expired";

export interface SyncEvent {
  type: SyncEventType;
  documentId?: string;
  status?: DocumentSyncStatus;
  connectivity?: ConnectivityState;
  error?: string;
  processed?: number;
  failed?: number;
}

export type SyncEventListener = (event: SyncEvent) => void;

export class SyncCoordinator {
  private connectivity: ConnectivityManager;
  private statusTracker: DocumentStatusTracker;
  private queue: PendingOperationsQueue;
  private serverUrl: string;
  private getToken: () => string | null;
  private getRepo: () => Repo | null;
  private listeners: Set<SyncEventListener> = new Set();
  private unsubscribeConnectivity: (() => void) | null = null;
  private syncTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;

  constructor(options: SyncCoordinatorOptions) {
    this.serverUrl = options.serverUrl;
    this.getToken = options.getToken;
    this.getRepo = options.getRepo;

    this.connectivity = new ConnectivityManager();
    this.statusTracker = new DocumentStatusTracker();
    this.queue = new PendingOperationsQueue();
  }

  /**
   * Initialize the sync coordinator.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Set up the operation processor
    this.queue.setProcessor(this.processOperation.bind(this));

    // Subscribe to connectivity changes
    this.unsubscribeConnectivity = this.connectivity.subscribe((state) => {
      this.emit({ type: "connectivity:changed", connectivity: state });

      if (state === "online") {
        // Trigger sync when we come online
        this.scheduleSyncProcessing();
      }
    });

    // Subscribe to document status changes
    this.statusTracker.subscribe((documentId, entry) => {
      this.emit({
        type: "document:status-changed",
        documentId,
        status: entry.status,
      });
    });

    this.initialized = true;
  }

  /**
   * Create a document that works offline.
   * Returns the document ID immediately. The document will be registered
   * on the server when connectivity is available.
   */
  async createDocumentOffline<T extends Record<string, unknown>>(
    initialValue: T,
    options: { type?: string; expiresAt?: string } = {}
  ): Promise<string> {
    const repo = this.getRepo();
    if (!repo) {
      throw new Error("Repo not initialized. Call getRepo() first.");
    }

    // Create document locally with automerge
    const handle = repo.create<T>();
    handle.change((doc) => {
      Object.assign(doc as object, initialValue);
    });

    const documentId = handle.documentId;

    // Track document status as local
    await this.statusTracker.setStatus(documentId, "local", {
      serverRegistered: false,
    });

    // Queue server registration
    await this.queue.enqueueDocumentRegistration(documentId, {
      type: options.type,
      expiresAt: options.expiresAt,
    });

    // Try to process immediately if online and authenticated
    if (this.connectivity.isOnline() && this.getToken()) {
      this.scheduleSyncProcessing();
    }

    return documentId;
  }

  /**
   * Process a pending operation (called by queue).
   */
  private async processOperation(
    operation: PendingOperation
  ): Promise<{ success: boolean; error?: string }> {
    const token = this.getToken();
    if (!token) {
      this.emit({ type: "auth:required" });
      return { success: false, error: "Not authenticated" };
    }

    if (operation.type === "register_document") {
      return this.registerDocument(operation);
    }

    return { success: false, error: `Unknown operation type: ${operation.type}` };
  }

  /**
   * Register a document on the server.
   */
  private async registerDocument(
    operation: PendingOperation
  ): Promise<{ success: boolean; error?: string }> {
    const token = this.getToken();
    if (!token) {
      return { success: false, error: "Not authenticated" };
    }

    // Update status to syncing
    await this.statusTracker.setStatus(operation.documentId, "syncing", {
      lastSyncAttempt: new Date().toISOString(),
    });

    try {
      const response = await fetch(`${this.serverUrl}/api/v1/documents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id: operation.documentId,
          type: operation.payload.type,
          expiresAt: operation.payload.expiresAt,
          // No ACL - private by default for offline-created documents
        }),
      });

      if (response.ok) {
        await this.statusTracker.markServerRegistered(operation.documentId);
        return { success: true };
      }

      // Handle specific error cases
      if (response.status === 401) {
        this.emit({ type: "auth:required" });
        return { success: false, error: "Authentication expired" };
      }

      if (response.status === 409) {
        // Document already exists - could happen if we retry after a partial success
        // Mark as registered since it exists on server
        await this.statusTracker.markServerRegistered(operation.documentId);
        return { success: true };
      }

      const errorBody = await response.json().catch(() => ({}));
      return {
        success: false,
        error: errorBody.message || `Server error: ${response.status}`,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Network error";
      await this.statusTracker.setStatus(operation.documentId, "local", {
        error: errorMessage,
      });
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Schedule sync processing with debouncing.
   */
  private scheduleSyncProcessing(): void {
    if (this.syncTimeoutId) {
      clearTimeout(this.syncTimeoutId);
    }

    this.syncTimeoutId = setTimeout(() => {
      this.processPendingOperations();
    }, 100);
  }

  /**
   * Process all pending operations.
   */
  async processPendingOperations(): Promise<{ processed: number; failed: number }> {
    if (!this.connectivity.isOnline()) {
      return { processed: 0, failed: 0 };
    }

    if (!this.getToken()) {
      this.emit({ type: "auth:required" });
      return { processed: 0, failed: 0 };
    }

    this.emit({ type: "sync:started" });

    try {
      const result = await this.queue.processQueue();

      this.emit({
        type: "sync:completed",
        processed: result.processed,
        failed: result.failed,
      });

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Sync error";
      this.emit({ type: "sync:error", error: errorMessage });
      return { processed: 0, failed: 0 };
    }
  }

  /**
   * Get document sync status.
   */
  async getDocumentSyncStatus(documentId: string): Promise<DocumentStatusEntry | undefined> {
    return this.statusTracker.getStatus(documentId);
  }

  /**
   * Get current connectivity state.
   */
  getConnectivityState(): ConnectivityState {
    return this.connectivity.getState();
  }

  /**
   * Get the connectivity manager (for network adapter integration).
   */
  getConnectivityManager(): ConnectivityManager {
    return this.connectivity;
  }

  /**
   * Get pending operations count.
   */
  async getPendingOperationsCount(): Promise<number> {
    return this.queue.getQueueLength();
  }

  /**
   * Check if a document has pending operations.
   */
  async hasPendingOperation(documentId: string): Promise<boolean> {
    return this.queue.hasPendingOperation(documentId);
  }

  /**
   * Get all unsynced documents.
   */
  async getUnsyncedDocuments(): Promise<DocumentStatusEntry[]> {
    return this.statusTracker.getUnregistered();
  }

  private emit(event: SyncEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("Error in sync event listener:", error);
      }
    }
  }

  /**
   * Emit auth:token-expired event.
   * Called by the client when WebSocket auth fails or HTTP returns 401.
   */
  emitTokenExpired(): void {
    this.emit({ type: "auth:token-expired" });
  }

  /**
   * Subscribe to sync events.
   */
  subscribe(listener: SyncEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Wait for online state.
   */
  async waitForOnline(): Promise<void> {
    return this.connectivity.waitForOnline();
  }

  /**
   * Cleanup resources.
   */
  destroy(): void {
    if (this.syncTimeoutId) {
      clearTimeout(this.syncTimeoutId);
    }

    if (this.unsubscribeConnectivity) {
      this.unsubscribeConnectivity();
    }

    this.connectivity.destroy();
    this.statusTracker.close();
    this.queue.close();
    this.listeners.clear();
    this.initialized = false;
  }
}
