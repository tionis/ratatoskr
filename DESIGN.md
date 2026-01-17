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

## Document Types

Documents are identified by a prefixed ID scheme:

| Prefix | Format | Description |
|--------|--------|-------------|
| `doc:` | `doc:<uuid>` | Regular documents with full ACL support |
| `app:` | `app:<app-id>` | Per-user-per-app documents (private to user) |
| `eph:` | `eph:<id>` | Ephemeral relay documents (temporary, no persistence) |

- **Regular documents** (`doc:`) support full ACL configuration and are persisted.
- **App documents** (`app:`) are private per-user storage for app-specific data. Only the owner can ever access them. The `app-id` is either a UUID or a reverse-DNS style identifier (e.g., `com.example.myapp`).
- **Ephemeral documents** (`eph:`) relay messages between peers without persistence. These are the only documents anonymous users can create.

## Authentication

### Architecture

Authentication is anchored to an OIDC provider (Authentik). Two authentication methods are supported:

#### 1. Popup-based Authentication (Primary)

For web applications, including single-file tools:

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│   Web App   │         │  Ratatoskr  │         │  Authentik  │
└──────┬──────┘         └──────┬──────┘         └──────┬──────┘
       │                       │                       │
       │  1. Open popup        │                       │
       │──────────────────────►│                       │
       │                       │  2. OIDC redirect     │
       │                       │──────────────────────►│
       │                       │                       │
       │                       │  3. User authenticates│
       │                       │◄──────────────────────│
       │                       │                       │
       │  4. postMessage(token)│                       │
       │◄──────────────────────│                       │
       │                       │                       │
       │  5. WebSocket + token │                       │
       │──────────────────────►│                       │
       │                       │                       │
```

1. Web app calls client library: `ratatoskr.login()`
2. Popup opens to `{ratatoskr}/auth/login`
3. User authenticates via Authentik
4. Popup sends short-lived token to opener via `postMessage`
5. Web app establishes WebSocket connection with token

The client library handles the popup flow and token management.

#### 2. API Tokens (Secondary)

For CLI tools, server-side applications, or advanced users:

- Users generate long-lived API tokens via a management UI or API
- Tokens can be scoped (read-only, specific documents)
- Tokens are used directly for WebSocket authentication

### WebSocket Authentication

Authentication occurs in the first message after WebSocket connection:

```json
{
  "type": "auth",
  "token": "<jwt-or-api-token>"
}
```

The server validates the token before allowing any sync messages. Invalid or missing auth results in connection termination. This approach:
- Keeps tokens out of URLs and server logs
- Works cross-origin without CORS complexity
- Allows connection-level rate limiting before auth

### Token Format

Short-lived tokens (from popup auth) are JWTs containing:
- `sub`: User ID (from OIDC)
- `exp`: Expiration timestamp (short, e.g., 1 hour)
- `iat`: Issued at timestamp

API tokens are opaque strings stored in the database with associated metadata.

## Authorization & Access Control

### Document Ownership

- Every document has exactly one owner (the user who created it)
- First-writer-locks: the first user to create a document with a given ID owns it
- Only the owner can:
  - Modify ACLs
  - Change document type
  - Delete the document
  - Set expiration timestamp

### ACL Structure

```typescript
interface ACL {
  entries: ACLEntry[];
}

interface ACLEntry {
  // Either a user ID or a document ID (for recursive ACLs)
  principal: UserId | DocumentId | "public";
  permission: "read" | "write"; // write implies read
}
```

### ACL Resolution

When checking access for a user to a document:

1. If user is owner → full access
2. Check direct user entries in ACL
3. For each document ID in ACL, recursively resolve that document's ACL (up to max depth of 10)
4. If "public" is in ACL → grant that permission to all users (including anonymous)

```
Document A (ACL: [user:alice=write, doc:B=read])
    │
    └── Document B (ACL: [user:bob=write, user:charlie=read])
            │
            └── Results: alice=write, bob=read, charlie=read
