// Murmur for Windows: the Murmur website in its own window, plus what a music app needs on a computer.
// - Media keys and the Windows media pop-up (cover, play/pause, skip) come from the page's media session.
// - Closing the window quits Murmur completely; while it's open the tray icon has play/pause, next and previous.
// - Built-in ad blocker (same list as the Android app's AdBlock.java), links to other sites open in the browser,
//   and a check for a newer version of this app on start.
const { app, BrowserWindow, Tray, Menu, shell, session, nativeImage, dialog, net, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const HOME = process.env.MURMUR_URL || 'https://rodriguezcurielj.github.io/Murmur/';   // MURMUR_URL: try the app against a test server
const UPDATE_INFO = 'https://rodriguezcurielj.github.io/Murmur/apps/windows.json';
const VERSION = app.getVersion();

app.setAppUserModelId('com.murmur.desktop');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');   // the next song starts by itself

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null, tray = null, quitting = false;
const stateFile = () => path.join(app.getPath('userData'), 'window.json');
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; } };
const saveState = () => {
    if (!win || win.isMinimized()) return;
    try { fs.writeFileSync(stateFile(), JSON.stringify({ ...readState(), bounds: win.getBounds(), max: win.isMaximized() })); } catch {}
};

/* ---- ad blocker ---- */
const AD_HOSTS = ['doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'googletagservices.com',
    'adservice.google.com', 'imasdk.googleapis.com', '2mdn.net', 'googleads.g.doubleclick.net'];
const YT_AD_PATHS = ['/pagead/', '/api/stats/ads', '/ptracking', '/get_midroll_', '/pcs/activeview',
    '/ad_data_204', '/api/stats/atr', '/youtubei/v1/player/ad_break'];
function isAd(u) {
    let url; try { url = new URL(u); } catch { return false; }
    const host = url.hostname.toLowerCase();
    if (AD_HOSTS.some(h => host === h || host.endsWith('.' + h))) return true;
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) return YT_AD_PATHS.some(p => url.pathname.startsWith(p));
    return false;   // the audio itself (googlevideo.com) is never blocked
}

/* ---- which pages stay in the app ---- */
function staysInApp(u) {
    let url; try { url = new URL(u); } catch { return false; }
    if (['blob:', 'data:', 'about:'].includes(url.protocol)) return true;
    if (url.pathname.startsWith('/Murmur/apps')) return false;   // the download page opens in the browser
    const h = url.hostname;
    return h === 'rodriguezcurielj.github.io' || h.endsWith('.ts.net') || h.endsWith('.trycloudflare.com')
        || h === 'accounts.spotify.com' || h === 'localhost' || h === '127.0.0.1';
}

const control = what => { if (win) win.webContents.executeJavaScript(`window.murmurControl && window.murmurControl(${JSON.stringify(what)})`).catch(() => {}); };
function show() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

function createWindow() {
    const st = readState();
    win = new BrowserWindow({
        width: 1280, height: 820, minWidth: 360, minHeight: 520, ...(st.bounds || {}),
        title: 'Murmur', backgroundColor: st.frameBg || '#120f17', autoHideMenuBar: true, show: false,
        // No Windows title bar: the page's top strip is the title bar, and the window buttons sit on it in the theme's colours.
        titleBarStyle: 'hidden', titleBarOverlay: { color: st.frameBg || '#120f17', symbolColor: st.frameFg || '#a798b4', height: 36 },
        icon: path.join(__dirname, 'icon.png'),
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false, additionalArguments: ['--murmur-version=' + VERSION] }
    });
    if (st.max) win.maximize();
    win.once('ready-to-show', () => win.show());
    win.webContents.once('did-finish-load', () => { if (!win.isVisible()) win.show(); });   // ready-to-show doesn't always come with the hidden title bar
    win.loadURL(HOME);

    win.webContents.setWindowOpenHandler(({ url }) => {
        if (staysInApp(url)) { win.loadURL(url); return { action: 'deny' }; }
        shell.openExternal(url); return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => { if (!staysInApp(url)) { e.preventDefault(); shell.openExternal(url); } });
    win.on('page-title-updated', e => e.preventDefault());   // keep "Murmur" in the title bar

    for (const ev of ['resize', 'move']) win.on(ev, () => { clearTimeout(win._t); win._t = setTimeout(saveState, 400); });
    // Closing the window quits Murmur completely (music stops, tray icon goes away).
    win.on('close', () => { saveState(); quitting = true; });
}

