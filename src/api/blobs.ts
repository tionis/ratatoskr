import { readFileSync, statSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/middleware.ts";
import { checkBlobQuota } from "../lib/quotas.ts";
import {
  assembleChunks,
  blobExists,
  computeHash,
  deleteUploadChunks,
  getBlobPath,
  getReceivedChunks,
  writeBlob,
  writeChunk,
} from "../storage/blobs.ts";
import {
  createBlob,
  createBlobClaim,
  createBlobUpload,
  deleteBlobClaim,
  deleteBlobUpload,
  getBlob,
  getBlobClaim,
  getBlobUpload,
  getUser,
  getUserBlobStorageUsed,
  getUserClaimedBlobs,
  updateBlobUploadChunksReceived,
} from "../storage/database.ts";
import {
  blobHashParamSchema,
  chunkIndexParamSchema,
  initBlobUploadSchema,
  listBlobsQuerySchema,
  uploadIdParamSchema,
} from "./schemas.ts";

const DEFAULT_CHUNK_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB
const UPLOAD_EXPIRY_HOURS = 24;

export async function blobRoutes(fastify: FastifyInstance): Promise<void> {
  // Initialize chunked upload
  fastify.post(
    "/upload/init",
    { preHandler: requireAuth },
    async (request, reply) => {
      const result = initBlobUploadSchema.safeParse(request.body);
      if (!result.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: result.error.message,
        });
      }

      const {
        size,
        mimeType,
        expectedHash,
        chunkSize: requestedChunkSize,
      } = result.data;
      const userId = request.auth!.userId;

      // Get user for quota check
      const user = getUser(userId);
      if (!user) {
        return reply.code(500).send({
          error: "internal_error",
          message: "User not found",
        });
      }

      // Check blob size quota
      if (size > user.quotaMaxBlobSize) {
        return reply.code(400).send({
          error: "blob_too_large",
          message: `Blob size ${size} exceeds maximum allowed size ${user.quotaMaxBlobSize}`,
          maxSize: user.quotaMaxBlobSize,
        });
      }

      // Check storage quota
      const quotaCheck = await checkBlobQuota(
        { getUserBlobStorageUsed: async (uid) => getUserBlobStorageUsed(uid) },
        user,
        size,
      );

      if (!quotaCheck.allowed) {
        return reply.code(402).send({
          error: "quota_exceeded",
          quota: quotaCheck.quota,
          current: quotaCheck.current,
          limit: quotaCheck.limit,
          required: size,
        });
      }

      // Calculate chunk size and count
      const chunkSize = Math.min(
        requestedChunkSize ?? DEFAULT_CHUNK_SIZE,
        MAX_CHUNK_SIZE,
      );
      const totalChunks = Math.ceil(size / chunkSize);

      // Create upload session
      const uploadId = crypto.randomUUID();
      const expiresAt = new Date(
        Date.now() + UPLOAD_EXPIRY_HOURS * 60 * 60 * 1000,
      );

      const upload = createBlobUpload({
        id: uploadId,
        userId,
        ...(expectedHash ? { expectedHash } : {}),
        expectedSize: size,
        mimeType,
        chunkSize,
        totalChunks,
        expiresAt,
      });

      return reply.code(200).send({
        uploadId: upload.id,
        chunkSize: upload.chunkSize,
        totalChunks: upload.totalChunks,
        expiresAt: upload.expiresAt.toISOString(),
      });
    },
  );

  // Upload a chunk
  fastify.put(
    "/upload/:uploadId/chunk/:index",
    { preHandler: requireAuth },
    async (request, reply) => {
      const paramsResult = chunkIndexParamSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: paramsResult.error.message,
        });
      }

      const { uploadId, index } = paramsResult.data;
      const userId = request.auth!.userId;

      // Get upload session
      const upload = getBlobUpload(uploadId);
      if (!upload) {
        return reply.code(404).send({
          error: "not_found",
          message: "Upload session not found",
        });
      }

      // Verify ownership
      if (upload.userId !== userId) {
        return reply.code(403).send({
          error: "forbidden",
          message: "Not authorized to upload to this session",
        });
      }

      // Check expiration
      if (new Date() > upload.expiresAt) {
        deleteUploadChunks(uploadId);
        deleteBlobUpload(uploadId);
        return reply.code(410).send({
          error: "upload_expired",
          message: "Upload session has expired",
        });
      }

      // Validate chunk index
      if (index < 0 || index >= upload.totalChunks) {
        return reply.code(400).send({
          error: "invalid_chunk_index",
          message: `Chunk index must be between 0 and ${upload.totalChunks - 1}`,
        });
      }

      // Get chunk data from request body
      const chunkData = new Uint8Array(request.body as ArrayBuffer);

      // Validate chunk size
      const isLastChunk = index === upload.totalChunks - 1;
      const expectedSize = isLastChunk
        ? upload.expectedSize - upload.chunkSize * (upload.totalChunks - 1)
        : upload.chunkSize;

      if (chunkData.length !== expectedSize) {
        return reply.code(400).send({
          error: "invalid_chunk_size",
          message: `Expected chunk size ${expectedSize}, got ${chunkData.length}`,
        });
      }

      // Write chunk to disk
      await writeChunk(uploadId, index, chunkData);

      // Update chunks received count
      const receivedChunks = getReceivedChunks(uploadId);
      updateBlobUploadChunksReceived(uploadId, receivedChunks.length);

      return reply.code(200).send({
        chunksReceived: receivedChunks.length,
        totalChunks: upload.totalChunks,
        complete: receivedChunks.length === upload.totalChunks,
      });
    },
  );

  // Complete upload
  fastify.post(
    "/upload/:uploadId/complete",
    { preHandler: requireAuth },
    async (request, reply) => {
      const paramsResult = uploadIdParamSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: paramsResult.error.message,
        });
      }

      const { uploadId } = paramsResult.data;
      const userId = request.auth!.userId;

      // Get upload session
      const upload = getBlobUpload(uploadId);
      if (!upload) {
        return reply.code(404).send({
          error: "not_found",
          message: "Upload session not found",
        });
      }

      // Verify ownership
      if (upload.userId !== userId) {
        return reply.code(403).send({
          error: "forbidden",
          message: "Not authorized to complete this upload",
        });
      }

      // Check all chunks are received
      const receivedChunks = getReceivedChunks(uploadId);
      if (receivedChunks.length !== upload.totalChunks) {
        return reply.code(400).send({
          error: "incomplete_upload",
          message: `Missing chunks: received ${receivedChunks.length} of ${upload.totalChunks}`,
          chunksReceived: receivedChunks.length,
          totalChunks: upload.totalChunks,
        });
      }

      // Assemble chunks
      let assembledData: Uint8Array;
      try {
        assembledData = await assembleChunks(uploadId, upload.totalChunks);
      } catch (error) {
        return reply.code(500).send({
          error: "assembly_failed",
          message: `Failed to assemble chunks: ${error}`,
        });
      }

      // Verify size
      if (assembledData.length !== upload.expectedSize) {
        deleteUploadChunks(uploadId);
        return reply.code(400).send({
          error: "size_mismatch",
          message: `Expected size ${upload.expectedSize}, got ${assembledData.length}`,
        });
      }

      // Compute hash
      const computedHash = await computeHash(assembledData);

      // Verify hash if expected hash was provided
      if (upload.expectedHash && computedHash !== upload.expectedHash) {
        deleteUploadChunks(uploadId);
        return reply.code(400).send({
          error: "hash_mismatch",
          message: "Computed hash does not match expected hash",
          computedHash,
          expectedHash: upload.expectedHash,
        });
      }

      // Check if blob already exists (deduplication)
      const existingBlob = getBlob(computedHash);
      let deduplicated = false;

      if (existingBlob) {
        // Blob already exists, just add claim
        deduplicated = true;
      } else {
        // Write new blob
        await writeBlob(computedHash, assembledData);

        // Create blob record
        createBlob({
          hash: computedHash,
          size: assembledData.length,
          mimeType: upload.mimeType,
        });
      }

      // Create user claim
      createBlobClaim(computedHash, userId);

      // Clean up upload session
      deleteUploadChunks(uploadId);
      deleteBlobUpload(uploadId);

      const blob = getBlob(computedHash)!;

      return reply.code(200).send({
        hash: blob.hash,
        size: blob.size,
        mimeType: blob.mimeType,
        deduplicated,
      });
    },
  );

  // Cancel upload
  fastify.delete(
    "/upload/:uploadId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const paramsResult = uploadIdParamSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: paramsResult.error.message,
        });
      }

      const { uploadId } = paramsResult.data;
      const userId = request.auth!.userId;

      // Get upload session
      const upload = getBlobUpload(uploadId);
      if (!upload) {
        return reply.code(404).send({
          error: "not_found",
          message: "Upload session not found",
        });
      }

      // Verify ownership
      if (upload.userId !== userId) {
        return reply.code(403).send({
          error: "forbidden",
          message: "Not authorized to cancel this upload",
        });
      }

      // Clean up
      deleteUploadChunks(uploadId);
      deleteBlobUpload(uploadId);

      return reply.code(204).send();
    },
  );

  // Download blob
  fastify.get("/:hash", async (request, reply) => {
    const paramsResult = blobHashParamSchema.safeParse(request.params);
    if (!paramsResult.success) {
      return reply.code(400).send({
        error: "invalid_request",
        message: paramsResult.error.message,
      });
    }

    const { hash } = paramsResult.data;

    // Get blob metadata
    const blob = getBlob(hash);
    if (!blob) {
      return reply.code(404).send({
        error: "not_found",
        message: "Blob not found",
      });
    }

    // Check if blob file exists
    if (!blobExists(hash)) {
      return reply.code(404).send({
        error: "not_found",
        message: "Blob data not found",
      });
    }

    const blobPath = getBlobPath(hash);
    const stat = statSync(blobPath);

    // Set headers
    reply.header("Content-Type", blob.mimeType);
    reply.header("Content-Length", stat.size);
    reply.header("ETag", `"${hash}"`);
    reply.header("Cache-Control", "public, max-age=31536000, immutable");

    // Handle range requests
    const range = request.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const startStr = parts[0] ?? "0";
      const start = Number.parseInt(startStr, 10);
      const end = parts[1] ? Number.parseInt(parts[1], 10) : stat.size - 1;
      const chunksize = end - start + 1;

      reply.code(206);
      reply.header("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      reply.header("Content-Length", chunksize);
      reply.header("Accept-Ranges", "bytes");

      // Use Bun.file for better compatibility
      const file = Bun.file(blobPath);
      const slice = file.slice(start, end + 1);
      const buffer = await slice.arrayBuffer();
      return reply.send(Buffer.from(buffer));
    }

    // Full file - use readFileSync for test compatibility
    const buffer = readFileSync(blobPath);
    return reply.send(buffer);
  });

  // Claim blob
  fastify.post(
    "/:hash/claim",
    { preHandler: requireAuth },
    async (request, reply) => {
      const paramsResult = blobHashParamSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: paramsResult.error.message,
        });
      }

      const { hash } = paramsResult.data;
      const userId = request.auth!.userId;

      // Get blob
      const blob = getBlob(hash);
      if (!blob) {
        return reply.code(404).send({
          error: "not_found",
          message: "Blob not found",
        });
      }

      // Check if already claimed
      const existingClaim = getBlobClaim(hash, userId);
      if (existingClaim) {
        return reply.code(409).send({
          error: "already_claimed",
          message: "You have already claimed this blob",
        });
      }

      // Check quota
      const user = getUser(userId);
      if (!user) {
        return reply.code(500).send({
          error: "internal_error",
          message: "User not found",
        });
      }

      const quotaCheck = await checkBlobQuota(
        { getUserBlobStorageUsed: async (uid) => getUserBlobStorageUsed(uid) },
        user,
        blob.size,
      );

      if (!quotaCheck.allowed) {
        return reply.code(402).send({
          error: "quota_exceeded",
          quota: quotaCheck.quota,
          current: quotaCheck.current,
          limit: quotaCheck.limit,
          required: blob.size,
        });
      }

      // Create claim
      const claim = createBlobClaim(hash, userId);

      return reply.code(200).send({
        hash: blob.hash,
        size: blob.size,
        mimeType: blob.mimeType,
        claimedAt: claim.claimedAt.toISOString(),
      });
    },
  );

  // Release claim
  fastify.delete(
    "/:hash/claim",
    { preHandler: requireAuth },
    async (request, reply) => {
      const paramsResult = blobHashParamSchema.safeParse(request.params);
      if (!paramsResult.success) {
        return reply.code(400).send({
          error: "invalid_request",
          message: paramsResult.error.message,
        });
      }

      const { hash } = paramsResult.data;
      const userId = request.auth!.userId;

      // Check if claimed
      const existingClaim = getBlobClaim(hash, userId);
      if (!existingClaim) {
        return reply.code(404).send({
          error: "not_found",
          message: "You have not claimed this blob",
        });
      }

      // Delete claim
      deleteBlobClaim(hash, userId);

      return reply.code(204).send();
    },
  );

  // List claimed blobs
  fastify.get("/", { preHandler: requireAuth }, async (request, reply) => {
    const queryResult = listBlobsQuerySchema.safeParse(request.query);
    if (!queryResult.success) {
      return reply.code(400).send({
        error: "invalid_request",
        message: queryResult.error.message,
      });
    }

    const { limit, offset } = queryResult.data;
    const userId = request.auth!.userId;

    const user = getUser(userId);
    if (!user) {
      return reply.code(500).send({
        error: "internal_error",
        message: "User not found",
      });
    }

    const { blobs, total } = getUserClaimedBlobs(userId, limit, offset);
    const quotaUsed = getUserBlobStorageUsed(userId);

    return reply.code(200).send({
      blobs: blobs.map((blob) => ({
        hash: blob.hash,
        size: blob.size,
        mimeType: blob.mimeType,
        claimedAt: blob.claimedAt.toISOString(),
      })),
      total,
      quotaUsed,
      quotaLimit: user.quotaMaxBlobStorage,
    });
  });
}
