/**
 * Ratatoskr client library for browser applications.
 *
 * This library provides:
 * - Popup-based authentication
 * - WebSocket connection to Ratatoskr server
 * - Integration with automerge-repo
 */

export { type AuthResult, authenticate } from "./auth.ts";
export { RatatoskrClient, type RatatoskrClientOptions } from "./client.ts";
export { RatatoskrNetworkAdapter } from "./network-adapter.ts";
export type { ACLEntry, ApiToken, DocumentMetadata, User } from "./types.ts";
