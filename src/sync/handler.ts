import type { WebSocket } from "@fastify/websocket";
import type { FastifyRequest } from "fastify";
import { verifyApiToken, verifySessionToken } from "../auth/tokens.ts";
import { config } from "../config.ts";
import { checkRateLimit } from "../lib/rate-limit.ts";

interface AuthMessage {
  type: "auth";
  token: string;
}

interface SyncMessage {
  type: "sync";
  documentId: string;
  data: unknown;
}

type IncomingMessage = AuthMessage | SyncMessage | { type: string };

interface AuthenticatedConnection {
  userId: string;
  isAnonymous: false;
}

interface AnonymousConnection {
  userId: null;
  isAnonymous: true;
}

type ConnectionState = AuthenticatedConnection | AnonymousConnection;

export async function syncHandler(
  socket: WebSocket,
  request: FastifyRequest,
): Promise<void> {
  const clientIp =
    (request.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    request.ip;

  let connectionState: ConnectionState | null = null;
  let authTimeout: Timer | null = null;

  // Require auth message within 10 seconds
  authTimeout = setTimeout(() => {
    if (!connectionState) {
      socket.send(
        JSON.stringify({
          type: "error",
          error: "auth_timeout",
          message: "Authentication required within 10 seconds",
        }),
      );
      socket.close();
    }
  }, 10_000);

  socket.on("message", async (data) => {
    let message: IncomingMessage;

    try {
      message = JSON.parse(data.toString()) as IncomingMessage;
    } catch {
      socket.send(
        JSON.stringify({
          type: "error",
          error: "invalid_json",
          message: "Invalid JSON",
        }),
      );
      return;
    }

    // Handle auth message
    if (message.type === "auth") {
      if (connectionState) {
        socket.send(
          JSON.stringify({
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

      const authMsg = message as AuthMessage;

      // Empty token = anonymous
      if (!authMsg.token) {
        // Rate limit anonymous connections
        const rateLimit = checkRateLimit(
          "anon_connections",
          clientIp,
          config.rateLimits.anon.connectionsPerMinute,
          60_000,
        );

        if (!rateLimit.allowed) {
          socket.send(
            JSON.stringify({
              type: "error",
              error: "rate_limited",
              message: "Too many connections",
              retryAfter: rateLimit.retryAfter,
            }),
          );
          socket.close();
          return;
        }

        connectionState = { userId: null, isAnonymous: true };
        socket.send(
          JSON.stringify({
            type: "auth_ok",
            user: null,
          }),
        );
        return;
      }

      // Try to authenticate
      let userId: string | null = null;

      // Try session token
      const payload = verifySessionToken(authMsg.token);
      if (payload) {
        userId = payload.sub;
      }

      // Try API token
      if (!userId) {
        userId = verifyApiToken(authMsg.token);
      }

      if (!userId) {
        socket.send(
          JSON.stringify({
            type: "auth_error",
            error: "invalid_token",
            message: "Invalid or expired token",
          }),
        );
        socket.close();
        return;
      }

      connectionState = { userId, isAnonymous: false };
      socket.send(
        JSON.stringify({
          type: "auth_ok",
          user: { id: userId },
        }),
      );
      return;
    }

    // Require authentication for all other messages
    if (!connectionState) {
      socket.send(
        JSON.stringify({
          type: "error",
          error: "not_authenticated",
          message: "Send auth message first",
        }),
      );
      return;
    }

    // Handle sync messages
    if (message.type === "sync") {
      const syncMsg = message as SyncMessage;

      // Rate limit anonymous sync messages
      if (connectionState.isAnonymous) {
        const rateLimit = checkRateLimit(
          "anon_messages",
          clientIp,
          config.rateLimits.anon.messagesPerMinute,
          60_000,
        );

        if (!rateLimit.allowed) {
          socket.send(
            JSON.stringify({
              type: "error",
              error: "rate_limited",
              documentId: syncMsg.documentId,
              message: "Too many messages",
              retryAfter: rateLimit.retryAfter,
            }),
          );
          return;
        }
      }

      // TODO: Implement actual automerge-repo sync
      // This is a placeholder that needs to be integrated with automerge-repo
      socket.send(
        JSON.stringify({
          type: "sync_ack",
          documentId: syncMsg.documentId,
        }),
      );
      return;
    }

    // Unknown message type
    socket.send(
      JSON.stringify({
        type: "error",
        error: "unknown_message_type",
        message: `Unknown message type: ${message.type}`,
      }),
    );
  });

  socket.on("close", () => {
    if (authTimeout) {
      clearTimeout(authTimeout);
    }
  });

  socket.on("error", (err) => {
    request.log.error(err, "WebSocket error");
  });
}
