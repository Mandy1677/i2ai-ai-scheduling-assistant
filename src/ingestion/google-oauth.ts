import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchJson, type FetchLike } from './http';

// Google OAuth for an installed desktop App: the system browser handles
// sign-in and returns to a temporary loopback receiver on 127.0.0.1, with
// PKCE. Shared by Gmail (T004) and Google Calendar (T011).

export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const CLIENT_CONFIG_FILE = 'google-oauth-client.json';

const AUTH_HOST = 'accounts.google.com';
const TOKEN_HOST = 'oauth2.googleapis.com';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface GoogleClientConfig {
  clientId: string;
  clientSecret: string;
  authUri: string;
  tokenUri: string;
}

export class ClientConfigError extends Error {
  constructor(readonly reason: 'missing' | 'invalid') {
    super(reason === 'missing' ? 'Google OAuth client file not found' : 'Google OAuth client file is invalid');
    this.name = 'ClientConfigError';
  }
}

export class AuthorizationCanceledError extends Error {
  constructor(readonly code: string) {
    super(`Google sign-in did not complete (${code})`);
    this.name = 'AuthorizationCanceledError';
  }
}

export class AuthorizationTimeoutError extends Error {
  constructor() {
    super('Google sign-in timed out');
    this.name = 'AuthorizationTimeoutError';
  }
}

/** Reads the Desktop-app client JSON downloaded from Google Cloud Console. */
export function loadClientConfig(filePath: string): GoogleClientConfig {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ClientConfigError('missing');
    throw error;
  }
  let installed: Record<string, unknown>;
  try {
    installed = (JSON.parse(raw) as { installed?: Record<string, unknown> }).installed ?? {};
  } catch {
    throw new ClientConfigError('invalid');
  }
  const { client_id, client_secret } = installed;
  const authUri = typeof installed.auth_uri === 'string' ? installed.auth_uri : `https://${AUTH_HOST}/o/oauth2/auth`;
  const tokenUri = typeof installed.token_uri === 'string' ? installed.token_uri : `https://${TOKEN_HOST}/token`;
  if (
    typeof client_id !== 'string' ||
    !client_id.endsWith('.apps.googleusercontent.com') ||
    typeof client_secret !== 'string' ||
    !isHttpsHost(authUri, AUTH_HOST) ||
    !isHttpsHost(tokenUri, TOKEN_HOST)
  ) {
    throw new ClientConfigError('invalid');
  }
  return { clientId: client_id, clientSecret: client_secret, authUri, tokenUri };
}

function isHttpsHost(url: string, host: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.host === host;
  } catch {
    return false;
  }
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthUrl(
  client: GoogleClientConfig,
  params: { redirectUri: string; scopes: string[]; state: string; codeChallenge: string; loginHint?: string },
): string {
  const url = new URL(client.authUri);
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', params.scopes.join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Offline access with forced consent so Google always returns a refresh token.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  if (params.loginHint) url.searchParams.set('login_hint', params.loginHint);
  return url.toString();
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

const RESULT_PAGE = (message: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>AI Scheduling Assistant</title></head>` +
  `<body style="font:16px 'Segoe UI',system-ui,sans-serif;padding:32px;color:#111827">` +
  `<p>${message}</p><p>You can close this tab and return to the App.</p></body></html>`;

export interface AuthorizeOptions {
  client: GoogleClientConfig;
  scopes: string[];
  loginHint?: string;
  openBrowser(url: string): Promise<void>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/** Runs the browser sign-in and returns tokens. Resolves only after the code is exchanged. */
export async function authorize(options: AuthorizeOptions): Promise<GoogleTokens> {
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString('base64url');
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  let timer: NodeJS.Timeout | undefined;
  try {
    const code = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new AuthorizationTimeoutError()), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri);
        // Ignore anything that is not our redirect (e.g. favicon requests or stray tabs).
        if (url.pathname !== '/' || url.searchParams.get('state') !== state) {
          res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
          return;
        }
        const error = url.searchParams.get('error');
        const authCode = url.searchParams.get('code');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        if (error || !authCode) {
          res.end(RESULT_PAGE('Google sign-in was not completed.'));
          reject(new AuthorizationCanceledError(error ?? 'no_code'));
        } else {
          res.end(RESULT_PAGE('Google sign-in is complete.'));
          resolve(authCode);
        }
      });
      const authUrl = buildAuthUrl(options.client, {
        redirectUri,
        scopes: options.scopes,
        state,
        codeChallenge: challenge,
        loginHint: options.loginHint,
      });
      options.openBrowser(authUrl).catch(reject);
    });
    return await exchangeCode(options.client, code, redirectUri, verifier, options.fetchImpl ?? fetch);
  } finally {
    clearTimeout(timer);
    closeServer(server);
  }
}

function closeServer(server: Server): void {
  server.close();
  server.closeAllConnections();
}

async function exchangeCode(
  client: GoogleClientConfig,
  code: string,
  redirectUri: string,
  verifier: string,
  fetchImpl: FetchLike,
): Promise<GoogleTokens> {
  const body = new URLSearchParams({
    code,
    client_id: client.clientId,
    client_secret: client.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  });
  const token = await fetchJson<TokenResponse>(fetchImpl, client.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!token.refresh_token) throw new AuthorizationCanceledError('no_refresh_token');
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + token.expires_in * 1000,
    scopes: (token.scope ?? '').split(' ').filter(Boolean),
  };
}

/** Exchanges a stored refresh token for short-lived access tokens, caching until near expiry. */
export class GoogleAccessTokenSource {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly client: GoogleClientConfig,
    private readonly refreshToken: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seeds the cache with the access token returned by sign-in. */
  prime(accessToken: string, expiresAt: number): void {
    this.cached = { token: accessToken, expiresAt };
  }

  async get(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > this.now()) return this.cached.token;
    const token = await fetchJson<TokenResponse>(this.fetchImpl, this.client.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.client.clientId,
        client_secret: this.client.clientSecret,
        refresh_token: this.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    this.cached = { token: token.access_token, expiresAt: this.now() + token.expires_in * 1000 };
    return token.access_token;
  }
}

/** Best-effort revocation when an account is removed or the wrong account signed in. */
export async function revokeToken(token: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
