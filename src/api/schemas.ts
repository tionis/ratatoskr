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
  id: documentIdSchema,
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