```

Recursive resolution stops at depth 10. Cycles are detected and skipped.

### Special Cases

| Document Type | ACL Behavior |
|---------------|--------------|
| `doc:*` | Full ACL support |
| `app:*` | No ACL - only owner can access (enforced, not configurable) |
| `eph:*` | Public by default, creator can restrict |

## REST API

Base path: `/api/v1`

### Authentication Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/auth/login` | Initiate OIDC login (popup endpoint) |
| `GET` | `/auth/callback` | OIDC callback handler |
| `POST` | `/auth/token` | Exchange auth code for token |
| `GET` | `/auth/userinfo` | Get current user info |
| `POST` | `/auth/api-tokens` | Create API token |
| `GET` | `/auth/api-tokens` | List user's API tokens |
| `DELETE` | `/auth/api-tokens/:id` | Revoke API token |

### Document Management Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/documents` | Create document metadata |
| `GET` | `/documents` | List documents (owned + accessible) |
| `GET` | `/documents/:id` | Get document metadata |
| `DELETE` | `/documents/:id` | Delete document (owner only) |
| `PUT` | `/documents/:id/acl` | Update document ACL (owner only) |
| `GET` | `/documents/:id/acl` | Get document ACL |
| `PUT` | `/documents/:id/type` | Update document type (owner only) |
| `PUT` | `/documents/:id/expiration` | Set expiration timestamp (owner only) |

### Document Creation

```typescript
interface CreateDocumentRequest {
  id: string;           // "doc:<uuid>" or "app:<app-id>"
  type: string;         // URL-like identifier, e.g., "com.example.myapp/note"
  acl?: ACLEntry[];     // Optional initial ACL
  expiresAt?: string;   // Optional ISO 8601 timestamp
}

interface CreateDocumentResponse {
  id: string;
  owner: string;
  type: string;
  acl: ACLEntry[];
  createdAt: string;
  expiresAt: string | null;
}
```

### Document Listing

```typescript
interface ListDocumentsResponse {
  owned: DocumentMetadata[];      // Documents user owns
  accessible: DocumentMetadata[]; // Documents user has access to (not owned)
}
```

### Error Responses

```typescript
interface ErrorResponse {
  error: string;      // Error code
  message: string;    // Human-readable message
}
```

| Status | Error Code | Description |
|--------|------------|-------------|
| 400 | `invalid_request` | Malformed request |
| 401 | `unauthorized` | Missing or invalid authentication |
| 403 | `forbidden` | Insufficient permissions |
| 404 | `not_found` | Document not found |
| 409 | `conflict` | Document ID already exists |
| 429 | `rate_limited` | Too many requests |

## WebSocket Sync Protocol

The sync endpoint is at `/sync`.

### Connection Flow

```
Client                              Server
   │                                   │
   │──── WebSocket Connect ───────────►│
   │                                   │
   │──── Auth Message ────────────────►│
   │     { type: "auth", token: "..." }│
   │                                   │
   │◄─── Auth Response ────────────────│
   │     { type: "auth_ok", user: ...} │
   │         or                        │
   │     { type: "auth_error", ... }   │
   │                                   │
   │◄──► Automerge Sync Messages ─────►│
   │                                   │
```

### Permission Enforcement

For each sync message:
- **Requesting document**: User must have at least `read` permission
- **Sending changes**: User must have `write` permission

Permission denied results in an error message (not connection termination):
```json
{
  "type": "error",
  "documentId": "doc:...",
  "error": "permission_denied",
  "message": "Write access required"
}
```

## Rate Limiting

### Anonymous Users

Strict rate limits to prevent abuse:

| Resource | Limit |
|----------|-------|
| WebSocket connections | 5 per IP per minute |
| Ephemeral document creation | 10 per IP per hour |
| Sync messages | 100 per connection per minute |
| Total bandwidth | 1 MB per connection per minute |

### Authenticated Users

Relaxed limits (trusted users):

| Resource | Limit |
|----------|-------|
| WebSocket connections | 100 per user per minute |
| Document creation | 1000 per user per hour |
| Sync messages | No limit |
| Total bandwidth | 100 MB per user per minute |

