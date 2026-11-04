import type {
  AccountProvider,
  AddAccountInput,
  CalendarConnection,
  FieldErrors,
  HistoryRange,
  HistoryRangeMode,
  PublicSettings,
  SaveResult,
  SettingsInput,
} from '../shared/contracts';
import type { ConfigStores } from '../storage/config-status';
import { SecureStorageUnavailableError } from '../storage/secret-store';
import { SettingKey } from '../storage/settings-store';

const RANGE_MODES: HistoryRangeMode[] = ['last-30-days', 'from-date', 'all-history'];
const PROVIDERS: AccountProvider[] = ['gmail', 'microsoft', 'imap'];
const MODEL_PATTERN = /^[A-Za-z0-9._\-/:]{1,200}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOST_PATTERN = /^[A-Za-z0-9.-]{1,253}$/;
const SECURE_STORAGE_ERROR = 'Could not be saved securely on this computer, so nothing was saved.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asTrimmedString = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Validates a YYYY-MM-DD date that is a real calendar day and not in the future. */
export function isValidPastDate(value: string, today: Date = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return false;
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return date.getTime() <= todayUtc;
}

export function validateSettingsInput(
  input: unknown,
  today?: Date,
): { value: SettingsInput; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const raw = isRecord(input) ? input : {};

  let historyRange: HistoryRange | null = null;
  const range = isRecord(raw.historyRange) ? raw.historyRange : null;
  const mode = range?.mode;
  if (typeof mode !== 'string' || !RANGE_MODES.includes(mode as HistoryRangeMode)) {
    errors.historyRange = 'Choose how much email history to read before the first scan.';
  } else if (mode === 'from-date') {
    const fromDate = asTrimmedString(range?.fromDate);
    if (!isValidPastDate(fromDate, today)) {
      errors.fromDate = 'Enter a valid date that is not in the future.';
    } else {
      historyRange = { mode, fromDate };
    }
  } else {
    historyRange = { mode: mode as HistoryRangeMode, fromDate: null };
  }

  const openRouterModel = asTrimmedString(raw.openRouterModel);
  if (!openRouterModel) {
    errors.openRouterModel = 'Enter an OpenRouter model ID, for example vendor/model-name:free.';
  } else if (!MODEL_PATTERN.test(openRouterModel)) {
    errors.openRouterModel = 'Model IDs use letters, numbers, and . _ - / : only.';
  }

  const openRouterApiKey = asTrimmedString(raw.openRouterApiKey);
  if (openRouterApiKey && (openRouterApiKey.length > 500 || /\s/.test(openRouterApiKey))) {
    errors.openRouterApiKey = 'The API key cannot contain spaces.';
  }

  return { value: { historyRange, openRouterModel, openRouterApiKey }, errors };
}

export function validateAccountInput(input: unknown): { value: AddAccountInput; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const raw = isRecord(input) ? input : {};

  const address = asTrimmedString(raw.address).toLowerCase();
  if (!EMAIL_PATTERN.test(address) || address.length > 254) {
    errors.address = 'Enter a valid email address.';
  }

  const provider = raw.provider as AccountProvider;
  if (!PROVIDERS.includes(provider)) errors.provider = 'Choose the account type.';

  const value: AddAccountInput = { address, provider };
  if (provider === 'imap') {
    const imap = isRecord(raw.imap) ? raw.imap : {};
    const host = asTrimmedString(imap.host).toLowerCase();
    const port = Number(imap.port);
    const username = asTrimmedString(imap.username);
    const password = typeof imap.password === 'string' ? imap.password : '';
    if (!HOST_PATTERN.test(host)) errors.imapHost = 'Enter the IMAP server name, for example imap.example.com.';
    if (!Number.isInteger(port) || port < 1 || port > 65535) errors.imapPort = 'Enter a port from 1 to 65535.';
    if (!username) errors.imapUsername = 'Enter the IMAP user name.';
    if (!password) errors.imapPassword = 'Enter the IMAP password.';
    value.imap = { host, port, username, password };
  }
  return { value, errors };
}

/** Settings operations behind the IPC bridge. */
export class SettingsService {
  constructor(private readonly stores: ConfigStores) {}

  read(): PublicSettings {
    const { settings, secrets, accounts } = this.stores;
    return {
      historyRange: settings.get<HistoryRange>(SettingKey.historyRange),
      openRouter: {
        model: settings.get<string>(SettingKey.openRouterModel) ?? '',
        keyConfigured: secrets.has(settings.get<string>(SettingKey.openRouterKeySecretId)),
      },
      calendar: settings.get<CalendarConnection>(SettingKey.calendar),
      accounts: accounts.list(),
      secureStorageAvailable: secrets.isAvailable(),
    };
  }

  save(input: unknown): SaveResult {
    const { value, errors } = validateSettingsInput(input);
    const { settings, secrets } = this.stores;
    const keySecretId = settings.get<string>(SettingKey.openRouterKeySecretId);
    if (!value.openRouterApiKey && !secrets.has(keySecretId) && !errors.openRouterApiKey) {
      errors.openRouterApiKey = 'Enter your OpenRouter API key.';
    }
    if (Object.keys(errors).length > 0) return { status: 'invalid', fieldErrors: errors };

    if (value.openRouterApiKey) {
      let newId: string;
      try {
        newId = secrets.save(value.openRouterApiKey);
      } catch (error) {
        if (error instanceof SecureStorageUnavailableError) {
          return { status: 'invalid', fieldErrors: { openRouterApiKey: SECURE_STORAGE_ERROR } };
        }
        throw error;
      }
      settings.set(SettingKey.openRouterKeySecretId, newId);
      if (keySecretId) secrets.delete(keySecretId);
    }
    settings.set(SettingKey.historyRange, value.historyRange);
    settings.set(SettingKey.openRouterModel, value.openRouterModel);
    return { status: 'saved', settings: this.read() };
  }

  addAccount(input: unknown): SaveResult {
    const { value, errors } = validateAccountInput(input);
    if (!errors.address && this.stores.accounts.exists(value.address)) {
      errors.address = 'This account has already been added.';
    }
    if (Object.keys(errors).length > 0) return { status: 'invalid', fieldErrors: errors };

    let credentialSecretId: string | null = null;
    if (value.imap) {
      try {
        credentialSecretId = this.stores.secrets.save(value.imap.password);
      } catch (error) {
        if (error instanceof SecureStorageUnavailableError) {
          return { status: 'invalid', fieldErrors: { imapPassword: SECURE_STORAGE_ERROR } };
        }
        throw error;
      }
    }
    const imap = value.imap
      ? { host: value.imap.host, port: value.imap.port, username: value.imap.username }
      : null;
    this.stores.accounts.add({ address: value.address, provider: value.provider, imap, credentialSecretId });
    return { status: 'saved', settings: this.read() };
  }

  removeAccount(id: unknown): SaveResult {
    if (typeof id !== 'string') return { status: 'invalid', fieldErrors: { account: 'Unknown account.' } };
    const { removed, credentialSecretId } = this.stores.accounts.remove(id);
    if (!removed) return { status: 'invalid', fieldErrors: { account: 'Unknown account.' } };
    if (credentialSecretId) this.stores.secrets.delete(credentialSecretId);
    return { status: 'saved', settings: this.read() };
  }
}
