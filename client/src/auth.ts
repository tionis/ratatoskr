/**
 * Popup-based authentication for Ratatoskr.
 */

import type { User } from "./types.ts";

export interface AuthResult {
  token: string;
  user: User;
}

/**
 * Authenticate using a popup window.
 *
 * Opens a popup to the Ratatoskr login endpoint, waits for the user to
 * authenticate via OIDC, and returns the token and user info.
 */
export function authenticate(serverUrl: string): Promise<AuthResult> {
  return new Promise((resolve, reject) => {
    const loginUrl = `${serverUrl}/api/v1/auth/login`;

    // Open popup
    const width = 500;
    const height = 600;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;

    const popup = window.open(
      loginUrl,
      "ratatoskr-auth",
      `width=${width},height=${height},left=${left},top=${top}`,
    );

    if (!popup) {
      reject(
        new Error(
          "Failed to open authentication popup. Check popup blocker settings.",
        ),
      );
      return;
    }

    // Listen for postMessage from popup
    const handleMessage = (event: MessageEvent) => {
      // Validate origin
      const serverOrigin = new URL(serverUrl).origin;
      if (event.origin !== serverOrigin) {
        return;
      }

      const data = event.data;
      if (data?.type !== "ratatoskr:auth") {
        return;
      }

      // Clean up
      window.removeEventListener("message", handleMessage);
      clearInterval(checkClosed);

      if (data.token && data.user) {
        resolve({
          token: data.token,
          user: data.user,
        });
      } else {
        reject(
          new Error("Authentication failed: Invalid response from server"),
        );
      }
    };

    window.addEventListener("message", handleMessage);

    // Check if popup was closed without completing auth
    const checkClosed = setInterval(() => {
      if (popup.closed) {
        clearInterval(checkClosed);
        window.removeEventListener("message", handleMessage);
        reject(new Error("Authentication cancelled: Popup was closed"));
      }
    }, 500);

    // Timeout after 5 minutes
    setTimeout(
      () => {
        if (!popup.closed) {
          popup.close();
        }
        clearInterval(checkClosed);
        window.removeEventListener("message", handleMessage);
        reject(new Error("Authentication timeout"));
      },
      5 * 60 * 1000,
    );
  });
}

/**
 * Store authentication token in localStorage.
 */
export function storeToken(key: string, token: string): void {
  localStorage.setItem(key, token);
}

/**
 * Retrieve authentication token from localStorage.
 */
export function getStoredToken(key: string): string | null {
  return localStorage.getItem(key);
}

/**
 * Remove authentication token from localStorage.
 */
export function clearStoredToken(key: string): void {
  localStorage.removeItem(key);
}

/**
 * Store user info in localStorage.
 */
export function storeUser(key: string, user: User): void {
  localStorage.setItem(key, JSON.stringify(user));
}

/**
 * Retrieve user info from localStorage.
 */
export function getStoredUser(key: string): User | null {
  const stored = localStorage.getItem(key);
  if (!stored) return null;
  try {
    return JSON.parse(stored) as User;
  } catch {
    return null;
  }
}

/**
 * Remove user info from localStorage.
 */
export function clearStoredUser(key: string): void {
  localStorage.removeItem(key);
}
