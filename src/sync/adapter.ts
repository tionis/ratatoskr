/**
 * Automerge-repo network adapter for Ratatoskr.
 *
 * This is a placeholder for the actual automerge-repo integration.
 * The full implementation will need to:
 *
 * 1. Integrate with @automerge/automerge-repo's NetworkAdapter interface
 * 2. Handle document storage via our storage layer
 * 3. Enforce permissions on document access
 * 4. Support ephemeral documents (relay-only, no persistence)
 *
 * See: https://automerge.org/docs/repositories/networking/
 */

import type { WebSocket } from "@fastify/websocket";
import { type ACLResolver, checkPermission } from "../lib/acl.ts";
import type { AuthContext } from "../lib/types.ts";
import { getDocument, getDocumentACL } from "../storage/database.ts";
import { readDocument, writeDocument } from "../storage/documents.ts";

// Placeholder for automerge-repo types
// These will be replaced with actual imports when implementing

export interface RatatoskrNetworkAdapter {
  // Connection management
  addConnection(socket: WebSocket, auth: AuthContext): void;
  removeConnection(socket: WebSocket): void;

  // Document operations (permission-checked)
  requestDocument(
    socket: WebSocket,
    documentId: string,
  ): Promise<Uint8Array | null>;
  sendChanges(
    socket: WebSocket,
    documentId: string,
    changes: Uint8Array,
  ): Promise<boolean>;
}

/**
 * Create an ACL resolver backed by our database.
 */
export function createACLResolver(): ACLResolver {
  return {
    async getDocumentOwner(documentId: string): Promise<string | null> {
      const doc = getDocument(documentId);
      return doc?.ownerId ?? null;
    },

    async getDocumentACL(documentId: string) {
      return getDocumentACL(documentId);
    },
  };
}

/**
 * Check if a user can read a document.
 */
export async function canReadDocument(
  documentId: string,
  userId: string | null,
): Promise<boolean> {
  const resolver = createACLResolver();
  return checkPermission(resolver, documentId, userId, "read");
}

/**
 * Check if a user can write to a document.
 */
export async function canWriteDocument(
  documentId: string,
  userId: string | null,
): Promise<boolean> {
  const resolver = createACLResolver();
  return checkPermission(resolver, documentId, userId, "write");
}

/**
 * Load document data from storage.
 * Returns null if document doesn't exist or user lacks permission.
 */
export async function loadDocument(
  documentId: string,
  userId: string | null,
): Promise<Uint8Array | null> {
  if (!(await canReadDocument(documentId, userId))) {
    return null;
  }

  return readDocument(documentId);
}

/**
 * Save document data to storage.
 * Returns false if user lacks permission.
 */
export async function saveDocument(
  documentId: string,
  userId: string | null,
  data: Uint8Array,
): Promise<boolean> {
  if (!(await canWriteDocument(documentId, userId))) {
    return false;
  }

  await writeDocument(documentId, data);
  return true;
}
