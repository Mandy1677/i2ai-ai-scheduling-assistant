import { app, powerMonitor, safeStorage, shell } from 'electron';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AppFailure,
  CalendarConnection,
  ConnectResult,
  HistoryRange,
  OpenCalendarResult,
  SaveResult,
} from '../shared/contracts';
import type { OpenRouterConfig } from '../analysis/openrouter';
import { createAnalysisHandler } from '../analysis/pipeline';
import { applyToCalendar } from '../calendar/apply';
import { CLIENT_CONFIG_FILE } from '../ingestion/google-oauth';
import { calendarViewUrl } from '../calendar/calendar-client';
import { CalendarConnector } from '../calendar/calendar-connector';
import { AccountStore } from '../storage/account-store';
import { CalendarStore } from '../storage/calendar-store';
import { isConfigured, MISSING_ACCOUNT, missingConfiguration, type ConfigStores } from '../storage/config-status';
import { DATABASE_FILE, openDatabase } from '../storage/database';
import { ProcessingStore } from '../storage/processing-store';
import { SchedulingStore } from '../storage/scheduling-store';
import { SecretStore, type Encryptor } from '../storage/secret-store';
import { SettingKey, SettingsStore } from '../storage/settings-store';
import { SyncCursorStore } from '../storage/sync-cursor-store';
import { SyncCoordinator } from '../sync/coordinator';
import { errorCode } from '../sync/queue-worker';
import { accountStateFailures, runSync } from '../sync/run';
import { AccountConnector, failureIdFor } from './account-connector';
import { registerIpc } from './ipc';
import { SettingsService } from './settings-service';
import { createTray } from './tray';
import { WindowManager } from './windows';

const electronEncryptor: Encryptor = {
  // Linux can fall back to an unencrypted store; treat that as unavailable.
  isAvailable: () =>
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
  encrypt: (plainText) => safeStorage.encryptString(plainText),
  decrypt: (cipherText) => safeStorage.decryptString(cipherText),
};

const STORAGE_FAILURE: AppFailure = {
  id: 'storage-unavailable',
  message: 'Local App data could not be opened.',
  action: 'Exit the App and start it again. If this continues, check that the disk is not full.',
};

const SECURE_STORAGE_FAILURE: AppFailure = {
  id: 'secure-storage-unavailable',
  message: 'Secure storage is unavailable on this computer.',
  action: 'Keys and passwords cannot be saved until Windows protected storage is available.',
};

const SYNC_FAILURE: AppFailure = {
  id: 'sync-failed',
  message: 'Sync could not be completed.',
  action: 'Click Sync now to try again. If this continues, exit and start the App again.',
};

/** How long Exit waits for an active run before stopping; queued work is durable either way. */
const SHUTDOWN_GRACE_MS = 15_000;

function openStores(): { db: DatabaseSync; stores: ConfigStores } | null {
  try {
    const db = openDatabase(path.join(app.getPath('userData'), DATABASE_FILE));
    return {
      db,
      stores: {
        settings: new SettingsStore(db),
        secrets: new SecretStore(db, electronEncryptor),
        accounts: new AccountStore(db),
      },
    };
  } catch (error) {
    console.error('Failed to open local storage:', error instanceof Error ? error.message : error);
    return null;
  }
}

