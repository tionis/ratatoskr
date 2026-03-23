/**
 * Server-side network adapter for automerge-repo.
 *
 * This adapter manages WebSocket connections from clients, handling:
 * - Authentication
 * - Permission checking for document access
 * - Message routing between clients and the repo
 */

import { decodeSyncMessage } from "@automerge/automerge";
import {
  cbor,
  type Message,
  NetworkAdapter,
  type PeerId,
  type PeerMetadata,
} from "@automerge/automerge-repo";
import type { WebSocket } from "@fastify/websocket";
import { verifyApiToken, verifySessionToken } from "../auth/tokens.ts";
import { config } from "../config.ts";
import {
  checkDocumentSizeQuota,
  checkTotalStorageQuota,
} from "../lib/quotas.ts";
import { checkRateLimit } from "../lib/rate-limit.ts";
import {
  getDocument,
  getDocumentByAutomergeId,
  getUser,
  getUserTotalStorage,
  updateDocumentSize,
} from "../storage/database.ts";
import { ephemeralManager, isEphemeralId } from "./ephemeral.ts";
import { canReadDocument, canWriteDocument } from "./permissions.ts";
import { userManager } from "./user-manager.ts";

interface AuthenticatedClient {
  peerId: PeerId;
  socket: WebSocket;
  userId: string | null;
  isAnonymous: boolean;
  ephemeralDocs: Set<string>; // Track which ephemeral docs this peer is connected to
  /** Documents this peer has passed read permission checks for (built on inbound). */
  authorizedDocs: Set<string>;
}

function messageContainsChanges(message: Message): boolean | null {
  if (message.type !== "sync" || !message.data) {
    return null;
  }

  try {
    const decoded = decodeSyncMessage(message.data);
    return decoded.changes.length > 0;
  } catch {
    return null;
  }
}

/**
 * Server-side network adapter that manages multiple WebSocket clients.
 */
export class ServerNetworkAdapter extends NetworkAdapter {
  private clients: Map<PeerId, AuthenticatedClient> = new Map();
  private socketToPeer: Map<WebSocket, PeerId> = new Map();
  private ready = false;

  connect(peerId: PeerId, peerMetadata?: PeerMetadata): void {
    this.peerId = peerId;
    this.peerMetadata = peerMetadata ?? {};
    this.ready = true;
    // biome-ignore lint/suspicious/noExplicitAny: event type strictness
    this.emit("ready" as any, { network: this });
  }

  disconnect(): void {
    for (const client of this.clients.values()) {
      client.socket.close();
    }
    this.clients.clear();
    this.socketToPeer.clear();
    this.ready = false;
    this.emit("close");
  }

  send(message: Message): void {
    const client = this.clients.get(message.targetId);
    if (!client) {
      return;
    }

    // Check outbound permission for document-scoped messages.
    // The repo may try to push document state to any peer — we must filter.
    if ("documentId" in message && message.documentId) {
      const docId = message.documentId as string;
      // Ephemeral docs are always allowed
      if (!isEphemeralId(docId) && !client.authorizedDocs.has(docId)) {
        // Peer hasn't passed a read check for this doc — drop silently.
        return;
      }
    }

    const encoded = cbor.encode(message);
    client.socket.send(encoded);
  }

  isReady(): boolean {
    return this.ready;
  }

  async whenReady(): Promise<void> {
    if (this.ready) return;
    return new Promise((resolve) => {
      // biome-ignore lint/suspicious/noExplicitAny: event type strictness
      this.once("ready" as any, () => resolve(undefined));
    });
  }

