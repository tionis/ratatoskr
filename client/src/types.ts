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
  type: string;
  size: number;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDocumentRequest {
  id: string;
  type: string;
  acl?: ACLEntry[];
  expiresAt?: string;
}

export interface ListDocumentsResponse {
  owned: DocumentMetadata[];
  accessible: DocumentMetadata[];
}
