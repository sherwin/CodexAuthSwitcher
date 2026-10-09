const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('authSwitcher', Object.freeze({
    call: (action, input) => ipcRenderer.invoke('proxy-call', action, input),
    chooseDirectory: () => ipcRenderer.invoke('choose-directory'),
    curlCommand: (action, target, stream) => ipcRenderer.invoke('curl-command', action, target, stream),
    networkSettings: input => ipcRenderer.invoke('network-settings', input)
}));
