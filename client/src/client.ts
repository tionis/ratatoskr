/**
 * High-level Ratatoskr client.
 *
 * Provides a convenient API for:
 * - Authentication
 * - Document management
 * - Automerge-repo integration
 * - Offline-first document creation
 */

import {
  type AnyDocumentId,
  type DocHandle,
  type PeerId,
  Repo,
} from "@automerge/automerge-repo";
import {
  authenticate,
  clearStoredToken,
  clearStoredUser,
  getStoredToken,
  getStoredUser,
  storeToken,
  storeUser,
} from "./auth.ts";
import { RatatoskrNetworkAdapter } from "./network-adapter.ts";
import {
  type ConnectivityState,
  type DocumentStatusEntry,
  SyncCoordinator,
  type SyncEventListener,
} from "./offline/index.ts";
import { IndexedDBStorageAdapter } from "./storage/indexeddb-storage-adapter.ts";
import type {
  ACLEntry,
  ApiToken,
  BlobInfo,
  BlobUploadProgress,
  CompleteUploadResponse,
  CreateDocumentRequest,
  DocumentBlobsResponse,
  DocumentMetadata,
  InitUploadResponse,
  ListBlobsResponse,
  ListDocumentsResponse,
  User,
} from "./types.ts";

export interface RatatoskrClientOptions {
  serverUrl: string;
  tokenStorageKey?: string;
  /**
   * Enable offline-first support with local storage.
   * When enabled, documents can be created and edited offline,
   * and will sync when connectivity is restored.
   * Default: true
   */
  enableOfflineSupport?: boolean;
}

export class RatatoskrClient {
  private serverUrl: string;
  private tokenStorageKey: string;
  private userStorageKey: string;
  private token: string | null = null;
  private user: User | null = null;
  private repo: Repo | null = null;
  private networkAdapter: RatatoskrNetworkAdapter | null = null;
  private offlineEnabled: boolean;
  private storageAdapter: IndexedDBStorageAdapter | null = null;
  private syncCoordinator: SyncCoordinator | null = null;

  constructor(options: RatatoskrClientOptions) {
    this.serverUrl = options.serverUrl.replace(/\/$/, ""); // Remove trailing slash
    this.tokenStorageKey = options.tokenStorageKey ?? "ratatoskr:token";
    this.userStorageKey = `${this.tokenStorageKey}:user`;
    this.offlineEnabled = options.enableOfflineSupport ?? true;

    // Try to restore token and user from storage
    this.token = getStoredToken(this.tokenStorageKey);
    this.user = getStoredUser(this.userStorageKey);

    // Initialize offline support
    if (this.offlineEnabled) {
      this.initializeOfflineSupport();
    }
  }

  private initializeOfflineSupport(): void {
    this.storageAdapter = new IndexedDBStorageAdapter();
    this.syncCoordinator = new SyncCoordinator({
      serverUrl: this.serverUrl,
      getToken: () => this.token,
      getRepo: () => this.repo,
    });
    this.syncCoordinator.initialize();
  }

  /**
   * Check if the user is authenticated (has a token).
   * Note: This doesn't validate the token - use validateToken() for that.
   */
  isAuthenticated(): boolean {
    return this.token !== null;
  }

  /**
   * Check if there are stored credentials from a previous session.
   * Useful for showing "Welcome back" UI even when offline.
   * Returns true if both token and user info are cached.
   */
  hasStoredCredentials(): boolean {
    return this.token !== null && this.user !== null;
  }

  /**
   * Get the current user, or null if not authenticated.
   * When offline with stored credentials, returns the cached user.
   */
  getUser(): User | null {
    return this.user;
  }

