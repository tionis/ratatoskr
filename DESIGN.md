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
3. Server generates PKCE code verifier and challenge, redirects to Authentik
4. User authenticates via Authentik
5. Authentik redirects back with authorization code
6. Server exchanges code for tokens using PKCE verifier
7. Popup sends short-lived session token to opener via `postMessage`
8. Web app establishes WebSocket connection with token

The OIDC flow uses PKCE (Proof Key for Code Exchange) with S256 challenge method for security. The client library handles the popup flow and token management.

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
  type TEXT,                     -- Optional type identifier (max 200 chars)
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
import { Ratatoskr } from 'ratatoskr-client';

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
PORT=4151
HOST=0.0.0.0
BASE_URL=https://sync.example.com

# OIDC (uses PKCE, client secret optional)
OIDC_ISSUER=https://auth.example.com
OIDC_CLIENT_ID=ratatoskr
OIDC_REDIRECT_URI=https://sync.example.com/auth/callback
# OIDC_CLIENT_SECRET=secret  # Optional: only for confidential clients

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
- PKCE (S256) used for all OIDC authorization code exchanges
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

## Blob Management

Ratatoskr provides content-addressable blob storage with claims-based lifecycle management. Blobs are immutable binary objects identified by their hash, allowing efficient deduplication and sharing.

### Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Blob Storage Model                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   User A uploads file.png ───► SHA-256 hash computed                 │
│                                      │                               │
│                                      ▼                               │
│                         ┌──────────────────────┐                     │
│                         │   Blob: abc123...    │                     │
│                         │   Content: [bytes]   │                     │
│                         │   MIME: image/png    │                     │
│                         │   Size: 2.5 MB       │                     │
│                         │   Claimers: [A]      │                     │
│                         └──────────────────────┘                     │
│                                      │                               │
│   User B claims by hash ────────────►│ Claimers: [A, B]             │
│                                      │                               │
│   User A releases ──────────────────►│ Claimers: [B]                │
│                                      │                               │
│   User B releases ──────────────────►│ Claimers: []                 │
│                                      │                               │
│                              24h grace period                        │
│                                      │                               │
│                                      ▼                               │
│                               Blob deleted                           │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Design Principles

| Principle | Description |
|-----------|-------------|
| Content-addressable | Blobs are identified by SHA-256 hash of their content |
| Immutable | Once uploaded, blob content cannot be modified |
| Deduplicated | Identical content stored only once on disk |
| Claims-based lifecycle | Blobs persist as long as at least one user claims them |
| Hash = Access | Anyone with the hash can download the blob (no ACLs) |

### Blob Model

```typescript
interface Blob {
  hash: string;           // SHA-256 hex (64 chars)
  size: number;           // Bytes
  mimeType: string;       // Content-Type (e.g., "image/png")
  createdAt: Date;        // First upload timestamp
  releasedAt: Date | null; // When all claimers released (for grace period)
}

// User claim - charged against user's blob quota
interface BlobClaim {
  blobHash: string;
  userId: string;
  claimedAt: Date;
}

// Document claim - charged against document owner's blob quota
interface DocumentBlobClaim {
  blobHash: string;
  documentId: string;     // The document claiming this blob
  ownerId: string;        // Document owner (for quota accounting)
  claimedAt: Date;
}
```

### Claim Types

Blobs can be claimed by two types of principals:

| Claim Type | Principal | Quota Charged To | Released When |
|------------|-----------|------------------|---------------|
| User claim | User ID | That user | User explicitly releases |
| Document claim | Document ID | Document owner | Document is deleted |

Both claim types are equal for lifecycle purposes: a blob with any claims (user or document) remains active.

### Access Model

Blob access follows a simple content-addressable model:

- **Download**: Anyone with the hash can download the blob
- **Upload**: Authenticated users can upload blobs (quota permitting)
- **Claim**: Authenticated users can claim existing blobs by hash
- **Release**: Users can release their claims on blobs

This model prioritizes simplicity and enables efficient sharing: users share only the hash, and recipients can claim and access the blob.

### Quota Management

Each claimer is charged the full blob size against their storage quota:

```
User A (quota: 5 GB, used: 500 MB)
  ├── User claim: blob X (100 MB)     → used: 600 MB
  ├── User claim: blob Y (200 MB)     → used: 800 MB
  └── Owns doc:123 which claims:
      └── blob Z (50 MB)              → used: 850 MB

User B (quota: 5 GB, used: 0 MB)
  └── User claim: blob X (100 MB)     → used: 100 MB  (same blob as A)
```

