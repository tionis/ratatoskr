import { z } from "zod";
import { aclEntrySchema, documentIdSchema } from "../lib/types.ts";

// Document creation
export const createDocumentSchema = z.object({
  id: documentIdSchema,
  type: z
    .string()
    .regex(
      /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/,
      "Type must be URL-like, e.g., com.example.myapp/note",
    ),
  acl: z.array(aclEntrySchema).optional(),
  expiresAt: z.string().datetime().optional(),
});

export type CreateDocumentRequest = z.infer<typeof createDocumentSchema>;

// Document update
export const updateDocumentTypeSchema = z.object({
  type: z
    .string()
    .regex(
      /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/,
      "Type must be URL-like, e.g., com.example.myapp/note",
    ),
});

export const updateDocumentExpirationSchema = z.object({
  expiresAt: z.string().datetime().nullable(),
});

export const updateDocumentAclSchema = z.object({
  acl: z.array(aclEntrySchema),
});

// API token creation
export const createApiTokenSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).optional(),
  expiresAt: z.string().datetime().optional(),
});

export type CreateApiTokenRequest = z.infer<typeof createApiTokenSchema>;
