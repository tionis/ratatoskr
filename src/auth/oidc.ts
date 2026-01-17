import * as client from "openid-client";
import { config } from "../config.ts";

let oidcConfig: client.Configuration | null = null;

export async function getOidcConfig(): Promise<client.Configuration> {
  if (!oidcConfig) {
    oidcConfig = await client.discovery(
      new URL(config.oidc.issuer),
      config.oidc.clientId,
      config.oidc.clientSecret,
    );
  }
  return oidcConfig;
}

export interface OidcUser {
  sub: string;
  email?: string;
  name?: string;
}

/**
 * Generate the authorization URL for OIDC login.
 */
export async function getAuthorizationUrl(state: string): Promise<string> {
  const oidc = await getOidcConfig();

  const codeVerifier = client.randomPKCECodeVerifier();
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);

  // Store code verifier in state for later use
  // In production, store in session/cookie
  const params = new URLSearchParams({
    redirect_uri: config.oidc.redirectUri,
    scope: "openid email profile",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const url = client.buildAuthorizationUrl(oidc, params);
  return url.href;
}

/**
 * Exchange authorization code for tokens and user info.
 */
export async function handleCallback(
  callbackUrl: URL,
  expectedState: string,
  codeVerifier: string,
): Promise<OidcUser> {
  const oidc = await getOidcConfig();

  const tokens = await client.authorizationCodeGrant(oidc, callbackUrl, {
    pkceCodeVerifier: codeVerifier,
    expectedState,
  });

  const claims = tokens.claims();
  if (!claims) {
    throw new Error("No claims in token response");
  }

  return {
    sub: claims.sub,
    email: claims.email as string | undefined,
    name: claims.name as string | undefined,
  };
}