Rate limit responses include retry-after information:
```json
{
  "type": "error",
  "error": "rate_limited",
  "retryAfter": 60
}
```

## Quotas

Per-user quotas for authenticated users:

| Quota | Default | Description |
|-------|---------|-------------|
| `maxDocuments` | 10,000 | Maximum number of owned documents |
| `maxDocumentSize` | 10 MB | Maximum size of a single document |
| `maxTotalStorage` | 1 GB | Total storage across all documents |

Quota exceeded errors:
```json
{
  "error": "quota_exceeded",
  "quota": "maxDocuments",
  "current": 10000,
  "limit": 10000
}
```

Quotas are configurable per-user for flexibility.

## Ephemeral Documents

Ephemeral documents (`eph:*`) provide real-time message relay without persistence:

- **No storage**: Messages are relayed but not persisted
- **Anonymous creation**: Only document type anonymous users can create
- **Expiration**: Deleted after configurable timeout (default: 5 minutes) from last peer disconnect
- **Owner expiration**: Creator can set a deletion timestamp

### Use Cases

- Temporary collaboration sessions
- Peer-to-peer signaling
- Transient shared state

### Lifecycle

```
Created ──► Active (peers connected) ──► Idle (no peers) ──► Deleted
                      │                         │
                      │                         │ (timeout or
                      │                         │  expiration)
                      └─────────────────────────┘
```

