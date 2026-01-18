/**
 * Server-side network adapter for automerge-repo.
 *
 * This adapter manages WebSocket connections from clients, handling:
 * - Authentication
 * - Permission checking for document access
 * - Message routing between clients and the repo
 */

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
import { checkRateLimit } from "../lib/rate-limit.ts";
import { ephemeralManager, isEphemeralId } from "./ephemeral.ts";
import { canReadDocument } from "./permissions.ts";

interface AuthenticatedClient {
  peerId: PeerId;
  socket: WebSocket;
  userId: string | null;
  isAnonymous: boolean;
  ephemeralDocs: Set<string>; // Track which ephemeral docs this peer is connected to
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
              userId = verifyApiToken(token);
              if (userId) {
                isAnonymous = false;
              }
            }

            if (!userId && token !== "") {
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

          // Generate peer ID for this client
          const peerId = `client-${crypto.randomUUID()}` as PeerId;

          client = {
            peerId,
            socket,
            userId,
            isAnonymous,
            ephemeralDocs: new Set(),
          };

          this.clients.set(peerId, client);
          this.socketToPeer.set(socket, peerId);

          // Send auth success
          socket.send(
            cbor.encode({
              type: "auth_ok",
              peerId,
              user: userId ? { id: userId } : null,
            }),
          );

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
    if (client) {
      this.socketToPeer.delete(client.socket);

      // Clean up ephemeral document connections
      for (const docId of client.ephemeralDocs) {
        ephemeralManager.removePeer(docId, peerId);
      }
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

    // Check document permissions for sync messages
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