function createTray() {
    const img = nativeImage.createFromPath(path.join(__dirname, 'icon.png')).resize({ width: 16, height: 16 });
    tray = new Tray(img);
    tray.setToolTip('Murmur');
    tray.setContextMenu(Menu.buildFromTemplate([
        { label: 'Open Murmur', click: show },
        { type: 'separator' },
        { label: 'Play / Pause', click: () => control('toggle') },
        { label: 'Next', click: () => control('next') },
        { label: 'Previous', click: () => control('prev') },
        { label: 'Like', click: () => control('like') },
        { type: 'separator' },
        { label: 'Quit Murmur', click: () => { quitting = true; app.quit(); } }
    ]));
    tray.on('click', show);
}

// Taskbar buttons under the window's preview: previous / play-pause / next.
function thumbButtons() {
    if (!win || process.platform !== 'win32') return;
    // Small white icons drawn pixel by pixel (Windows can't use SVG here). Shapes are polygons on a 24x24 grid.
    const icon = polys => {
        const N = 32, k = 24 / N, buf = Buffer.alloc(N * N * 4);
        const inside = (x, y, p) => { let c = false; for (let a = 0, b = p.length - 1; a < p.length; b = a++) { const [xa, ya] = p[a], [xb, yb] = p[b]; if ((ya > y) !== (yb > y) && x < (xb - xa) * (y - ya) / (yb - ya) + xa) c = !c; } return c; };
        for (let py = 0; py < N; py++) for (let px = 0; px < N; px++) {
            let hits = 0;   // 4x4 samples per pixel for smooth edges
            for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) { const x = (px + (sx + .5) / 4) * k, y = (py + (sy + .5) / 4) * k; if (polys.some(p => inside(x, y, p))) hits++; }
            const o = (py * N + px) * 4, a = Math.round(hits / 16 * 255);
            buf[o] = buf[o + 1] = buf[o + 2] = 255; buf[o + 3] = a;
        }
        return nativeImage.createFromBitmap(buf, { width: N, height: N });
    };
    const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
    const PREV = [rect(6, 6, 2, 12), [[9.5, 12], [18, 6], [18, 18]]], PLAY = [[[8, 5], [19, 12], [8, 19]]], NEXT = [[[6, 6], [14.5, 12], [6, 18]], rect(16, 6, 2, 12)];
    try {
        win.setThumbarButtons([
            { tooltip: 'Previous', icon: icon(PREV), click: () => control('prev') },
            { tooltip: 'Play / Pause', icon: icon(PLAY), click: () => control('toggle') },
            { tooltip: 'Next', icon: icon(NEXT), click: () => control('next') }
        ]);
    } catch {}
}

// A newer Murmur for Windows: say so once a day, and open the download.
async function checkUpdate() {
    try {
        const r = await net.fetch(UPDATE_INFO + '?t=' + Date.now());
        if (!r.ok) return;
        const info = await r.json();
        const num = v => String(v).split('.').map(n => parseInt(n, 10) || 0).reduce((a, n, i) => a + n / Math.pow(1000, i), 0);
        if (!info.version || num(info.version) <= num(VERSION)) return;
        const st = readState();
        if (st.askedUpdate === info.version && Date.now() - (st.askedAt || 0) < 86400e3) return;
        try { fs.writeFileSync(stateFile(), JSON.stringify({ ...st, askedUpdate: info.version, askedAt: Date.now() })); } catch {}
        const { response } = await dialog.showMessageBox(win, {
            type: 'info', buttons: ['Update now', 'Later'], defaultId: 0, cancelId: 1,
            title: 'New Murmur update available',
            message: `Murmur ${info.version} for Windows is out.`,
            detail: (info.notes ? info.notes + '\n\n' : '') + 'Update now downloads the installer. Run it and Murmur updates itself; your music and sign-in stay.'
        });
        if (response === 0 && info.url) shell.openExternal(info.url);
    } catch {}
}

// The page sends its theme colours (background, icon colour) for the window buttons.
ipcMain.on('murmur-frame', (e, c) => {
    const hex = v => /^#[0-9a-f]{6}$/i.test(String(v)) ? String(v) : null;
    const bg = hex(c && c.bg), fg = hex(c && c.fg);
    if (!win || !bg || !fg) return;
    try { win.setTitleBarOverlay({ color: bg, symbolColor: fg }); win.setBackgroundColor(bg); } catch {}
    const st = readState();
    if (st.frameBg !== bg || st.frameFg !== fg) try { fs.writeFileSync(stateFile(), JSON.stringify({ ...st, frameBg: bg, frameFg: fg })); } catch {}
});
app.on('second-instance', show);
app.on('before-quit', () => { quitting = true; });
app.whenReady().then(() => {
    session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: isAd(d.url) }));
    createWindow();
    createTray();
    win.once('show', thumbButtons);
    setTimeout(checkUpdate, 8000);
});
app.on('window-all-closed', () => app.quit());
