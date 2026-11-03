import { app } from 'electron';
import type { AppFailure } from '../shared/contracts';
import { SyncCoordinator } from '../sync/coordinator';
import { registerIpc } from './ipc';
import { createTray } from './tray';
import { WindowManager } from './windows';

// Persistent configuration arrives with T002/T003. Until then the App is
// always unconfigured and must say so rather than simulate a sync.
const isConfigured = (): boolean => false;

const NOT_CONFIGURED: AppFailure = {
  id: 'setup-incomplete',
  message: 'Setup is incomplete.',
  action: 'Open Settings to connect email accounts, Google Calendar, and OpenRouter.',
};

function currentFailures(): AppFailure[] {
  return isConfigured() ? [] : [NOT_CONFIGURED];
}

function start(): void {
  const windows = new WindowManager();
  const coordinator = new SyncCoordinator(
    isConfigured,
    async () => {
      // Processing pipeline is wired in T016.
    },
    () => windows.refreshMain(),
  );

  const syncNow = (): void => {
    const result = coordinator.requestSync();
    if (result.status === 'configuration-required') windows.show('main');
  };

  registerIpc({
    requestSync: () => coordinator.requestSync(),
    openCalendar: async () => ({ status: 'not-configured' }),
    openSettings: () => windows.show('settings'),
    readFailures: currentFailures,
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
  app.on('will-quit', () => tray.destroy());

  if (isConfigured()) {
    syncNow();
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
