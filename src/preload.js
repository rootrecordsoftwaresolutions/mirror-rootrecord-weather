const { contextBridge, ipcRenderer } = require('electron');

const bridge = {
  invoke(channel, payload) {
    return ipcRenderer.invoke(channel, payload);
  }
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('rootRecordBridge', bridge);
} else {
  globalThis.rootRecordBridge = bridge;
}
