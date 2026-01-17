/**
 * High-level Ratatoskr client.
 *
 * Provides a convenient API for:
 * - Authentication
 * - Document management
 * - Automerge-repo integration
 */

import { type PeerId, Repo } from "@automerge/automerge-repo";
import {
  authenticate,
  clearStoredToken,
  getStoredToken,
  storeToken,
} from "./auth.ts";
import { RatatoskrNetworkAdapter } from "./network-adapter.ts";
import type {
  ACLEntry,
  CreateDocumentRequest,
  DocumentMetadata,
  ListDocumentsResponse,
  User,
} from "./types.ts";

export interface RatatoskrClientOptions {
  serverUrl: string;
  tokenStorageKey?: string;
}

export class RatatoskrClient {
  private serverUrl: string;
  private tokenStorageKey: string;
  private token: string | null = null;
  private user: User | null = null;
  private repo: Repo | null = null;
  private networkAdapter: RatatoskrNetworkAdapter | null = null;

  constructor(options: RatatoskrClientOptions) {
    this.serverUrl = options.serverUrl.replace(/\/$/, ""); // Remove trailing slash
    this.tokenStorageKey = options.tokenStorageKey ?? "ratatoskr:token";

    // Try to restore token from storage
    this.token = getStoredToken(this.tokenStorageKey);
  }

  /**
   * Check if the user is authenticated.
   */
  isAuthenticated(): boolean {
    return this.token !== null;
  }

  /**
   * Get the current user, or null if not authenticated.
   */
  getUser(): User | null {
    return this.user;
  }

  /**
   * Authenticate using popup-based OIDC flow.
   */
  async login(): Promise<User> {
    const result = await authenticate(this.serverUrl);

    this.token = result.token;
    this.user = result.user;

    // Store token
    storeToken(this.tokenStorageKey, this.token);

    // Update network adapter if connected
    if (this.networkAdapter) {
      this.networkAdapter.setToken(this.token);
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

    // Create network adapter
    this.networkAdapter = new RatatoskrNetworkAdapter({
      serverUrl: this.serverUrl,
      token: this.token ?? undefined,
    });

    // Create repo
    this.repo = new Repo({
      network: [this.networkAdapter],
      peerId: `client-${crypto.randomUUID()}` as PeerId,
    });

    return this.repo;
  }

  /**
   * Fetch current user info from server.
   */
  async fetchUserInfo(): Promise<User> {
    const response = await this.fetch("/api/v1/auth/userinfo");

    if (!response.ok) {
      throw new Error("Failed to fetch user info");
    }

    this.user = await response.json();
    return this.user!;
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
