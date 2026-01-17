import type { User } from "./types.ts";

export interface QuotaCheck {
  allowed: boolean;
  quota: string;
  current: number;
  limit: number;
}

export interface QuotaChecker {
  getUserDocumentCount(userId: string): Promise<number>;
  getUserTotalStorage(userId: string): Promise<number>;
}

/**
 * Check if a user can create a new document.
 */
export async function checkDocumentCreationQuota(
  checker: QuotaChecker,
  user: User,
): Promise<QuotaCheck> {
  const current = await checker.getUserDocumentCount(user.id);

  if (current >= user.quotaMaxDocuments) {
    return {
      allowed: false,
      quota: "maxDocuments",
      current,
      limit: user.quotaMaxDocuments,
    };
  }

  return {
    allowed: true,
    quota: "maxDocuments",
    current,
    limit: user.quotaMaxDocuments,
  };
}

/**
 * Check if a document size is within the user's limit.
 */
export function checkDocumentSizeQuota(
  user: User,
  documentSize: number,
): QuotaCheck {
  if (documentSize > user.quotaMaxDocumentSize) {
    return {
      allowed: false,
      quota: "maxDocumentSize",
      current: documentSize,
      limit: user.quotaMaxDocumentSize,
    };
  }

  return {
    allowed: true,
    quota: "maxDocumentSize",
    current: documentSize,
    limit: user.quotaMaxDocumentSize,
  };
}

/**
 * Check if adding a document would exceed total storage quota.
 */
export async function checkTotalStorageQuota(
  checker: QuotaChecker,
  user: User,
  additionalSize: number,
): Promise<QuotaCheck> {
  const current = await checker.getUserTotalStorage(user.id);
  const newTotal = current + additionalSize;

  if (newTotal > user.quotaMaxTotalStorage) {
    return {
      allowed: false,
      quota: "maxTotalStorage",
      current,
      limit: user.quotaMaxTotalStorage,
    };
  }

  return {
    allowed: true,
    quota: "maxTotalStorage",
    current,
    limit: user.quotaMaxTotalStorage,
  };
}
