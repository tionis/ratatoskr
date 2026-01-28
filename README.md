# Ratatoskr

Ratatoskr is an automerge-repo sync server with authentication and per-document permissions. It provides shared backend infrastructure for multiple web applications that need real-time collaborative document synchronization.

## Features

- **Automerge-repo sync**: Real-time document synchronization using automerge
- **OIDC authentication**: Integrates with any OIDC provider (e.g., Authentik)
- **Web UI**: Built-in dashboard for managing documents, ACLs, and API tokens
- **Per-document permissions**: Flexible ACL system with owner-based access control
- **Offline-first client**: Create and edit documents offline, auto-sync when back online
- **Blob storage**: Content-addressable file storage with chunked uploads and deduplication
- **Multiple document types**:
  - `doc:` - Regular documents with full ACL support
  - `app:` - Per-user-per-app private documents
  - `eph:` - Ephemeral relay documents for temporary collaboration
- **Rate limiting**: Protection against abuse for anonymous users
- **Quotas**: Per-user limits on document count, size, blob storage, and total storage

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) v1.0+
- OIDC provider (e.g., Authentik)

### Using Podman

```bash
podman run -d \
  -p 4151:4151 \
  -v ratatoskr-data:/app/data \
  -e BASE_URL=http://localhost:4151 \
  -e OIDC_ISSUER=https://auth.example.com/application/o/your-app/ \
  -e OIDC_CLIENT_ID=your-client-id \
  -e OIDC_REDIRECT_URI=http://localhost:4151/api/v1/auth/callback \
  ghcr.io/tionis/ratatoskr:latest
```

### From Source

```bash
# Clone the repository
git clone <repository-url>
cd ratatoskr

# Install dependencies
bun install

# Configure environment (see Configuration below)
cp .env.example .env
# Edit .env with your settings

# Run migrations
bun run db:migrate

# Start server
bun run dev
```

### Configuration

Create a `.env` file with:

```bash
PORT=4151
BASE_URL=http://localhost:4151

# For Authentik, use the application-specific OIDC endpoint
OIDC_ISSUER=https://auth.example.com/application/o/your-app/
OIDC_CLIENT_ID=your-client-id
OIDC_REDIRECT_URI=http://localhost:4151/api/v1/auth/callback

DATA_DIR=./data
```

See [docs/dev.md](docs/dev.md) for full configuration options.

## Documentation

- [Client Library](client/README.md) - Browser client library documentation
- [CLI Tools](docs/cli.md) - Admin and User CLI documentation
- [Design Document](DESIGN.md) - Architecture and API specification
- [Development Guide](docs/dev.md) - Local development setup

**Live Documentation:** Every Ratatoskr server serves client library docs at `/docs` (e.g., `http://localhost:4151/docs`).

## Web UI

Ratatoskr includes a built-in web dashboard accessible at the server root URL (e.g., `http://localhost:4151/`).

Features:
- **Login via OIDC**: Authenticate using your identity provider
- **Document Management**: View, create, and delete documents
- **ACL Editor**: Configure access permissions for documents
- **API Token Management**: Create and manage API tokens for CLI/programmatic access
- **Account Overview**: View quotas and usage statistics

## API Overview

### REST API

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |
| `GET /api/v1/auth/login` | Initiate OIDC login |
| `GET /api/v1/auth/userinfo` | Get current user info |
| `POST /api/v1/documents` | Create document |
| `GET /api/v1/documents` | List documents |
| `PUT /api/v1/documents/:id/acl` | Update document ACL |
| `POST /api/v1/blobs/upload/init` | Initialize chunked blob upload |
| `PUT /api/v1/blobs/upload/:id/chunk/:index` | Upload a chunk |
| `POST /api/v1/blobs/upload/:id/complete` | Complete blob upload |
| `GET /api/v1/blobs/:hash` | Download blob by hash |
| `POST /api/v1/blobs/:hash/claim` | Claim an existing blob |
| `GET /api/v1/blobs` | List user's claimed blobs |

### WebSocket Sync

Connect to `/sync` and send an auth message (CBOR encoded):

```json
{"type": "auth", "token": "<your-token>"}
```

## Client Library

The browser client library is available on npm as `ratatoskr-client`.

### Installation

```bash
npm install ratatoskr-client @automerge/automerge-repo
```

### Direct ESM Import (No Build Step)

```html
<script type="module">
import { RatatoskrClient } from 'https://esm.sh/ratatoskr-client';

const client = new RatatoskrClient({
  serverUrl: 'https://your-ratatoskr-server.com'
});

await client.login();
const repo = client.getRepo();
</script>
```

### Usage

```typescript
import { RatatoskrClient } from 'ratatoskr-client';

const client = new RatatoskrClient({
  serverUrl: 'http://localhost:4151',
});

// Authenticate via popup
await client.login();

// Get automerge-repo instance
const repo = client.getRepo();

// Create a document (type is optional)
await client.createDocument({
  id: 'doc:my-document',
  type: 'notes',
});

// List documents
const { owned, accessible } = await client.listDocuments();

// Manage ACLs
await client.setDocumentACL('doc:my-document', [
  { principal: 'other-user', permission: 'read' },
  { principal: 'public', permission: 'read' },
]);

// API tokens
const { token, id } = await client.createApiToken('my-cli-tool', ['read', 'write']);

// Real-time sync via automerge-repo
const handle = repo.find('doc:my-document');
```

See [client/README.md](client/README.md) for full documentation.

## Container

### Build locally

```bash
podman build -t ratatoskr -f Containerfile .
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `4151` | Server port |
| `HOST` | No | `0.0.0.0` | Server host |
| `BASE_URL` | Yes | - | Public URL of the server |
| `DATA_DIR` | No | `./data` | Data directory path |
| `OIDC_ISSUER` | Yes | - | OIDC provider discovery URL |
| `OIDC_CLIENT_ID` | Yes | - | OIDC client ID |
| `OIDC_CLIENT_SECRET` | No | - | OIDC client secret (for confidential clients) |
| `OIDC_REDIRECT_URI` | Yes | - | OAuth callback URL |

## Development

```bash
# Development server with hot reload
bun run dev

# Run tests
bun test

# Lint and format
bun run lint:fix

# Type check
bun run typecheck
```

## License

[License TBD]