**Quota accounting rules**:
- User claims: charged to that user
- Document claims: charged to document owner
- Same blob claimed multiple ways by same user: charged once per claim type
- A user's total blob quota usage = sum of (user claims + document claims for owned docs)

**Rationale**: Per-claimer charging:
- Prevents abuse where users claim many blobs they don't own
- Ensures users have "skin in the game" for content they claim
- Simplifies quota accounting (no complex split calculations)
- Users can always release claims to free quota

**Quota configuration** (per-user, extends existing quota system):

| Quota | Default | Description |
|-------|---------|-------------|
| `maxBlobStorage` | 5 GB | Total storage for claimed blobs (user + document claims) |
| `maxBlobSize` | 1 GB | Maximum size of a single blob |

### Storage

#### Filesystem Structure

Blobs are stored using their hash for content-addressability:

```
data/
├── blobs/
│   ├── ab/                    # First 2 chars of hash (sharding)
│   │   ├── ab12cd34ef...      # Full hash as filename
│   │   └── ab98fe76dc...
│   └── cd/
│       └── cd45ab89...
├── blob-chunks/               # Temporary storage for chunked uploads
│   └── {upload-id}/
│       ├── 0                  # Chunk 0
│       ├── 1                  # Chunk 1
│       └── ...
└── ratatoskr.db
```

#### Database Schema

```sql
-- Blobs (one row per unique content)
CREATE TABLE blobs (
  hash TEXT PRIMARY KEY,           -- SHA-256 hex
  size INTEGER NOT NULL,           -- Bytes
  mime_type TEXT NOT NULL,         -- Content-Type
  created_at TEXT NOT NULL,        -- First upload timestamp
  released_at TEXT                 -- When claimers became 0 (NULL if claimed)
);
CREATE INDEX idx_blobs_released ON blobs(released_at)
  WHERE released_at IS NOT NULL;

-- User blob claims (many-to-many: users ↔ blobs)
CREATE TABLE blob_claims (
  blob_hash TEXT NOT NULL REFERENCES blobs(hash) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (blob_hash, user_id)
);
CREATE INDEX idx_blob_claims_user ON blob_claims(user_id);

-- Document blob claims (many-to-many: documents ↔ blobs)
-- Quota is charged to the document owner
CREATE TABLE document_blob_claims (
  blob_hash TEXT NOT NULL REFERENCES blobs(hash) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  owner_id TEXT NOT NULL REFERENCES users(id),  -- Denormalized for quota queries
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (blob_hash, document_id)
);
CREATE INDEX idx_document_blob_claims_owner ON document_blob_claims(owner_id);
CREATE INDEX idx_document_blob_claims_document ON document_blob_claims(document_id);

-- Chunked uploads (in-progress uploads)
CREATE TABLE blob_uploads (
  id TEXT PRIMARY KEY,             -- Upload session ID
  user_id TEXT NOT NULL REFERENCES users(id),
  expected_hash TEXT,              -- Client-provided expected hash (optional)
  expected_size INTEGER NOT NULL,  -- Total expected size
  mime_type TEXT NOT NULL,
  chunk_size INTEGER NOT NULL,     -- Size of each chunk (except last)
  chunks_received INTEGER DEFAULT 0,
  total_chunks INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL         -- Auto-cleanup stale uploads
);
```

### REST API

Base path: `/api/v1/blobs`

#### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/blobs/upload/init` | Initialize chunked upload |
| `PUT` | `/blobs/upload/:uploadId/chunk/:index` | Upload a chunk |
| `POST` | `/blobs/upload/:uploadId/complete` | Complete upload, returns hash |
| `DELETE` | `/blobs/upload/:uploadId` | Cancel upload |
| `GET` | `/blobs/:hash` | Download blob |
| `HEAD` | `/blobs/:hash` | Check if blob exists, get metadata |
| `POST` | `/blobs/:hash/claim` | Claim existing blob (user claim) |
| `DELETE` | `/blobs/:hash/claim` | Release user claim on blob |
| `GET` | `/blobs` | List user's claimed blobs |
| `POST` | `/documents/:id/blobs/:hash` | Add document claim on blob |
| `DELETE` | `/documents/:id/blobs/:hash` | Remove document claim on blob |
| `GET` | `/documents/:id/blobs` | List blobs claimed by document |

