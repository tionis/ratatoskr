# ratatoskr-client

Browser client library for [Ratatoskr](https://github.com/tionis/ratatoskr) - an automerge-repo sync server with authentication and per-document permissions.

## Features

- 🔐 **Popup-based OIDC authentication** - Seamless login flow
- 📡 **WebSocket sync** - Real-time document synchronization via automerge-repo
- 📄 **Document management** - Create, list, delete documents
- 🔑 **Access control** - Manage document ACLs and permissions
- 🎫 **API tokens** - Generate tokens for CLI/programmatic access
- 🌐 **Works everywhere** - Browser, bundlers, or direct ESM import
- 📴 **Offline-first** - Create and edit documents offline, sync when back online
- 💾 **Persistent storage** - Documents saved to IndexedDB survive browser sessions

## Quick Start

### Installation (npm/bun/yarn)

```bash
npm install ratatoskr-client @automerge/automerge-repo
```

### Direct ESM Import (No Build Step)

```html
<script type="module">
  import { RatatoskrClient } from 'https://esm.sh/ratatoskr-client';
  import { Repo } from 'https://esm.sh/@automerge/automerge-repo';
  
  const client = new RatatoskrClient({
    serverUrl: window.location.origin
  });
  
  // Login via popup
  const user = await client.login();
  console.log('Logged in as:', user.name);
  
  // Get automerge repo for real-time sync
  const repo = client.getRepo();
</script>
```

## Complete Example

```html
<!DOCTYPE html>
<html>
<head>
  <title>Ratatoskr Example</title>
</head>
<body>
  <button id="login">Login</button>
  <button id="create">Create Document</button>
  <div id="output"></div>

  <script type="module">
    import { RatatoskrClient } from 'https://esm.sh/ratatoskr-client';
    
    const client = new RatatoskrClient({
      serverUrl: window.location.origin
    });
    
    // Login button
    document.getElementById('login').onclick = async () => {
      try {
        const user = await client.login();
        document.getElementById('output').textContent = `Hello, ${user.name}!`;
      } catch (err) {
        alert('Login failed: ' + err.message);
      }
    };
    
    // Create document button
    document.getElementById('create').onclick = async () => {
      const doc = await client.createDocument({
        id: `doc:${crypto.randomUUID()}`,
        type: 'notes'
      });
      console.log('Created:', doc);
    };
  </script>
</body>
</html>
```

## API Reference

### RatatoskrClient

The main client class for interacting with a Ratatoskr server.

#### Constructor

```typescript
new RatatoskrClient(options: RatatoskrClientOptions)
```

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `serverUrl` | `string` | ✅ | - | Base URL of the Ratatoskr server |
| `tokenStorageKey` | `string` | ❌ | `"ratatoskr:token"` | localStorage key for token persistence |
| `enableOfflineSupport` | `boolean` | ❌ | `true` | Enable offline-first document creation with IndexedDB storage |

#### Authentication Methods

##### `login(): Promise<User>`

Opens a popup for OIDC authentication. Returns user info on success. Requires network connectivity.

```typescript
const user = await client.login();
// { id: "alice", name: "Alice Smith", email: "alice@example.com" }
```

##### `logout(): void`

Clears stored credentials and disconnects.

```typescript
client.logout();
```

##### `isAuthenticated(): boolean`

Check if user has a stored token (doesn't validate the token).

```typescript
if (client.isAuthenticated()) {
  // Token exists (may still be expired)
}
```

##### `hasStoredCredentials(): boolean`

Check if both token and user info are cached. Useful for showing "Welcome back" UI even when offline.

```typescript
if (client.hasStoredCredentials()) {
  console.log(`Welcome back, ${client.getUser()?.name}!`);
}
```

##### `getUser(): User | null`

Get the current user object. When offline with stored credentials, returns the cached user.

##### `fetchUserInfo(): Promise<User>`

Fetch current user info from the server. Updates the cached user info. Useful to validate stored tokens.

```typescript
try {
  const user = await client.fetchUserInfo();
  console.log('Token valid for:', user.name);
} catch {
  console.log('Token expired, need to login again');
}
```

##### `validateToken(): Promise<boolean>`

Validate the stored token by fetching user info. Returns `true` if valid, `false` if expired/invalid.

```typescript
if (client.isAuthenticated()) {
  const isValid = await client.validateToken();
  if (!isValid) {
    // Token expired, prompt re-login
  }
}
```

#### Automerge Integration

##### `getRepo(): Repo`

Get or create the automerge-repo instance connected to the server.

```typescript
const repo = client.getRepo();

// Find an existing document
const handle = repo.find('doc:abc123');
await handle.whenReady();
const doc = handle.docSync();

// Create a new document
const newHandle = repo.create();
newHandle.change(doc => {
  doc.title = 'My Document';
  doc.items = [];
});
```

##### `disconnect(): void`

Disconnect from the server and clean up the repo.

```typescript
client.disconnect();
```

#### Document Management

##### `createDocument(request): Promise<DocumentMetadata>`

Create a new document on the server.

```typescript
const doc = await client.createDocument({
  id: 'doc:my-unique-id',      // Required: doc:, app:, or eph: prefix
  type: 'notes',                // Optional: document type
  acl: [                        // Optional: initial ACL
    { principal: 'bob', permission: 'write' },
    { principal: 'public', permission: 'read' }
  ],
  expiresAt: '2025-12-31'       // Optional: auto-delete date
});
```

**Document ID Prefixes:**
| Prefix | Example | Description |
|--------|---------|-------------|
| `doc:` | `doc:abc123` | Regular document with full ACL support |
| `app:` | `app:myapp` | Per-user-per-app private document |
| `eph:` | `eph:session` | Ephemeral document (no persistence) |

##### `listDocuments(): Promise<ListDocumentsResponse>`

List documents you own or have access to.

```typescript
const { owned, accessible } = await client.listDocuments();

console.log('My documents:', owned);
console.log('Shared with me:', accessible);
```

##### `getDocument(id): Promise<DocumentMetadata>`

Get metadata for a specific document.

```typescript
const doc = await client.getDocument('doc:abc123');
console.log('Owner:', doc.owner);
console.log('Size:', doc.size);
```

##### `deleteDocument(id): Promise<void>`

Delete a document (owner only).

```typescript
await client.deleteDocument('doc:abc123');
```

#### Access Control

##### `getDocumentACL(id): Promise<ACLEntry[]>`

Get the access control list for a document.

```typescript
const acl = await client.getDocumentACL('doc:abc123');
// [{ principal: 'bob', permission: 'write' }]
```

##### `setDocumentACL(id, acl): Promise<void>`

Update a document's ACL (owner only).

```typescript
await client.setDocumentACL('doc:abc123', [
  { principal: 'bob', permission: 'write' },
  { principal: 'charlie', permission: 'read' },
  { principal: 'public', permission: 'read' }  // Anyone can read
]);
```

**ACL Entries:**
| Principal | Description |
|-----------|-------------|
| User ID | Grant access to specific user |
| Document ID | Inherit ACL from another document |
| `"public"` | Grant access to everyone (including anonymous) |

**Permissions:**
| Permission | Allows |
|------------|--------|
| `"read"` | Read document content |
| `"write"` | Read and write document content |

#### API Tokens

##### `createApiToken(name, scopes?, expiresAt?): Promise<{token, id}>`

Create an API token for CLI or programmatic access.

```typescript
const { token, id } = await client.createApiToken(
  'my-cli-tool',
  ['read', 'write'],       // Optional scopes
  '2026-01-01T00:00:00Z'   // Optional expiration
);

console.log('Save this token:', token);  // Only shown once!
```

##### `listApiTokens(): Promise<ApiToken[]>`

List all your API tokens (tokens values are not returned).

```typescript
const tokens = await client.listApiTokens();
for (const t of tokens) {
  console.log(`${t.name} (${t.id}) - last used: ${t.lastUsedAt}`);
}
```

##### `deleteApiToken(id): Promise<void>`

Revoke an API token.

```typescript
await client.deleteApiToken('token-id-here');
```

#### KV Store

The KV store provides simple per-user key-value storage, namespaced by application. This is useful for storing app configuration, document references, or other metadata.

##### `kvGet(namespace, key): Promise<string | null>`

Get a value from the KV store.

```typescript
const rootDocUrl = await client.kvGet('dev.myapp', 'root');
if (rootDocUrl) {
  const handle = repo.find(rootDocUrl);
}
```

##### `kvSet(namespace, key, value): Promise<void>`

Set a value in the KV store (max 64KB per value).

```typescript
await client.kvSet('dev.myapp', 'root', 'automerge:abc123');
await client.kvSet('dev.myapp', 'settings', JSON.stringify({ theme: 'dark' }));
```

##### `kvDelete(namespace, key): Promise<boolean>`

Delete a value. Returns `true` if deleted, `false` if not found.

```typescript
const deleted = await client.kvDelete('dev.myapp', 'oldKey');
```

##### `kvList(namespace): Promise<Array<{key, value, updatedAt}>>`

List all entries in a namespace.

```typescript
const entries = await client.kvList('dev.myapp');
for (const { key, value } of entries) {
  console.log(`${key}: ${value}`);
}
```

#### App Document Helper

##### `getOrCreateAppDocument<T>(namespace, options?): Promise<{handle, url, isNew}>`

Get or create a per-user root document for your application. This implements the recommended pattern for app state management:

1. Check server-side KV store for existing document URL
2. If found, return the existing document
3. If not found, create a new document and store its URL

```typescript
// Get or create the app's root document
const { handle, url, isNew } = await client.getOrCreateAppDocument('dev.myapp', {
  key: 'root',           // KV key (default: 'root')
  type: 'app-index',     // Document type for server registration
  initialize: (doc) => { // Called only when creating new document
    doc.notes = [];
    doc.settings = { theme: 'light' };
  }
});

// Wait for document to be ready
await handle.whenReady();

// Use the document
const doc = handle.docSync();
console.log('Notes:', doc.notes);

// The URL persists across sessions via server-side KV store
if (isNew) {
  console.log('Created new app document');
} else {
  console.log('Loaded existing app document');
}
```

This pattern ensures:
- Each user gets their own private root document
- Document URL is stored server-side (survives browser data clearing)
- Subsequent calls return the same document
- No need for localStorage management

#### Blob Storage

Ratatoskr provides content-addressable blob storage with automatic deduplication. Blobs are identified by their SHA-256 hash and can be shared across users.

##### `uploadBlob(data, options?): Promise<BlobInfo>`

Upload a blob to the server with chunked upload support for large files.

```typescript
// Upload a file
const file = document.querySelector('input[type="file"]').files[0];
const blob = await client.uploadBlob(file, {
  onProgress: (progress) => {
    console.log(`${progress.phase}: ${progress.bytesProcessed}/${progress.totalBytes}`);
  }
});
console.log('Uploaded:', blob.hash);

// Upload raw data
const data = new Uint8Array([1, 2, 3, 4]);
const result = await client.uploadBlob(data, {
  mimeType: 'application/octet-stream'
});
```

Progress phases: `"hashing"` → `"checking"` → `"uploading"` → `"complete"`

##### `downloadBlob(hash): Promise<Uint8Array>`

Download a blob by its hash.

```typescript
const data = await client.downloadBlob('abc123...');
```

##### `getBlobUrl(hash): string`

Get the direct URL for a blob. Useful for `<img src="...">` or direct links.

```typescript
const url = client.getBlobUrl('abc123...');
// https://server.com/api/v1/blobs/abc123...
```

##### `getBlobInfo(hash): Promise<BlobInfo | null>`

Get blob metadata without downloading the content.

```typescript
const info = await client.getBlobInfo('abc123...');
if (info) {
  console.log(`Size: ${info.size}, Type: ${info.mimeType}`);
}
```

##### `claimBlob(hash): Promise<BlobInfo>`

Claim an existing blob by its hash. This adds you as a claimer, counting towards your quota.

```typescript
const blob = await client.claimBlob('abc123...');
```

##### `releaseBlobClaim(hash): Promise<void>`

Release your claim on a blob. When all claims are released, the blob is cleaned up after a grace period.

```typescript
await client.releaseBlobClaim('abc123...');
```

##### `listClaimedBlobs(options?): Promise<ListBlobsResponse>`

List all blobs you've claimed with quota information.

```typescript
const { blobs, total, quotaUsed, quotaLimit } = await client.listClaimedBlobs({
  limit: 20,
  offset: 0
});

console.log(`Using ${quotaUsed} of ${quotaLimit} bytes`);
```

##### Document Blob Claims

Blobs can be attached to documents. When the document is deleted, its blob claims are automatically released.

```typescript
// Upload and attach to document in one call
const blob = await client.uploadBlobToDocument('doc:my-doc', file);

// Or attach an existing blob to a document
await client.addDocumentBlobClaim('doc:my-doc', 'abc123...');

// Remove blob from document
await client.removeDocumentBlobClaim('doc:my-doc', 'abc123...');

// List document's blobs
const { blobs, totalSize } = await client.listDocumentBlobs('doc:my-doc');
```

#### Offline-First Document Creation

Documents can be created and edited offline. They'll be registered on the server when connectivity and authentication are restored.

##### `createDocumentOffline<T>(initialValue, options?): Promise<string>`

Create a document that works offline. Returns the document ID immediately.

```typescript
// Create document offline - works even without network
const docId = await client.createDocumentOffline(
  { title: 'My Notes', items: [] },
  { type: 'notes' }
);

// Document is usable immediately via automerge
const handle = client.getRepo().find(docId);
handle.change(doc => {
  doc.items.push('First item');
});

// When online + authenticated, document auto-registers on server
```

**Note:** Documents created offline are **private** (no ACLs) until you're online. You can set ACLs after the document syncs using `setDocumentACL()`.

##### `getDocumentSyncStatus(documentId): Promise<DocumentStatusEntry | undefined>`

Get the sync status of a document.

```typescript
const status = await client.getDocumentSyncStatus(docId);
if (status) {
  console.log('Status:', status.status); // 'local' | 'syncing' | 'synced'
  console.log('Registered on server:', status.serverRegistered);
}
```

##### `getConnectivityState(): ConnectivityState`

Get the current connectivity state.

```typescript
const state = client.getConnectivityState();
// 'online' | 'offline' | 'connecting'
```

##### `processPendingOperations(): Promise<{processed, failed}>`

Force processing of pending sync operations. Useful after login.

```typescript
await client.login();
const result = await client.processPendingOperations();
console.log(`Synced ${result.processed} documents`);
```

##### `getPendingOperationsCount(): Promise<number>`

Get the number of pending sync operations.

##### `getUnsyncedDocuments(): Promise<DocumentStatusEntry[]>`

Get all documents that haven't been synced to the server yet.

##### `onSyncEvent(listener): () => void`

Subscribe to sync events. Returns an unsubscribe function.

```typescript
const unsubscribe = client.onSyncEvent((event) => {
  switch (event.type) {
    case 'connectivity:changed':
      console.log('Connectivity:', event.connectivity);
      break;
    case 'document:status-changed':
      console.log(`Document ${event.documentId}: ${event.status}`);
      break;
    case 'sync:completed':
      console.log(`Synced ${event.processed} documents`);
      break;
    case 'auth:required':
      console.log('Please log in to sync');
      break;
    case 'auth:token-expired':
      console.log('Token expired, please log in again');
      break;
  }
});

// Later: unsubscribe()
```

**Event Types:**
| Event | Description |
|-------|-------------|
| `connectivity:changed` | Network/server connection state changed |
| `document:status-changed` | A document's sync status changed |
| `sync:started` | Sync processing started |
| `sync:completed` | Sync processing completed |
| `sync:error` | Sync error occurred |
| `auth:required` | Authentication needed to continue syncing |
| `auth:token-expired` | Token is invalid/expired |

##### `isOfflineEnabled(): boolean`

Check if offline support is enabled.

##### `destroy(): void`

Cleanup all resources including IndexedDB connections.

### Types

```typescript
interface User {
  id: string;
  email?: string;
  name?: string;
}

interface DocumentMetadata {
  id: string;
  owner: string;
  type: string | null;
  size: number;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ACLEntry {
  principal: string;           // User ID, document ID, or "public"
  permission: 'read' | 'write';
}

interface ApiToken {
  id: string;
  name: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

// Blob types
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

interface ListBlobsResponse {
  blobs: BlobInfo[];
  total: number;
  quotaUsed: number;
  quotaLimit: number;
}

interface DocumentBlobsResponse {
  blobs: BlobInfo[];
  totalSize: number;
}

// Offline support types
type ConnectivityState = 'online' | 'offline' | 'connecting';

type DocumentSyncStatus = 'local' | 'syncing' | 'synced';

interface DocumentStatusEntry {
  documentId: string;
  status: DocumentSyncStatus;
  serverRegistered: boolean;
  createdAt: string;
  lastSyncAttempt?: string;
  error?: string;
}

type SyncEventType =
  | 'sync:started'
  | 'sync:completed'
  | 'sync:error'
  | 'document:status-changed'
  | 'connectivity:changed'
  | 'auth:required'
  | 'auth:token-expired';

interface SyncEvent {
  type: SyncEventType;
  documentId?: string;
  status?: DocumentSyncStatus;
  connectivity?: ConnectivityState;
  error?: string;
  processed?: number;
  failed?: number;
}
```

### RatatoskrNetworkAdapter

Low-level network adapter for custom automerge-repo setups.

```typescript
import { Repo } from '@automerge/automerge-repo';
import { RatatoskrNetworkAdapter } from 'ratatoskr-client';

const adapter = new RatatoskrNetworkAdapter({
  serverUrl: 'https://your-server.com',
  token: 'your-auth-token'  // Optional
});

const repo = new Repo({
  network: [adapter],
  peerId: 'my-peer-id'
});

// Update token after login
adapter.setToken(newToken);
```

## Usage Patterns

### Single-File HTML Tool

```html
<!DOCTYPE html>
<html>
<head>
  <title>My Tool</title>
  <script type="importmap">
    {
      "imports": {
        "ratatoskr-client": "https://esm.sh/ratatoskr-client?external=@automerge/automerge-repo",
        "@automerge/automerge-repo": "https://esm.sh/@automerge/automerge-repo"
      }
    }
  </script>
</head>
<body>
  <script type="module">
    import { RatatoskrClient } from 'ratatoskr-client';

    const client = new RatatoskrClient({
      serverUrl: window.location.origin
    });
    
    // Check for existing session
    if (client.isAuthenticated()) {
      try {
        await client.fetchUserInfo();
        startApp();
      } catch {
        client.logout();
        showLogin();
      }
    } else {
      showLogin();
    }
    
    function showLogin() {
      // Show login UI
    }
    
    async function startApp() {
      const repo = client.getRepo();
      // Use automerge-repo for real-time collaboration
    }
  </script>
</body>
</html>
```

### React/Vue/Svelte App

```typescript
// src/lib/ratatoskr.ts
import { RatatoskrClient } from 'ratatoskr-client';

export const client = new RatatoskrClient({
  serverUrl: import.meta.env.VITE_RATATOSKR_URL
});

// React hook example
export function useRatatoskr() {
  const [user, setUser] = useState(client.getUser());
  
  const login = async () => {
    const u = await client.login();
    setUser(u);
  };
  
  const logout = () => {
    client.logout();
    setUser(null);
  };
  
  return { client, user, login, logout };
}
```

### CLI Tool with API Token

```typescript
// Use the token directly with fetch or the network adapter
const response = await fetch(`${process.env.RATATOSKR_URL}/api/v1/documents`, {
  headers: {
    'Authorization': `Bearer ${process.env.RATATOSKR_TOKEN}`
  }
});
```

### App State Management Pattern

The recommended pattern for building apps with Ratatoskr uses a per-user root document to store app state and references to other documents:

```typescript
const APP_NAMESPACE = 'dev.mycompany.myapp';

async function initializeApp() {
  // 1. Login
  if (!client.isAuthenticated()) {
    await client.login();
  }

  // 2. Get the repo
  const repo = client.getRepo();

  // 3. Get or create the app's root document
  const { handle: appDoc, isNew } = await client.getOrCreateAppDocument(APP_NAMESPACE, {
    type: 'app-root',
    initialize: (doc) => {
      doc.notes = [];      // Array of note document URLs
      doc.settings = {};   // App settings
      doc.version = 1;     // Schema version for migrations
    }
  });

  // 4. Wait for document to be ready
  await appDoc.whenReady();

  // 5. Listen for changes
  appDoc.on('change', () => {
    renderUI(appDoc.docSync());
  });

  // 6. Create related documents as needed
  async function createNote(title) {
    const noteHandle = repo.create();
    noteHandle.change(doc => {
      doc.title = title;
      doc.content = '';
      doc.createdAt = Date.now();
    });

    // Add reference to root document
    appDoc.change(doc => {
      doc.notes.push(noteHandle.url);
    });

    return noteHandle;
  }

  return { appDoc, createNote };
}
```

This pattern provides:
- **Per-user isolation**: Each user gets their own root document
- **Server-side persistence**: Document URL stored in KV store (survives browser clearing)
- **Offline support**: Documents work offline, sync when back online
- **Collaboration**: Individual documents can be shared via ACLs
- **Discoverability**: Root document contains references to all related documents

## Error Handling

All async methods throw errors on failure:

```typescript
try {
  await client.login();
} catch (err) {
  if (err.message.includes('popup')) {
    // Popup was blocked or closed
  } else if (err.message.includes('timeout')) {
    // Authentication took too long
  }
}

try {
  await client.createDocument({ id: 'doc:test' });
} catch (err) {
  // err.message contains server error details
}
```

## Browser Compatibility

- Modern browsers with ES2022 support
- Requires `crypto.randomUUID()` (Chrome 92+, Firefox 95+, Safari 15.4+)
- WebSocket support required

## License

MIT