## Storage

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Storage Layer                       │
├─────────────────────────┬───────────────────────────────┤
│        SQLite           │         Filesystem            │
├─────────────────────────┼───────────────────────────────┤
│ • User accounts         │ • Automerge document blobs    │
│ • Document metadata     │ • Organized by document ID    │
│ • ACLs                  │                               │
│ • API tokens            │                               │
│ • Rate limit state      │                               │
└─────────────────────────┴───────────────────────────────┘
```

### SQLite Schema

```sql
-- Users (cached from OIDC)
CREATE TABLE users (
  id TEXT PRIMARY KEY,           -- OIDC subject
  email TEXT,
  name TEXT,
  quota_max_documents INTEGER DEFAULT 10000,
  quota_max_document_size INTEGER DEFAULT 10485760,
  quota_max_total_storage INTEGER DEFAULT 1073741824,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- API tokens
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,      -- bcrypt hash
  scopes TEXT,                   -- JSON array of scopes
  last_used_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

-- Documents
CREATE TABLE documents (
  id TEXT PRIMARY KEY,           -- "doc:uuid" or "app:app-id"
  owner_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,            -- URL-like type identifier
  size INTEGER DEFAULT 0,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ACL entries
CREATE TABLE acl_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  principal TEXT NOT NULL,       -- user ID, document ID, or "public"
  permission TEXT NOT NULL,      -- "read" or "write"
  UNIQUE(document_id, principal)
);

-- Indexes
CREATE INDEX idx_documents_owner ON documents(owner_id);
CREATE INDEX idx_acl_principal ON acl_entries(principal);
CREATE INDEX idx_documents_expires ON documents(expires_at) WHERE expires_at IS NOT NULL;
```

### Filesystem Structure

```
data/
├── documents/
│   ├── doc/
│   │   ├── ab/
│   │   │   └── ab12cd34-...    # Automerge binary
│   │   └── ...
│   └── app/
│       └── {user-id}/
│           └── {app-id}        # Per-user-per-app documents
└── ratatoskr.db                # SQLite database
```

### Backup Strategy

- **SQLite**: Use `.backup` command or filesystem snapshot
- **Documents**: Filesystem backup (rsync, restic, etc.)
- **Consistency**: Stop writes or use WAL mode for consistent backups

## Technology Stack

| Component | Technology | Rationale |
|-----------|------------|-----------|
| Runtime | Bun | Fast, Node-compatible, built-in TypeScript |
| Language | TypeScript | Type safety, ecosystem compatibility |
| Framework | Fastify | Performance, WebSocket support |
| Auth | openid-client | Standard OIDC library |
| Database | better-sqlite3 | Synchronous, fast, embedded |
| Sync | @automerge/automerge-repo | Official sync implementation |
| WebSocket | @fastify/websocket | Fastify integration |
| Linting | Biome | Fast, all-in-one linter and formatter |
| Testing | bun:test | Built-in test runner |

### Project Structure

```
ratatoskr/
├── src/
│   ├── index.ts              # Entry point
│   ├── config.ts             # Configuration
│   ├── server.ts             # Fastify setup
│   ├── auth/
│   │   ├── oidc.ts           # OIDC integration
│   │   ├── tokens.ts         # Token management
│   │   └── middleware.ts     # Auth middleware
│   ├── api/
│   │   ├── documents.ts      # Document endpoints
│   │   ├── auth.ts           # Auth endpoints
│   │   └── schemas.ts        # Request/response schemas
│   ├── sync/
│   │   ├── handler.ts        # WebSocket handler
│   │   └── adapter.ts        # Automerge network adapter
│   ├── storage/
│   │   ├── database.ts       # SQLite operations
│   │   ├── documents.ts      # Document blob storage
│   │   └── migrate.ts        # Database migrations
│   └── lib/
│       ├── types.ts          # Shared types
│       ├── acl.ts            # ACL resolution
│       ├── rate-limit.ts     # Rate limiting
│       └── quotas.ts         # Quota enforcement
├── client/
│   └── src/                  # Client library (future)
├── test/
├── docs/
│   └── dev.md                # Development guide
├── package.json
├── tsconfig.json
├── biome.json
└── DESIGN.md
```

## Client Library

A lightweight client library for web applications:

```typescript
import { Ratatoskr } from '@ratatoskr/client';

const client = new Ratatoskr({
  serverUrl: 'https://sync.example.com',
});

// Authenticate via popup
await client.login();

// Get automerge-repo instance with auth
const repo = client.getRepo();

// Create a document
const handle = repo.create();
await client.registerDocument({
  id: `doc:${handle.documentId}`,
  type: 'com.example.myapp/note',
});

// Access existing document
const doc = repo.find('doc:abc123');
```

## Configuration

Environment variables:

```bash
# Server
PORT=3000
HOST=0.0.0.0
BASE_URL=https://sync.example.com

# OIDC
OIDC_ISSUER=https://auth.example.com
OIDC_CLIENT_ID=ratatoskr
OIDC_CLIENT_SECRET=secret
OIDC_REDIRECT_URI=https://sync.example.com/auth/callback

# Storage
DATA_DIR=/var/lib/ratatoskr

# Limits
DEFAULT_MAX_DOCUMENTS=10000
DEFAULT_MAX_DOCUMENT_SIZE=10485760
DEFAULT_MAX_TOTAL_STORAGE=1073741824
EPHEMERAL_TIMEOUT_SECONDS=300

# Rate limits
ANON_RATE_LIMIT_CONNECTIONS=5
ANON_RATE_LIMIT_MESSAGES=100
AUTH_RATE_LIMIT_CONNECTIONS=100
```

## Security Considerations

### Token Security
- Short-lived JWTs for popup auth (1 hour expiration)
- API tokens hashed with bcrypt before storage
- Tokens transmitted only over TLS

### Input Validation
- Document IDs validated against prefix pattern
- Type strings validated as URL-like identifiers
- ACL entries validated for valid principals

### Cross-Origin Security
- Popup auth uses postMessage with origin validation
- CORS configured for allowed origins
- WebSocket upgrade validated

### Rate Limiting
- Applied before authentication for anonymous users
- IP-based for anonymous, user-based for authenticated
- Prevents resource exhaustion

## Future Work

- **Y.js support**: Add Y.js sync endpoint for Y.js-based applications
- **Advanced ACLs**:
  - Role-based access control
  - Time-limited access
  - Conditional access (e.g., require specific claims)
- **Federation**: Allow multiple Ratatoskr instances to sync
- **Webhooks**: Notify external services of document changes
- **Admin API**: User management, global settings, monitoring
- **Metrics**: Prometheus metrics endpoint for monitoring