#### Chunked Upload Protocol

For large files (up to 1 GB+), uploads are chunked for reliability and resumability.

**1. Initialize Upload**

```typescript
// POST /api/v1/blobs/upload/init
interface InitUploadRequest {
  size: number;              // Total file size in bytes
  mimeType: string;          // Content-Type
  expectedHash?: string;     // Optional: client-computed hash for verification
  chunkSize?: number;        // Optional: chunk size (default: 5 MB, max: 10 MB)
}

interface InitUploadResponse {
  uploadId: string;          // Upload session ID
  chunkSize: number;         // Confirmed chunk size
  totalChunks: number;       // Number of chunks expected
  expiresAt: string;         // Upload session expiration (24h)
}
```

**2. Upload Chunks**

```typescript
// PUT /api/v1/blobs/upload/:uploadId/chunk/:index
// Body: raw binary chunk data
// Headers: Content-Type: application/octet-stream

interface ChunkUploadResponse {
  chunksReceived: number;
  totalChunks: number;
  complete: boolean;
}
```

**3. Complete Upload**

```typescript
// POST /api/v1/blobs/upload/:uploadId/complete

interface CompleteUploadResponse {
  hash: string;              // Computed SHA-256
  size: number;
  mimeType: string;
  deduplicated: boolean;     // True if blob already existed
}
```

If `expectedHash` was provided and doesn't match, the upload fails with `hash_mismatch` error.

#### Download

```typescript
// GET /api/v1/blobs/:hash
// Response: raw blob content
// Headers:
//   Content-Type: {mimeType}
//   Content-Length: {size}
//   ETag: "{hash}"
//   Cache-Control: public, max-age=31536000, immutable

// Supports Range requests for partial downloads
```

#### Claim Operations

```typescript
// POST /api/v1/blobs/:hash/claim
// Claim an existing blob by hash

interface ClaimResponse {
  hash: string;
  size: number;
  mimeType: string;
  claimedAt: string;
}

// Errors:
// 404: Blob not found
// 409: Already claimed by this user
// 402: Quota exceeded (would exceed maxBlobStorage)

// DELETE /api/v1/blobs/:hash/claim
// Release claim on a blob

// Errors:
// 404: Blob not found or not claimed by user
```

#### List Claims

```typescript
// GET /api/v1/blobs
// Query params: limit, offset, sort (size, claimedAt)

interface ListBlobsResponse {
  blobs: BlobWithClaim[];
  total: number;
  quotaUsed: number;         // Total bytes claimed
  quotaLimit: number;        // User's maxBlobStorage
}

interface BlobWithClaim {
  hash: string;
  size: number;
  mimeType: string;
  claimedAt: string;
}
```

#### Document Blob Claims

Documents can claim blobs, enabling automatic cleanup when documents are deleted:

```typescript
// POST /api/v1/documents/:id/blobs/:hash
// Add a document claim on an existing blob
// Requires: write access to document
// Quota: charged to document owner

interface DocumentBlobClaimResponse {
  hash: string;
  size: number;
  mimeType: string;
  documentId: string;
  claimedAt: string;
}

// Errors:
// 403: No write access to document
// 404: Blob or document not found
// 402: Document owner's blob quota exceeded

// DELETE /api/v1/documents/:id/blobs/:hash
// Remove document claim on blob
// Requires: write access to document

// GET /api/v1/documents/:id/blobs
// List all blobs claimed by this document

interface DocumentBlobsResponse {
  blobs: BlobInfo[];
  totalSize: number;
}
```

**Document Claim Lifecycle**:

```
┌─────────────────────────────────────────────────────────────────────┐
│                  Document-Blob Claim Lifecycle                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   Document created                                                   │
│         │                                                            │
│         ▼                                                            │
│   User uploads blob ──► uploadBlobToDocument(docId, file)           │
│         │                     │                                      │
│         │                     ▼                                      │
│         │              Blob uploaded + document claim added          │
│         │              (quota charged to doc owner)                  │
│         │                                                            │
│         ▼                                                            │
│   Document stores blob hash in content                               │
│   (e.g., Automerge doc: { images: ["abc123..."] })                  │
│         │                                                            │
│         ▼                                                            │
│   Document deleted ──► All document claims released                  │
│         │                     │                                      │
│         │                     ▼                                      │
│         │              If no other claims → 24h grace → deleted      │
│         │                                                            │
└─────────────────────────────────────────────────────────────────────┘
```

