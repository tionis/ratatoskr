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
      };
    }

    // Try API token
    const userId = verifyApiToken(token);
    if (userId) {
      return {
        userId,
        isAnonymous: false,
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
): Promise<void> {
  const auth = extractAuth(request);

  if (!auth) {
    reply.code(401).send({
      error: "unauthorized",
      message: "Authentication required",
    });
    return;
  }

  request.auth = auth;
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
