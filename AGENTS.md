# Agent Instructions

Guidelines for LLM agents working on this repository.

## Before Starting

1. Read `DESIGN.md` to understand the architecture
2. Read `STATE.md` (gitignored) for current implementation status
3. Check `WORK_LOG.md` (gitignored) for recent changes

## During Work

- **Update `STATE.md`** when you complete features or discover issues
- **Update documentation** in `docs/` and `README.md` when changing behavior

## After Work

Add a summary to `WORK_LOG.md`:
```markdown
## YYYY-MM-DD

### Changes
- Brief description of what was done

### Notes
- Any important observations or decisions made
```

## Key Files

| File | Purpose |
|------|---------|
| `DESIGN.md` | Architecture and API specification |
| `STATE.md` | Current implementation status (gitignored) |
| `WORK_LOG.md` | Log of changes (gitignored) |
| `docs/dev.md` | Development setup guide |
| `README.md` | Project overview |

## Development

```bash
bun install        # Install dependencies
bun run dev        # Start dev server
bun test           # Run tests
bun run lint:fix   # Fix linting issues
bun run typecheck  # Type check
```

## Code Organization

- `src/auth/` - Authentication (OIDC, tokens)
- `src/api/` - REST API routes
- `src/sync/` - WebSocket sync handler
- `src/storage/` - Database and file storage
- `src/lib/` - Shared utilities

## Testing

Add tests for new functionality in `test/`. Use `bun:test`:

```typescript
import { describe, expect, test } from "bun:test";

describe("feature", () => {
  test("should work", () => {
    expect(true).toBe(true);
  });
});
```
