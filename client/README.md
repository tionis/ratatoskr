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
- 🏠 **Opinionated State** - Automatic User and App root document management

## Quick Start

### Installation (npm/bun/yarn)

```bash
npm install ratatoskr-client @automerge/automerge-repo
```

### Self-Hosted Script

When running the Ratatoskr server, the client library is available at the root:

```html
<script type="module">
  import { RatatoskrClient } from '/ratatoskr-client.js';
  
  const client = new RatatoskrClient({
    serverUrl: window.location.origin
  });
</script>
```

### Direct ESM Import (No Build Step)

```html
<script type="module">
  import { RatatoskrClient } from 'https://esm.sh/ratatoskr-client';
  import { Repo } from 'https://esm.sh/@automerge/automerge-repo';
  
  const client = new RatatoskrClient({
    serverUrl: window.location.origin,
    appId: 'com.example.myapp' // Optional: Request an app-specific root document
  });
  
  // Login via popup
  const user = await client.login();
  console.log('Logged in as:', user.name);
  
  // Access automatically synced documents
  if (client.appDocHandle) {
    await client.appDocHandle.whenReady();
    console.log('App State:', client.appDocHandle.docSync());
  }
</script>
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
| `appId` | `string` | ❌ | - | Application identifier (e.g. 'com.myapp') |
| `tokenStorageKey` | `string` | ❌ | `"ratatoskr:token"` | localStorage key for token persistence |
| `enableOfflineSupport` | `boolean` | ❌ | `true` | Enable offline-first document creation with IndexedDB storage |

#### Properties

- `userDocHandle`: `DocHandle<UserDocument> | null` - Handle to the user's profile document (synced on login).
- `appDocHandle`: `DocHandle<any> | null` - Handle to the application's root document (synced if `appId` provided).

#### Authentication Methods

##### `login(): Promise<User>`

Opens a popup for OIDC authentication. Returns user info on success. Automatically syncs `userDocHandle` and `appDocHandle`.

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

##### `fetchUserInfo(): Promise<User>`

Fetch current user info from the server.

#### Automerge Integration

##### `getRepo(): Repo`

Get or create the automerge-repo instance connected to the server.

```typescript
const repo = client.getRepo();

// Find an existing document
const handle = repo.find('abc123xyz...'); // Use Base58 ID (automerge URL format supported)
await handle.whenReady();
const doc = handle.docSync();
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
  type: 'notes',                // Optional: document type
  acl: [                        // Optional: initial ACL
    { principal: 'bob', permission: 'write' },
    { principal: 'public', permission: 'read' }
  ],
  expiresAt: '2025-12-31'       // Optional: auto-delete date
});
console.log('Created ID:', doc.id);
```

##### `listDocuments(): Promise<ListDocumentsResponse>`

List documents you own or have access to.

```typescript
const { owned, accessible } = await client.listDocuments();
```

##### `getDocument(id): Promise<DocumentMetadata>`

Get metadata for a specific document.

##### `deleteDocument(id): Promise<void>`

Delete a document (owner only).

##### `createEphemeralDocument(id?): DocHandle<any>`

Create (or join) an ephemeral document. Ephemeral documents are relay-only and not persisted to the database. Useful for temporary peer-to-peer signaling or collaboration sessions.

```typescript
// Create with random ID
const handle = client.createEphemeralDocument();
console.log('Session ID:', handle.documentId); // starts with "eph:"

// Join known session
const sessionHandle = client.createEphemeralDocument('eph:my-session-id');
```

#### Access Control

##### `getDocumentACL(id): Promise<ACLEntry[]>`

Get the access control list for a document.

##### `setDocumentACL(id, acl): Promise<void>`

Update a document's ACL (owner only).

```typescript
await client.setDocumentACL('abc123...', [
  { principal: 'bob', permission: 'write' },
  { principal: 'public', permission: 'read' }
]);
```

#### Blob Storage

(Standard blob methods available: `uploadBlob`, `downloadBlob`, etc. See server documentation for details.)

#### App State Management Pattern

The recommended pattern uses the `appDocHandle` initialized via `appId` in the constructor.

```typescript
const client = new RatatoskrClient({
  serverUrl: '...',
  appId: 'com.mycompany.todo'
});

await client.login();

const appDoc = client.appDocHandle;
await appDoc.whenReady();

// Initialize if empty
appDoc.change(doc => {
  if (!doc.todos) doc.todos = [];
});

// Create a new item document
const repo = client.getRepo();
const itemHandle = repo.create();
itemHandle.change(d => { d.text = "Buy milk"; d.done = false; });

// Link it in the app root
appDoc.change(doc => {
  doc.todos.push(itemHandle.documentId);
});
```

This ensures each user has a unique, private root document for your application that persists across sessions and devices.

## License

MIT