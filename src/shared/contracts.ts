// Shapes shared by the main process, preload bridge, and renderer.
// See docs/ARCHITECTURE.md section 9 for the logical operation contracts.

export type SyncRequestResult =
  | { status: 'started' }
  | { status: 'already-running' }
  | { status: 'configuration-required' };

export type OpenCalendarResult =
  | { status: 'opened' }
  | { status: 'not-configured' }
  | { status: 'failed' };

/** A safe, actionable failure shown as red text on the main window. */
export interface AppFailure {
  id: string;
  message: string;
  action: string;
}

export type HistoryRangeMode = 'last-30-days' | 'from-date' | 'all-history';

export interface HistoryRange {
  mode: HistoryRangeMode;
  /** YYYY-MM-DD, only for 'from-date'. */
  fromDate: string | null;
}

export type AccountProvider = 'gmail' | 'microsoft' | 'imap';
export type ConnectionState = 'not-connected' | 'connected' | 'needs-reconnect';

export interface ImapSettings {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface AccountSummary {
  id: string;
  address: string;
  provider: AccountProvider;
  connectionState: ConnectionState;
  /** IMAP server details without the password. */
  imap: Omit<ImapSettings, 'password'> | null;
}

export interface CalendarConnection {
  googleAccount: string;
  calendarId: string;
  calendarName: string;
}

/** Everything the Settings window may see. Never includes secret values. */
export interface PublicSettings {
  historyRange: HistoryRange | null;
  openRouter: { model: string; keyConfigured: boolean };
  calendar: CalendarConnection | null;
  accounts: AccountSummary[];
  secureStorageAvailable: boolean;
}

export interface SettingsInput {
  historyRange: HistoryRange | null;
  openRouterModel: string;
  /** Omitted or empty keeps the saved key. */
  openRouterApiKey?: string;
}

export interface AddAccountInput {
  address: string;
  provider: AccountProvider;
  imap?: ImapSettings;
}

export type FieldErrors = Record<string, string>;

/** A failed connection is reported on the main window, not in Settings. */
export type ConnectResult =
  | { status: 'connected'; settings: PublicSettings }
  | { status: 'failed'; settings: PublicSettings }
  | { status: 'busy' };

export type SaveResult =
  | { status: 'saved'; settings: PublicSettings }
  | { status: 'invalid'; fieldErrors: FieldErrors };

/** The only operations the renderer can reach. */
export interface AssistantBridge {
  requestSync(): Promise<SyncRequestResult>;
  openCalendar(): Promise<OpenCalendarResult>;
  openSettings(): Promise<void>;
  readFailures(): Promise<AppFailure[]>;
  readSettings(): Promise<PublicSettings>;
  saveSettings(input: SettingsInput): Promise<SaveResult>;
  addAccount(input: AddAccountInput): Promise<SaveResult>;
  removeAccount(id: string): Promise<SaveResult>;
  connectAccount(id: string): Promise<ConnectResult>;
}

export const IpcChannel = {
  requestSync: 'assistant:request-sync',
  openCalendar: 'assistant:open-calendar',
  openSettings: 'assistant:open-settings',
  readFailures: 'assistant:read-failures',
  readSettings: 'assistant:read-settings',
  saveSettings: 'assistant:save-settings',
  addAccount: 'assistant:add-account',
  removeAccount: 'assistant:remove-account',
  connectAccount: 'assistant:connect-account',
} as const;
