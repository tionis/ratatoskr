# Ratatoskr Command Line Interfaces

Ratatoskr provides two CLI tools for managing the server and interacting with the API.

## Admin CLI (Server Binary)

The Admin CLI is integrated directly into the `ratatoskr` server binary (or `src/index.ts` during development). It provides direct access to the database and storage layer, bypassing API permission checks.

**Usage:**
- Runs on the server machine.
- Requires read/write access to the `data/` directory.
- Bypasses all ACLs (root access).

### Commands

Run `bun run src/index.ts --help` (or `./ratatoskr --help` if using the binary) to see available commands.

#### User Management
```bash
# List all users
ratatoskr user list [limit] [offset]

# Get user details
ratatoskr user get <user_id>

# Manually create a user
ratatoskr user create <user_id> [email] [name]
```

#### Document Management
```bash
# List all documents (system-wide)
ratatoskr doc list

# View document metadata
ratatoskr doc get <doc_id>

# Read document content (outputs text)
ratatoskr doc cat <doc_id>

# Force delete a document
ratatoskr doc delete <doc_id>
```

#### Blob Management
```bash
# List all blobs
ratatoskr blob list

# View blob metadata
ratatoskr blob get <hash>

# Force delete a blob
ratatoskr blob delete <hash>
```

---

## User CLI (Client Script)

The User CLI (`src/user-cli.ts`) interacts with the Ratatoskr API using an API token. It respects all server-side permissions, ACLs, and quotas.

**Usage:**
- Can run on any machine with network access to the server.
- Requires an API token (generate one via the Web UI or Admin CLI).
- Stores configuration in `~/.ratatoskr-cli.json`.

### Setup

1.  **Get an API Token**: Log in to the Web UI and create a token, or ask an administrator.
2.  **Login**:
    ```bash
    bun run src/user-cli.ts login <server_url> <token>
    # Example:
    # bun run src/user-cli.ts login http://localhost:4151 rat_abcdef123456...
    ```

### Commands

#### Basics
```bash
# Check current authenticated user
ratatoskr-user whoami
```

#### Documents
```bash
# List your documents (owned and accessible)
ratatoskr-user doc list

# Create a new document
ratatoskr-user doc create <type>

# Get document metadata
ratatoskr-user doc get <doc_id>

# Edit a document (opens $EDITOR)
ratatoskr-user doc edit <doc_id>

# Watch a document live
ratatoskr-user doc watch <doc_id>

# Delete a document (if owner)
ratatoskr-user doc delete <doc_id>
```

#### Blobs
```bash
# Upload a file (calculates SHA-256, deduplicates, uploads in chunks)
ratatoskr-user blob upload ./path/to/file.png

# List your claimed blobs
ratatoskr-user blob list

# Download a blob
ratatoskr-user blob download <hash> [output_filename]

# Release claim on a blob
ratatoskr-user blob delete <hash>
```