**Use Cases**:
- Embedding images in collaborative notes
- Attaching files to shared documents
- Linking assets to app-specific data

### Rate Limiting

Rate limits protect against hash scanning attacks and general abuse:

| Operation | Anonymous | Authenticated |
|-----------|-----------|---------------|
| Download | 10/min/IP, 100 MB/min | 100/min, 1 GB/min |
| HEAD (exists check) | 20/min/IP | 200/min |
| Upload init | N/A | 10/min |
| Chunk upload | N/A | 100/min |
| Claim | N/A | 100/min |

**Anti-Scanning Protection**:
- Anonymous download/HEAD requests are strictly rate-limited per IP
- Failed lookups (404s) count toward rate limit
- Repeated 404s from same IP trigger exponential backoff
- Consider CAPTCHA for excessive anonymous requests

### Cleanup Process

Blobs with no claimers enter a 24-hour grace period before deletion:

```
┌──────────────────────────────────────────────────────────────┐
│                    Blob Cleanup Lifecycle                     │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  Active                Released                Deleted        │
│  (claimers > 0)        (claimers = 0)          (after 24h)   │
│       │                      │                      │         │
│       │  last claim          │    grace period      │         │
│       │  released            │    expires           │         │
│       ├─────────────────────►├─────────────────────►│         │
│       │                      │                      │         │
│       │◄─────────────────────┤                      │         │
│       │  re-claimed          │                      │         │
│       │  within 24h          │                      │         │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

**Cleanup job** runs periodically (every hour) and:
1. Finds blobs where `released_at < NOW() - 24 hours`
2. Deletes blob files from filesystem
3. Removes blob records from database

**Document deletion cascade**:
- When a document is deleted, all its blob claims are automatically released
- This is handled by `ON DELETE CASCADE` in the `document_blob_claims` table
- A trigger updates `blobs.released_at` when the last claim is removed

**Stale upload cleanup**:
- Upload sessions expire after 24 hours
- Cleanup job removes expired upload chunks and records

### Client Library

The client library provides offline-first blob management:

```typescript
class RatatoskrClient {
  constructor(options: {
    serverUrl: string;
    // ... existing options ...
    blobCacheSize?: number;    // Max blob cache size in bytes (default: 100 MB)
  });

  // ... existing methods ...

  // Blob Management - User Claims
  async uploadBlob(
    data: Blob | File | ArrayBuffer | Uint8Array,
    options?: {
      mimeType?: string;       // Auto-detected if File/Blob
      onProgress?: (progress: BlobUploadProgress) => void;
    }
  ): Promise<BlobInfo>;

  async downloadBlob(hash: string): Promise<Uint8Array>;
  async getBlobUrl(hash: string): string;  // Direct download URL
  async getBlobInfo(hash: string): Promise<BlobInfo | null>;

  async claimBlob(hash: string): Promise<BlobInfo>;
  async releaseBlobClaim(hash: string): Promise<void>;
  async listClaimedBlobs(options?: ListOptions): Promise<ListBlobsResponse>;

  // Blob Management - Document Claims
  async addDocumentBlobClaim(documentId: string, blobHash: string): Promise<void>;
  async removeDocumentBlobClaim(documentId: string, blobHash: string): Promise<void>;
  async listDocumentBlobs(documentId: string): Promise<BlobInfo[]>;

  // Convenience: Upload and immediately attach to document
  async uploadBlobToDocument(
    documentId: string,
    data: Blob | File | ArrayBuffer | Uint8Array,
    options?: {
      mimeType?: string;
      onProgress?: (progress: BlobUploadProgress) => void;
    }
  ): Promise<BlobInfo>;

  // Offline status
  getBlobSyncStatus(hash: string): BlobSyncStatus;
  getPendingBlobUploads(): PendingBlobUpload[];
  onBlobSyncEvent(listener: (event: BlobSyncEvent) => void): () => void;
}

interface BlobInfo {
  hash: string;
  size: number;
  mimeType: string;
  claimedAt?: string;
}

interface BlobUploadProgress {
  phase: 'hashing' | 'checking' | 'uploading' | 'complete';
  bytesProcessed: number;
  totalBytes: number;
  chunksUploaded?: number;
  totalChunks?: number;
}

type BlobSyncStatus =
  | 'local'      // Queued locally, not yet uploaded
  | 'uploading'  // Upload in progress
  | 'synced'     // Uploaded and claimed
  | 'error';     // Upload failed
