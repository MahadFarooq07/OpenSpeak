'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const { CH } = require('../shared/channels');

contextBridge.exposeInMainWorld('rec', {
  onWarm: (fn) => ipcRenderer.on(CH.REC_WARM, (_e, p) => fn(p)),
  onStart: (fn) => ipcRenderer.on(CH.REC_START, (_e, p) => fn(p)),
  onStop: (fn) => ipcRenderer.on(CH.REC_STOP, (_e, p) => fn(p)),
  onCancel: (fn) => ipcRenderer.on(CH.REC_CANCEL, (_e, p) => fn(p)),
  onListDevices: (fn) => ipcRenderer.on(CH.REC_LIST_DEVICES, (_e, p) => fn(p)),
  onMonitor: (fn) => ipcRenderer.on(CH.REC_MONITOR, (_e, p) => fn(p)),

  ready: (info) => ipcRenderer.send(CH.REC_READY, info),
  level: (v) => ipcRenderer.send(CH.REC_LEVEL, v),
  data: (payload) => ipcRenderer.send(CH.REC_DATA, payload),
  error: (msg) => ipcRenderer.send(CH.REC_ERROR, msg),
  devices: (list) => ipcRenderer.send(CH.REC_DEVICES, list)
});
