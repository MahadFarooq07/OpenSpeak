'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { CH } = require('../shared/channels');

contextBridge.exposeInMainWorld('pill', {
  onState: (fn) => ipcRenderer.on(CH.OVL_STATE, (_e, p) => fn(p)),
  onLevel: (fn) => ipcRenderer.on(CH.OVL_LEVEL, (_e, v) => fn(v)),
  cancel: () => ipcRenderer.send(CH.OVL_CANCEL),
  openHub: () => ipcRenderer.send(CH.OVL_OPEN_HUB)
});