  /**
   * Handle a new WebSocket connection.
   * Returns a cleanup function to call when the connection closes.
   */
  async handleConnection(
    socket: WebSocket,
    clientIp: string,
  ): Promise<(() => void) | null> {
    return new Promise((resolve) => {
      let authTimeout: Timer | null = null;
      let client: AuthenticatedClient | null = null;

      // Require auth message within 10 seconds
      authTimeout = setTimeout(() => {
        if (!client) {
          socket.send(
            cbor.encode({
              type: "error",
              error: "auth_timeout",
              message: "Authentication required within 10 seconds",
            }),
          );
          socket.close();
          resolve(null);
        }
      }, 10_000);

      const handleMessage = async (data: Buffer | ArrayBuffer | Buffer[]) => {
        let message: { type: string; token?: string; [key: string]: unknown };

        try {
          const bytes =
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : Array.isArray(data)
                ? Buffer.concat(data)
                : data;
          message = cbor.decode(bytes) as typeof message;
        } catch {
          socket.send(
            cbor.encode({
              type: "error",
              error: "invalid_message",
              message: "Failed to decode message",
            }),
          );
          return;
        }

        // Handle auth message
        if (message.type === "auth") {
          if (client) {
            socket.send(
              cbor.encode({
                type: "error",
                error: "already_authenticated",
                message: "Already authenticated",
              }),
            );
            return;
          }

          if (authTimeout) {
            clearTimeout(authTimeout);
            authTimeout = null;
          }

          const token = message.token as string | undefined;
          const wantsAnonymous = message.anonymous === true;
          let userId: string | null = null;
          let isAnonymous = true;

          if (token) {
            // Try session token
            const payload = verifySessionToken(token);
            if (payload) {
              userId = payload.sub;
              isAnonymous = false;
            } else {
              // Try API token
              const apiToken = verifyApiToken(token);
              if (apiToken) {
                userId = apiToken.userId;
                isAnonymous = false;
              }
            }

            if (!userId) {
              socket.send(
                cbor.encode({
                  type: "auth_error",
                  error: "invalid_token",
                  message: "Invalid or expired token",
                }),
              );
              socket.close();
              resolve(null);
              return;
            }
          } else if (!wantsAnonymous) {
            // No token and not explicitly requesting anonymous access
            socket.send(
              cbor.encode({
                type: "auth_error",
                error: "missing_credentials",
                message: "Provide a token or set anonymous: true",
              }),
            );
            socket.close();
            resolve(null);
            return;
          }

          // Rate limit anonymous connections
          if (isAnonymous) {
            const rateLimit = checkRateLimit(
              "anon_connections",
              clientIp,
              config.rateLimits.anon.connectionsPerMinute,
              60_000,
            );

            if (!rateLimit.allowed) {
              socket.send(
                cbor.encode({
                  type: "error",
                  error: "rate_limited",
                  message: "Too many connections",
                  retryAfter: rateLimit.retryAfter,
                }),
              );
              socket.close();
              resolve(null);
              return;
            }
          }

          // Always generate peer IDs server-side.
          const peerId = `client-${crypto.randomUUID()}` as PeerId;

          client = {
            peerId,
            socket,
            userId,
            isAnonymous,
            ephemeralDocs: new Set(),
            authorizedDocs: new Set(),
          };

          this.clients.set(peerId, client);
          this.socketToPeer.set(socket, peerId);

          // Send auth success with SERVER'S peerId
          socket.send(
            cbor.encode({
              type: "auth_ok",
              peerId: this.peerId, // Send server's peer ID
              clientPeerId: peerId,
              user: userId ? { id: userId } : null,
            }),
          );

          // Ensure User Document exists and is synced
          if (userId) {
            userManager.ensureUserDocument(userId).catch((err) => {
              console.error(
                `Failed to ensure user document for ${userId}:`,
                err,
              );
            });
          }

          // Announce new peer to the repo
          this.emit("peer-candidate", {
            peerId,
            peerMetadata: {
              isEphemeral: isAnonymous,
            },
          });

          resolve(() => this.handleDisconnect(peerId));
          return;
        }

        // All other messages require authentication
        if (!client) {
          socket.send(
            cbor.encode({
              type: "error",
              error: "not_authenticated",
              message: "Send auth message first",
            }),
          );
          return;
        }

        // Handle automerge-repo messages
        await this.handleRepoMessage(client, message as Message);
      };

      socket.on("message", handleMessage);

      socket.on("close", () => {
        if (authTimeout) {
          clearTimeout(authTimeout);
        }
        if (client) {
          this.handleDisconnect(client.peerId);
        }
      });

      socket.on("error", () => {
        if (client) {
          this.handleDisconnect(client.peerId);
        }
      });
    });
  }

  private handleDisconnect(peerId: PeerId): void {
    const client = this.clients.get(peerId);
    if (!client) {
      // Already cleaned up (idempotent — may be called from multiple handlers)
      return;
    }

    this.socketToPeer.delete(client.socket);

    // Clean up ephemeral document connections
    for (const docId of client.ephemeralDocs) {
      ephemeralManager.removePeer(docId, peerId);
    }

    // Stop watching user document
    if (client.userId) {
      userManager.stopWatching(client.userId);
    }

    this.clients.delete(peerId);
    this.emit("peer-disconnected", { peerId });
  }

