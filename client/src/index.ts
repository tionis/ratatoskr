/**
 * Ratatoskr client library for browser applications.
 *
 * This library provides:
 * - Popup-based authentication
 * - WebSocket connection to Ratatoskr server
 * - Integration with automerge-repo
 * - Offline-first document creation and sync
 */

export { type AuthResult, authenticate } from "./auth.ts";
export { RatatoskrClient, type RatatoskrClientOptions } from "./client.ts";
export { RatatoskrNetworkAdapter } from "./network-adapter.ts";
export type {
  ConnectivityState,
  DocumentStatusEntry,
  DocumentSyncStatus,
  SyncEvent,
  SyncEventType,
} from "./offline/index.ts";

// Offline support
export { IndexedDBStorageAdapter } from "./storage/indexeddb-storage-adapter.ts";

// Types
export type {
  ACLEntry,
  ApiToken,
  BlobInfo,
  BlobUploadProgress,
  CompleteUploadResponse,
  CreateDocumentRequest,
  DocumentBlobsResponse,
  DocumentMetadata,
  InitUploadResponse,
  ListBlobsResponse,
  ListDocumentsResponse,
  User,
} from "./types.ts";
