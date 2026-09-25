import { randomBytes, createHash } from "crypto";

/**
 * Twitter/X OAuth 2.0 (Authorization Code + PKCE) integration (#14). Kept
 * to plain `fetch` calls with no SDK, the same house style as the Soroban
 * RPC client (sorobanEventListener.ts) and the email provider
 * (mailer.ts) — one module owns knowing the provider's API shape, so
 * swapping or mocking it never touches a caller.
 */

const AUTHORIZE_URL = "https://twitter.com/i/oauth2/authorize";
const TOKEN_URL = "https://api.twitter.com/2/oauth2/token";
const PROFILE_URL = "https://api.twitter.com/2/users/me";

export interface TwitterOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function getTwitterOAuthConfig(): TwitterOAuthConfig | null {
  const clientId = process.env.TWITTER_CLIENT_ID;
  const clientSecret = process.env.TWITTER_CLIENT_SECRET;
  const redirectUri = process.env.TWITTER_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** S256 PKCE, per RFC 7636 (the only method Twitter's OAuth 2.0 accepts). */
export function generatePkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(
  config: TwitterOAuthConfig,
  state: string,
  codeChallenge: string
): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  // "users.read" for the profile fetch below, "tweet.read" because
  // Twitter's API requires it alongside users.read, "offline.access" only
  // if a refresh token is ever needed later (not used today, kept for
  // forward-compatibility with the OAuthIdentity.refreshToken column).
  url.searchParams.set("scope", "users.read tweet.read");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface TwitterTokenResponse {
  accessToken: string;
  refreshToken?: string;
}

export async function exchangeCodeForToken(
  config: TwitterOAuthConfig,
  code: string,
  codeVerifier: string
): Promise<TwitterTokenResponse> {
  const basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Twitter token exchange failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { access_token: string; refresh_token?: string };
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

export interface TwitterProfile {
  id: string;
  username: string;
  name: string;
}

export async function fetchTwitterProfile(accessToken: string): Promise<TwitterProfile> {
  const response = await fetch(`${PROFILE_URL}?user.fields=username,name`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Twitter profile fetch failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { data: { id: string; username: string; name: string } };
  return { id: data.data.id, username: data.data.username, name: data.data.name };
}