```

### Offline-First Implementation

The client supports full offline blob operations:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Offline Blob Upload Flow                          │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   1. User calls uploadBlob(file)                                     │
│                  │                                                   │
│                  ▼                                                   │
│   2. Compute SHA-256 hash locally (Web Crypto API)                   │
│                  │                                                   │
│                  ▼                                                   │
│   3. Store blob in IndexedDB with status='local'                     │
│                  │                                                   │
│                  ▼                                                   │
│   4. Return immediately with hash                                    │
│                  │                                                   │
│                  ▼                                                   │
│   5. Queue upload operation                                          │
│                  │                                                   │
│      ┌──────────┴──────────┐                                        │
│      │                     │                                         │
│   Online              Offline                                        │
│      │                     │                                         │
│      ▼                     ▼                                         │
│   6a. Check if blob      6b. Wait for                               │
│       exists (HEAD)          connectivity                            │
│      │                          │                                    │
│      ├── exists ──────────┐     │                                    │
│      │                    │     │                                    │
│      ▼                    ▼     │                                    │
│   6c. Upload chunks    Claim    │                                    │
│      │                 only     │                                    │
│      ▼                    │     │                                    │
│   7. Mark synced ◄───────┴─────┘                                    │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

**Local Storage** (IndexedDB):

```typescript
interface PendingBlobUpload {
  hash: string;
  data: ArrayBuffer;         // Blob content
  mimeType: string;
  status: BlobSyncStatus;
  createdAt: number;
  lastAttempt?: number;
  error?: string;
}
```

**Sync Behavior**:
- Blobs are hashed client-side before upload
- If online: check if blob exists (HEAD request), claim if yes, upload if no
- If offline: store in IndexedDB, sync when connectivity restored
- Upload progress is reported via events
- Failed uploads are retried with exponential backoff

**Cache Management**:
- Downloaded blobs are cached in IndexedDB for offline access
- Cache size is configurable via `blobCacheSize` option (default: 100 MB)
- LRU (Least Recently Used) eviction when cache is full
- Pending uploads are stored separately and don't count toward cache limit

### Security Considerations

#### Hash = Access Model

Since anyone with the hash can access a blob, users should understand:
- Sharing a hash is equivalent to sharing the content
- Hashes should be treated as semi-secret for private content
- For truly private content, encrypt before uploading

#### Hash Collision Resistance

SHA-256 provides sufficient collision resistance:
- 2^128 operations for birthday attack
- No known practical attacks

#### Upload Validation

- Chunks are validated for size
- Final hash is computed server-side and verified
- MIME type is stored but not trusted (use Content-Disposition for downloads)

#### Quota Enforcement

- Quota checked at upload init (expected size)
- Quota checked at claim time
- Prevents users from claiming more than their quota allows

### Example Usage

```typescript
const client = new RatatoskrClient({
  serverUrl: 'https://sync.example.com',
  blobCacheSize: 200 * 1024 * 1024,  // 200 MB cache
});
await client.login();

// === User Claims ===

// Upload a file (creates user claim)
const file = new File(['Hello, World!'], 'hello.txt', { type: 'text/plain' });
const blob = await client.uploadBlob(file, {
  onProgress: (p) => console.log(`${p.phase}: ${p.bytesProcessed}/${p.totalBytes}`)
});
console.log(`Uploaded: ${blob.hash}`);

// Share the hash with another user...
// Other user claims the blob
const claimed = await otherClient.claimBlob(blob.hash);

// Download
const data = await client.downloadBlob(blob.hash);

// Or get direct URL for <img src="...">
const url = client.getBlobUrl(blob.hash);

// Release when done
await client.releaseBlobClaim(blob.hash);

// === Document Claims ===

// Create a document for notes
const docId = `doc:${crypto.randomUUID()}`;
await client.createDocument({ id: docId, type: 'com.example/note' });

// Upload an image and attach to document
const imageFile = document.getElementById('imageInput').files[0];
const imageBlob = await client.uploadBlobToDocument(docId, imageFile);

// Store the hash in your document content
const handle = client.getRepo().find(docId);
handle.change(doc => {
  doc.images = doc.images || [];
  doc.images.push(imageBlob.hash);
});

// When the document is deleted, the blob claim is automatically released
await client.deleteDocument(docId);
// → If no other claims exist, blob enters 24h grace period
```

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
