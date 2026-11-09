import { BrowserWindow } from 'electron';
import path from 'node:path';

type WindowName = 'main' | 'settings';

const PAGES: Record<WindowName, { file: string; title: string; width: number; height: number }> = {
  main: { file: 'main.html', title: 'AI Scheduling Assistant', width: 420, height: 320 },
  settings: { file: 'settings.html', title: 'Settings', width: 560, height: 640 },
};

export const UI_DIR = path.join(__dirname, '..', 'ui');

/**
 * Owns the App windows. Closing a window only hides it; the process keeps
 * running in the tray until the user chooses Exit.
 */
export class WindowManager {
  private readonly windows = new Map<WindowName, BrowserWindow>();
  private quitting = false;

  markQuitting(): void {
    this.quitting = true;
  }

  show(name: WindowName): void {
    const existing = this.windows.get(name);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return;
    }
    this.windows.set(name, this.create(name));
  }

  /** Re-renders the main window so it picks up new failure state. */
  refreshMain(): void {
    const win = this.windows.get('main');
    if (win && !win.isDestroyed()) win.webContents.send('assistant:failures-changed');
  }

  private create(name: WindowName): BrowserWindow {
    const page = PAGES[name];
    const win = new BrowserWindow({
      title: page.title,
      width: page.width,
      height: page.height,
      minWidth: 360,
      minHeight: 260,
      backgroundColor: '#F6F7F9',
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    win.on('close', (event) => {
      if (this.quitting) return;
      event.preventDefault();
      win.hide();
    });
    win.once('ready-to-show', () => win.show());

    // The App has no reason to navigate or open windows from its own pages.
    win.webContents.on('will-navigate', (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

    void win.loadFile(path.join(UI_DIR, page.file));
    return win;
  }
}
