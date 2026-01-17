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
 * Generate a PKCE code verifier.
 */
export function generateCodeVerifier(): string {
  return client.randomPKCECodeVerifier();
}

/**
 * Generate the authorization URL for OIDC login with PKCE.
 */
export async function getAuthorizationUrl(
  state: string,
  codeVerifier: string,
): Promise<string> {
  const oidc = await getOidcConfig();

  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);

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
