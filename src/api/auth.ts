import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/middleware.ts";
import {
  generateCodeVerifier,
  getAuthorizationUrl,
  handleCallback,
} from "../auth/oidc.ts";
import {
  createApiToken,
  createSessionToken,
  deleteApiToken,
  listApiTokens,
} from "../auth/tokens.ts";
import { createUser, getUser } from "../storage/database.ts";
import { createApiTokenSchema } from "./schemas.ts";

// In-memory store for PKCE state (in production, use Redis or similar)
const pendingAuth = new Map<
  string,
  { codeVerifier: string; createdAt: number }
>();

// Clean up old pending auth entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [state, data] of pendingAuth) {
    if (now - data.createdAt > 10 * 60 * 1000) {
      // 10 minutes
      pendingAuth.delete(state);
    }
  }
}, 60_000);

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  // Initiate OIDC login
  fastify.get("/login", async (request, reply) => {
    const state = randomBytes(16).toString("hex");
    const codeVerifier = generateCodeVerifier();

    pendingAuth.set(state, { codeVerifier, createdAt: Date.now() });

    const authUrl = await getAuthorizationUrl(state, codeVerifier);

    // For popup flow, return the URL
    // The client library will open this in a popup
    if (request.headers.accept?.includes("application/json")) {
      return { url: authUrl, state };
    }

    // For direct navigation, redirect
    reply.redirect(authUrl);
  });

  // OIDC callback
  fastify.get("/callback", async (request, reply) => {
    const { code, state } = request.query as {
      code?: string;
      state?: string;
    };

    if (!code || !state) {
      reply.code(400).send({
        error: "invalid_request",
        message: "Missing code or state",
      });
      return;
    }

    const pending = pendingAuth.get(state);
    if (!pending) {
      reply.code(400).send({
        error: "invalid_request",
        message: "Invalid or expired state",
      });
      return;
    }

    pendingAuth.delete(state);

    try {
      const callbackUrl = new URL(request.url, "http://localhost");
      const oidcUser = await handleCallback(
        callbackUrl,
        state,
        pending.codeVerifier,
      );

      // Create or update user - prefer username over sub for cleaner IDs
      const userId = oidcUser.preferredUsername || oidcUser.sub;
      const user = createUser({
        id: userId,
        email: oidcUser.email,
        name: oidcUser.name,
      });

      // Create session token
      const token = createSessionToken(user.id);

      // For popup flow, return HTML that posts message to opener
      return reply.type("text/html").send(`
        <!DOCTYPE html>
        <html>
        <head><title>Authentication Complete</title></head>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({
                type: 'ratatoskr:auth',
                token: '${token}',
                user: ${JSON.stringify({ id: user.id, email: user.email, name: user.name })}
              }, '*');
              window.close();
            } else {
              document.body.innerHTML = '<p>Authentication successful. You can close this window.</p>';
            }
          </script>
          <p>Authentication successful. This window should close automatically.</p>
        </body>
        </html>
      `);
    } catch (err) {
      fastify.log.error(err);
      reply.code(500).send({
        error: "auth_failed",
        message: "Authentication failed",
      });
    }
  });

  // Get current user info
  fastify.get(
    "/userinfo",
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = getUser(request.auth!.userId);
      if (!user) {
        reply.code(404).send({
          error: "not_found",
          message: "User not found",
        });
        return;
      }

      return {
        id: user.id,
        email: user.email,
        name: user.name,
        quotas: {
          maxDocuments: user.quotaMaxDocuments,
          maxDocumentSize: user.quotaMaxDocumentSize,
          maxTotalStorage: user.quotaMaxTotalStorage,
        },
      };
    },
  );

  // Create API token
  fastify.post(
    "/api-tokens",
    { preHandler: requireAuth },
    async (request, reply) => {
      const result = createApiTokenSchema.safeParse(request.body);
      if (!result.success) {
        reply.code(400).send({
          error: "invalid_request",
          message: result.error.message,
        });
        return;
      }

      const { name, scopes, expiresAt } = result.data;

      const { token, record } = createApiToken(
        request.auth!.userId,
        name,
        scopes,
        expiresAt ? new Date(expiresAt) : undefined,
      );

      // Return the token only once - it cannot be retrieved later
      return {
        token,
        id: record.id,
        name: record.name,
        scopes: record.scopes,
        expiresAt: record.expiresAt?.toISOString() ?? null,
        createdAt: record.createdAt.toISOString(),
      };
    },
  );

  // List API tokens
  fastify.get("/api-tokens", { preHandler: requireAuth }, async (request) => {
    const tokens = listApiTokens(request.auth!.userId);

    return tokens.map((t) => ({
      id: t.id,
      name: t.name,
      scopes: t.scopes,
      lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
      expiresAt: t.expiresAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
    }));
  });

  // Delete API token
  fastify.delete(
    "/api-tokens/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const deleted = deleteApiToken(id, request.auth!.userId);

      if (!deleted) {
        reply.code(404).send({
          error: "not_found",
          message: "Token not found",
        });
        return;
      }

      reply.code(204).send();
    },
  );
}