function start(): void {
  const windows = new WindowManager();
  const opened = openStores();
  const stores = opened?.stores ?? null;
  const settingsService = stores ? new SettingsService(stores) : null;

  const clientConfigPath = path.join(app.getPath('userData'), CLIENT_CONFIG_FILE);
  const openSignIn = async (url: string): Promise<void> => {
    if (!url.startsWith('https://accounts.google.com/')) throw new Error('Unexpected sign-in URL');
    await shell.openExternal(url);
  };
  const connector = stores ? new AccountConnector({ stores, clientConfigPath, openBrowser: openSignIn }) : null;
  const calendarConnector = stores
    ? new CalendarConnector({
        stores,
        clientConfigPath,
        openBrowser: openSignIn,
        defaultTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      })
    : null;
  const pipeline = opened
    ? {
        cursors: new SyncCursorStore(opened.db),
        queue: new ProcessingStore(opened.db),
        scheduling: new SchedulingStore(opened.db),
        associations: new CalendarStore(opened.db),
      }
    : null;
  const connecting = new Set<string>();

  // Operational failures from connections, keyed by failure ID, until resolved.
  const operationalFailures = new Map<string, AppFailure>();
  // Failures found by the last sync run; replaced after each run.
  let syncFailures: AppFailure[] = [];
  // Possible missed mail stays visible until Settings is saved again.
  const gapFailures = new Map<string, AppFailure>();
  // Email changes kept back by a manual calendar edit stay until the calendar is opened.
  const editNotices = new Map<string, AppFailure>();

  const configured = (): boolean => stores !== null && isConfigured(stores);

  const currentFailures = (): AppFailure[] => {
    if (!stores) return [STORAGE_FAILURE];
    const accountFailures = accountStateFailures(stores.accounts);
    const byId = new Map<string, AppFailure>();
    for (const failure of [
      ...operationalFailures.values(),
      ...accountFailures,
      ...syncFailures,
      ...gapFailures.values(),
      ...editNotices.values(),
    ]) {
      if (!byId.has(failure.id)) byId.set(failure.id, failure);
    }
    const failures = [...byId.values()];
    if (!stores.secrets.isAvailable()) failures.push(SECURE_STORAGE_FAILURE);
    // An account warning already says what to do; don't repeat it as missing setup.
    const missing = missingConfiguration(stores).filter(
      (item) => item !== MISSING_ACCOUNT || accountFailures.length === 0,
    );
    if (missing.length > 0) {
      failures.push({
        id: 'setup-incomplete',
        message: 'Setup is incomplete.',
        action: `Open Settings to add ${missing.join(', ')}.`,
      });
    }
    return failures;
  };

  const openRouterConfig = (): OpenRouterConfig => {
    const model = stores?.settings.get<string>(SettingKey.openRouterModel);
    const keyId = stores?.settings.get<string>(SettingKey.openRouterKeySecretId);
    const apiKey = keyId ? stores?.secrets.read(keyId) : null;
    if (!model || !apiKey) throw new Error('OpenRouter is not configured');
    // Route only to providers that do not collect prompts (PRD F08); fail visibly otherwise.
    return { apiKey, model, denyDataCollection: true };
  };

  const runPipeline = async (shouldStop: () => boolean): Promise<void> => {
    const range = stores?.settings.get<HistoryRange>(SettingKey.historyRange);
    if (!stores || !opened || !pipeline || !connector || !calendarConnector || !range) return;
    const timeZone =
      stores.settings.get<CalendarConnection>(SettingKey.calendar)?.timeZone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone;
    const report = await runSync({
      db: opened.db,
      accounts: stores.accounts,
      cursors: pipeline.cursors,
      queue: pipeline.queue,
      range,
      adapterFor: (accountId) => connector.gmailAdapter(accountId),
      analysis: (threadFor) =>
        createAnalysisHandler({
          store: pipeline.scheduling,
          openRouter: openRouterConfig,
          ownerAddresses: () => stores.accounts.list().map((account) => account.address),
          threadFor,
          defaultTimeZone: timeZone,
        }),
      applyCalendar: async () => {
        const client = calendarConnector.client();
        if (!client) return null;
        return applyToCalendar({
          store: pipeline.scheduling,
          associations: pipeline.associations,
          calendar: client.calendar,
          connection: client.connection,
          accountAddress: (accountId) => stores.accounts.get(accountId)?.address ?? null,
        });
      },
      needsReconnect: AccountConnector.needsReconnect,
      shouldStop,
    });
    if (report.stopped) return;
    syncFailures = report.failures;
    for (const gap of report.possibleGaps) gapFailures.set(gap.id, gap);
    for (const notice of report.editNotices) editNotices.set(notice.id, notice);
    // Counts only; no message content is logged.
    console.info(
      `Sync finished: ${report.discovered} new, ${report.processed} processed, ${report.failures.length} problems`,
    );
  };

  const coordinator = new SyncCoordinator(
    configured,
    runPipeline,
    (error) => {
      console.error('Sync run failed:', errorCode(error));
      syncFailures = [SYNC_FAILURE];
    },
    (running) => {
      windows.notifySyncState(running);
      if (!running) windows.refreshMain();
    },
  );

  const syncNow = (): void => {
    const result = coordinator.requestSync();
    // Actions that need missing configuration lead to Settings (DESIGN.md section 6).
    if (result.status === 'configuration-required') windows.show('settings');
  };

  const requireSettings = (): SettingsService => {
    if (!settingsService) throw new Error('Local storage is unavailable');
    return settingsService;
  };

  // Saving may complete configuration or change the warnings shown.
  const afterSave = (result: SaveResult): SaveResult => {
    if (result.status === 'saved') {
      windows.refreshMain();
      if (configured()) coordinator.requestSync();
    }
    return result;
  };

  const connectAccount = async (id: unknown): Promise<ConnectResult> => {
    const service = requireSettings();
    if (typeof id !== 'string' || !connector) return { status: 'failed', settings: service.read() };
    if (connecting.has(id)) return { status: 'busy' };
    connecting.add(id);
    try {
      const outcome = await connector.connect(id);
      if (outcome.status === 'connected') {
        operationalFailures.delete(failureIdFor(id));
        operationalFailures.delete('google-client-config');
        afterSave({ status: 'saved', settings: service.read() });
        return { status: 'connected', settings: service.read() };
      }
      operationalFailures.set(outcome.failure.id, outcome.failure);
      windows.refreshMain();
      // Failures appear on the main window (DESIGN.md section 3).
      windows.show('main');
      return { status: 'failed', settings: service.read() };
    } finally {
      connecting.delete(id);
    }
  };

  const connectCalendar = async (): Promise<ConnectResult> => {
    const service = requireSettings();
    if (!calendarConnector) return { status: 'failed', settings: service.read() };
    if (connecting.has('calendar')) return { status: 'busy' };
    connecting.add('calendar');
    try {
      const outcome = await calendarConnector.connect();
      if (outcome.status === 'connected') {
        operationalFailures.delete(CalendarConnector.failureId);
        afterSave({ status: 'saved', settings: service.read() });
        return { status: 'connected', settings: service.read() };
      }
      operationalFailures.set(outcome.failure.id, outcome.failure);
      windows.refreshMain();
      windows.show('main');
      return { status: 'failed', settings: service.read() };
    } finally {
      connecting.delete('calendar');
    }
  };

  const openCalendar = async (): Promise<OpenCalendarResult> => {
    const connection = stores?.settings.get<CalendarConnection>(SettingKey.calendar) ?? null;
    if (!connection) {
      windows.show('settings');
      return { status: 'not-configured' };
    }
    try {
      await shell.openExternal(calendarViewUrl(connection.calendarId, connection.googleAccount));
      editNotices.clear();
      windows.refreshMain();
      return { status: 'opened' };
    } catch {
      return { status: 'failed' };
    }
  };

  const removeAccount = async (id: unknown): Promise<SaveResult> => {
    if (typeof id === 'string' && connector) {
      await connector.revoke(id).catch(() => undefined);
      operationalFailures.delete(failureIdFor(id));
    }
    return afterSave(requireSettings().removeAccount(id));
  };

  registerIpc({
    requestSync: () => {
      const result = coordinator.requestSync();
      if (result.status === 'configuration-required') windows.show('settings');
      return result;
    },
    openCalendar,
    openSettings: () => windows.show('settings'),
    readFailures: currentFailures,
    readSettings: () => requireSettings().read(),
    saveSettings: (input) => {
      const result = requireSettings().save(input);
      if (result.status === 'saved') gapFailures.clear();
      return afterSave(result);
    },
    addAccount: (input) => afterSave(requireSettings().addAccount(input)),
    removeAccount,
    connectAccount,
    connectCalendar,
    isSyncing: () => coordinator.isRunning,
  });

  // Keep a reference so the tray icon is not garbage-collected.
  const tray = createTray({
    openApp: () => windows.show('main'),
    syncNow,
    exit: () => app.quit(),
  });

  app.on('second-instance', () => windows.show('main'));

  // Closing every window leaves the App running in the tray.
  app.on('window-all-closed', () => undefined);

  let exiting = false;
  app.on('before-quit', (event) => {
    windows.markQuitting();
    coordinator.stop();
    if (exiting || !coordinator.isRunning) return;
    // Let an active run finish its current step, within a bounded wait.
    event.preventDefault();
    exiting = true;
    const grace = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS));
    void Promise.race([coordinator.whenIdle(), grace]).finally(() => app.quit());
  });
  app.on('will-quit', () => {
    tray.destroy();
    opened?.db.close();
  });

  // Check every five minutes while running, and catch up after sleep.
  coordinator.schedule();
  powerMonitor.on('resume', () => coordinator.requestSync());

  if (configured()) {
    syncNow();
  } else if (!stores) {
    windows.show('main');
  } else {
    windows.show('settings');
  }
}

// One process instance only; a second launch focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(start);
}
