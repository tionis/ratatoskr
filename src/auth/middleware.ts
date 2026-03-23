import type { FastifyReply, FastifyRequest } from "fastify";
import type { AuthContext } from "../lib/types.ts";
import { verifyApiToken, verifySessionToken } from "./tokens.ts";

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

/**
 * Extract auth context from request.
 * Checks Authorization header for Bearer token or API token.
 */
export function extractAuth(request: FastifyRequest): AuthContext | null {
  const authHeader = request.headers.authorization;

  if (!authHeader) {
    return null;
  }

  if (authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);

    // Try session token first
    const payload = verifySessionToken(token);
    if (payload) {
      return {
        userId: payload.sub,
        isAnonymous: false,
        scopes: null, // Session tokens have full access
      };
    }

    // Try API token
    const apiToken = verifyApiToken(token);
    if (apiToken) {
      return {
        userId: apiToken.userId,
        isAnonymous: false,
        scopes: apiToken.scopes,
      };
    }
  }

  return null;
}

/**
 * Middleware that requires authentication.
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply | void> {
  const auth = extractAuth(request);

  if (!auth) {
    return reply.code(401).send({
      error: "unauthorized",
      message: "Authentication required",
    });
  }

  request.auth = auth;
}

/**
 * Check if the current auth context has the required scope.
 * Returns true if scopes is null (full access) or includes the required scope.
 */
export function hasScope(auth: AuthContext, scope: string): boolean {
  // null scopes = full access (session token or unscoped API token)
  if (auth.scopes === null) return true;
  return auth.scopes.includes(scope);
}

/**
 * Create a middleware that requires a specific scope.
 * Must be used after requireAuth.
 */
export function requireScope(scope: string) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | void> => {
    if (!request.auth) {
      return reply.code(401).send({
        error: "unauthorized",
        message: "Authentication required",
      });
    }

    if (!hasScope(request.auth, scope)) {
      return reply.code(403).send({
        error: "insufficient_scope",
        message: `This action requires the "${scope}" scope`,
      });
    }
  };
}

/**
 * Middleware that optionally extracts auth context.
 */
export async function optionalAuth(request: FastifyRequest): Promise<void> {
  const auth = extractAuth(request);
  if (auth) {
    request.auth = auth;
  }
}
