// Shapes shared by the main process, preload bridge, and renderer.
// See docs/ARCHITECTURE.md section 9 for the logical operation contracts.

export type SyncRequestResult =
  | { status: 'started' }
  | { status: 'already-running' }
  | { status: 'configuration-required' };

export type OpenCalendarResult =
  | { status: 'opened' }
  | { status: 'not-configured' }
  | { status: 'failed' };

/** A safe, actionable failure shown as red text on the main window. */
export interface AppFailure {
  id: string;
  message: string;
  action: string;
}

/** The only operations the renderer can reach. */
export interface AssistantBridge {
  requestSync(): Promise<SyncRequestResult>;
  openCalendar(): Promise<OpenCalendarResult>;
  openSettings(): Promise<void>;
  readFailures(): Promise<AppFailure[]>;
}

export const IpcChannel = {
  requestSync: 'assistant:request-sync',
  openCalendar: 'assistant:open-calendar',
  openSettings: 'assistant:open-settings',
  readFailures: 'assistant:read-failures',
} as const;
