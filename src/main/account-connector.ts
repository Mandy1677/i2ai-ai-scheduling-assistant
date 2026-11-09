import type { AppFailure } from '../shared/contracts';
import { GmailAdapter } from '../ingestion/gmail-adapter';
import {
  authorize,
  AuthorizationCanceledError,
  AuthorizationTimeoutError,
  ClientConfigError,
  GMAIL_READONLY_SCOPE,
  GoogleAccessTokenSource,
  loadClientConfig,
  revokeToken,
  type GoogleClientConfig,
} from '../ingestion/google-oauth';
import { HttpError, type FetchLike } from '../ingestion/http';
import type { ConfigStores } from '../storage/config-status';

export type ConnectOutcome = { status: 'connected' } | { status: 'failed'; failure: AppFailure };

export interface AccountConnectorDeps {
  stores: ConfigStores;
  clientConfigPath: string;
  openBrowser(url: string): Promise<void>;
  fetchImpl?: FetchLike;
}

export const failureIdFor = (accountId: string): string => `account:${accountId}`;

/**
 * Connects email accounts through their provider's authorization. Only Gmail
 * is implemented (T004); Microsoft and IMAP arrive with T005/T006.
 */
export class AccountConnector {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly deps: AccountConnectorDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async connect(accountId: string): Promise<ConnectOutcome> {
    const account = this.deps.stores.accounts.get(accountId);
    if (!account) return this.fail(accountId, 'This account no longer exists.', 'Open Settings and add it again.');
    if (account.provider !== 'gmail') {
      return this.fail(
        accountId,
        `Connecting ${account.address} is not available in this build yet.`,
        'Only Gmail accounts can be connected so far.',
      );
    }

    let client: GoogleClientConfig;
    try {
      client = loadClientConfig(this.deps.clientConfigPath);
    } catch (error) {
      if (error instanceof ClientConfigError) {
        return {
          status: 'failed',
          failure: {
            id: 'google-client-config',
            message:
              error.reason === 'missing' ? 'Google sign-in is not set up.' : 'The Google sign-in file is not valid.',
            action: `Place the Desktop-app OAuth client JSON at ${this.deps.clientConfigPath}, then click Connect again.`,
          },
        };
      }
      throw error;
    }

    const label = `Gmail sign-in for ${account.address}`;
    let tokens;
    try {
      tokens = await authorize({
        client,
        scopes: [GMAIL_READONLY_SCOPE],
        loginHint: account.address,
        openBrowser: this.deps.openBrowser,
        fetchImpl: this.fetchImpl,
      });
    } catch (error) {
      if (error instanceof AuthorizationCanceledError) {
        return this.fail(accountId, `${label} was canceled or denied.`, 'Open Settings and click Connect to try again.');
      }
      if (error instanceof AuthorizationTimeoutError) {
        return this.fail(accountId, `${label} timed out.`, 'Open Settings and click Connect to try again.');
      }
      return this.networkFailure(accountId, account.address);
    }

    if (!tokens.scopes.includes(GMAIL_READONLY_SCOPE)) {
      await revokeToken(tokens.refreshToken, this.fetchImpl);
      return this.fail(
        accountId,
        `Gmail read access was not granted for ${account.address}.`,
        'Click Connect again and allow the App to view your email.',
      );
    }

    const source = new GoogleAccessTokenSource(client, tokens.refreshToken, this.fetchImpl);
    source.prime(tokens.accessToken, tokens.expiresAt);
    const adapter = new GmailAdapter(account.id, account.folderScope, () => source.get(), this.fetchImpl);
    let signedInAs: string;
    try {
      signedInAs = (await adapter.profile()).emailAddress;
    } catch {
      await revokeToken(tokens.refreshToken, this.fetchImpl);
      return this.networkFailure(accountId, account.address);
    }
    if (signedInAs.toLowerCase() !== account.address.toLowerCase()) {
      await revokeToken(tokens.refreshToken, this.fetchImpl);
      return this.fail(
        accountId,
        `You signed in with a different Google account than ${account.address}.`,
        `Click Connect again and choose ${account.address}.`,
      );
    }

    const { secrets, accounts } = this.deps.stores;
    let secretId: string;
    try {
      secretId = secrets.save(tokens.refreshToken);
    } catch {
      await revokeToken(tokens.refreshToken, this.fetchImpl);
      return this.fail(
        accountId,
        `${account.address} could not be saved securely on this computer.`,
        'Secure storage must be available before accounts can be connected.',
      );
    }
    accounts.setConnection(account.id, 'connected', secretId);
    if (account.credentialSecretId) secrets.delete(account.credentialSecretId);
    return { status: 'connected' };
  }

  /** Builds a read-only adapter for a connected Gmail account. */
  gmailAdapter(accountId: string): GmailAdapter {
    const account = this.deps.stores.accounts.get(accountId);
    if (!account || account.provider !== 'gmail' || !account.credentialSecretId) {
      throw new Error('Account is not a connected Gmail account');
    }
    const refreshToken = this.deps.stores.secrets.read(account.credentialSecretId);
    if (!refreshToken) throw new Error('Stored Gmail credential is missing');
    const source = new GoogleAccessTokenSource(
      loadClientConfig(this.deps.clientConfigPath),
      refreshToken,
      this.fetchImpl,
    );
    return new GmailAdapter(account.id, account.folderScope, () => source.get(), this.fetchImpl);
  }

  /** Revokes a Gmail account's token before it is removed; failures are ignored. */
  async revoke(accountId: string): Promise<void> {
    const account = this.deps.stores.accounts.get(accountId);
    if (account?.provider !== 'gmail' || !account.credentialSecretId) return;
    const refreshToken = this.deps.stores.secrets.read(account.credentialSecretId);
    if (refreshToken) await revokeToken(refreshToken, this.fetchImpl);
  }

  /** True when a provider rejected a stored token and the account must reconnect. */
  static needsReconnect(error: unknown): boolean {
    return error instanceof HttpError && (error.code === 'invalid_grant' || error.status === 401);
  }

  private fail(accountId: string, message: string, action: string): ConnectOutcome {
    return { status: 'failed', failure: { id: failureIdFor(accountId), message, action } };
  }

  private networkFailure(accountId: string, address: string): ConnectOutcome {
    return this.fail(
      accountId,
      `Could not reach Google to connect ${address}.`,
      'Check the internet connection, then click Connect again.',
    );
  }
}
