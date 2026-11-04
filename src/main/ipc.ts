import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { pathToFileURL } from 'node:url';
import {
  IpcChannel,
  type AppFailure,
  type OpenCalendarResult,
  type SyncRequestResult,
} from '../shared/contracts';
import { UI_DIR } from './windows';

export interface IpcHandlers {
  requestSync(): SyncRequestResult;
  openCalendar(): Promise<OpenCalendarResult>;
  openSettings(): void;
  readFailures(): AppFailure[];
}

// Windows paths are case-insensitive, and drive-letter case can differ
// between Node and Chromium file URLs.
const normalize = (url: string): string => (process.platform === 'win32' ? url.toLowerCase() : url);
const uiOrigin = normalize(pathToFileURL(UI_DIR).href);

/** Only the App's own packaged pages may call the bridge. */
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = normalize(event.senderFrame?.url ?? '');
  if (!url.startsWith(uiOrigin + '/')) {
    throw new Error('Rejected IPC call from an untrusted frame');
  }
}

export function registerIpc(handlers: IpcHandlers): void {
  ipcMain.handle(IpcChannel.requestSync, (event) => {
    assertTrustedSender(event);
    return handlers.requestSync();
  });
  ipcMain.handle(IpcChannel.openCalendar, (event) => {
    assertTrustedSender(event);
    return handlers.openCalendar();
  });
  ipcMain.handle(IpcChannel.openSettings, (event) => {
    assertTrustedSender(event);
    handlers.openSettings();
  });
  ipcMain.handle(IpcChannel.readFailures, (event) => {
    assertTrustedSender(event);
    return handlers.readFailures();
  });
}
