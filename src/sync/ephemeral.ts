/**
 * Ephemeral document management.
 *
 * Ephemeral documents are relay-only documents that don't persist data.
 * They're useful for temporary collaboration sessions and peer-to-peer signaling.
 *
 * Key characteristics:
 * - Use the `eph:` prefix
 * - Don't persist to storage
 * - Are the only document type anonymous users can create
 * - Have a timeout after the last peer disconnects
 */

import { config } from "../config.ts";

interface EphemeralDocument {
  id: string;
  createdAt: Date;
  expiresAt: Date | null;
  connectedPeers: Set<string>;
  cleanupTimer: Timer | null;
}

class EphemeralDocumentManager {
  private documents: Map<string, EphemeralDocument> = new Map();

  /**
   * Create or get an ephemeral document.
   */
  getOrCreate(documentId: string): EphemeralDocument {
    let doc = this.documents.get(documentId);

    if (!doc) {
      doc = {
        id: documentId,
        createdAt: new Date(),
        expiresAt: null,
        connectedPeers: new Set(),
        cleanupTimer: null,
      };
      this.documents.set(documentId, doc);
    }

    return doc;
  }

  /**
   * Check if an ephemeral document exists.
   */
  exists(documentId: string): boolean {
    return this.documents.has(documentId);
  }

  /**
   * Add a peer to an ephemeral document.
   */
  addPeer(documentId: string, peerId: string): void {
    const doc = this.getOrCreate(documentId);
    doc.connectedPeers.add(peerId);

    // Cancel any pending cleanup
    if (doc.cleanupTimer) {
      clearTimeout(doc.cleanupTimer);
      doc.cleanupTimer = null;
    }
  }

  /**
   * Remove a peer from an ephemeral document.
   * Starts cleanup timer if no peers remain.
   */
  removePeer(documentId: string, peerId: string): void {
    const doc = this.documents.get(documentId);
    if (!doc) return;

    doc.connectedPeers.delete(peerId);

    // If no peers remain, start cleanup timer
    if (doc.connectedPeers.size === 0) {
      this.scheduleCleanup(documentId);
    }
  }

  /**
   * Set expiration time for an ephemeral document.
   */
  setExpiration(documentId: string, expiresAt: Date | null): void {
    const doc = this.documents.get(documentId);
    if (!doc) return;

    doc.expiresAt = expiresAt;

    // If explicitly expired, clean up immediately
    if (expiresAt && expiresAt <= new Date()) {
      this.cleanup(documentId);
    }
  }

  /**
   * Schedule cleanup of an ephemeral document.
   */
  private scheduleCleanup(documentId: string): void {
    const doc = this.documents.get(documentId);
    if (!doc) return;

    // Don't schedule if peers are connected
    if (doc.connectedPeers.size > 0) return;

    // Cancel existing timer
    if (doc.cleanupTimer) {
      clearTimeout(doc.cleanupTimer);
    }

    // Determine timeout
    let timeoutMs = config.ephemeralTimeoutSeconds * 1000;

    // If explicit expiration is set and is sooner, use that
    if (doc.expiresAt) {
      const msUntilExpiry = doc.expiresAt.getTime() - Date.now();
      if (msUntilExpiry < timeoutMs) {
        timeoutMs = Math.max(0, msUntilExpiry);
      }
    }

    doc.cleanupTimer = setTimeout(() => {
      this.cleanup(documentId);
    }, timeoutMs);
  }

  /**
   * Clean up an ephemeral document.
   */
  private cleanup(documentId: string): void {
    const doc = this.documents.get(documentId);
    if (!doc) return;

    if (doc.cleanupTimer) {
      clearTimeout(doc.cleanupTimer);
    }

    this.documents.delete(documentId);
  }

  /**
   * Get stats about ephemeral documents.
   */
  getStats(): { count: number; totalPeers: number } {
    let totalPeers = 0;
    for (const doc of this.documents.values()) {
      totalPeers += doc.connectedPeers.size;
    }
    return {
      count: this.documents.size,
      totalPeers,
    };
  }

  /**
   * Clean up all ephemeral documents.
   */
  shutdown(): void {
    for (const doc of this.documents.values()) {
      if (doc.cleanupTimer) {
        clearTimeout(doc.cleanupTimer);
      }
    }
    this.documents.clear();
  }
}

// Singleton instance
export const ephemeralManager = new EphemeralDocumentManager();

/**
 * Check if a document ID is ephemeral.
 */
export function isEphemeralId(documentId: string): boolean {
  return documentId.startsWith("eph:");
}
