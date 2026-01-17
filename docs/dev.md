# Development Guide

This document covers how to set up and develop Ratatoskr locally.

## Prerequisites

- [Bun](https://bun.sh/) v1.0 or later
- An OIDC provider (e.g., Authentik) for authentication testing

## Setup

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd ratatoskr
   ```

2. Install dependencies:
   ```bash
   bun install
   ```

3. Create a `.env` file (see [Configuration](#configuration) below)

4. Run database migrations:
   ```bash
   bun run db:migrate
   ```

5. Start the development server:
   ```bash
   bun run dev
   ```

## Configuration

Create a `.env` file in the project root:

```bash
# Server
PORT=4151
HOST=0.0.0.0
BASE_URL=http://localhost:4151

# OIDC - Uses PKCE (public client, no secret needed)
OIDC_ISSUER=https://auth.tionis.dev
OIDC_CLIENT_ID=juhMlePBJWwnVCxbnO5bFJJcaMIN0tVahhfqVj2Q
OIDC_REDIRECT_URI=http://localhost:4151/api/v1/auth/callback

# Storage
DATA_DIR=./data

# Optional: Override default quotas
# DEFAULT_MAX_DOCUMENTS=10000
# DEFAULT_MAX_DOCUMENT_SIZE=10485760
# DEFAULT_MAX_TOTAL_STORAGE=1073741824
```

## Available Scripts

| Command | Description |
|---------|-------------|
| `bun run dev` | Start dev server with hot reload |
| `bun run start` | Start production server |
| `bun test` | Run tests |
| `bun test --watch` | Run tests in watch mode |
| `bun run lint` | Check linting and formatting |
| `bun run lint:fix` | Auto-fix linting and formatting issues |
| `bun run typecheck` | Run TypeScript type checking |
| `bun run db:migrate` | Run database migrations |

## Project Structure

```
src/
├── index.ts          # Entry point
├── config.ts         # Environment configuration
├── server.ts         # Fastify server setup
├── auth/             # Authentication (OIDC, tokens)
├── api/              # REST API routes
├── sync/             # WebSocket sync handler
├── storage/          # Database and file storage
└── lib/              # Shared utilities (ACL, rate limiting, etc.)
```

## Testing

Tests use Bun's built-in test runner:

```bash
# Run all tests
bun test

# Run specific test file
bun test test/acl.test.ts

# Run in watch mode
bun test --watch
```

## Code Style

This project uses [Biome](https://biomejs.dev/) for linting and formatting:

```bash
# Check for issues
bun run lint

# Auto-fix issues
bun run lint:fix

# Format only
bun run format
```

## Database

SQLite is used for metadata storage. The database file is stored at `{DATA_DIR}/ratatoskr.db`.

### Migrations

Migrations run automatically on startup. To run them manually:

```bash
bun run db:migrate
```

### Schema

See `DESIGN.md` for the full database schema.

## API Testing

### Health Check

```bash
curl http://localhost:4151/health
```

### Create API Token (after authentication)

```bash
curl -X POST http://localhost:4151/api/v1/auth/api-tokens \
  -H "Authorization: Bearer <session-token>" \
  -H "Content-Type: application/json" \
  -d '{"name": "dev-token"}'
```

### List Documents

```bash
curl http://localhost:4151/api/v1/documents \
  -H "Authorization: Bearer <token>"
```

## Debugging

### Enable Debug Logging

Set the `DEBUG` environment variable:

```bash
DEBUG=* bun run dev
```

### Database Inspection

The SQLite database can be inspected with any SQLite client:

```bash
sqlite3 ./data/ratatoskr.db
```
