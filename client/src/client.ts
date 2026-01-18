/**
 * High-level Ratatoskr client.
 *
 * Provides a convenient API for:
 * - Authentication
 * - Document management
 * - Automerge-repo integration
 * - Offline-first document creation
 */

import { type PeerId, Repo } from "@automerge/automerge-repo";
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
  CreateDocumentRequest,
  DocumentMetadata,
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
