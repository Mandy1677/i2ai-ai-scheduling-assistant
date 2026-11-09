import type { HistoryRange } from '../shared/contracts';
import type { AccountStore } from './account-store';
import type { SecretStore } from './secret-store';
import { SettingKey, type SettingsStore } from './settings-store';

export interface ConfigStores {
  settings: SettingsStore;
  secrets: SecretStore;
  accounts: AccountStore;
}

export const MISSING_ACCOUNT = 'a connected email account';

/** Human-readable names of required configuration that is still missing. */
export function missingConfiguration(stores: ConfigStores): string[] {
  const missing: string[] = [];
  if (stores.accounts.countConnected() === 0) missing.push(MISSING_ACCOUNT);
  if (!stores.settings.get(SettingKey.calendar)) missing.push('Google Calendar');
  if (!stores.secrets.has(stores.settings.get<string>(SettingKey.openRouterKeySecretId))) {
    missing.push('an OpenRouter API key');
  }
  if (!stores.settings.get<string>(SettingKey.openRouterModel)) missing.push('an OpenRouter model');
  if (!stores.settings.get<HistoryRange>(SettingKey.historyRange)) missing.push('an initial email range');
  return missing;
}

export function isConfigured(stores: ConfigStores): boolean {
  return missingConfiguration(stores).length === 0;
}
