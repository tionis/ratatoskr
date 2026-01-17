/**
 * WebSocket sync handler for automerge-repo.
 *
 * This handler delegates all the connection management and message handling
 * to the ServerNetworkAdapter.
 */

import type { WebSocket } from "@fastify/websocket";
import type { FastifyRequest } from "fastify";
import { getNetworkAdapter } from "./repo.ts";

export async function syncHandler(
  socket: WebSocket,
  request: FastifyRequest,
): Promise<void> {
  const clientIp =
    (request.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    request.ip;

  const networkAdapter = getNetworkAdapter();

  // Let the network adapter handle the connection
  const cleanup = await networkAdapter.handleConnection(socket, clientIp);

  if (!cleanup) {
    // Connection was rejected (auth failed, rate limited, etc.)
    return;
  }

  socket.on("close", () => {
    cleanup();
  });

  socket.on("error", (err) => {
    request.log.error(err, "WebSocket error");
    cleanup();
  });
}
