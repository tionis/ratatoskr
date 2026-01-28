/**
 * Shared types for the Ratatoskr client.
 */

export interface User {
  id: string;
  email?: string;
  name?: string;
  userDocumentId?: string;
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

// Blob types

export interface BlobInfo {
  hash: string;
  size: number;
  mimeType: string;
  claimedAt?: string;
}

export interface BlobUploadProgress {
  phase: "hashing" | "checking" | "uploading" | "complete";
  bytesProcessed: number;
  totalBytes: number;
  chunksUploaded?: number;
  totalChunks?: number;
}

export interface InitUploadResponse {
  uploadId: string;
  chunkSize: number;
  totalChunks: number;
  expiresAt: string;
}

export interface CompleteUploadResponse {
  hash: string;
  size: number;
  mimeType: string;
  deduplicated: boolean;
}

export interface ListBlobsResponse {
  blobs: BlobInfo[];
  total: number;
  quotaUsed: number;
  quotaLimit: number;
}

export interface DocumentBlobsResponse {
  blobs: BlobInfo[];
  totalSize: number;
}
