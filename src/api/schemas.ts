import { z } from "zod";
import { aclEntrySchema, documentIdSchema } from "../lib/types.ts";

// Helper for flexible datetime parsing - accepts ISO strings with or without timezone
const flexibleDatetime = z
  .string()
  .refine((val) => !Number.isNaN(Date.parse(val)), {
    message: "Invalid date format",
  });

// Document creation
export const createDocumentSchema = z.object({
  id: documentIdSchema.optional(),
  automergeId: z.string().max(100).optional(),
  type: z.string().max(200).optional(),
  acl: z.array(aclEntrySchema).optional(),
  expiresAt: flexibleDatetime.optional(),
});

export type CreateDocumentRequest = z.infer<typeof createDocumentSchema>;

// Document update
export const updateDocumentTypeSchema = z.object({
  type: z.string().max(200),
});

export const updateDocumentExpirationSchema = z.object({
  expiresAt: flexibleDatetime.nullable(),
});

export const updateDocumentAclSchema = z.object({
  acl: z.array(aclEntrySchema),
});

// API token creation
export const createApiTokenSchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.string()).optional(),
  expiresAt: flexibleDatetime.optional(),
});

export type CreateApiTokenRequest = z.infer<typeof createApiTokenSchema>;

// Blob upload initialization
export const initBlobUploadSchema = z.object({
  size: z.number().int().positive(),
  mimeType: z.string().min(1).max(200),
  expectedHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  chunkSize: z
    .number()
    .int()
    .min(1024) // 1 KB minimum
    .max(10 * 1024 * 1024) // 10 MB maximum
    .optional(),
});

export type InitBlobUploadRequest = z.infer<typeof initBlobUploadSchema>;

// Blob hash parameter
export const blobHashParamSchema = z.object({
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});

// Upload ID parameter
export const uploadIdParamSchema = z.object({
  uploadId: z.string().uuid(),
});

// Chunk index parameter
export const chunkIndexParamSchema = z.object({
  uploadId: z.string().uuid(),
  index: z.coerce.number().int().nonnegative(),
});

// List blobs query
export const listBlobsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().nonnegative().optional().default(0),
});
