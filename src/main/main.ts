import { app, safeStorage } from 'electron';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AppFailure, SaveResult } from '../shared/contracts';
import { AccountStore } from '../storage/account-store';
import { isConfigured, missingConfiguration, type ConfigStores } from '../storage/config-status';
import { DATABASE_FILE, openDatabase } from '../storage/database';
import { SecretStore, type Encryptor } from '../storage/secret-store';
import { SettingsStore } from '../storage/settings-store';
import { SyncCoordinator } from '../sync/coordinator';
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

  const configured = (): boolean => stores !== null && isConfigured(stores);

  const currentFailures = (): AppFailure[] => {
    if (!stores) return [STORAGE_FAILURE];
    const failures: AppFailure[] = [];
    if (!stores.secrets.isAvailable()) failures.push(SECURE_STORAGE_FAILURE);
    const missing = missingConfiguration(stores);
    if (missing.length > 0) {
      failures.push({
        id: 'setup-incomplete',
        message: 'Setup is incomplete.',
        action: `Open Settings to add ${missing.join(', ')}.`,
      });
    }
    return failures;
  };

  const coordinator = new SyncCoordinator(
    configured,
    async () => {
      // Processing pipeline is wired in T016.
    },
    () => windows.refreshMain(),
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

  registerIpc({
    requestSync: () => {
      const result = coordinator.requestSync();
      if (result.status === 'configuration-required') windows.show('settings');
      return result;
    },
    openCalendar: async () => {
      windows.show('settings');
      return { status: 'not-configured' };
    },
    openSettings: () => windows.show('settings'),
    readFailures: currentFailures,
    readSettings: () => requireSettings().read(),
    saveSettings: (input) => afterSave(requireSettings().save(input)),
    addAccount: (input) => afterSave(requireSettings().addAccount(input)),
    removeAccount: (id) => afterSave(requireSettings().removeAccount(id)),
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
    if (exiting || !coordinator.isRunning) return;
    // Let an active run persist its progress before the process stops.
    event.preventDefault();
    exiting = true;
    void coordinator.whenIdle().finally(() => app.quit());
  });
  app.on('will-quit', () => {
    tray.destroy();
    opened?.db.close();
  });

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
