# Native Ephemeral Messaging Implementation Plan

This document outlines the strategy for adding real-time, ephemeral messaging (cursors, presence, live reactions) to Ratatoskr using `automerge-repo`'s native ephemeral message type.

## Core Concept

Instead of writing high-frequency data (like mouse positions) to the CRDT history—which causes bloat and performance issues—we will use the `ephemeral` message type. These messages are fire-and-forget, routed via the existing WebSocket connection, and scoped to a specific `documentId`.

## Architecture

The Server acts as a **Relay/Router**. It does not store these messages.

1.  **Client A** sends an ephemeral message for `doc-123`.
2.  **Server** verifies Client A has `READ` permission for `doc-123`.
3.  **Server** looks up which other clients are currently "watching" `doc-123`.
4.  **Server** forwards the message to those clients.

## Server-Side Implementation (`src/sync/network-adapter.ts`)

### 1. Identity & Anonymous Users
We need to ensure every peer has a displayable identity.
*   **Verified Users:** Use the `name` from their account.
*   **Anonymous Users:** The server assigns a random "fun" name upon connection.
    *   Format: `Adjective Animal` (e.g., "Neon Narwhal", "Curious Capybara").
    *   Store this in the `AuthenticatedClient` object.

### 2. Global Identity Broadcast
To ensure identity cannot be forged:
*   **Broadcast Identity:** When a client authenticates (`auth_ok`), the server broadcasts a `type: "peer_identity"` message to all clients: `{ peerId: "...", user: { id: "...", name: "...", isAnonymous: boolean } }`.
*   **Initial Sync:** When a new client joins, send them the identities of all currently connected peers.
*   **Cleanup:** Broadcast `peer_disconnected` when a socket closes.

### 3. Document Presence (Reactive & Explicit)
To support reactive UI (e.g., "User X left the document" even if they are still online), we use an **Explicit Presence Protocol**.

*   **Protocol:** Clients send ephemeral messages to signal status changes.
    *   `{ type: "presence", status: "join", documentId: "..." }`
    *   `{ type: "presence", status: "leave", documentId: "..." }`
    *   `{ type: "presence", status: "heartbeat", documentId: "..." }` (every 30s)

*   **Server Logic:**
    *   Maintain `documentPresence: Map<DocId, Set<PeerId>>`.
    *   **On "join":** Add peer to map. Broadcast `type: "peer_joined_doc", documentId, peerId`. Send `type: "doc_presence_state"` to the joining peer.
    *   **On "leave":** Remove peer from map. Broadcast `type: "peer_left_doc", documentId, peerId`.
    *   **On Disconnect:** Find all docs where this peer was present. For each, remove them and broadcast "peer_left_doc".

### 4. Message Routing & Security
Intercept messages with `type: "ephemeral"`.
*   **Check Permissions:** Use `canReadDocument(docId, client.userId)`.
*   **Rate Limiting:** Enforce limits (e.g., 600/min) using `checkRateLimit`.
*   **Broadcast:** Forward to all subscribers of the `documentId` except the sender.

## Client-Side Usage

### Handling Identity & Presence
The `RatatoskrClient` should expose a reactive store:
```typescript
// Subscribe to presence changes
ratatoskr.on("presence-changed", (docId, peers) => {
  console.log(`Users viewing ${docId}:`, peers);
});

// Explicitly enter/leave (e.g., on mount/unmount)
ratatoskr.enterDocument(docId);
ratatoskr.leaveDocument(docId);
```

### Decoupled Permissions ("Sidecar Channels")
If readers need to "write" to a channel (e.g., a public chat for a private doc), use a **Sidecar Channel**.
*   **Strategy:** Send messages on a separate ID like `eph:chat-<docId>`.
*   **Result:** The `eph:` prefix allows public relaying while the main `doc:` remains protected.

## Benefits
*   **Zero Storage Cost:** Messages are never saved to the DB.
*   **Reactive:** UI updates instantly when users join, leave, or close tabs.
*   **Secure & Verified:** Reuses existing document ACLs and server-verified identities.
*   **Social:** Immediate sense of "others are here" even for anonymous users.
