import * as Automerge from "@automerge/automerge";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/middleware.ts";
import { checkDocumentCreationQuota } from "../lib/quotas.ts";
import { parseDocumentId } from "../lib/types.ts";
import {
  createDocument,
  deleteDocument,
  getAccessibleDocuments,
  getDocument,
  getDocumentACL,
  getDocumentsByOwner,
  getUser,
  getUserDocumentCount,
  getUserTotalStorage,
  setDocumentACL,
  updateDocumentExpiration,
  updateDocumentSize,
  updateDocumentType,
} from "../storage/database.ts";
import {
  deleteDocumentFile,
  readDocument,
  writeDocument,
} from "../storage/documents.ts";
import {
  createDocumentSchema,
  updateDocumentAclSchema,
  updateDocumentExpirationSchema,
  updateDocumentTypeSchema,
} from "./schemas.ts";

export async function documentRoutes(fastify: FastifyInstance): Promise<void> {
  // Create document
  fastify.post("/", { preHandler: requireAuth }, async (request, reply) => {
    const result = createDocumentSchema.safeParse(request.body);
    if (!result.success) {
      reply.code(400).send({
        error: "invalid_request",
        message: result.error.message,
      });
      return;
    }

    const { id, type, acl, expiresAt } = result.data;
    const userId = request.auth!.userId;

    // Validate document type
    const { prefix } = parseDocumentId(id);

    // App documents cannot be shared
    if (prefix === "app" && acl && acl.length > 0) {
      reply.code(400).send({
        error: "invalid_request",
        message: "App documents cannot have ACL entries",
      });
      return;
    }

    // Check if document already exists
    const existing = getDocument(id);
    if (existing) {
      reply.code(409).send({
        error: "conflict",
        message: "Document already exists",
      });
      return;
    }

    // Check quota
    const user = getUser(userId);
    if (!user) {
      reply.code(500).send({
        error: "internal_error",
        message: "User not found",
      });
      return;
    }

    const quotaCheck = await checkDocumentCreationQuota(
      {
        getUserDocumentCount: async (uid) => getUserDocumentCount(uid),
        getUserTotalStorage: async (uid) => getUserTotalStorage(uid),
      },
      user,
    );

    if (!quotaCheck.allowed) {
      reply.code(403).send({
        error: "quota_exceeded",
        quota: quotaCheck.quota,
        current: quotaCheck.current,
        limit: quotaCheck.limit,
      });
      return;
    }

    // Create document
    const doc = createDocument({
      id,
      ownerId: userId,
      ...(type ? { type } : {}),
    });

    // Set ACL if provided
    if (acl && acl.length > 0) {
      setDocumentACL(id, acl);
    }

    // Set expiration if provided
    if (expiresAt) {
      updateDocumentExpiration(id, new Date(expiresAt));
    }

    return {
      id: doc.id,
      owner: doc.ownerId,
      type: doc.type,
      acl: acl ?? [],
      createdAt: doc.createdAt.toISOString(),
      expiresAt: expiresAt ?? null,
    };
  });

  // List documents
  fastify.get("/", { preHandler: requireAuth }, async (request) => {
    const userId = request.auth!.userId;

    const owned = getDocumentsByOwner(userId);
    const accessible = getAccessibleDocuments(userId).filter(
      (d) => d.ownerId !== userId,
    );

    return {
      owned: owned.map(docToResponse),
      accessible: accessible.map(docToResponse),
    };
  });

  // Get document metadata
  fastify.get("/:id", { preHandler: requireAuth }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = request.auth!.userId;

    const doc = getDocument(id);
    if (!doc) {
      reply.code(404).send({
        error: "not_found",
        message: "Document not found",
      });
      return;
    }

    // Check access
    if (doc.ownerId !== userId) {
      const acl = getDocumentACL(id);
      const hasAccess = acl.some(
        (e) => e.principal === userId || e.principal === "public",
      );

      if (!hasAccess) {
        reply.code(403).send({
          error: "forbidden",
          message: "Access denied",
        });
        return;
      }
    }

    return {
      ...docToResponse(doc),
      acl: getDocumentACL(id),
    };
  });

  // Export document content
  fastify.get(
    "/:id/export",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { format } = request.query as { format?: string };
      const userId = request.auth!.userId;

      const doc = getDocument(id);
      if (!doc) {
        reply.code(404).send({
          error: "not_found",
          message: "Document not found",
        });
        return;
      }

      // Check read access
      if (doc.ownerId !== userId) {
        const acl = getDocumentACL(id);
        const hasAccess = acl.some(
          (e) =>
            (e.principal === userId || e.principal === "public") &&
            (e.permission === "read" || e.permission === "write"),
        );

        if (!hasAccess) {
          reply.code(403).send({
            error: "forbidden",
            message: "Access denied",
          });
          return;
        }
      }

      const data = await readDocument(id);
      if (!data) {
        // Empty document or file missing
        if (format === "json") {
          return {};
        }
        return reply
          .header("Content-Type", "application/octet-stream")
          .send(new Uint8Array(0));
      }

      if (format === "json") {
        try {
          const automergeDoc = Automerge.load(data);
          return Automerge.view(automergeDoc, Automerge.getHeads(automergeDoc));
        } catch (err) {
          reply.code(500).send({
            error: "internal_error",
            message: `Failed to parse document: ${(err as Error).message}`,
          });
          return;
        }
      } else {
        // Binary
        reply
          .header("Content-Type", "application/octet-stream")
          .header("Content-Disposition", `attachment; filename="${id}.amrg"`);
        return reply.send(data);
      }
    },
  );

  // Update document content (from JSON)
  fastify.put(
    "/:id/content",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.auth!.userId;
      const newContent = request.body as Record<string, unknown>;

      const doc = getDocument(id);
      if (!doc) {
        reply.code(404).send({
          error: "not_found",
          message: "Document not found",
        });
        return;
      }

      // Check write access
      if (doc.ownerId !== userId) {
        const acl = getDocumentACL(id);
        const hasAccess = acl.some(
          (e) =>
            (e.principal === userId || e.principal === "public") &&
            e.permission === "write",
        );

        if (!hasAccess) {
          reply.code(403).send({
            error: "forbidden",
            message: "Access denied",
          });
          return;
        }
      }

      // Load existing or create new
      const data = await readDocument(id);
      let automergeDoc: Automerge.Doc<unknown>;

      try {
        if (data && data.length > 0) {
          automergeDoc = Automerge.load(data);
        } else {
          automergeDoc = Automerge.init();
        }

        // Apply changes
        // biome-ignore lint/suspicious/noExplicitAny: Automerge document root is dynamic
        automergeDoc = Automerge.change(automergeDoc, (d: any) => {
          // Clear existing keys
          for (const key of Object.keys(d)) {
            delete d[key];
          }
          // Set new keys
          Object.assign(d, newContent);
        });

        const newData = Automerge.save(automergeDoc);
        await writeDocument(id, newData);
        updateDocumentSize(id, newData.length);

        return { success: true, size: newData.length };
      } catch (err) {
        reply.code(500).send({
          error: "internal_error",
          message: `Failed to update document: ${(err as Error).message}`,
        });
        return;
      }
    },
  );

  // Delete document
  fastify.delete(
    "/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.auth!.userId;

      const doc = getDocument(id);
      if (!doc) {
        reply.code(404).send({
          error: "not_found",
          message: "Document not found",
        });
        return;
      }

      if (doc.ownerId !== userId) {
        reply.code(403).send({
          error: "forbidden",
          message: "Only the owner can delete a document",
        });
        return;
      }

      deleteDocument(id);
      deleteDocumentFile(id);

      reply.code(204).send();
    },
  );

  // Update ACL
  fastify.put(
    "/:id/acl",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.auth!.userId;

      const result = updateDocumentAclSchema.safeParse(request.body);
      if (!result.success) {
        reply.code(400).send({
          error: "invalid_request",
          message: result.error.message,
        });
        return;
      }

      const doc = getDocument(id);
      if (!doc) {
        reply.code(404).send({
          error: "not_found",
          message: "Document not found",
        });
        return;
      }

      if (doc.ownerId !== userId) {
        reply.code(403).send({
          error: "forbidden",
          message: "Only the owner can modify ACL",
        });
        return;
      }

      // Check if app document
      const { prefix } = parseDocumentId(id);
      if (prefix === "app") {
        reply.code(400).send({
          error: "invalid_request",
          message: "App documents cannot have ACL entries",
        });
        return;
      }

      setDocumentACL(id, result.data.acl);

      return { acl: result.data.acl };
    },
  );

  // Get ACL
  fastify.get(
    "/:id/acl",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.auth!.userId;

      const doc = getDocument(id);
      if (!doc) {
        reply.code(404).send({
          error: "not_found",
          message: "Document not found",
        });
        return;
      }

      // Only owner can view ACL
      if (doc.ownerId !== userId) {
        reply.code(403).send({
          error: "forbidden",
          message: "Only the owner can view ACL",
        });
        return;
      }

      return { acl: getDocumentACL(id) };
    },
  );

  // Update type
  fastify.put(
    "/:id/type",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.auth!.userId;

      const result = updateDocumentTypeSchema.safeParse(request.body);
      if (!result.success) {
        reply.code(400).send({
          error: "invalid_request",
          message: result.error.message,
        });
        return;
      }

      const doc = getDocument(id);
      if (!doc) {
        reply.code(404).send({
          error: "not_found",
          message: "Document not found",
        });
        return;
      }

      if (doc.ownerId !== userId) {
        reply.code(403).send({
          error: "forbidden",
          message: "Only the owner can change document type",
        });
        return;
      }

      updateDocumentType(id, result.data.type);

      return { type: result.data.type };
    },
  );

  // Update expiration
  fastify.put(
    "/:id/expiration",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.auth!.userId;

      const result = updateDocumentExpirationSchema.safeParse(request.body);
      if (!result.success) {
        reply.code(400).send({
          error: "invalid_request",
          message: result.error.message,
        });
        return;
      }

      const doc = getDocument(id);
      if (!doc) {
        reply.code(404).send({
          error: "not_found",
          message: "Document not found",
        });
        return;
      }

      if (doc.ownerId !== userId) {
        reply.code(403).send({
          error: "forbidden",
          message: "Only the owner can set expiration",
        });
        return;
      }

      const expiresAt = result.data.expiresAt
        ? new Date(result.data.expiresAt)
        : null;
      updateDocumentExpiration(id, expiresAt);

      return { expiresAt: expiresAt?.toISOString() ?? null };
    },
  );
}

function docToResponse(doc: {
  id: string;
  ownerId: string;
  type: string;
  size: number;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: doc.id,
    owner: doc.ownerId,
    type: doc.type,
    size: doc.size,
    expiresAt: doc.expiresAt?.toISOString() ?? null,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}
