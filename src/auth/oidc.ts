import * as oauth from "oauth4webapi";
import { config } from "../config.ts";

// Cached authorization server metadata
let authServerCache: oauth.AuthorizationServer | null = null;
let oauthClient: oauth.Client | null = null;

async function getAuthServer(): Promise<oauth.AuthorizationServer> {
  if (!authServerCache) {
    const issuerUrl = new URL(config.oidc.issuer);
    const response = await oauth.discoveryRequest(issuerUrl);
    authServerCache = await oauth.processDiscoveryResponse(issuerUrl, response);
  }
  return authServerCache;
}

function getClient(): oauth.Client {
  if (!oauthClient) {
    oauthClient = {
      client_id: config.oidc.clientId,
      token_endpoint_auth_method: config.oidc.clientSecret
        ? "client_secret_post"
        : "none",
    };
  }
  return oauthClient;
}

export interface OidcUser {
  sub: string;
  email?: string;
  name?: string;
  preferredUsername?: string;
}

/**
 * Generate a PKCE code verifier.
 */
export function generateCodeVerifier(): string {
  return oauth.generateRandomCodeVerifier();
}

/**
 * Generate the authorization URL for OIDC login with PKCE.
 */
export async function getAuthorizationUrl(
  state: string,
  codeVerifier: string,
): Promise<string> {
  const as = await getAuthServer();
  const client = getClient();

  const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);

  const authUrl = new URL(as.authorization_endpoint!);
  authUrl.searchParams.set("client_id", client.client_id);
  authUrl.searchParams.set("redirect_uri", config.oidc.redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  return authUrl.href;
}

/**
 * Exchange authorization code for tokens and user info.
 */
export async function handleCallback(
  callbackUrl: URL,
  expectedState: string,
  codeVerifier: string,
): Promise<OidcUser> {
  const as = await getAuthServer();
  const client = getClient();

  // Validate the callback parameters - throws AuthorizationResponseError on OAuth errors
  const params = oauth.validateAuthResponse(
    as,
    client,
    callbackUrl,
    expectedState,
  );

  // Exchange code for tokens - throws ResponseBodyError on OAuth errors
  const response = await oauth.authorizationCodeGrantRequest(
    as,
    client,
    config.oidc.clientSecret
      ? oauth.ClientSecretPost(config.oidc.clientSecret)
      : oauth.None(),
    params,
    config.oidc.redirectUri,
    codeVerifier,
  );

  const result = await oauth.processAuthorizationCodeResponse(
    as,
    client,
    response,
  );

  // Get claims from ID token
  const claims = oauth.getValidatedIdTokenClaims(result);
  if (!claims) {
    throw new Error("No claims in token response");
  }

  return {
    sub: claims.sub,
    ...(typeof claims.email === "string" ? { email: claims.email } : {}),
    ...(typeof claims.name === "string" ? { name: claims.name } : {}),
    ...(typeof claims.preferred_username === "string"
      ? { preferredUsername: claims.preferred_username }
      : {}),
  };
}
