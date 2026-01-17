import { z } from "zod";

// Document ID patterns
export const documentIdSchema = z
  .string()
  .regex(
    /^(doc|app|eph):[a-zA-Z0-9._-]+$/,
    "Document ID must be prefixed with doc:, app:, or eph: followed by alphanumeric characters",
  );

export type DocumentId = z.infer<typeof documentIdSchema>;

export type DocumentPrefix = "doc" | "app" | "eph";

export function parseDocumentId(id: string): {
  prefix: DocumentPrefix;
  localId: string;
} {
  const [prefix, ...rest] = id.split(":");
  if (!prefix || !["doc", "app", "eph"].includes(prefix)) {
    throw new Error(`Invalid document ID prefix: ${prefix}`);
  }
  return {
    prefix: prefix as DocumentPrefix,
    localId: rest.join(":"),
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
  quotaMaxDocuments: number;
  quotaMaxDocumentSize: number;
  quotaMaxTotalStorage: number;
  createdAt: Date;
  updatedAt: Date;
}

// Document metadata
export interface DocumentMetadata {
  id: string;
  ownerId: string;
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
