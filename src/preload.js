'use strict';

// The only bridge between the UI and the main process. Keep this list small and explicit.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('tidy', {
  getState: invoke('state:get'),
  updateSettings: invoke('settings:update'),
  resetSettings: invoke('settings:reset'),
  scan: invoke('scan'),
  getScan: invoke('scan:get'),
  organize: invoke('organize'),
  getHistory: invoke('history:get'),
  undo: invoke('history:undo'),
  undoLast: invoke('history:undoLast'),
  findStale: invoke('cleanup:stale'),
  findDuplicates: invoke('cleanup:duplicates'),
  applyCleanup: invoke('cleanup:apply'),
  emptyHolding: invoke('holding:empty'),
  openTrash: invoke('file:openTrash'),
  addFolder: invoke('folders:add'),
  updateFolder: invoke('folders:update'),
  removeFolder: invoke('folders:remove'),
  suggestFolders: invoke('folders:suggest'),
  applySuggestion: invoke('suggestions:apply'),
  dismissSuggestion: invoke('suggestions:dismiss'),
  exportRules: invoke('config:export'),
  pickImport: invoke('config:importPick'),
  applyImport: invoke('config:importApply'),
  pickSyncFolder: invoke('sync:pick'),
  setSync: invoke('sync:set'),
  markWhatsNewSeen: invoke('whatsnew:seen'),
  exportLedger: invoke('ledger:export'),
  find: invoke('find:run'),
  gather: invoke('find:gather'),
  preview: invoke('find:preview'),
  startDrag: (p) => ipcRenderer.send('find:drag', p),
  addToShelf: invoke('find:toShelf'),
  checkUpdate: invoke('update:check'),
  installUpdate: invoke('update:install'),
  laterUpdate: invoke('update:later'),
  skipUpdate: invoke('update:skip'),
  openUpdateNotes: invoke('update:notes'),
  onUpdateShow: (fn) => ipcRenderer.on('update:show', () => fn()),
  onUpdateProgress: (fn) => ipcRenderer.on('update:progress', (_e, p) => fn(p)),
  clearLedger: invoke('ledger:clear'),
  onSyncApplied: (fn) => ipcRenderer.on('sync:applied', (_e, summary) => fn(summary)),
  clearHistory: invoke('history:clear'),
  testRule: invoke('rule:test'),
  fileIcon: invoke('file:icon'),
  reveal: invoke('file:reveal'),
  openPath: invoke('file:open'),
  pickFolder: invoke('dialog:pickFolder'),
  onStateChanged: (fn) => {
    const handler = (_e, payload) => fn(payload);
    ipcRenderer.on('state:changed', handler);
    return () => ipcRenderer.removeListener('state:changed', handler);
  },
  onMenuUndo: (fn) => ipcRenderer.on('menu:undo', () => fn()),
  onMenuTour: (fn) => ipcRenderer.on('menu:tour', () => fn()),
  onNavigate: (fn) => ipcRenderer.on('navigate', (_e, page) => fn(page)),
});
