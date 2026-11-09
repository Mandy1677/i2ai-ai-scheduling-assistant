import { contextBridge, ipcRenderer } from 'electron';
import type { AssistantBridge } from '../shared/contracts';

// Sandboxed preloads cannot require local modules, so channel names are
// repeated here; they must match IpcChannel in src/shared/contracts.ts.
const bridge: AssistantBridge = {
  requestSync: () => ipcRenderer.invoke('assistant:request-sync'),
  openCalendar: () => ipcRenderer.invoke('assistant:open-calendar'),
  openSettings: () => ipcRenderer.invoke('assistant:open-settings'),
  readFailures: () => ipcRenderer.invoke('assistant:read-failures'),
  readSettings: () => ipcRenderer.invoke('assistant:read-settings'),
  saveSettings: (input) => ipcRenderer.invoke('assistant:save-settings', input),
  addAccount: (input) => ipcRenderer.invoke('assistant:add-account', input),
  removeAccount: (id) => ipcRenderer.invoke('assistant:remove-account', id),
  connectAccount: (id) => ipcRenderer.invoke('assistant:connect-account', id),
  connectCalendar: () => ipcRenderer.invoke('assistant:connect-calendar'),
  isSyncing: () => ipcRenderer.invoke('assistant:is-syncing'),
};

contextBridge.exposeInMainWorld('assistant', bridge);
contextBridge.exposeInMainWorld('assistantEvents', {
  onFailuresChanged(listener: () => void): void {
    ipcRenderer.on('assistant:failures-changed', () => listener());
  },
  onSyncStateChanged(listener: (running: boolean) => void): void {
    ipcRenderer.on('assistant:sync-state-changed', (_event, running: unknown) => listener(running === true));
  },
});
