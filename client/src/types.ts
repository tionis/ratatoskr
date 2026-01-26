/**
 * Shared types for the Ratatoskr client.
 */

export interface User {
  id: string;
  email?: string;
  name?: string;
}

export interface ACLEntry {
  principal: string;
  permission: "read" | "write";
}

export interface DocumentMetadata {
  id: string;
  owner: string;
  type: string | null;
  size: number;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDocumentRequest {
  id: string;
  automergeId?: string;
  type?: string;
  acl?: ACLEntry[];
  expiresAt?: string;
}

export interface ListDocumentsResponse {
  owned: DocumentMetadata[];
  accessible: DocumentMetadata[];
}

export interface ApiToken {
  id: string;
  name: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}
