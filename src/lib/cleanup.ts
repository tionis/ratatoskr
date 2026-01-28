import { deleteBlobFile, deleteUploadChunks } from "../storage/blobs.ts";
import {
  deleteBlob,
  deleteBlobUpload,
  deleteDocument,
  deleteExpiredTokens,
  getExpiredBlobUploads,
  getExpiredDocuments,
  getReleasedBlobs,
} from "../storage/database.ts";
import { deleteDocumentFile } from "../storage/documents.ts";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const BLOB_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000; // 24 hours

export function cleanupExpiredItems(): {
  tokensDeleted: number;
  documentsDeleted: number;
  blobsDeleted: number;
  uploadsDeleted: number;
} {
  // Cleanup tokens
  const tokensDeleted = deleteExpiredTokens();

  // Cleanup documents
  const expiredDocs = getExpiredDocuments();
  let documentsDeleted = 0;

  for (const docId of expiredDocs) {
    try {
      // Remove from filesystem first
      deleteDocumentFile(docId);
      // Then remove from database
      if (deleteDocument(docId)) {
        documentsDeleted++;
      }
    } catch (error) {
      console.error(`Failed to delete expired document ${docId}:`, error);
    }
  }

  // Cleanup blobs past grace period
  const gracePeriodCutoff = new Date(Date.now() - BLOB_GRACE_PERIOD_MS);
  const releasedBlobs = getReleasedBlobs(gracePeriodCutoff);
  let blobsDeleted = 0;

  for (const blob of releasedBlobs) {
    try {
      // Remove from filesystem first
      deleteBlobFile(blob.hash);
      // Then remove from database
      if (deleteBlob(blob.hash)) {
        blobsDeleted++;
      }
    } catch (error) {
      console.error(`Failed to delete released blob ${blob.hash}:`, error);
    }
  }

  // Cleanup expired blob uploads
  const expiredUploads = getExpiredBlobUploads();
  let uploadsDeleted = 0;

  for (const upload of expiredUploads) {
    try {
      // Remove chunks from filesystem
      deleteUploadChunks(upload.id);
      // Remove from database
      if (deleteBlobUpload(upload.id)) {
        uploadsDeleted++;
      }
    } catch (error) {
      console.error(`Failed to delete expired upload ${upload.id}:`, error);
    }
  }

  return { tokensDeleted, documentsDeleted, blobsDeleted, uploadsDeleted };
}

function hasCleanedItems(
  result: ReturnType<typeof cleanupExpiredItems>,
): boolean {
  return (
    result.tokensDeleted > 0 ||
    result.documentsDeleted > 0 ||
    result.blobsDeleted > 0 ||
    result.uploadsDeleted > 0
  );
}

function logCleanupResult(
  prefix: string,
  result: ReturnType<typeof cleanupExpiredItems>,
): void {
  const parts: string[] = [];
  if (result.tokensDeleted > 0) parts.push(`${result.tokensDeleted} tokens`);
  if (result.documentsDeleted > 0)
    parts.push(`${result.documentsDeleted} documents`);
  if (result.blobsDeleted > 0) parts.push(`${result.blobsDeleted} blobs`);
  if (result.uploadsDeleted > 0)
    parts.push(`${result.uploadsDeleted} stale uploads`);
  console.log(`${prefix}: Deleted ${parts.join(", ")}`);
}

export function startCleanupJob() {
  // Run immediately on startup
  try {
    const result = cleanupExpiredItems();
    if (hasCleanedItems(result)) {
      logCleanupResult("Initial cleanup", result);
    }
  } catch (error) {
    console.error("Initial cleanup failed:", error);
  }

  // Schedule periodic cleanup
  setInterval(() => {
    try {
      const result = cleanupExpiredItems();
      if (hasCleanedItems(result)) {
        logCleanupResult("Cleanup", result);
      }
    } catch (error) {
      console.error("Cleanup job failed:", error);
    }
  }, CLEANUP_INTERVAL_MS);

  console.log("Cleanup job started");
}
