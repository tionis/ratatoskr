/**
 * Document permission checking for sync operations.
 */

import { type ACLResolver, checkPermission } from "../lib/acl.ts";
import { parseDocumentId } from "../lib/types.ts";
import {
  getDocument,
  getDocumentACL,
  getDocumentByAutomergeId,
} from "../storage/database.ts";

/**
 * Create an ACL resolver backed by our database.
 */
function createACLResolver(): ACLResolver {
  return {
    async getDocumentOwner(documentId: string): Promise<string | null> {
      // For automerge document IDs, we need to map them to our doc: prefixed IDs
      const ourDocId = mapAutomergeIdToOurId(documentId);
      const doc = getDocument(ourDocId);
      return doc?.ownerId ?? null;
    },

    async getDocumentACL(documentId: string) {
      const ourDocId = mapAutomergeIdToOurId(documentId);
      return getDocumentACL(ourDocId);
    },
  };
}

/**
 * Map an automerge document ID to our prefixed document ID.
 *
 * Automerge uses IDs like "4NMNnkMhL8jXrdJ9jamS58PAVdXu".
 * We use IDs like "doc:namespace-4NMNnkMhL8jXrdJ9jamS58PAVdXu".
 *
 * This function first checks if there's a document registered with
 * this automerge ID, and returns its full document ID if found.
 * Otherwise falls back to simple prefix mapping.
 */
function mapAutomergeIdToOurId(automergeId: string): string {
  // If it already has our prefix, use it
  if (
    automergeId.startsWith("doc:") ||
    automergeId.startsWith("app:") ||
    automergeId.startsWith("eph:")
  ) {
    return automergeId;
  }

  // Look up by automerge ID in the database
  const doc = getDocumentByAutomergeId(automergeId);
  if (doc) {
    return doc.id;
  }

  // Default to doc: prefix for unrecognized IDs
  return `doc:${automergeId}`;
}

/**
 * Check if a user can read a document.
 */
export async function canReadDocument(
  documentId: string,
  userId: string | null,
): Promise<boolean> {
  const ourDocId = mapAutomergeIdToOurId(documentId);

  // Check document type
  try {
    const { prefix } = parseDocumentId(ourDocId);

    // Ephemeral documents are always readable (they're relay-only)
    if (prefix === "eph") {
      return true;
    }

    // App documents are only readable by their owner
    if (prefix === "app") {
      if (!userId) return false;
      const doc = getDocument(ourDocId);
      return doc?.ownerId === userId;
    }
  } catch {
    // If parsing fails, proceed with normal ACL check
  }

  // For doc: prefixed documents, check ACL
  const resolver = createACLResolver();
  return checkPermission(resolver, ourDocId, userId, "read");
}

/**
 * Check if a user can write to a document.
 */
export async function canWriteDocument(
  documentId: string,
  userId: string | null,
): Promise<boolean> {
  const ourDocId = mapAutomergeIdToOurId(documentId);

  // Check document type
  try {
    const { prefix } = parseDocumentId(ourDocId);

    // Ephemeral documents are always writable (they're relay-only)
    if (prefix === "eph") {
      return true;
    }

    // App documents are only writable by their owner
    if (prefix === "app") {
      if (!userId) return false;
      const doc = getDocument(ourDocId);
      return doc?.ownerId === userId;
    }
  } catch {
    // If parsing fails, proceed with normal ACL check
  }

  // For doc: prefixed documents, check ACL
  const resolver = createACLResolver();
  return checkPermission(resolver, ourDocId, userId, "write");
}

/**
 * Check if a document exists in our metadata store.
 */
export function documentExists(documentId: string): boolean {
  const ourDocId = mapAutomergeIdToOurId(documentId);
  return getDocument(ourDocId) !== null;
}

/**
 * Check if a document is ephemeral.
 */
export function isEphemeralDocument(documentId: string): boolean {
  const ourDocId = mapAutomergeIdToOurId(documentId);
  try {
    const { prefix } = parseDocumentId(ourDocId);
    return prefix === "eph";
  } catch {
    return false;
  }
}
