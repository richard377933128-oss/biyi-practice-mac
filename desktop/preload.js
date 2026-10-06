const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pteDesktop", {
  isDesktop: true,
  platform: process.platform,
  selectEnglishInput: () => ipcRenderer.invoke("ime-select-english"),
  restoreInputMethod: () => ipcRenderer.invoke("ime-restore"),
  openSystemCamera: () => ipcRenderer.invoke("open-system-camera"),
});