  /**
   * Authenticate using popup-based OIDC flow.
   * Requires network connectivity.
   */
  async login(): Promise<User> {
    const result = await authenticate(this.serverUrl);

    this.token = result.token;
    this.user = result.user;

    // Store token and user for offline access
    storeToken(this.tokenStorageKey, this.token);
    storeUser(this.userStorageKey, this.user);

    // Update network adapter if connected
    if (this.networkAdapter) {
      this.networkAdapter.setToken(this.token);
    }

    // Process any pending operations now that we're authenticated
    if (this.syncCoordinator) {
      this.syncCoordinator.processPendingOperations();
    }

    return this.user;
  }

  /**
   * Log out the current user.
   */
  logout(): void {
    this.token = null;
    this.user = null;
    clearStoredToken(this.tokenStorageKey);
    clearStoredUser(this.userStorageKey);

    // Disconnect and reconnect as anonymous
    if (this.networkAdapter) {
      this.networkAdapter.setToken("");
    }
  }

  /**
   * Get or create the automerge-repo instance.
   */
  getRepo(): Repo {
    if (this.repo) {
      return this.repo;
    }

    // Get connectivity manager for callbacks
    const connectivityManager = this.syncCoordinator?.getConnectivityManager();

    // Create network adapter
    this.networkAdapter = new RatatoskrNetworkAdapter({
      serverUrl: this.serverUrl,
      token: this.token ?? undefined,
      onConnecting: () => connectivityManager?.setServerConnecting(),
      onConnected: () => {
        connectivityManager?.setServerConnected();
        // Validate token on reconnect by processing pending operations
        // This will trigger auth:required if token is invalid
        this.syncCoordinator?.processPendingOperations();
      },
      onDisconnected: () => connectivityManager?.setServerDisconnected(),
      onAuthError: () => this.handleAuthError(),
    });

    // Create repo with optional storage adapter
    this.repo = new Repo({
      network: [this.networkAdapter],
      storage: this.storageAdapter ?? undefined,
      peerId: `client-${crypto.randomUUID()}` as PeerId,
    });

    return this.repo;
  }

  /**
   * Fetch current user info from server and update cache.
   * Use this to refresh user info or validate the token is still valid.
   */
  async fetchUserInfo(): Promise<User> {
    const response = await this.fetch("/api/v1/auth/userinfo");

    if (!response.ok) {
      if (response.status === 401) {
        // Token is invalid/expired - emit event and clear credentials
        this.handleTokenExpired();
        throw new Error("Token expired or invalid");
      }
      throw new Error("Failed to fetch user info");
    }

    this.user = await response.json();
    // Update cached user info
    storeUser(this.userStorageKey, this.user!);
    return this.user!;
  }

  /**
   * Handle token expiration (from HTTP 401).
   */
  private handleTokenExpired(): void {
    this.emitAuthTokenExpired();
  }

  /**
   * Handle auth error from WebSocket connection.
   */
  private handleAuthError(): void {
    this.emitAuthTokenExpired();
  }

  /**
   * Emit auth:token-expired event through sync coordinator.
   */
  private emitAuthTokenExpired(): void {
    // Emit through sync coordinator so apps can subscribe via onSyncEvent
    this.syncCoordinator?.emitTokenExpired();
  }