  /**
   * Handle automerge-repo protocol messages with permission checking.
   */
  private async handleRepoMessage(
    client: AuthenticatedClient,
    message: Message,
  ): Promise<void> {
    const { type } = message;

    // Rate limit anonymous users
    if (client.isAnonymous) {
      const rateLimit = checkRateLimit(
        "anon_messages",
        client.peerId,
        config.rateLimits.anon.messagesPerMinute,
        60_000,
      );

      if (!rateLimit.allowed) {
        client.socket.send(
          cbor.encode({
            type: "error",
            error: "rate_limited",
            message: "Too many messages",
            retryAfter: rateLimit.retryAfter,
          }),
        );
        return;
      }
    }

    // Check document permissions for sync messages.
    if (
      (type === "sync" || type === "request") &&
      "documentId" in message &&
      message.documentId
    ) {
      const docId = message.documentId as string;

      // Track ephemeral document connections
      if (isEphemeralId(docId)) {
        if (!client.ephemeralDocs.has(docId)) {
          client.ephemeralDocs.add(docId);
          ephemeralManager.addPeer(docId, client.peerId);
        }
      } else {
        const existingDoc =
          getDocumentByAutomergeId(docId) ?? getDocument(docId);
        if (!existingDoc) {
          client.socket.send(
            cbor.encode({
              type: "error",
              error: "document_not_found",
              documentId: docId,
              message: "Document must be created via API before syncing",
            }),
          );
          return;
        }

        const canRead = await canReadDocument(docId, client.userId);
        if (!canRead) {
          client.socket.send(
            cbor.encode({
              type: "error",
              error: "permission_denied",
              documentId: docId,
              message: "Read access required",
            }),
          );
          return;
        }

        // Record that this peer has passed the read check for this document.
        // This is used by send() to filter outbound messages.
        client.authorizedDocs.add(docId);

        if (type === "sync") {
          const hasChanges = messageContainsChanges(message);
          if (hasChanges === null) {
            client.socket.send(
              cbor.encode({
                type: "error",
                error: "invalid_sync_message",
                documentId: docId,
                message: "Unable to decode sync payload",
              }),
            );
            return;
          }

          if (hasChanges) {
            const canWrite = await canWriteDocument(docId, client.userId);
            if (!canWrite) {
              client.socket.send(
                cbor.encode({
                  type: "error",
                  error: "permission_denied",
                  documentId: docId,
                  message: "Write access required to apply changes",
                }),
              );
              return;
            }

            const owner = getUser(existingDoc.ownerId);
            if (!owner) {
              client.socket.send(
                cbor.encode({
                  type: "error",
                  error: "internal_error",
                  documentId: docId,
                  message: "Document owner not found",
                }),
              );
              return;
            }

            const estimatedAdditionalSize = message.data?.length ?? 0;
            const sizeCheck = checkDocumentSizeQuota(
              owner,
              existingDoc.size + estimatedAdditionalSize,
            );
            if (!sizeCheck.allowed) {
              client.socket.send(
                cbor.encode({
                  type: "error",
                  error: "quota_exceeded",
                  documentId: docId,
                  quota: sizeCheck.quota,
                  current: sizeCheck.current,
                  limit: sizeCheck.limit,
                  message: "Document size quota exceeded",
                }),
              );
              return;
            }

            if (estimatedAdditionalSize > 0) {
              const totalStorageCheck = await checkTotalStorageQuota(
                {
                  getUserDocumentCount: async () => 0,
                  getUserTotalStorage: async (uid) => getUserTotalStorage(uid),
                },
                owner,
                estimatedAdditionalSize,
              );

              if (!totalStorageCheck.allowed) {
                client.socket.send(
                  cbor.encode({
                    type: "error",
                    error: "quota_exceeded",
                    documentId: docId,
                    quota: totalStorageCheck.quota,
                    current: totalStorageCheck.current,
                    limit: totalStorageCheck.limit,
                    message: "Total storage quota exceeded",
                  }),
                );
                return;
              }

              // Keep metadata roughly in sync for quota checks across WS writes.
              updateDocumentSize(
                existingDoc.id,
                existingDoc.size + estimatedAdditionalSize,
              );
            }
          }
        }
      }
    }

    // Add sender info and forward to repo
    const repoMessage = {
      ...message,
      senderId: client.peerId,
      targetId: this.peerId,
    } as Message;

    this.emit("message", repoMessage);
  }

  /**
   * Broadcast a message to all clients except the sender.
   */
  broadcast(message: Message, excludePeerId?: PeerId): void {
    for (const client of this.clients.values()) {
      if (client.peerId !== excludePeerId) {
        const targetMessage = { ...message, targetId: client.peerId };
        this.send(targetMessage);
      }
    }
  }

  /**
   * Get the user ID for a peer, if authenticated.
   */
  getUserForPeer(peerId: PeerId): string | null {
    return this.clients.get(peerId)?.userId ?? null;
  }

  /**
   * Check if a peer is anonymous.
   */
  isPeerAnonymous(peerId: PeerId): boolean {
    return this.clients.get(peerId)?.isAnonymous ?? true;
  }
}
