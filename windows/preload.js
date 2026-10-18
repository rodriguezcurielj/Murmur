// Lets the page know it's running in Murmur for Windows (and which version).
const { contextBridge } = require('electron');
const v = (process.argv.find(a => a.startsWith('--murmur-version=')) || '').split('=')[1] || '';
contextBridge.exposeInMainWorld('MurmurDesktop', { platform: 'windows', version: v });
