# Ratatoskr Design Document

Ratatoskr is a backend server providing automerge-repo synchronization with authentication and per-document permissions. It serves as shared infrastructure for multiple web applications.

## Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Web App A     │     │   Web App B     │     │   CLI Tool      │
│  (single-file)  │     │  (full SPA)     │     │                 │
└────────┬────────┘     └────────┬────────┘     └────────┬────────┘
         │                       │                       │
         │    Popup Auth         │    Popup Auth         │  API Token
         │    + WebSocket        │    + WebSocket        │  + WebSocket
         │                       │                       │
         └───────────────────────┼───────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │       Ratatoskr         │
                    │  ┌──────────────────┐   │
                    │  │   Auth Service   │◄──┼──── Authentik (OIDC)
                    │  └──────────────────┘   │
                    │  ┌──────────────────┐   │
                    │  │  Sync Service    │   │
                    │  │  (automerge-repo)│   │
                    │  └──────────────────┘   │
                    │  ┌──────────────────┐   │
                    │  │  REST API        │   │
                    │  │  (management)    │   │
                    │  └──────────────────┘   │
                    │  ┌──────────────────┐   │
                    │  │  Storage         │   │
                    │  │  (SQLite + FS)   │   │
                    │  └──────────────────┘   │
                    └─────────────────────────┘
```

## Data Model

Ratatoskr uses a document-centric model where user state and application roots are themselves Automerge documents.

### Document Types

| Type | ID Format | Description |
|------|-----------|-------------|
| **Standard** | Base58 (e.g. `2k5...`) | Regular persistent documents with ACLs. |
| **User Doc** | Base58 | Special per-user document containing profile and doc lists. |
| **App Doc** | Base58 | Per-user-per-app root document. Replaces KV store. |
| **Ephemeral** | `eph:<id>` | Relay-only documents for signaling (no persistence). |

### The User Document

Every user has exactly one **User Document**, created automatically on their first login. This document serves as the user's "home base" and contains:

- **Profile**: User ID, name, email.
- **Owned Documents**: List of documents created by the user.
- **Shared Documents**: List of documents shared with the user.

The server actively syncs the list of documents *from* the database *to* this Automerge document. In the future, clients will be able to modify ACLs by editing this document (syncing *to* the database).

### The App Document

Applications can request an **App Document** by providing an `appId` (e.g., `com.example.notes`). Ratatoskr ensures a unique document exists for that `(user, appId)` pair.

- **Purpose**: Replaces the need for a separate Key-Value store. Apps store their root state (e.g., list of note IDs, settings) here.
- **Privacy**: Only the owner can access their App Documents.

## Authentication

### Architecture

Authentication is anchored to an OIDC provider (Authentik).

#### 1. Popup-based Authentication (Primary)

For web applications:
1. Web app calls `ratatoskr.login({ appId: 'my-app' })`.
2. Popup opens, user authenticates via OIDC.
3. Server returns session token *and* IDs for the User Document and App Document.
4. Client establishes WebSocket and automatically syncs these documents.

#### 2. API Tokens (Secondary)

For CLI tools:
- Long-lived tokens generated via UI/CLI.
- Used for direct WebSocket or REST API access.

## Authorization & Access Control

### ACL Structure

- **Owner**: Has full control.
- **ACL Entries**: List of `{ principal: userId, permission: 'read'|'write' }`.
- **Public Access**: Principal `public` grants global access.

### Permission Checking

1. **Ephemeral**: Public (relay-only).
2. **App Docs**: Owner only.
3. **Standard**:
    - Owner -> Allow.
    - ACL check -> Allow if match.
    - Recursive ACL (document-to-document) is supported.

## REST API

Base path: `/api/v1`

### Key Endpoints

- `POST /api/v1/documents`: Create a document. If `id` is omitted, one is generated.
- `GET /api/v1/documents/app/:appId`: Get or create the App Document for the current user.
- `GET /api/v1/auth/userinfo`: Returns user info including `userDocumentId`.

## WebSocket Sync Protocol

Standard `automerge-repo` sync protocol over WebSocket at `/sync`.
- Authenticated via first message `{ type: "auth", token: "..." }`.
- Enforces read/write permissions per document.

## Storage

### Architecture

Dual-database + Filesystem:
- `ratatoskr.db` (SQLite): Metadata, Users, ACLs, Blob index.
- `automerge.db` (SQLite): Automerge binary chunks (efficient storage).
- Filesystem: Blob data.

### Schema (`ratatoskr.db`)

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  user_document_id TEXT,         -- Reference to the User Document
  -- quotas...
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE documents (
  id TEXT PRIMARY KEY,           -- Base58 ID
  owner_id TEXT NOT NULL REFERENCES users(id),
  automerge_id TEXT,             -- Same as ID (legacy support)
  type TEXT,
  -- ...
);

CREATE TABLE app_documents (
  user_id TEXT NOT NULL REFERENCES users(id),
  app_id TEXT NOT NULL,
  document_id TEXT NOT NULL REFERENCES documents(id),
  PRIMARY KEY (user_id, app_id)
);

CREATE TABLE acl_entries (...);
-- Blob tables (blobs, claims)...
```

## Client Library

The client library (`ratatoskr-client`) is opinionated and offline-first.

```typescript
const client = new RatatoskrClient({
  serverUrl: 'https://sync.example.com',
  appId: 'com.my.app'
});

await client.login();

// Access special documents
const userDoc = client.userDocHandle; // Contains list of docs
const appDoc = client.appDocHandle;   // App-specific root

// Create new doc
await client.createDocument({ type: 'note' });
// The new doc automatically appears in userDoc.owned (via server sync)
```

## Blob Management

(Unchanged from previous design - see Blob Management section in history/previous docs for details on content-addressable storage).