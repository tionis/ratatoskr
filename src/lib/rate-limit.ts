interface RateLimitEntry {
  count: number;
  resetAt: number;
}

interface RateLimitStore {
  entries: Map<string, RateLimitEntry>;
}

const stores: Map<string, RateLimitStore> = new Map();

function getStore(name: string): RateLimitStore {
  let store = stores.get(name);
  if (!store) {
    store = { entries: new Map() };
    stores.set(name, store);
  }
  return store;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter: number | null;
}

/**
 * Check and update rate limit for a given key.
 * Returns whether the request is allowed and rate limit info.
 */
export function checkRateLimit(
  storeName: string,
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const store = getStore(storeName);
  const now = Date.now();

  let entry = store.entries.get(key);

  // Clean up expired entry
  if (entry && entry.resetAt <= now) {
    store.entries.delete(key);
    entry = undefined;
  }

  if (!entry) {
    entry = {
      count: 0,
      resetAt: now + windowMs,
    };
    store.entries.set(key, entry);
  }

  entry.count++;

  if (entry.count > limit) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: entry.resetAt,
      retryAfter: Math.ceil((entry.resetAt - now) / 1000),
    };
  }

  return {
    allowed: true,
    remaining: limit - entry.count,
    resetAt: entry.resetAt,
    retryAfter: null,
  };
}

/**
 * Clean up expired entries from all stores.
 * Call periodically to prevent memory leaks.
 */
export function cleanupExpiredEntries(): void {
  const now = Date.now();
  for (const store of stores.values()) {
    for (const [key, entry] of store.entries) {
      if (entry.resetAt <= now) {
        store.entries.delete(key);
      }
    }
  }
}

// Run cleanup every minute
setInterval(cleanupExpiredEntries, 60_000);
