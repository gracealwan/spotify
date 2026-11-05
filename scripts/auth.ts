import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const ACCOUNTS_BASE = "https://accounts.spotify.com";
const PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-public",
  "playlist-modify-private",
].join(" ");
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const EXPIRY_MARGIN_MS = 60 * 1000;

type Tokens = { accessToken: string; refreshToken: string; expiresAt: number };

const base64Url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");

const decodeSavedTokens = (value: unknown): Tokens | null => {
  if (typeof value !== "object" || value === null) return null;
  const { accessToken, refreshToken, expiresAt } = value as Record<string, unknown>;
  return typeof accessToken === "string" &&
    typeof refreshToken === "string" &&
    typeof expiresAt === "number"
    ? { accessToken, refreshToken, expiresAt }
    : null;
};

const requestTokens = async (
  params: Record<string, string>,
  fallbackRefreshToken?: string,
): Promise<Tokens> => {
  const response = await fetch(`${ACCOUNTS_BASE}/api/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  if (!response.ok) {
    throw new Error(`Spotify sign-in failed (${response.status}): ${await response.text()}`);
  }
  const body = (await response.json()) as Record<string, unknown>;
  const refreshToken = body.refresh_token ?? fallbackRefreshToken;
  if (
    typeof body.access_token !== "string" ||
    typeof body.expires_in !== "number" ||
    typeof refreshToken !== "string"
  ) {
    throw new Error("Spotify sign-in returned an unexpected response");
  }
  return {
    accessToken: body.access_token,
    refreshToken,
    expiresAt: Date.now() + body.expires_in * 1000,
  };
};

const waitForAuthorizationCode = (authorizeUrl: string, state: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      // Give the browser time to receive the response before the server closes.
      setTimeout(() => server.stop(true), 500);
      settle();
    };
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: PORT,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });

        const code = url.searchParams.get("code");
        if (url.searchParams.get("state") !== state || !code) {
          const reason = url.searchParams.get("error") ?? "invalid response";
          finish(() => reject(new Error(`Spotify sign-in was not completed: ${reason}`)));
          return new Response("Sign-in failed. You can close this tab.", { status: 400 });
        }
        finish(() => resolve(code));
        return new Response("Signed in. You can close this tab and go back to Claude.");
      },
    });
    const timer = setTimeout(
      () => finish(() => reject(new Error("Timed out waiting for Spotify sign-in"))),
      LOGIN_TIMEOUT_MS,
    );

    console.log(`\nApprove access in the browser. If it did not open, visit:\n${authorizeUrl}\n`);
    Bun.spawn(["open", authorizeUrl]);
  });

const logIn = async (clientId: string): Promise<Tokens> => {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(64)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));

  const authorizeUrl = new URL(`${ACCOUNTS_BASE}/authorize`);
  authorizeUrl.search = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    state,
    code_challenge_method: "S256",
    code_challenge: base64Url(new Uint8Array(digest)),
  }).toString();

  const code = await waitForAuthorizationCode(authorizeUrl.toString(), state);
  return requestTokens({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });
};

export const createTokenProvider = (clientId: string, tokenPath: string) => {
  let current: Tokens | null = null;

  const save = async (tokens: Tokens): Promise<Tokens> => {
    await mkdir(dirname(tokenPath), { recursive: true });
    await Bun.write(tokenPath, JSON.stringify(tokens));
    await chmod(tokenPath, 0o600);
    current = tokens;
    return tokens;
  };

  return async (): Promise<string> => {
    if (!current) {
      const file = Bun.file(tokenPath);
      current = (await file.exists()) ? decodeSavedTokens(await file.json()) : null;
    }
    if (!current) return (await save(await logIn(clientId))).accessToken;
    if (current.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return current.accessToken;

    const refreshed = await requestTokens(
      { grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: clientId },
      current.refreshToken,
    );
    return (await save(refreshed)).accessToken;
  };
};
