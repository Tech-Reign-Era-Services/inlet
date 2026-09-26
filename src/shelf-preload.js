'use strict';

// The Shelf window's only bridge to the main process. It can act on Shelf items by id, nothing else.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);
const listen = (channel) => (fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload));

contextBridge.exposeInMainWorld('shelf', {
  items: invoke('shelf:items'),
  addFiles: invoke('shelf:addFiles'),
  addText: invoke('shelf:addText'),
  paste: invoke('shelf:paste'),
  remove: invoke('shelf:remove'),
  clear: invoke('shelf:clear'),
  copy: invoke('shelf:copy'),
  open: invoke('shelf:open'),
  reveal: invoke('shelf:reveal'),
  preview: invoke('shelf:preview'),
  closePreview: invoke('shelf:closePreview'),
  focus: invoke('shelf:focus'),
  icon: invoke('shelf:icon'),
  setState: (state) => ipcRenderer.send('shelf:setState', state),
  drag: (ids) => ipcRenderer.send('shelf:drag', ids),
  // Dropped files carry no path in a sandboxed page; this asks Electron for it.
  pathFor: (file) => webUtils.getPathForFile(file),
  onState: listen('shelf:state'),
  onItems: listen('shelf:items'),
  onFlash: listen('shelf:flash'),
});
