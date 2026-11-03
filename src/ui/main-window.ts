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

  syncButton.addEventListener('click', async () => {
    syncButton.disabled = true;
    syncButton.textContent = 'Syncing…';
    try {
      await window.assistant.requestSync();
    } finally {
      syncButton.disabled = false;
      syncButton.textContent = 'Sync now';
      await renderFailures();
    }
  });

  settingsButton.addEventListener('click', () => {
    void window.assistant.openSettings();
  });

  window.assistantEvents.onFailuresChanged(() => void renderFailures());
  void renderFailures();
})();
