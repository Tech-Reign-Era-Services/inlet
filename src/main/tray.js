'use strict';

const path = require('path');
const { Tray, Menu, nativeImage } = require('electron');

function iconPath() {
  // build/ ships with the app (see package.json "files"); in dev it's the repo's build/ folder.
  return path.join(__dirname, '..', '..', 'build', 'trayTemplate.png');
}

class TrayController {
  /** actions: { getSettings, getUnsorted, getUndoable, setMode, tidyNow, undoLast, show, quit } */
  constructor(actions) {
    this.actions = actions;
    const image = nativeImage.createFromPath(iconPath());
    image.setTemplateImage(true);
    this.tray = new Tray(image);
    this.tray.setToolTip('Inlet');
    this.refresh();
  }

  refresh() {
    const { mode } = this.actions.getSettings();
    const unsorted = this.actions.getUnsorted();
    const undoable = this.actions.getUndoable();
    const undoWhat = { auto: 'Auto-Sort', scheduled: 'Scheduled Tidy', cleanup: 'Cleanup', gather: 'Gather' };
    const auto = mode === 'auto';
    this.tray.setTitle(!auto && unsorted > 0 ? ` ${unsorted}` : '', { fontType: 'monospacedDigit' });
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: auto ? 'Auto mode — sorting new downloads' : `Manual mode — ${unsorted || 'no'} unsorted file${unsorted === 1 ? '' : 's'}`, enabled: false },
      { type: 'separator' },
      { label: 'Tidy Now', accelerator: 'Command+T', enabled: unsorted > 0, click: () => this.actions.tidyNow() },
      {
        label: undoable ? `Undo Last ${undoWhat[undoable.trigger] || 'Tidy'} (${undoable.count} file${undoable.count === 1 ? '' : 's'})` : 'Undo Last Tidy',
        enabled: !!undoable,
        click: () => this.actions.undoLast(),
      },
      { label: 'Auto Mode', type: 'checkbox', checked: auto, click: (item) => this.actions.setMode(item.checked ? 'auto' : 'manual') },
      { type: 'separator' },
      { label: 'Open Inlet…', click: () => this.actions.show('overview') },
      { label: 'Clean Up…', click: () => this.actions.show('cleanup') },
      { label: 'Activity…', click: () => this.actions.show('activity') },
      { label: 'Settings…', accelerator: 'Command+,', click: () => this.actions.show('settings') },
      { type: 'separator' },
      { label: 'Quit Inlet', accelerator: 'Command+Q', click: () => this.actions.quit() },
    ]));
  }
}

module.exports = { TrayController };
