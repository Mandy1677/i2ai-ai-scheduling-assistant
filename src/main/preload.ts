import { contextBridge, ipcRenderer } from 'electron';
import type { AssistantBridge } from '../shared/contracts';

// Sandboxed preloads cannot require local modules, so channel names are
// repeated here; they must match IpcChannel in src/shared/contracts.ts.
const bridge: AssistantBridge = {
  requestSync: () => ipcRenderer.invoke('assistant:request-sync'),
  openCalendar: () => ipcRenderer.invoke('assistant:open-calendar'),
  openSettings: () => ipcRenderer.invoke('assistant:open-settings'),
  readFailures: () => ipcRenderer.invoke('assistant:read-failures'),
};

contextBridge.exposeInMainWorld('assistant', bridge);
contextBridge.exposeInMainWorld('assistantEvents', {
  onFailuresChanged(listener: () => void): void {
    ipcRenderer.on('assistant:failures-changed', () => listener());
  },
});
