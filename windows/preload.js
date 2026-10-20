// Lets the page know it's running in Murmur for Windows (and which version).
const { contextBridge, ipcRenderer } = require('electron');
const v = (process.argv.find(a => a.startsWith('--murmur-version=')) || '').split('=')[1] || '';
contextBridge.exposeInMainWorld('MurmurDesktop', {
    platform: 'windows', version: v,
    // Colours for the window buttons on Murmur's own title bar.
    setFrame: (bg, fg) => ipcRenderer.send('murmur-frame', { bg: String(bg), fg: String(fg) })
});
