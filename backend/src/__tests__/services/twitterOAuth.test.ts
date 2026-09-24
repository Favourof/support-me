import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchTwitterProfile,
  generatePkcePair,
  getTwitterOAuthConfig,
} from "../../services/twitterOAuth";

const CONFIG = {
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://supportme.app/auth/twitter/callback",
};

describe("getTwitterOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when any required env var is missing", () => {
    delete process.env.TWITTER_CLIENT_ID;
    delete process.env.TWITTER_CLIENT_SECRET;
    delete process.env.TWITTER_REDIRECT_URI;
    expect(getTwitterOAuthConfig()).toBeNull();
  });

  it("returns the config when all three env vars are set", () => {
    process.env.TWITTER_CLIENT_ID = "id";
    process.env.TWITTER_CLIENT_SECRET = "secret";
    process.env.TWITTER_REDIRECT_URI = "https://supportme.app/callback";
    expect(getTwitterOAuthConfig()).toEqual({
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "https://supportme.app/callback",
    });
  });
});

describe("generatePkcePair", () => {
  it("produces a challenge derived from the verifier via SHA-256/base64url (not equal to it)", () => {
    const { verifier, challenge } = generatePkcePair();
    expect(verifier).not.toBe(challenge);
    expect(verifier.length).toBeGreaterThan(20);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet only
  });

  it("produces a different pair on every call", () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe("buildAuthorizeUrl", () => {
  it("includes the required OAuth 2.0 + PKCE parameters", () => {
    const url = new URL(buildAuthorizeUrl(CONFIG, "state-123", "challenge-abc"));

    expect(url.origin + url.pathname).toBe("https://twitter.com/i/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("code_challenge")).toBe("challenge-abc");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });
});

describe("exchangeCodeForToken", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("posts the authorization code with Basic auth and returns the parsed tokens", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: "at-1", refresh_token: "rt-1" }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const result = await exchangeCodeForToken(CONFIG, "auth-code", "verifier-value");

    expect(result).toEqual({ accessToken: "at-1", refreshToken: "rt-1" });
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.twitter.com/2/oauth2/token");
    expect(init.headers.Authorization).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`
    );
    const body = new URLSearchParams(init.body as string);
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("code_verifier")).toBe("verifier-value");
    expect(body.get("grant_type")).toBe("authorization_code");
  });

  it("throws with the provider's status and body when the exchange fails", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "invalid_grant",
    }) as unknown as typeof fetch;

    await expect(exchangeCodeForToken(CONFIG, "bad-code", "verifier")).rejects.toThrow(
      /400.*invalid_grant/
    );
  });
});

describe("fetchTwitterProfile", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("returns the profile fields from a successful response", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: "12345", username: "alice", name: "Alice" } }),
    }) as unknown as typeof fetch;

    const profile = await fetchTwitterProfile("access-token");

    expect(profile).toEqual({ id: "12345", username: "alice", name: "Alice" });
  });

  it("sends the access token as a Bearer header", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: "1", username: "a", name: "A" } }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    await fetchTwitterProfile("my-access-token");

    const [, init] = mockFetch.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer my-access-token");
  });

  it("throws when the profile fetch fails", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    }) as unknown as typeof fetch;

    await expect(fetchTwitterProfile("expired-token")).rejects.toThrow(/401.*unauthorized/);
  });
});
