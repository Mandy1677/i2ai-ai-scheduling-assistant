import type { AppFailure, CalendarConnection } from '../shared/contracts';
import {
  authorize,
  AuthorizationCanceledError,
  AuthorizationTimeoutError,
  ClientConfigError,
  GoogleAccessTokenSource,
  loadClientConfig,
  revokeToken,
} from '../ingestion/google-oauth';
import { fetchJson, HttpError, type FetchLike } from '../ingestion/http';
import type { ConfigStores } from '../storage/config-status';
import { SettingKey } from '../storage/settings-store';
import { CalendarClient } from './calendar-client';

// T011: Google authorization for the dedicated calendar. The App asks only
// for calendar.app.created, so it can manage calendars it creates and nothing
// else in Monica's Google Calendar.

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
const IDENTITY_SCOPES = ['openid', 'email'];
export const DEDICATED_CALENDAR_NAME = 'AI Scheduling Assistant';
const FAILURE_ID = 'calendar-connection';

export type CalendarConnectOutcome = { status: 'connected' } | { status: 'failed'; failure: AppFailure };

export interface CalendarConnectorDeps {
  stores: ConfigStores;
  clientConfigPath: string;
  openBrowser(url: string): Promise<void>;
  defaultTimeZone: string;
  fetchImpl?: FetchLike;
}

export class CalendarConnector {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly deps: CalendarConnectorDeps) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async connect(): Promise<CalendarConnectOutcome> {
    let client;
    try {
      client = loadClientConfig(this.deps.clientConfigPath);
    } catch (error) {
      if (error instanceof ClientConfigError) {
        return this.fail(
          'Google sign-in is not set up.',
          `Place the Desktop-app OAuth client JSON at ${this.deps.clientConfigPath}, then click Connect Google Calendar again.`,
        );
      }
      throw error;
    }

    let tokens;
    try {
      tokens = await authorize({
        client,
        scopes: [CALENDAR_SCOPE, ...IDENTITY_SCOPES],
        openBrowser: this.deps.openBrowser,
        fetchImpl: this.fetchImpl,
      });
    } catch (error) {
      if (error instanceof AuthorizationCanceledError) {
        return this.fail('Google Calendar sign-in was canceled or denied.', 'Open Settings and click Connect Google Calendar to try again.');
      }
      if (error instanceof AuthorizationTimeoutError) {
        return this.fail('Google Calendar sign-in timed out.', 'Open Settings and click Connect Google Calendar to try again.');
      }
      return this.unreachable();
    }
    if (!tokens.scopes.includes(CALENDAR_SCOPE)) {
      await revokeToken(tokens.refreshToken, this.fetchImpl);
      return this.fail(
        'Calendar access was not granted.',
        'Click Connect Google Calendar again and allow the App to create and manage its own calendar.',
      );
    }

    const source = new GoogleAccessTokenSource(client, tokens.refreshToken, this.fetchImpl);
    source.prime(tokens.accessToken, tokens.expiresAt);
    const calendar = new CalendarClient(() => source.get(), this.fetchImpl);
    const { settings, secrets } = this.deps.stores;
    const previous = settings.get<CalendarConnection>(SettingKey.calendar);

    let googleAccount: string;
    let connection: CalendarConnection;
    try {
      googleAccount = await this.accountEmail(tokens.accessToken);
      // Reuse the stored dedicated calendar when this account can still reach it;
      // otherwise create a new one. Never adopt an unrelated existing calendar.
      const reused =
        previous && previous.googleAccount === googleAccount ? await this.reachable(calendar, previous.calendarId) : null;
      const info =
        reused ??
        (await calendar.createCalendar(
          DEDICATED_CALENDAR_NAME,
          'Created by the AI Scheduling Assistant. Confirmed appointments and follow-ups from scheduling email.',
          this.deps.defaultTimeZone,
        ));
      connection = { googleAccount, calendarId: info.id, calendarName: info.summary, timeZone: info.timeZone };
    } catch {
      await revokeToken(tokens.refreshToken, this.fetchImpl);
      return this.unreachable();
    }

    let secretId: string;
    try {
      secretId = secrets.save(tokens.refreshToken);
    } catch {
      await revokeToken(tokens.refreshToken, this.fetchImpl);
      return this.fail('Google Calendar could not be saved securely on this computer.', 'Secure storage must be available.');
    }
    const oldSecret = settings.get<string>(SettingKey.calendarSecretId);
    settings.set(SettingKey.calendar, connection);
    settings.set(SettingKey.calendarSecretId, secretId);
    if (oldSecret) secrets.delete(oldSecret);
    return { status: 'connected' };
  }

  /** A client for the connected dedicated calendar, or null when not connected. */
  client(): { calendar: CalendarClient; connection: CalendarConnection } | null {
    const { settings, secrets } = this.deps.stores;
    const connection = settings.get<CalendarConnection>(SettingKey.calendar);
    const secretId = settings.get<string>(SettingKey.calendarSecretId);
    const refreshToken = secretId ? secrets.read(secretId) : null;
    if (!connection || !refreshToken) return null;
    const source = new GoogleAccessTokenSource(loadClientConfig(this.deps.clientConfigPath), refreshToken, this.fetchImpl);
    return { calendar: new CalendarClient(() => source.get(), this.fetchImpl), connection };
  }

  static failureId = FAILURE_ID;

  private async accountEmail(accessToken: string): Promise<string> {
    const info = await fetchJson<{ email?: string }>(this.fetchImpl, 'https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!info.email) throw new Error('No account email returned');
    return info.email.toLowerCase();
  }

  private async reachable(calendar: CalendarClient, calendarId: string) {
    try {
      return await calendar.getCalendar(calendarId);
    } catch (error) {
      if (error instanceof HttpError && (error.status === 404 || error.status === 403)) return null;
      throw error;
    }
  }

  private fail(message: string, action: string): CalendarConnectOutcome {
    return { status: 'failed', failure: { id: FAILURE_ID, message, action } };
  }

  private unreachable(): CalendarConnectOutcome {
    return this.fail(
      'Could not reach Google Calendar.',
      'Check the internet connection and that the Google Calendar API is enabled, then click Connect Google Calendar again.',
    );
  }
}
