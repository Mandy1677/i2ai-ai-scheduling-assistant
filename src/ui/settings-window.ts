// Renderer for the Settings window. Plain script: no imports, Node is unavailable.
(() => {
  type Settings = import('../shared/contracts').PublicSettings;
  type Result = import('../shared/contracts').SaveResult;
  type Errors = import('../shared/contracts').FieldErrors;

  const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

  const accountList = byId<HTMLUListElement>('account-list');
  const accountForm = byId<HTMLFormElement>('add-account-form');
  const addressInput = byId<HTMLInputElement>('account-address');
  const providerSelect = byId<HTMLSelectElement>('account-provider');
  const imapFields = byId<HTMLDivElement>('imap-fields');
  const imapHost = byId<HTMLInputElement>('imap-host');
  const imapPort = byId<HTMLInputElement>('imap-port');
  const imapUsername = byId<HTMLInputElement>('imap-username');
  const imapPassword = byId<HTMLInputElement>('imap-password');
  const addAccountButton = byId<HTMLButtonElement>('add-account');
  const calendarStatus = byId<HTMLParagraphElement>('calendar-status');
  const connectCalendarButton = byId<HTMLButtonElement>('connect-calendar');
  const settingsForm = byId<HTMLFormElement>('settings-form');
  const keyInput = byId<HTMLInputElement>('openrouter-key');
  const keyStatus = byId<HTMLParagraphElement>('key-status');
  const modelInput = byId<HTMLInputElement>('openrouter-model');
  const fromDateField = byId<HTMLDivElement>('from-date-field');
  const fromDateInput = byId<HTMLInputElement>('from-date');
  const saveButton = byId<HTMLButtonElement>('save-settings');
  const saveStatus = byId<HTMLSpanElement>('save-status');
  const rangeInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="range"]'));

  const PROVIDER_LABELS: Record<string, string> = {
    gmail: 'Gmail',
    microsoft: 'Microsoft / Outlook',
    imap: 'IMAP',
  };
  const STATE_LABELS: Record<string, string> = {
    'not-connected': 'Not connected',
    connected: 'Connected',
    'needs-reconnect': 'Needs reconnecting',
  };

  /** Shows errors next to their fields; fields not in `errors` are cleared. */
  function showErrors(errors: Errors, fields: string[]): void {
    for (const field of fields) {
      const el = document.getElementById(`err-${field}`);
      if (!el) continue;
      el.textContent = errors[field] ?? '';
      el.hidden = !errors[field];
    }
    const first = fields.find((field) => errors[field]);
    const input = first ? document.querySelector<HTMLElement>(`[aria-describedby~="err-${first}"]`) : null;
    input?.focus();
  }

  function renderAccounts(settings: Settings): void {
    if (settings.accounts.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'hint';
      empty.textContent = 'No email accounts added yet.';
      accountList.replaceChildren(empty);
      return;
    }
    accountList.replaceChildren(
      ...settings.accounts.map((account) => {
        const item = document.createElement('li');
        item.className = 'account';
        const details = document.createElement('div');
        const address = document.createElement('strong');
        address.textContent = account.address;
        const meta = document.createElement('span');
        meta.className = 'hint';
        const server = account.imap ? ` · ${account.imap.host}:${account.imap.port}` : '';
        meta.textContent = `${PROVIDER_LABELS[account.provider]}${server} · ${STATE_LABELS[account.connectionState]}`;
        details.append(address, meta);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Remove';
        remove.setAttribute('aria-label', `Remove ${account.address}`);
        remove.addEventListener('click', async () => {
          // Two-step confirmation instead of a popup dialog.
          if (remove.dataset.confirm !== 'yes') {
            remove.dataset.confirm = 'yes';
            remove.textContent = 'Confirm remove';
            return;
          }
          remove.disabled = true;
          const result = await window.assistant.removeAccount(account.id);
          handleResult(result, ['account']);
        });
        const actions = document.createElement('div');
        actions.className = 'account-actions';
        if (account.provider === 'gmail') actions.append(connectButton(account));
        actions.append(remove);
        item.append(details, actions);
        return item;
      }),
    );
  }

  function connectButton(account: Settings['accounts'][number]): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    const label = account.connectionState === 'not-connected' ? 'Connect' : 'Reconnect';
    button.textContent = label;
    button.setAttribute('aria-label', `${label} ${account.address}`);
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'Waiting for Google sign-in…';
      try {
        const result = await window.assistant.connectAccount(account.id);
        if (result.status !== 'busy') render(result.settings);
      } finally {
        button.disabled = false;
        button.textContent = label;
      }
    });
    return button;
  }

  function render(settings: Settings): void {
    renderAccounts(settings);

    calendarStatus.textContent = settings.calendar
      ? `Connected: ${settings.calendar.calendarName} (${settings.calendar.googleAccount})`
      : 'Not connected.';
    connectCalendarButton.textContent = settings.calendar ? 'Reconnect Google Calendar' : 'Connect Google Calendar';

    keyInput.value = '';
    keyInput.placeholder = settings.openRouter.keyConfigured ? 'Saved key will be kept' : '';
    keyStatus.textContent = settings.openRouter.keyConfigured
      ? 'A key is saved. Leave this blank to keep it, or enter a new key to replace it.'
      : settings.secureStorageAvailable
        ? 'No key saved yet.'
        : 'Secure storage is unavailable on this computer, so a key cannot be saved.';
    modelInput.value = settings.openRouter.model;

    for (const input of rangeInputs) input.checked = input.value === settings.historyRange?.mode;
    fromDateInput.value = settings.historyRange?.fromDate ?? '';
    updateRangeVisibility();
  }

  function handleResult(result: Result, fields: string[]): boolean {
    if (result.status === 'invalid') {
      showErrors(result.fieldErrors, fields);
      return false;
    }
    showErrors({}, fields);
    render(result.settings);
    return true;
  }

  function updateRangeVisibility(): void {
    const selected = rangeInputs.find((input) => input.checked)?.value;
    fromDateField.hidden = selected !== 'from-date';
  }

  function updateProviderVisibility(): void {
    imapFields.hidden = providerSelect.value !== 'imap';
  }

  for (const input of rangeInputs) input.addEventListener('change', updateRangeVisibility);
  providerSelect.addEventListener('change', updateProviderVisibility);
  fromDateInput.max = new Date().toISOString().slice(0, 10);

  accountForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (addAccountButton.disabled) return;
    addAccountButton.disabled = true;
    addAccountButton.textContent = 'Adding…';
    try {
      const provider = providerSelect.value as 'gmail' | 'microsoft' | 'imap';
      const result = await window.assistant.addAccount({
        address: addressInput.value,
        provider,
        imap:
          provider === 'imap'
            ? {
                host: imapHost.value,
                port: Number(imapPort.value),
                username: imapUsername.value,
                password: imapPassword.value,
              }
            : undefined,
      });
      const fields = ['address', 'provider', 'imapHost', 'imapPort', 'imapUsername', 'imapPassword'];
      if (handleResult(result, fields)) {
        accountForm.reset();
        updateProviderVisibility();
      }
    } finally {
      imapPassword.value = '';
      addAccountButton.disabled = false;
      addAccountButton.textContent = 'Add account';
    }
  });

  settingsForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saveButton.disabled) return;
    saveButton.disabled = true;
    saveButton.textContent = 'Saving…';
    saveStatus.textContent = '';
    try {
      const mode = rangeInputs.find((input) => input.checked)?.value;
      const result = await window.assistant.saveSettings({
        historyRange: mode
          ? { mode: mode as 'last-30-days' | 'from-date' | 'all-history', fromDate: fromDateInput.value || null }
          : null,
        openRouterModel: modelInput.value,
        openRouterApiKey: keyInput.value || undefined,
      });
      const saved = handleResult(result, ['openRouterApiKey', 'openRouterModel', 'historyRange', 'fromDate']);
      saveStatus.textContent = saved ? 'Saved.' : '';
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = 'Save settings';
    }
  });

  connectCalendarButton.addEventListener('click', async () => {
    const label = connectCalendarButton.textContent ?? 'Connect Google Calendar';
    connectCalendarButton.disabled = true;
    connectCalendarButton.textContent = 'Waiting for Google sign-in…';
    try {
      const result = await window.assistant.connectCalendar();
      if (result.status !== 'busy') render(result.settings);
      else connectCalendarButton.textContent = label;
    } finally {
      connectCalendarButton.disabled = false;
    }
  });

  updateProviderVisibility();
  void window.assistant.readSettings().then(render);
})();
