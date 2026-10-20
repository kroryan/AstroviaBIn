'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/** The only bridge between the setup page and the app: no Node access in the page itself. */
contextBridge.exposeInMainWorld('astroviabin', {
  state: () => ipcRenderer.invoke('state'),
  pick: request => ipcRenderer.invoke('pick', request),
  check: values => ipcRenderer.invoke('check', values),
  save: values => ipcRenderer.invoke('save', values),
  close: () => ipcRenderer.invoke('close'),
  openExternal: target => ipcRenderer.invoke('open-external', target),
  onStatus: callback => ipcRenderer.on('server-status', (_event, status) => callback(status)),
});
