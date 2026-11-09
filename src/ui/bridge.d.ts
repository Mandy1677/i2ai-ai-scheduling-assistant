// Globals exposed by src/main/preload.ts. Kept as a global declaration so the
// renderer scripts stay plain browser scripts with no module loader.
interface Window {
  assistant: import('../shared/contracts').AssistantBridge;
  assistantEvents: {
    onFailuresChanged(listener: () => void): void;
    onSyncStateChanged(listener: (running: boolean) => void): void;
  };
}
