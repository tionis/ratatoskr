import { z } from "zod";

// Document ID patterns
export const documentIdSchema = z.string().min(1);

export type DocumentId = z.infer<typeof documentIdSchema>;

export type DocumentPrefix = "doc" | "app" | "eph";

export function parseDocumentId(id: string): {
  prefix: DocumentPrefix;
  localId: string;
} {
  if (id.startsWith("eph:")) {
    return { prefix: "eph", localId: id.slice(4) };
  }
  if (id.startsWith("app:")) {
    return { prefix: "app", localId: id.slice(4) };
  }
  if (id.startsWith("doc:")) {
    return { prefix: "doc", localId: id.slice(4) };
  }
  // Default to "doc" for unprefixed IDs (standard Automerge IDs)
  return {
    prefix: "doc",
    localId: id,
  };
}

// Permission types
export const permissionSchema = z.enum(["read", "write"]);
export type Permission = z.infer<typeof permissionSchema>;

// ACL entry
export const aclEntrySchema = z.object({
  principal: z.string(), // user ID, document ID, or "public"
  permission: permissionSchema,
});
export type ACLEntry = z.infer<typeof aclEntrySchema>;

// User
export interface User {
  id: string;
  email: string | null;
  name: string | null;
  userDocumentId: string | null;
  quotaMaxDocuments: number;
  quotaMaxDocumentSize: number;
  quotaMaxTotalStorage: number;
  quotaMaxBlobStorage: number;
  quotaMaxBlobSize: number;
  createdAt: Date;
  updatedAt: Date;
}

// Document metadata
export interface DocumentMetadata {
  id: string;
  ownerId: string;
  automergeId: string | null;
  type: string;
  size: number;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// API Token
export interface ApiToken {
  id: string;
  userId: string;
  name: string;
  scopes: string[] | null;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

// Auth context for requests
export interface AuthContext {
  userId: string;
  isAnonymous: boolean;
}

// Blob metadata
export interface BlobMetadata {
  hash: string;
  size: number;
  mimeType: string;
  createdAt: Date;
  releasedAt: Date | null;
}

// Blob claim (user claiming a blob)
export interface BlobClaim {
  blobHash: string;
  userId: string;
  claimedAt: Date;
}

// Document blob claim (document claiming a blob)
export interface DocumentBlobClaim {
  blobHash: string;
  documentId: string;
  ownerId: string;
  claimedAt: Date;
}

// Blob upload session (for chunked uploads)
export interface BlobUpload {
  id: string;
  userId: string;
  expectedHash: string | null;
  expectedSize: number;
  mimeType: string;
  chunkSize: number;
  chunksReceived: number;
  totalChunks: number;
  createdAt: Date;
  expiresAt: Date;
}

// Blob hash validation (SHA-256 hex string, 64 chars)
export const blobHashSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Blob hash must be a valid SHA-256 hex string");

export type BlobHash = z.infer<typeof blobHashSchema>;
