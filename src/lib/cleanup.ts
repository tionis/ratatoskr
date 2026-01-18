import {
  deleteDocument,
  deleteExpiredTokens,
  getExpiredDocuments,
} from "../storage/database.ts";
import { deleteDocumentFile } from "../storage/documents.ts";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function cleanupExpiredItems(): {
  tokensDeleted: number;
  documentsDeleted: number;
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

  return { tokensDeleted, documentsDeleted };
}

export function startCleanupJob() {
  // Run immediately on startup
  try {
    const result = cleanupExpiredItems();
    if (result.tokensDeleted > 0 || result.documentsDeleted > 0) {
      console.log(
        `Initial cleanup: Deleted ${result.tokensDeleted} expired tokens and ${result.documentsDeleted} expired documents`,
      );
    }
  } catch (error) {
    console.error("Initial cleanup failed:", error);
  }

  // Schedule periodic cleanup
  setInterval(() => {
    try {
      const result = cleanupExpiredItems();
      if (result.tokensDeleted > 0 || result.documentsDeleted > 0) {
        console.log(
          `Cleanup: Deleted ${result.tokensDeleted} expired tokens and ${result.documentsDeleted} expired documents`,
        );
      }
    } catch (error) {
      console.error("Cleanup job failed:", error);
    }
  }, CLEANUP_INTERVAL_MS);

  console.log("Cleanup job started");
}
