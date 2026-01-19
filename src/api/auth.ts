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
        email: oidcUser.email ?? null,
        name: oidcUser.name ?? null,
      });

      // Create session token
      const token = createSessionToken(user.id);
      const userJson = JSON.stringify({
        id: user.id,
        email: user.email,
        name: user.name,
      });

      // Show confirmation page before sending credentials to opener
      return reply.type("text/html").send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Confirm Login</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            * { box-sizing: border-box; margin: 0; padding: 0; }
            body {
              font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
              background: #1a1a2e;
              color: #eaeaea;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 1rem;
            }
            .card {
              background: #16213e;
              border-radius: 12px;
              padding: 2rem;
              max-width: 400px;
              width: 100%;
              text-align: center;
              box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            }
            .avatar {
              width: 64px;
              height: 64px;
              background: #4f9cf9;
              border-radius: 50%;
              display: flex;
              align-items: center;
              justify-content: center;
              margin: 0 auto 1rem;
              font-size: 1.5rem;
            }
            h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
            .user-info { color: #a0a0a0; margin-bottom: 1.5rem; }
            .user-name { color: #4f9cf9; font-weight: 600; }
            .origin-box {
              background: #1a1a2e;
              border: 1px solid #2a2a4a;
              border-radius: 8px;
              padding: 1rem;
              margin-bottom: 1.5rem;
              word-break: break-all;
            }
            .origin-label { font-size: 0.75rem; color: #a0a0a0; margin-bottom: 0.25rem; }
            .origin-value { font-family: monospace; color: #4ade80; }
            .warning {
              font-size: 0.875rem;
              color: #fbbf24;
              margin-bottom: 1.5rem;
            }
            .buttons { display: flex; gap: 1rem; }
            button {
              flex: 1;
              padding: 0.75rem 1rem;
              border: none;
              border-radius: 8px;
              font-size: 1rem;
              font-weight: 600;
              cursor: pointer;
              transition: opacity 0.2s;
            }
            button:hover { opacity: 0.9; }
            .btn-approve { background: #4f9cf9; color: white; }
            .btn-deny { background: #4a4a6a; color: #eaeaea; }
            .no-opener {
              color: #f87171;
              padding: 1rem;
            }
          </style>
        </head>
        <body>
          <div class="card" id="confirm-card">
            <div class="avatar">${user.name?.[0]?.toUpperCase() || user.id[0]?.toUpperCase() || "?"}</div>
            <h1>Confirm Login</h1>
            <p class="user-info">
              Logged in as <span class="user-name">${user.name || user.id}</span>
            </p>
            <div class="origin-box">
              <div class="origin-label">Application requesting access:</div>
              <div class="origin-value" id="origin">Loading...</div>
            </div>
            <p class="warning">
              Only approve if you trust this application.
            </p>
            <div class="buttons">
              <button class="btn-deny" onclick="deny()">Deny</button>
              <button class="btn-approve" onclick="approve()">Approve</button>
            </div>
          </div>
          <div class="card no-opener" id="no-opener" style="display:none;">
            <h1>Authentication Successful</h1>
            <p>You can close this window.</p>
          </div>
          <script>
            const token = '${token}';
            const user = ${userJson};

            // Check if opened as popup
            if (!window.opener) {
              document.getElementById('confirm-card').style.display = 'none';
              document.getElementById('no-opener').style.display = 'block';
            } else {
              // Show the opener's origin
              // Note: We can't directly access opener.location due to cross-origin restrictions
              // Instead, we use document.referrer or let the client provide origin in state
              const openerOrigin = document.referrer ? new URL(document.referrer).origin : 'Unknown origin';
              document.getElementById('origin').textContent = openerOrigin;
            }

            function approve() {
              if (window.opener) {
                window.opener.postMessage({
                  type: 'ratatoskr:auth',
                  token: token,
                  user: user
                }, '*');
              }
              window.close();
            }

            function deny() {
              if (window.opener) {
                window.opener.postMessage({
                  type: 'ratatoskr:auth',
                  error: 'User denied the login request'
                }, '*');
              }
              window.close();
            }
          </script>
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
