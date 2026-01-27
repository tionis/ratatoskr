/**
 * KV Store API routes.
 *
 * Provides a simple key-value store per user, namespaced by application.
 * Apps can use this to store metadata like their root document ID.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.ts";
import { kvDelete, kvGet, kvList, kvSet } from "../storage/database.ts";

// Namespace must be a valid identifier (e.g., "dev.tionis.notes")
const namespaceSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9._-]*$/,
    "Namespace must start with a letter and contain only alphanumeric characters, dots, underscores, and hyphens",
  );

// Key must be a valid identifier
const keySchema = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9._-]*$/,
    "Key must start with a letter and contain only alphanumeric characters, dots, underscores, and hyphens",
  );

// Value can be any string up to 64KB
const valueSchema = z.string().max(65536);

const setValueSchema = z.object({
  value: valueSchema,
});

export async function kvRoutes(fastify: FastifyInstance): Promise<void> {
  // Get a value
  fastify.get(
    "/:namespace/:key",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { namespace, key } = request.params as {
        namespace: string;
        key: string;
      };
      const userId = request.auth!.userId;

      // Validate params
      const nsResult = namespaceSchema.safeParse(namespace);
      if (!nsResult.success) {
        reply.code(400).send({
          error: "invalid_namespace",
          message: nsResult.error.message,
        });
        return;
      }

      const keyResult = keySchema.safeParse(key);
      if (!keyResult.success) {
        reply.code(400).send({
          error: "invalid_key",
          message: keyResult.error.message,
        });
        return;
      }

      const value = kvGet(userId, namespace, key);
      if (value === null) {
        reply.code(404).send({
          error: "not_found",
          message: "Key not found",
        });
        return;
      }

      return { namespace, key, value };
    },
  );

  // Set a value
  fastify.put(
    "/:namespace/:key",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { namespace, key } = request.params as {
        namespace: string;
        key: string;
      };
      const userId = request.auth!.userId;

      // Validate params
      const nsResult = namespaceSchema.safeParse(namespace);
      if (!nsResult.success) {
        reply.code(400).send({
          error: "invalid_namespace",
          message: nsResult.error.message,
        });
        return;
      }

      const keyResult = keySchema.safeParse(key);
      if (!keyResult.success) {
        reply.code(400).send({
          error: "invalid_key",
          message: keyResult.error.message,
        });
        return;
      }

      // Validate body
      const bodyResult = setValueSchema.safeParse(request.body);
      if (!bodyResult.success) {
        reply.code(400).send({
          error: "invalid_request",
          message: bodyResult.error.message,
        });
        return;
      }

      kvSet(userId, namespace, key, bodyResult.data.value);

      return { namespace, key, value: bodyResult.data.value };
    },
  );

  // Delete a value
  fastify.delete(
    "/:namespace/:key",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { namespace, key } = request.params as {
        namespace: string;
        key: string;
      };
      const userId = request.auth!.userId;

      // Validate params
      const nsResult = namespaceSchema.safeParse(namespace);
      if (!nsResult.success) {
        reply.code(400).send({
          error: "invalid_namespace",
          message: nsResult.error.message,
        });
        return;
      }

      const keyResult = keySchema.safeParse(key);
      if (!keyResult.success) {
        reply.code(400).send({
          error: "invalid_key",
          message: keyResult.error.message,
        });
        return;
      }

      const deleted = kvDelete(userId, namespace, key);
      if (!deleted) {
        reply.code(404).send({
          error: "not_found",
          message: "Key not found",
        });
        return;
      }

      reply.code(204).send();
    },
  );

  // List all keys in a namespace
  fastify.get(
    "/:namespace",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { namespace } = request.params as { namespace: string };
      const userId = request.auth!.userId;

      // Validate params
      const nsResult = namespaceSchema.safeParse(namespace);
      if (!nsResult.success) {
        reply.code(400).send({
          error: "invalid_namespace",
          message: nsResult.error.message,
        });
        return;
      }

      const entries = kvList(userId, namespace);

      return {
        namespace,
        entries: entries.map((e) => ({
          key: e.key,
          value: e.value,
          updatedAt: e.updatedAt.toISOString(),
        })),
      };
    },
  );
}
