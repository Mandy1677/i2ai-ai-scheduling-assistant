import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { pathToFileURL } from 'node:url';
import {
  IpcChannel,
  type AppFailure,
  type OpenCalendarResult,
  type PublicSettings,
  type SaveResult,
  type SyncRequestResult,
} from '../shared/contracts';
import { UI_DIR } from './windows';

export interface IpcHandlers {
  requestSync(): SyncRequestResult;
  openCalendar(): Promise<OpenCalendarResult>;
  openSettings(): void;
  readFailures(): AppFailure[];
  readSettings(): PublicSettings;
  // Inputs arrive untrusted from the renderer; handlers validate them.
  saveSettings(input: unknown): SaveResult;
  addAccount(input: unknown): SaveResult;
  removeAccount(id: unknown): SaveResult;
}

const uiOrigin = pathToFileURL(UI_DIR).href;

/** Only the App's own packaged pages may call the bridge. */
function assertTrustedSender(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? '';
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
  ipcMain.handle(IpcChannel.readSettings, (event) => {
    assertTrustedSender(event);
    return handlers.readSettings();
  });
  ipcMain.handle(IpcChannel.saveSettings, (event, input: unknown) => {
    assertTrustedSender(event);
    return handlers.saveSettings(input);
  });
  ipcMain.handle(IpcChannel.addAccount, (event, input: unknown) => {
    assertTrustedSender(event);
    return handlers.addAccount(input);
  });
  ipcMain.handle(IpcChannel.removeAccount, (event, id: unknown) => {
    assertTrustedSender(event);
    return handlers.removeAccount(id);
  });
}
