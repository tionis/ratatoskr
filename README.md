# Ratatoskr

Ratatoskr is an automerge-repo sync server with authentication and per-document permissions. It provides shared backend infrastructure for multiple web applications that need real-time collaborative document synchronization.

## Features

- **Automerge-repo sync**: Real-time document synchronization using automerge
- **OIDC authentication**: Integrates with any OIDC provider (e.g., Authentik)
- **Per-document permissions**: Flexible ACL system with owner-based access control
- **Multiple document types**:
  - `doc:` - Regular documents with full ACL support
  - `app:` - Per-user-per-app private documents
  - `eph:` - Ephemeral relay documents for temporary collaboration
- **Rate limiting**: Protection against abuse for anonymous users
- **Quotas**: Per-user limits on document count, size, and total storage

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) v1.0+
- OIDC provider (e.g., Authentik)

### Installation

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
PORT=3000
BASE_URL=http://localhost:3000

OIDC_ISSUER=https://auth.example.com
OIDC_CLIENT_ID=ratatoskr
OIDC_CLIENT_SECRET=your-secret
OIDC_REDIRECT_URI=http://localhost:3000/api/v1/auth/callback

DATA_DIR=./data
```

See [docs/dev.md](docs/dev.md) for full configuration options.

## Documentation

- [Design Document](DESIGN.md) - Architecture and API specification
- [Development Guide](docs/dev.md) - Local development setup

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

### WebSocket Sync

Connect to `/sync` and send an auth message (CBOR encoded):

```json
{"type": "auth", "token": "<your-token>"}
```

## Client Library

A browser client library is included in `client/`:

```typescript
import { RatatoskrClient } from './client/src';

const client = new RatatoskrClient({
  serverUrl: 'http://localhost:3000',
});

// Authenticate via popup
await client.login();

// Get automerge-repo instance
const repo = client.getRepo();

// Create a document
await client.createDocument({
  id: 'doc:my-document',
  type: 'com.example.myapp/note',
});

// Access via automerge-repo
const handle = repo.find('doc:my-document');
```

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
