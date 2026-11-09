// Renderer for the main window. Plain script: no imports, Node is unavailable.
(() => {
  const openCalendarButton = document.getElementById('open-calendar') as HTMLButtonElement;
  const syncButton = document.getElementById('sync-now') as HTMLButtonElement;
  const settingsButton = document.getElementById('settings') as HTMLButtonElement;
  const warnings = document.getElementById('warnings') as HTMLDivElement;

  async function renderFailures(): Promise<void> {
    const failures = await window.assistant.readFailures();
    warnings.replaceChildren(
      ...failures.map((failure) => {
        const item = document.createElement('div');
        item.className = 'warning';
        const message = document.createElement('strong');
        message.textContent = failure.message;
        item.append(message, ' ', failure.action);
        return item;
      }),
    );
  }

  openCalendarButton.addEventListener('click', async () => {
    await window.assistant.openCalendar();
    await renderFailures();
  });

  // Busy for the whole run, whether it was started here, by the timer, or from the tray.
  function setSyncing(running: boolean): void {
    syncButton.disabled = running;
    syncButton.textContent = running ? 'Syncing…' : 'Sync now';
  }

  syncButton.addEventListener('click', async () => {
    const result = await window.assistant.requestSync();
    if (result.status !== 'configuration-required') setSyncing(true);
    await renderFailures();
  });

  settingsButton.addEventListener('click', () => {
    void window.assistant.openSettings();
  });

  window.assistantEvents.onFailuresChanged(() => void renderFailures());
  window.assistantEvents.onSyncStateChanged(setSyncing);
  void window.assistant.isSyncing().then(setSyncing);
  void renderFailures();
})();
