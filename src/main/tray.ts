import { Menu, Tray, nativeImage } from 'electron';
import path from 'node:path';

export interface TrayActions {
  openApp(): void;
  syncNow(): void;
  exit(): void;
}

export function createTray(actions: TrayActions): Tray {
  const icon = nativeImage
    .createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'))
    .resize({ width: 16, height: 16 });
  const tray = new Tray(icon);
  tray.setToolTip('AI Scheduling Assistant');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open App', click: actions.openApp },
      { label: 'Sync now', click: actions.syncNow },
      { type: 'separator' },
      { label: 'Exit', click: actions.exit },
    ]),
  );
  // Left-click on Windows conventionally reopens the App.
  tray.on('click', actions.openApp);
  return tray;
}
