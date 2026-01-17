# ratatoskr-client

Browser client library for [Ratatoskr](https://github.com/tionis/ratatoskr) - an automerge-repo sync server with authentication and per-document permissions.

## Features

- 🔐 **Popup-based OIDC authentication** - Seamless login flow
- 📡 **WebSocket sync** - Real-time document synchronization via automerge-repo
- 📄 **Document management** - Create, list, delete documents
- 🔑 **Access control** - Manage document ACLs and permissions
- 🎫 **API tokens** - Generate tokens for CLI/programmatic access
- 🌐 **Works everywhere** - Browser, bundlers, or direct ESM import

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
    serverUrl: 'https://your-ratatoskr-server.com'
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
      serverUrl: 'https://your-server.com'
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

#### Authentication Methods

##### `login(): Promise<User>`

Opens a popup for OIDC authentication. Returns user info on success.

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

Check if user has a stored token.

```typescript
if (client.isAuthenticated()) {
  // Token exists (may still be expired)
}
```

##### `getUser(): User | null`

Get the current user object (available after `login()` or `fetchUserInfo()`).

##### `fetchUserInfo(): Promise<User>`

Fetch current user info from the server. Useful to validate stored tokens.

```typescript
try {
  const user = await client.fetchUserInfo();
  console.log('Token valid for:', user.name);
} catch {
  console.log('Token expired, need to login again');
  client.logout();
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
        "ratatoskr-client": "https://esm.sh/ratatoskr-client",
        "@automerge/automerge-repo": "https://esm.sh/@automerge/automerge-repo"
      }
    }
  </script>
</head>
<body>
  <script type="module">
    import { RatatoskrClient } from 'ratatoskr-client';
    
    const client = new RatatoskrClient({
      serverUrl: 'https://sync.example.com'
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
const response = await fetch('https://sync.example.com/api/v1/documents', {
  headers: {
    'Authorization': `Bearer ${process.env.RATATOSKR_TOKEN}`
  }
});
```

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
