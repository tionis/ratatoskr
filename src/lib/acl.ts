import type { ACLEntry, Permission } from "./types.ts";

const MAX_ACL_DEPTH = 10;

export interface ACLResolver {
  getDocumentOwner(documentId: string): Promise<string | null>;
  getDocumentACL(documentId: string): Promise<ACLEntry[]>;
}

export interface ResolvedPermission {
  canRead: boolean;
  canWrite: boolean;
}

/**
 * Resolves the effective permissions for a user on a document.
 * Handles recursive ACL resolution through document references.
 */
export async function resolvePermissions(
  resolver: ACLResolver,
  documentId: string,
  userId: string | null,
  depth = 0,
  visited = new Set<string>(),
): Promise<ResolvedPermission> {
  // Prevent infinite loops
  if (visited.has(documentId)) {
    return { canRead: false, canWrite: false };
  }
  visited.add(documentId);

  // Check if user is owner
  const ownerId = await resolver.getDocumentOwner(documentId);
  if (ownerId === null) {
    return { canRead: false, canWrite: false };
  }

  if (userId !== null && ownerId === userId) {
    return { canRead: true, canWrite: true };
  }

  // Get ACL entries
  const acl = await resolver.getDocumentACL(documentId);

  let canRead = false;
  let canWrite = false;

  for (const entry of acl) {
    // Check public access
    if (entry.principal === "public") {
      if (entry.permission === "write") {
        canWrite = true;
        canRead = true;
      } else {
        canRead = true;
      }
      continue;
    }

    // Check direct user match
    if (userId !== null && entry.principal === userId) {
      if (entry.permission === "write") {
        canWrite = true;
        canRead = true;
      } else {
        canRead = true;
      }
      continue;
    }

    // Check document reference (recursive ACL)
    if (depth < MAX_ACL_DEPTH) {
      const refPermissions = await resolvePermissions(
        resolver,
        entry.principal,
        userId,
        depth + 1,
        visited,
      );

      // If user has access to the referenced document, grant the specified permission
      if (refPermissions.canRead || refPermissions.canWrite) {
        if (entry.permission === "write") {
          canWrite = true;
          canRead = true;
        } else {
          canRead = true;
        }
      }
    }
  }

  return { canRead, canWrite };
}

/**
 * Checks if a user has at least the specified permission on a document.
 */
export async function checkPermission(
  resolver: ACLResolver,
  documentId: string,
  userId: string | null,
  required: Permission,
): Promise<boolean> {
  const permissions = await resolvePermissions(resolver, documentId, userId);

  if (required === "write") {
    return permissions.canWrite;
  }
  return permissions.canRead;
}
