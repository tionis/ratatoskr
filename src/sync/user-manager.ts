import type { DocHandle } from "@automerge/automerge-repo";
import {
  getAccessibleDocuments,
  getDocumentsByOwner,
  getUser,
  updateUser,
} from "../storage/database.ts";
import { getRepo } from "./repo.ts";

interface UserDocument {
  profile: {
    id: string;
    name: string | null;
    email: string | null;
  };
  owned: Record<string, MinimalDocInfo>;
  shared: Record<string, MinimalDocInfo>;
}

interface MinimalDocInfo {
  id: string;
  type: string;
  updatedAt: string;
}

class UserManager {
  private handles: Map<string, DocHandle<UserDocument>> = new Map();

  /**
   * Ensure the user has a User Document and it is up-to-date.
   * Called on user login.
   */
  async ensureUserDocument(userId: string): Promise<string> {
    const user = getUser(userId);
    if (!user) throw new Error("User not found");

    let docId = user.userDocumentId;
    const repo = getRepo();

    if (!docId) {
      // Create new user document
      const handle = repo.create<UserDocument>();
      docId = handle.url.replace("automerge:", "");

      // Update user record
      updateUser(userId, { userDocumentId: docId });

      // Initial population
      handle.change((doc) => {
        doc.profile = {
          id: user.id,
          name: user.name,
          email: user.email,
        };
        doc.owned = {};
        doc.shared = {};
      });
    }

    // Sync latest state from DB to Document
    await this.syncDbToDoc(userId, docId);

    // Start watching for changes (Sync Doc to DB)
    this.watchUserDocument(userId, docId);

    return docId;
  }

  /**
   * Sync current DB state (documents list) to the User Document.
   */
  async syncDbToDoc(userId: string, docId: string): Promise<void> {
    const repo = getRepo();
    const handle = await repo.find<UserDocument>(`automerge:${docId}` as any);

    // Ensure we have the latest state
    await handle.whenReady();

    const ownedDocs = getDocumentsByOwner(userId);
    const sharedDocs = getAccessibleDocuments(userId).filter(
      (d) => d.ownerId !== userId,
    );

    handle.change((doc: any) => {
      // Update Owned
      const currentOwnedIds = new Set(Object.keys(doc.owned || {}));
      const newOwnedIds = new Set<string>();

      for (const d of ownedDocs) {
        newOwnedIds.add(d.id);
        if (!doc.owned) doc.owned = {};
        doc.owned[d.id] = {
          id: d.id,
          type: d.type,
          updatedAt: d.updatedAt.toISOString(),
        };
      }

      // Remove deleted owned docs
      for (const id of currentOwnedIds) {
        if (!newOwnedIds.has(id)) {
          delete doc.owned[id];
        }
      }

      // Update Shared
      const currentSharedIds = new Set(Object.keys(doc.shared || {}));
      const newSharedIds = new Set<string>();

      for (const d of sharedDocs) {
        newSharedIds.add(d.id);
        if (!doc.shared) doc.shared = {};
        doc.shared[d.id] = {
          id: d.id,
          type: d.type,
          updatedAt: d.updatedAt.toISOString(),
        };
      }

      // Remove revoked shared docs
      for (const id of currentSharedIds) {
        if (!newSharedIds.has(id)) {
          delete doc.shared[id];
        }
      }
    });
  }

  /**
   * Watch the User Document for changes (e.g. ACL updates) and sync back to DB.
   */
  private async watchUserDocument(userId: string, docId: string) {
    if (this.handles.has(userId)) return; // Already watching

    const repo = getRepo();
    const handle = await repo.find<UserDocument>(`automerge:${docId}` as any);
    this.handles.set(userId, handle);

    handle.on("change", ({ doc: _doc }: any) => {
      // TODO: Implement Sync Doc -> DB logic
      // e.g. check for ACL changes in doc.owned[id].acl if we add that field
      // For now, this is a placeholder as the requirement specified "Server watches for changes... and sync them back"
      // but we haven't defined the exact schema for ACLs in the doc yet.
    });
  }

  /**
   * Stop watching a user document (on disconnect).
   */
  stopWatching(_userId: string) {
    // In a real server, we might want to keep watching active users for a while,
    // or stop immediately. For now, we assume we keep handles in memory or rely on repo cache.
    // To properly "unwatch", we'd remove the listener.
    // automerge-repo handles don't have "off" easily exposed in all versions,
    // but we can just drop the reference if we don't need to explicitly unsubscribe.
    // However, if we attached a listener, it persists.
    // For this POC, we'll leave it attached.
  }
}

export const userManager = new UserManager();
