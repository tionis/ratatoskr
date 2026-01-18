import { createHash, randomBytes } from "node:crypto";
import type { ApiToken } from "../lib/types.ts";
import { getDb } from "../storage/database.ts";

const JWT_SECRET = process.env.JWT_SECRET || randomBytes(32).toString("hex");

export interface TokenPayload {
  sub: string;
  exp: number;
  iat: number;
  type: "session" | "api";
}

/**
 * Create a short-lived session token (JWT-like, but simpler).
 */
export function createSessionToken(
  userId: string,
  expiresInSeconds = 3600,
): string {
  const payload: TokenPayload = {
    sub: userId,
    exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    iat: Math.floor(Date.now() / 1000),
    type: "session",
  };

  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHash("sha256")
    .update(data + JWT_SECRET)
    .digest("base64url");

  return `${data}.${signature}`;
}

/**
 * Verify and decode a session token.
 */
export function verifySessionToken(token: string): TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) {
    return null;
  }

  const [data, signature] = parts;
  if (!data || !signature) {
    return null;
  }

  const expectedSignature = createHash("sha256")
    .update(data + JWT_SECRET)
    .digest("base64url");

  if (signature !== expectedSignature) {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(data, "base64url").toString(),
    ) as TokenPayload;

    if (payload.exp < Date.now() / 1000) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Create an API token for a user.
 */
export function createApiToken(
  userId: string,
  name: string,
  scopes?: string[],
  expiresAt?: Date,
): { token: string; record: ApiToken } {
  const token = `rat_${randomBytes(32).toString("hex")}`;
  const tokenHash = hashApiToken(token);
  const id = randomBytes(16).toString("hex");

  const stmt = getDb().prepare(`
    INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    RETURNING *
  `);

  const row = stmt.get(
    id,
    userId,
    name,
    tokenHash,
    scopes ? JSON.stringify(scopes) : null,
    expiresAt?.toISOString() ?? null,
  ) as Record<string, unknown>;

  return {
    token,
    record: rowToApiToken(row),
  };
}

/**
 * Verify an API token and return the associated user ID.
 */
export function verifyApiToken(token: string): string | null {
  if (!token.startsWith("rat_")) {
    return null;
  }

  const tokenHash = hashApiToken(token);

  const stmt = getDb().prepare(`
    SELECT * FROM api_tokens
    WHERE token_hash = ?
    AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
  `);

  const row = stmt.get(tokenHash) as Record<string, unknown> | undefined;

  if (!row) {
    return null;
  }

  // Update last used timestamp
  getDb()
    .prepare(
      "UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?",
    )
    .run(row.id as string);

  return row.user_id as string;
}

/**
 * List API tokens for a user.
 */
export function listApiTokens(userId: string): ApiToken[] {
  const stmt = getDb().prepare(
    "SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC",
  );
  const rows = stmt.all(userId) as Record<string, unknown>[];
  return rows.map(rowToApiToken);
}

/**
 * Delete an API token.
 */
export function deleteApiToken(id: string, userId: string): boolean {
  const stmt = getDb().prepare(
    "DELETE FROM api_tokens WHERE id = ? AND user_id = ?",
  );
  const result = stmt.run(id, userId);
  return result.changes > 0;
}

function hashApiToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function rowToApiToken(row: Record<string, unknown>): ApiToken {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    name: row.name as string,
    scopes: row.scopes ? JSON.parse(row.scopes as string) : null,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at as string) : null,
    expiresAt: row.expires_at ? new Date(row.expires_at as string) : null,
    createdAt: new Date(row.created_at as string),
  };
}
