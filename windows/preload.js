// Lets the page know it's running in Murmur for Windows (and which version).
const { contextBridge, ipcRenderer } = require('electron');
const v = (process.argv.find(a => a.startsWith('--murmur-version=')) || '').split('=')[1] || '';
contextBridge.exposeInMainWorld('MurmurDesktop', {
    platform: 'windows', version: v,
    // Colours for the window buttons on Murmur's own title bar.
    setFrame: (bg, fg) => ipcRenderer.send('murmur-frame', { bg: String(bg), fg: String(fg) }),
    // App updates: { state: 'none' | 'downloading' (pct 0..1) | 'ready' | 'error', version, notes }
    onUpdate: cb => { ipcRenderer.on('murmur-update', (e, u) => cb(u)); ipcRenderer.invoke('murmur-update-state').then(cb).catch(() => {}); },
    installUpdate: () => ipcRenderer.send('murmur-update-install')
});