  /**
   * Validate the stored token by fetching user info.
   * Returns true if valid, false if expired/invalid.
   * Use this on app startup to check if re-login is needed.
   */
  async validateToken(): Promise<boolean> {
    if (!this.token) {
      return false;
    }

    try {
      await this.fetchUserInfo();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a document on the server.
   */
  async createDocument(
    request: CreateDocumentRequest,
  ): Promise<DocumentMetadata> {
    const response = await this.fetch("/api/v1/documents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message ?? "Failed to create document");
    }

    return response.json();
  }

  /**
   * List all documents the user owns or has access to.
   */
  async listDocuments(): Promise<ListDocumentsResponse> {
    const response = await this.fetch("/api/v1/documents");

    if (!response.ok) {
      throw new Error("Failed to list documents");
    }

    return response.json();
  }

  /**
   * Get document metadata.
   */
  async getDocument(id: string): Promise<DocumentMetadata> {
    const response = await this.fetch(
      `/api/v1/documents/${encodeURIComponent(id)}`,
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message ?? "Failed to get document");
    }

    return response.json();
  }

  /**
   * Delete a document.
   */
  async deleteDocument(id: string): Promise<void> {
    const response = await this.fetch(
      `/api/v1/documents/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
      },
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message ?? "Failed to delete document");
    }
  }

  /**
   * Update document ACL.
   */
  async setDocumentACL(id: string, acl: ACLEntry[]): Promise<void> {
    const response = await this.fetch(
      `/api/v1/documents/${encodeURIComponent(id)}/acl`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ acl }),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message ?? "Failed to update ACL");
    }
  }

  /**
   * Create an API token.
   */
  async createApiToken(
    name: string,
    scopes?: string[],
    expiresAt?: string,
  ): Promise<{ token: string; id: string }> {
    const response = await this.fetch("/api/v1/auth/api-tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name, scopes, expiresAt }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message ?? "Failed to create API token");
    }

    return response.json();
  }

  /**
   * List API tokens for the current user.
   */
  async listApiTokens(): Promise<ApiToken[]> {
    const response = await this.fetch("/api/v1/auth/api-tokens");

    if (!response.ok) {
      throw new Error("Failed to list API tokens");
    }

    return response.json();
  }

  /**
   * Delete an API token.
   */
  async deleteApiToken(id: string): Promise<void> {
    const response = await this.fetch(`/api/v1/auth/api-tokens/${id}`, {
      method: "DELETE",
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message ?? "Failed to delete API token");
    }
  }

  /**
   * Get document ACL.
   */
  async getDocumentACL(id: string): Promise<ACLEntry[]> {
    const response = await this.fetch(
      `/api/v1/documents/${encodeURIComponent(id)}/acl`,
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message ?? "Failed to get ACL");
    }

    const data = await response.json();
    return data.acl;
  }

  // ============================================
  // Offline-first document creation
  // ============================================

  /**
   * Create a document that works offline.
   *
   * The document is created locally first, then registered on the server
   * when connectivity is available. Documents created offline are private
   * (no ACLs) until you set them after syncing.
   *
   * @param initialValue - Initial document content
   * @param options - Optional document type and expiration
   * @returns The document ID (automerge document ID)
   */
  async createDocumentOffline<T extends Record<string, unknown>>(
    initialValue: T,
    options: { type?: string; expiresAt?: string } = {},
  ): Promise<string> {
    if (!this.syncCoordinator) {
      throw new Error("Offline support is not enabled");
    }

    // Ensure repo is initialized
    this.getRepo();

    return this.syncCoordinator.createDocumentOffline(initialValue, options);
  }

  /**
   * Get the sync status of a document.
   *
   * @returns Document status or undefined if not tracked
   */
  async getDocumentSyncStatus(
    documentId: string,
  ): Promise<DocumentStatusEntry | undefined> {
    if (!this.syncCoordinator) {
      return undefined;
    }
    return this.syncCoordinator.getDocumentSyncStatus(documentId);
  }

  /**
   * Get the current connectivity state.
   */
  getConnectivityState(): ConnectivityState {
    if (!this.syncCoordinator) {
      return "offline";
    }
    return this.syncCoordinator.getConnectivityState();
  }

  /**
   * Force processing of pending operations.
   * Useful when you want to immediately sync after login.
   */
  async processPendingOperations(): Promise<{
    processed: number;
    failed: number;
  }> {
    if (!this.syncCoordinator) {
      return { processed: 0, failed: 0 };
    }
    return this.syncCoordinator.processPendingOperations();
  }

  /**
   * Get the number of pending operations.
   */
  async getPendingOperationsCount(): Promise<number> {
    if (!this.syncCoordinator) {
      return 0;
    }
    return this.syncCoordinator.getPendingOperationsCount();
  }

  /**
   * Get all documents that haven't been synced to the server.
   */
  async getUnsyncedDocuments(): Promise<DocumentStatusEntry[]> {
    if (!this.syncCoordinator) {
      return [];
    }
    return this.syncCoordinator.getUnsyncedDocuments();
  }

  /**
   * Subscribe to sync events.
   *
   * Events include:
   * - sync:started - Sync processing started
   * - sync:completed - Sync processing completed
   * - sync:error - Sync error occurred
   * - document:status-changed - A document's sync status changed
   * - connectivity:changed - Connectivity state changed
   * - auth:required - Authentication is required to continue syncing
   *
   * @returns Unsubscribe function
   */
  onSyncEvent(listener: SyncEventListener): () => void {
    if (!this.syncCoordinator) {
      return () => {};
    }
    return this.syncCoordinator.subscribe(listener);
  }

  /**
   * Check if offline support is enabled.
   */
  isOfflineEnabled(): boolean {
    return this.offlineEnabled;
  }

  /**
   * Disconnect from the server.
   */
  disconnect(): void {
    if (this.networkAdapter) {
      this.networkAdapter.disconnect();
      this.networkAdapter = null;
    }
    this.repo = null;
  }

  /**
   * Destroy the client and cleanup resources.
   */
  destroy(): void {
    this.disconnect();

    if (this.syncCoordinator) {
      this.syncCoordinator.destroy();
      this.syncCoordinator = null;
    }

    if (this.storageAdapter) {
      this.storageAdapter.close();
      this.storageAdapter = null;
    }
  }

  // ============ KV Store Methods ============

  /**
   * Get a value from the KV store.
   * @param namespace - Application namespace (e.g., "dev.tionis.notes")
   * @param key - Key within the namespace
   * @returns The value, or null if not found
   */
  async kvGet(namespace: string, key: string): Promise<string | null> {
    const response = await this.fetch(
      `/api/v1/kv/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`,
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message ?? "Failed to get KV value");
    }

    const data = await response.json();
    return data.value;
  }

  /**
   * Set a value in the KV store.
   * @param namespace - Application namespace (e.g., "dev.tionis.notes")
   * @param key - Key within the namespace
   * @param value - Value to store (max 64KB)
   */
  async kvSet(namespace: string, key: string, value: string): Promise<void> {
    const response = await this.fetch(
      `/api/v1/kv/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value }),
      },
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message ?? "Failed to set KV value");
    }
  }

  /**
   * Delete a value from the KV store.
   * @param namespace - Application namespace (e.g., "dev.tionis.notes")
   * @param key - Key within the namespace
   * @returns true if deleted, false if not found
   */
  async kvDelete(namespace: string, key: string): Promise<boolean> {
    const response = await this.fetch(
      `/api/v1/kv/${encodeURIComponent(namespace)}/${encodeURIComponent(key)}`,
      {
        method: "DELETE",
      },
    );

    if (response.status === 404) {
      return false;
    }

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message ?? "Failed to delete KV value");
    }

    return true;
  }

  /**
   * List all entries in a namespace.
   * @param namespace - Application namespace (e.g., "dev.tionis.notes")
   */
  async kvList(
    namespace: string,
  ): Promise<Array<{ key: string; value: string; updatedAt: string }>> {
    const response = await this.fetch(
      `/api/v1/kv/${encodeURIComponent(namespace)}`,
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message ?? "Failed to list KV entries");
    }

    const data = await response.json();
    return data.entries;
  }

  // ============ App Document Helper ============

  /**
   * Get or create an app's root document.
   *
   * This helper implements the common pattern where an app needs a per-user
   * root document to store its state. On first call, it creates a new
   * automerge document and stores its URL in the KV store. On subsequent
   * calls, it returns the existing document.
   *
   * @param namespace - Application namespace (e.g., "dev.tionis.notes")
   * @param options - Options for document creation
   * @param options.key - KV key to store the document URL (default: "root")
   * @param options.initialize - Function to initialize the document state
   * @returns The document handle
   *
   * @example
   * ```typescript
   * const handle = await client.getOrCreateAppDocument("dev.tionis.notes", {
   *   initialize: (doc) => {
   *     doc.notes = [];
   *     doc.settings = { theme: "light" };
   *   }
   * });
   * ```
   */
  async getOrCreateAppDocument<T>(
    namespace: string,
    options: {
      key?: string;
      initialize?: (doc: T) => void;
      type?: string;
    } = {},
  ): Promise<{ handle: DocHandle<T>; url: string; isNew: boolean }> {
    const { key = "root", initialize, type } = options;

    if (!this.repo) {
      throw new Error("Repo not initialized. Call getRepo() first.");
    }

    // Check KV store for existing document URL
    const existingUrl = await this.kvGet(namespace, key);

    if (existingUrl) {
      // Find existing document
      const handle = await this.repo.find<T>(existingUrl as AnyDocumentId);
      return { handle, url: existingUrl, isNew: false };
    }

    // Create new document
    const handle = this.repo.create<T>();
    const url = handle.url;

    // Initialize document state if provided
    if (initialize) {
      handle.change((doc: T) => {
        initialize(doc);
      });
    }

    // Store URL in KV store
    await this.kvSet(namespace, key, url);

    // Register document with server if we have a type
    if (type) {
      const automergeHash = url.replace("automerge:", "");
      try {
        await this.createDocument({
          id: `doc:${namespace}:${automergeHash}`,
          automergeId: automergeHash,
          type,
        });
      } catch (err) {
        console.warn("Could not register app document with server:", err);
      }
    }

    return { handle, url, isNew: true };
  }

  // ============ Blob Methods ============

  /**
   * Upload a blob to the server.
   *
   * The blob is uploaded in chunks for reliability and to support large files.
   * Progress updates are provided through the onProgress callback.
   *
   * @param data - The blob data to upload
   * @param options - Upload options
   * @returns The uploaded blob info including its hash
   */
  async uploadBlob(
    data: Blob | File | ArrayBuffer | Uint8Array,
    options: {
      mimeType?: string;
      onProgress?: (progress: BlobUploadProgress) => void;
    } = {},
  ): Promise<BlobInfo> {
    const { onProgress } = options;

    // Convert to Uint8Array
    let bytes: Uint8Array;
    let mimeType = options.mimeType ?? "application/octet-stream";

    if (data instanceof Blob || data instanceof File) {
      mimeType = options.mimeType ?? (data.type || "application/octet-stream");
      bytes = new Uint8Array(await data.arrayBuffer());
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else {
      bytes = data;
    }

    const totalSize = bytes.length;

    // Phase 1: Compute hash locally
    onProgress?.({
      phase: "hashing",
      bytesProcessed: 0,
      totalBytes: totalSize,
    });

    const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
    const hashArray = new Uint8Array(hashBuffer);
    const expectedHash = Array.from(hashArray)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    onProgress?.({
      phase: "hashing",
      bytesProcessed: totalSize,
      totalBytes: totalSize,
    });

    // Phase 2: Check if blob already exists
    onProgress?.({
      phase: "checking",
      bytesProcessed: 0,
      totalBytes: totalSize,
    });

    const headResponse = await this.fetch(`/api/v1/blobs/${expectedHash}`, {
      method: "HEAD",
    });

    if (headResponse.ok) {
      // Blob exists, just claim it
      const claimResponse = await this.fetch(
        `/api/v1/blobs/${expectedHash}/claim`,
        {
          method: "POST",
        },
      );

      if (claimResponse.ok || claimResponse.status === 409) {
        // Either claimed or already claimed
        onProgress?.({
          phase: "complete",
          bytesProcessed: totalSize,
          totalBytes: totalSize,
        });

        // Fetch blob info
        const infoResponse = await this.fetch(`/api/v1/blobs/${expectedHash}`, {
          method: "HEAD",
        });
        const size = Number.parseInt(
          infoResponse.headers.get("Content-Length") ?? "0",
          10,
        );
        const blobMimeType =
          infoResponse.headers.get("Content-Type") ?? mimeType;

        return {
          hash: expectedHash,
          size,
          mimeType: blobMimeType,
        };
      }

      const error = await claimResponse.json();
      throw new Error(error.message ?? "Failed to claim blob");
    }

    // Phase 3: Upload chunks
    onProgress?.({
      phase: "uploading",
      bytesProcessed: 0,
      totalBytes: totalSize,
      chunksUploaded: 0,
      totalChunks: 0,
    });

    // Initialize upload
    const initResponse = await this.fetch("/api/v1/blobs/upload/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        size: totalSize,
        mimeType,
        expectedHash,
      }),
    });

    if (!initResponse.ok) {
      const error = await initResponse.json();
      throw new Error(error.message ?? "Failed to initialize upload");
    }

    const uploadInfo: InitUploadResponse = await initResponse.json();
    const { uploadId, chunkSize, totalChunks } = uploadInfo;

    // Upload chunks
    let bytesUploaded = 0;
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, totalSize);
      const chunk = bytes.slice(start, end);

      const chunkResponse = await this.fetch(
        `/api/v1/blobs/upload/${uploadId}/chunk/${i}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: chunk,
        },
      );

      if (!chunkResponse.ok) {
        const error = await chunkResponse.json();
        throw new Error(error.message ?? `Failed to upload chunk ${i}`);
      }

      bytesUploaded += chunk.length;
      onProgress?.({
        phase: "uploading",
        bytesProcessed: bytesUploaded,
        totalBytes: totalSize,
        chunksUploaded: i + 1,
        totalChunks,
      });
    }

    // Complete upload
    const completeResponse = await this.fetch(
      `/api/v1/blobs/upload/${uploadId}/complete`,
      {
        method: "POST",
      },
    );

    if (!completeResponse.ok) {
      const error = await completeResponse.json();
      throw new Error(error.message ?? "Failed to complete upload");
    }

    const result: CompleteUploadResponse = await completeResponse.json();

    onProgress?.({
      phase: "complete",
      bytesProcessed: totalSize,
      totalBytes: totalSize,
      chunksUploaded: totalChunks,
      totalChunks,
    });

    return {
      hash: result.hash,
      size: result.size,
      mimeType: result.mimeType,
    };
  }

  /**
   * Download a blob by its hash.
   *
   * @param hash - The SHA-256 hash of the blob
   * @returns The blob data as Uint8Array
   */
  async downloadBlob(hash: string): Promise<Uint8Array> {
    const response = await this.fetch(`/api/v1/blobs/${hash}`);

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message ?? "Failed to download blob");
    }

    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  /**
   * Get the direct URL for a blob.
   * Useful for <img src="..."> or other direct access.
   *
   * @param hash - The SHA-256 hash of the blob
   * @returns The full URL to the blob
   */
  getBlobUrl(hash: string): string {
    return `${this.serverUrl}/api/v1/blobs/${hash}`;
  }

  /**
   * Get blob metadata without downloading the content.
   *
   * @param hash - The SHA-256 hash of the blob
   * @returns The blob info or null if not found
   */
  async getBlobInfo(hash: string): Promise<BlobInfo | null> {
    const response = await this.fetch(`/api/v1/blobs/${hash}`, {
      method: "HEAD",
    });

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error("Failed to get blob info");
    }

    return {
      hash,
      size: Number.parseInt(response.headers.get("Content-Length") ?? "0", 10),
      mimeType:
        response.headers.get("Content-Type") ?? "application/octet-stream",
    };
  }

  /**
   * Claim an existing blob by its hash.
   *
   * @param hash - The SHA-256 hash of the blob
   * @returns The blob info
   */
  async claimBlob(hash: string): Promise<BlobInfo> {
    const response = await this.fetch(`/api/v1/blobs/${hash}/claim`, {
      method: "POST",
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message ?? "Failed to claim blob");
    }

    return response.json();
  }

  /**
   * Release a claim on a blob.
   *
   * @param hash - The SHA-256 hash of the blob
   */
  async releaseBlobClaim(hash: string): Promise<void> {
    const response = await this.fetch(`/api/v1/blobs/${hash}/claim`, {
      method: "DELETE",
    });

    if (!response.ok && response.status !== 404) {
      const error = await response.json();
      throw new Error(error.message ?? "Failed to release blob claim");
    }
  }

  /**
   * List all blobs claimed by the current user.
   *
   * @param options - Pagination options
   * @returns List of claimed blobs with quota info
   */
  async listClaimedBlobs(
    options: { limit?: number; offset?: number } = {},
  ): Promise<ListBlobsResponse> {
    const params = new URLSearchParams();
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.offset !== undefined)
      params.set("offset", String(options.offset));

    const query = params.toString();
    const response = await this.fetch(
      `/api/v1/blobs${query ? `?${query}` : ""}`,
    );

    if (!response.ok) {
      throw new Error("Failed to list blobs");
    }

    return response.json();
  }

  // ============ Document Blob Methods ============

  /**
   * Add a document claim on a blob.
   * The blob will be linked to the document and cleaned up when the document is deleted.
   *
   * @param documentId - The document ID
   * @param blobHash - The SHA-256 hash of the blob
   */
  async addDocumentBlobClaim(
    documentId: string,
    blobHash: string,
  ): Promise<void> {
    const response = await this.fetch(
      `/api/v1/documents/${encodeURIComponent(documentId)}/blobs/${blobHash}`,
      {
        method: "POST",
      },
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message ?? "Failed to add document blob claim");
    }
  }

  /**
   * Remove a document claim on a blob.
   *
   * @param documentId - The document ID
   * @param blobHash - The SHA-256 hash of the blob
   */
  async removeDocumentBlobClaim(
    documentId: string,
    blobHash: string,
  ): Promise<void> {
    const response = await this.fetch(
      `/api/v1/documents/${encodeURIComponent(documentId)}/blobs/${blobHash}`,
      {
        method: "DELETE",
      },
    );

    if (!response.ok && response.status !== 404) {
      const error = await response.json();
      throw new Error(error.message ?? "Failed to remove document blob claim");
    }
  }

  /**
   * List all blobs claimed by a document.
   *
   * @param documentId - The document ID
   * @returns List of blobs with total size
   */
  async listDocumentBlobs(documentId: string): Promise<DocumentBlobsResponse> {
    const response = await this.fetch(
      `/api/v1/documents/${encodeURIComponent(documentId)}/blobs`,
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message ?? "Failed to list document blobs");
    }

    return response.json();
  }

  /**
   * Upload a blob and immediately attach it to a document.
   *
   * @param documentId - The document ID to attach the blob to
   * @param data - The blob data to upload
   * @param options - Upload options
   * @returns The uploaded blob info
   */
  async uploadBlobToDocument(
    documentId: string,
    data: Blob | File | ArrayBuffer | Uint8Array,
    options: {
      mimeType?: string;
      onProgress?: (progress: BlobUploadProgress) => void;
    } = {},
  ): Promise<BlobInfo> {
    // Upload the blob
    const blobInfo = await this.uploadBlob(data, options);

    // Add document claim
    await this.addDocumentBlobClaim(documentId, blobInfo.hash);

    return blobInfo;
  }

  /**
   * Make an authenticated fetch request to the server.
   */
  private async fetch(
    path: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(options.headers);

    if (this.token) {
      headers.set("Authorization", `Bearer ${this.token}`);
    }

    return fetch(`${this.serverUrl}${path}`, {
      ...options,
      headers,
    });
  }
}
