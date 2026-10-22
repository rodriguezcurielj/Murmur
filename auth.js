// Murmur sign-in: one owner plus people the owner adds, each with a name and a 4-digit PIN.
// Each person can add an email; a forgotten PIN is reset with a link sent there (see mail.js).
// PINs are stored as salted scrypt hashes. Sessions are random tokens kept in an
// HttpOnly cookie; only a SHA-256 of each token is saved on disk.
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;

const HOUR = 3600e3, DAY = 24 * HOUR;
const REMEMBER_MS = 90 * DAY;   // "Remember this computer"
const SESSION_MS = 12 * HOUR;   // everyone else
const COOKIE = 'murmur_session';

module.exports = function createAuth(file, opts = {}) {
  // Sites (like the GitHub Pages copy) that may use this server from another address.
  const allowedOrigins = new Set((opts.allowedOrigins || []).map(o => o.replace(/\/+$/, '')));
  let db = { users: [], sessions: [] };
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  db.users = db.users || []; db.sessions = db.sessions || [];

  let saving = Promise.resolve();
  function save() {
    const data = JSON.stringify(db, null, 2);
    saving = saving.then(async () => { await fsp.writeFile(file + '.tmp', data, { mode: 0o600 }); await fsp.rename(file + '.tmp', file); })
      .catch(err => console.error('Could not save auth.json:', err));
    return saving;
  }
  function prune() {
    const now = Date.now(), before = db.sessions.length;
    db.sessions = db.sessions.filter(s => s.expiresAt > now && db.users.some(u => u.id === s.userId));
    if (db.sessions.length !== before) save();
  }
  prune(); setInterval(() => { prune(); pruneFails(); }, HOUR).unref();

  const id = (n = 8) => crypto.randomBytes(n).toString('hex');
  const sha = s => crypto.createHash('sha256').update(s).digest('hex');
  const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
  const validPin = p => typeof p === 'string' && /^\d{4}$/.test(p);
  const cleanName = n => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const findByName = n => db.users.find(u => u.name.toLowerCase() === cleanName(n).toLowerCase());
  const canEdit = u => u.role === 'owner' || !!u.canEdit;
  // '' = no email. Anything else must look like an address.
  const cleanEmail = e => String(e || '').trim().toLowerCase().slice(0, 200);
  const emailOk = e => e === '' || /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(e);
  const DUMMY_SALT = id(16);

  function checkPin(user, pin) {
    // Hash even when the name is unknown, so timing doesn't reveal which names exist.
    const got = Buffer.from(hashPin(pin, user ? user.salt : DUMMY_SALT), 'hex');
    const want = Buffer.from(user ? user.pinHash : '0'.repeat(64), 'hex');
    return !!user && crypto.timingSafeEqual(got, want);
  }
  function setPin(user, pin) { user.salt = id(16); user.pinHash = hashPin(pin, user.salt); }

  /* --- brute-force protection: 5 wrong PINs locks that name and that address, doubling up to 15 min --- */
  const fails = new Map();
  // Forget wrong-PIN records once their lock is long over, so random names can't fill memory.
  function pruneFails() { const now = Date.now(); for (const [k, f] of fails) if (f.until < now - DAY && (f.n < 5 || f.until)) fails.delete(k); if (fails.size > 50000) fails.clear(); }
  const waitFor = key => { const f = fails.get(key); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; };
  function fail(key) {
    const f = fails.get(key) || { n: 0, until: 0 };
    f.n++;
    if (f.n >= 5) f.until = Date.now() + Math.min(15, 2 ** (f.n - 5)) * 60e3;
    fails.set(key, f);
  }

  /* --- cookies & sessions --- */
  function readToken(req) {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) return h.slice(7).trim() || null;
    const m = (req.headers.cookie || '').split(/;\s*/).map(c => c.split('=')).find(([k]) => k === COOKIE);
    return m ? decodeURIComponent(m.slice(1).join('=')) : null;
  }
  // True when the request comes from the player hosted on another site (e.g. GitHub Pages).
  function crossSite(req) {
    const o = req.headers.origin;
    if (!o) return false;
    try { return new URL(o).host !== req.headers.host; } catch { return true; }
  }
  function secure(req) { return req.secure || req.headers['x-forwarded-proto'] === 'https'; }
  function setCookie(req, res, token, maxAgeMs) {
    const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
    if (maxAgeMs != null) parts.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
    if (secure(req)) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }
  function deviceName(ua = '') {
    const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const o = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'a device';
    return `${b} on ${o}`;
  }
  function startSession(req, res, user) {
    const token = crypto.randomBytes(32).toString('base64url'), now = Date.now();
    const s = { id: id(6), tokenHash: sha(token), mediaKey: id(16), userId: user.id, createdAt: now, expiresAt: now + SESSION_MS, remember: false, device: deviceName(req.headers['user-agent']), lastSeen: now };
    db.sessions.push(s); save();
    if (!crossSite(req)) setCookie(req, res, token);   // session cookie: gone when the browser closes
    return { session: s, token };
  }
  function current(req, mediaKey) {
    let s;
    if (mediaKey) s = db.sessions.find(x => x.mediaKey && x.mediaKey === mediaKey);
    else { const token = readToken(req); if (!token) return null; const h = sha(token); s = db.sessions.find(x => x.tokenHash === h); }
    if (!s) return null;
    if (s.expiresAt <= Date.now()) { db.sessions = db.sessions.filter(x => x !== s); save(); return null; }
    const u = db.users.find(x => x.id === s.userId); if (!u) return null;
    if (Date.now() - s.lastSeen > 60e3) { s.lastSeen = Date.now(); save(); }
    return { user: u, session: s, token: mediaKey ? null : readToken(req) };
  }
  const publicUser = (u, s) => ({ id: u.id, name: u.name, role: u.role, canEdit: canEdit(u), avatar: u.avatar || '', email: u.email || '', expiresAt: s ? s.expiresAt : null, remembered: s ? s.remember : false });
  // A player on another site can't use our cookie, so it gets the token, plus a read-only key for audio and cover URLs.
  const creds = (req, s, token) => crossSite(req) ? { token, mediaKey: s.mediaKey } : {};
  const personView = (u, s) => ({ id: u.id, name: u.name, role: u.role, canEdit: canEdit(u), avatar: u.avatar || '', email: u.email || '', createdAt: u.createdAt, storageMB: u.storageMB || 0,
    sessions: db.sessions.filter(x => x.userId === u.id).map(x => ({ id: x.id, device: x.device, createdAt: x.createdAt, expiresAt: x.expiresAt, remember: x.remember, lastSeen: x.lastSeen, current: !!s && x.id === s.id })) });

  /* --- middleware --- */
  const PUBLIC = new Set(['/auth/status', '/auth/login', '/auth/setup', '/auth/forgot', '/auth/reset', '/health']);
  function cors(req, res, next) {
    const o = (req.headers.origin || '').replace(/\/+$/, '');
    if (o && allowedOrigins.has(o)) {
      res.setHeader('Access-Control-Allow-Origin', o);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Range');
        res.setHeader('Access-Control-Max-Age', '600');
        if (req.headers['access-control-request-private-network']) res.setHeader('Access-Control-Allow-Private-Network', 'true');
        return res.status(204).end();
      }
    }
    next();
  }
  function sameOrigin(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const o = (req.headers.origin || '').replace(/\/+$/, '');
    if (o && crossSite(req) && !allowedOrigins.has(o)) return res.status(403).json({ error: 'Blocked a request from another website.' });
    next();
  }
  function requireUser(req, res, next) {
    // /api/sync/... is for other Murmur servers; each of those routes checks the shared sync key itself.
    if (PUBLIC.has(req.path) || req.path.startsWith('/sync/') || req.path.startsWith('/auth/invite/')) return next();   // sign-up links work before signing in
    const a = current(req);
    if (!a) return res.status(401).json({ error: 'Please sign in.' });
    req.user = a.user; req.session = a.session; req.token = a.token;
    next();
  }
  function requireUserFiles(req, res, next) {
    const a = (typeof req.query.k === 'string' && current(req, req.query.k)) || current(req);
    if (!a) return res.status(401).type('text').send('Please sign in.');
    next();
  }
  function requireEdit(req, res, next) {
    if (!canEdit(req.user)) return res.status(403).json({ error: 'Your account can listen and download, but not add, edit or delete music. Ask the owner to allow it.' });
    next();
  }
  function requireOwner(req, res, next) {
    if (req.user.role !== 'owner') return res.status(403).json({ error: 'Only the owner can do that.' });
    next();
  }

  /* --- routes --- */
  function routes(app) {
    app.get('/api/auth/status', (req, res) => {
      const a = current(req);
      res.json({ setup: db.users.some(u => u.role === 'owner'), user: a ? { ...publicUser(a.user, a.session), ...(crossSite(req) ? { mediaKey: a.session.mediaKey } : {}) } : null });
    });

    app.post('/api/auth/setup', (req, res) => {
      if (db.users.some(u => u.role === 'owner')) return res.status(409).json({ error: 'Murmur is already set up. Sign in instead.' });
      const name = cleanName(req.body && req.body.name), pin = req.body && req.body.pin;
      if (!name) return res.status(400).json({ error: 'Enter your name.' });
      if (!validPin(pin)) return res.status(400).json({ error: 'Your PIN must be exactly 4 digits.' });
      const email = cleanEmail(req.body && req.body.email);
      if (!emailOk(email)) return res.status(400).json({ error: 'That email address doesn’t look right.' });
      const u = { id: id(), name, role: 'owner', canEdit: true, createdAt: Date.now(), ...(email ? { email } : {}) };
      setPin(u, pin); db.users.push(u);
      const { session: s, token } = startSession(req, res, u);
      console.log(`Owner account created for ${name}`);
      res.json({ user: publicUser(u, s), ...creds(req, s, token) });
    });

    app.post('/api/auth/login', (req, res) => {
      const name = cleanName(req.body && req.body.name), pin = String((req.body && req.body.pin) || '');
      const keys = ['ip:' + req.ip, 'name:' + name.toLowerCase()];
      const wait = Math.max(...keys.map(waitFor));
      if (wait) return res.status(429).json({ error: `Too many wrong PINs. Try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''}.` });
      const u = findByName(name);
      if (!validPin(pin) || !checkPin(u, pin)) {
        keys.forEach(fail);
        return res.status(401).json({ error: 'That name and PIN don’t match.' });
      }
      keys.forEach(k => fails.delete(k));
      const { session: s, token } = startSession(req, res, u);
      res.json({ user: publicUser(u, s), ...creds(req, s, token) });
    });

    app.post('/api/auth/remember', (req, res) => {
      if (req.body && req.body.remember) {
        req.session.remember = true;
        req.session.expiresAt = Date.now() + REMEMBER_MS;
        save();
        if (!crossSite(req)) setCookie(req, res, req.token, REMEMBER_MS);
      }
      res.json({ user: publicUser(req.user, req.session) });
    });

    app.post('/api/auth/logout', (req, res) => {
      db.sessions = db.sessions.filter(s => s !== req.session); save();
      setCookie(req, res, '', 0);
      res.json({ ok: true });
    });

    app.post('/api/me/pin', (req, res) => {
      const { current: cur, pin } = req.body || {};
      const key = 'user:' + req.user.id, wait = waitFor(key);
      if (wait) return res.status(429).json({ error: `Too many wrong PINs. Try again in ${Math.ceil(wait / 60)} minutes.` });
      if (!checkPin(req.user, String(cur || ''))) { fail(key); return res.status(401).json({ error: 'Your current PIN isn’t right.' }); }
      if (!validPin(pin)) return res.status(400).json({ error: 'Your new PIN must be exactly 4 digits.' });
      setPin(req.user, pin);
      db.sessions = db.sessions.filter(s => s.userId !== req.user.id || s.id === req.session.id);   // sign out other devices
      save();
      res.json({ ok: true });
    });

    // Your email, for PIN reset links. '' removes it.
    app.put('/api/me/email', (req, res) => {
      const email = cleanEmail(req.body && req.body.email);
      // Your own email can be changed but not removed: it's how a forgotten PIN gets reset.
      if (!email) return res.status(400).json({ error: 'Enter your email.' });
      if (!emailOk(email)) return res.status(400).json({ error: 'That email address doesn’t look right.' });
      req.user.email = email;
      save();
      res.json({ email: req.user.email || '' });
    });

    // Your profile picture: a small square image (the app shrinks it first) as a data URL, or '' to remove it.
    app.put('/api/me/avatar', (req, res) => {
      const img = String((req.body && req.body.image) || '');
      if (img && (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(img) || img.length > 200000)) return res.status(400).json({ error: 'That picture couldn’t be used. Try a different photo.' });
      if (img) req.user.avatar = img; else delete req.user.avatar;
      save();
      res.json({ avatar: req.user.avatar || '' });
    });

    /* ---- Sign-up links: the owner makes a link, and whoever opens it picks their own name, PIN and email ---- */
    if (!Array.isArray(db.invites)) db.invites = [];
    const liveInvite = t => db.invites.find(i => i.token === t && i.expiresAt > Date.now() && i.uses < i.maxUses);
    const inviteView = i => ({ token: i.token, createdAt: i.createdAt, expiresAt: i.expiresAt, uses: i.uses, maxUses: i.maxUses, canEdit: !!i.canEdit, by: i.byName });
    app.get('/api/invites', requireOwner, (req, res) => res.json({ invites: db.invites.filter(i => i.expiresAt > Date.now() && i.uses < i.maxUses).map(inviteView) }));
    app.post('/api/invites', requireOwner, (req, res) => {
      const b = req.body || {};
      const days = Math.min(30, Math.max(1, Number(b.days) || 7)), maxUses = Math.min(50, Math.max(1, Number(b.uses) || 1));
      db.invites = db.invites.filter(i => i.expiresAt > Date.now() && i.uses < i.maxUses);   // tidy up old ones
      const inv = { token: id(16), createdAt: Date.now(), expiresAt: Date.now() + days * DAY, uses: 0, maxUses, canEdit: !!b.canEdit, by: req.user.id, byName: req.user.name };
      db.invites.push(inv); save();
      res.json({ invite: inviteView(inv) });
    });
    app.delete('/api/invites/:token', requireOwner, (req, res) => { db.invites = db.invites.filter(i => i.token !== req.params.token); save(); res.json({ ok: true }); });
    // Opening the link: is it still good, and who sent it.
    app.get('/api/auth/invite/:token', (req, res) => {
      const i = liveInvite(String(req.params.token || ''));
      if (!i) return res.status(404).json({ error: 'This sign-up link has expired or was already used. Ask for a new one.' });
      res.json({ ok: true, by: i.byName, expiresAt: i.expiresAt });
    });
    // Signing up with it: their own name, PIN and email. They're signed in right away.
    app.post('/api/auth/invite/:token', (req, res) => {
      const key = 'ip:' + req.ip, wait = waitFor(key);
      if (wait) return res.status(429).json({ error: `Too many tries. Try again in ${Math.ceil(wait / 60)} minutes.` });
      const i = liveInvite(String(req.params.token || ''));
      if (!i) { fail(key); return res.status(404).json({ error: 'This sign-up link has expired or was already used. Ask for a new one.' }); }
      const b = req.body || {}, name = cleanName(b.name), pin = b.pin, email = cleanEmail(b.email);
      if (!name) return res.status(400).json({ error: 'Enter your name.' });
      if (findByName(name)) return res.status(409).json({ error: `Someone called ${name} is already on Murmur. Pick a different name (add a last initial).` });
      if (!validPin(pin)) return res.status(400).json({ error: 'Your PIN must be exactly 4 digits.' });
      if (!email) return res.status(400).json({ error: 'Enter your email (it’s how you reset a forgotten PIN).' });
      if (!emailOk(email)) return res.status(400).json({ error: 'That email address doesn’t look right.' });
      const u = { id: id(), name, role: 'member', canEdit: !!i.canEdit, createdAt: Date.now(), email, invitedBy: i.by };
      setPin(u, pin); db.users.push(u); i.uses++;
      const { session: s, token } = startSession(req, res, u);
      console.log(`${name} signed up with a link from ${i.byName}`);
      res.json({ user: publicUser(u, s), ...creds(req, s, token) });
    });

    app.get('/api/users', requireOwner, (req, res) => {
      const order = u => (u.role === 'owner' ? 0 : 1);
      res.json({ users: db.users.slice().sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name)).map(u => personView(u, req.session)) });
    });

    app.post('/api/users', requireOwner, (req, res) => {
      const name = cleanName(req.body && req.body.name), pin = req.body && req.body.pin;
      if (!name) return res.status(400).json({ error: 'Enter a name.' });
      if (findByName(name)) return res.status(409).json({ error: `Someone called ${name} is already on the list. Use a different name.` });
      if (!validPin(pin)) return res.status(400).json({ error: 'The PIN must be exactly 4 digits.' });
      const email = cleanEmail(req.body && req.body.email);
      if (!emailOk(email)) return res.status(400).json({ error: 'That email address doesn’t look right.' });
      const u = { id: id(), name, role: 'member', canEdit: !!(req.body && req.body.canEdit), createdAt: Date.now(), ...(email ? { email } : {}) };
      setPin(u, pin); db.users.push(u); save();
      console.log(`Added ${name}`);
      res.json({ user: personView(u) });
    });

    app.patch('/api/users/:id', requireOwner, (req, res) => {
      const u = db.users.find(x => x.id === req.params.id);
      if (!u) return res.status(404).json({ error: 'That person isn’t on the list anymore.' });
      const b = req.body || {};
      if (b.name != null) {
        const name = cleanName(b.name);
        if (!name) return res.status(400).json({ error: 'Enter a name.' });
        const other = findByName(name);
        if (other && other !== u) return res.status(409).json({ error: `Someone called ${name} is already on the list.` });
        u.name = name;
      }
      if (b.canEdit != null && u.role !== 'owner') u.canEdit = !!b.canEdit;
      if (b.email != null) {
        const email = cleanEmail(b.email);
        if (!emailOk(email)) return res.status(400).json({ error: 'That email address doesn’t look right.' });
        if (email) u.email = email; else delete u.email;
      }
      // How much music they may add (megabytes; 0 = no limit). The owner has no limit.
      if (b.storageMB != null && u.role !== 'owner') {
        const mb = Math.round(Number(b.storageMB));
        if (!(mb >= 0 && mb <= 10e6)) return res.status(400).json({ error: 'Enter a size, or 0 for no limit.' });
        u.storageMB = mb;
      }
      if (b.pin != null) {
        if (!validPin(b.pin)) return res.status(400).json({ error: 'The PIN must be exactly 4 digits.' });
        setPin(u, b.pin);
        db.sessions = db.sessions.filter(s => s.userId !== u.id || s.id === req.session.id);   // new PIN: sign them out
      }
      save();
      res.json({ user: personView(u, req.session) });
    });

    app.delete('/api/users/:id', requireOwner, (req, res) => {
      const u = db.users.find(x => x.id === req.params.id);
      if (!u) return res.status(404).json({ error: 'That person isn’t on the list anymore.' });
      if (u.role === 'owner') return res.status(400).json({ error: 'The owner account can’t be deleted.' });
      db.users = db.users.filter(x => x !== u);
      db.sessions = db.sessions.filter(s => s.userId !== u.id);
      save();
      console.log(`Deleted ${u.name}`);
      res.json({ ok: true });
    });

    /* Forgot PIN: a one-time link (30 minutes) to the person's email. The answer is the same whether or not
       the name exists or has an email, so it can't be used to find out who's on this Murmur. The link is kept
       on the person (as a hash), so it works on any of the synced servers. */
    const asked = new Map();   // name or address -> times asked lately
    app.post('/api/auth/forgot', async (req, res) => {
      const name = cleanName(req.body && req.body.name);
      if (!name) return res.status(400).json({ error: 'Enter your name.' });
      if (!mailer || !mailer.ready()) return res.status(503).json({ error: 'Email isn’t set up on this Murmur yet. Ask the person who runs it to reset your PIN.' });
      const now = Date.now();
      for (const [k, v] of asked) if (v.at < now - HOUR) asked.delete(k);
      const keys = ['ip:' + req.ip, 'name:' + name.toLowerCase()];
      if (keys.some(k => (asked.get(k) || { n: 0 }).n >= 3)) return res.status(429).json({ error: 'Too many reset emails. Try again in an hour.' });
      keys.forEach(k => { const v = asked.get(k) || { n: 0, at: now }; v.n++; asked.set(k, v); });
      // Where the link opens: the page that asked, if it's this server or a site allowed to use it.
      const own = `${secure(req) ? 'https' : 'http'}://${req.headers.host}`;
      let page = '';
      try { const u = new URL(String((req.body && req.body.page) || '')); if (u.origin === own || allowedOrigins.has(u.origin)) page = u.origin + u.pathname; } catch {}
      if (!page) page = own + '/';
      const sent = { ok: true, message: `If ${name} has an email on file, a reset link is on its way. It works for 30 minutes.` };
      const u = findByName(name);
      if (!u || !u.email) return res.json(sent);
      const token = id(24);
      u.reset = { hash: sha(token), until: now + 30 * 60e3 }; save();
      const link = `${page}?reset=${token}`;
      try {
        await mailer.send(u.email, 'Reset your Murmur PIN',
          `Hi ${u.name},\n\nSomeone (hopefully you) asked to reset your Murmur PIN. Open this link within 30 minutes to choose a new one:\n\n${link}\n\nIf this wasn't you, ignore this email. Your PIN stays the same.`,
          `<p>Hi ${u.name.replace(/[<>&"]/g, '')},</p><p>Someone (hopefully you) asked to reset your Murmur PIN. Open this link within 30 minutes to choose a new one:</p>
           <p><a href="${link}" style="display:inline-block;padding:10px 18px;border-radius:999px;background:#1ed760;color:#000;font-weight:700;text-decoration:none">Choose a new PIN</a></p>
           <p style="color:#666;font-size:13px">If this wasn't you, ignore this email. Your PIN stays the same.</p>`);
        console.log(`Sent a PIN reset link to ${u.name}`);
      } catch (e) {
        console.error('Could not send a PIN reset email:', e.message);
        return res.status(502).json({ error: 'Murmur couldn’t send the email right now. Try again later, or ask the person who runs it.' });
      }
      res.json(sent);
    });
    app.post('/api/auth/reset', (req, res) => {
      const token = String((req.body && req.body.token) || ''), pin = String((req.body && req.body.pin) || '');
      const wait = waitFor('ip:' + req.ip);
      if (wait) return res.status(429).json({ error: `Too many tries. Try again in ${Math.ceil(wait / 60)} minutes.` });
      const h = token ? sha(token) : '', u = h && db.users.find(x => x.reset && x.reset.hash === h);
      if (!u || u.reset.until < Date.now()) { fail('ip:' + req.ip); return res.status(400).json({ error: 'That reset link has expired or was already used. Ask for a new one.' }); }
      if (!validPin(pin)) return res.status(400).json({ error: 'Your new PIN must be exactly 4 digits.' });
      setPin(u, pin); delete u.reset;
      db.sessions = db.sessions.filter(s => s.userId !== u.id);   // sign out everywhere, then in here
      const { session: s, token: t } = startSession(req, res, u);
      console.log(`${u.name} reset their PIN by email`);
      res.json({ user: publicUser(u, s), ...creds(req, s, t) });
    });

    app.delete('/api/sessions/:id', (req, res) => {
      const s = db.sessions.find(x => x.id === req.params.id);
      if (!s) return res.status(404).json({ error: 'That device is already signed out.' });
      if (s.userId !== req.user.id && req.user.role !== 'owner') return res.status(403).json({ error: 'Only the owner can do that.' });
      db.sessions = db.sessions.filter(x => x !== s); save();
      if (s === req.session) setCookie(req, res, '', 0);
      res.json({ ok: true });
    });
  }

  // For server-to-server sync: people and sign-ins, by id. "lastSeen" changes on every visit, so it isn't compared.
  const syncCollections = {
    users: { get: () => Object.fromEntries(db.users.map(u => [u.id, u])), set: o => { db.users = Object.values(o); save(); } },
    sessions: { get: () => Object.fromEntries(db.sessions.map(s => [s.id, s])), set: o => { db.sessions = Object.values(o); save(); },
      strip: s => ({ ...s, lastSeen: 0 }) }
  };

  // Storage limit in bytes for a person (0 = no limit).
  const storageLimit = uid => { const u = db.users.find(x => x.id === uid); return u && u.role !== 'owner' && u.storageMB ? u.storageMB * 1024 * 1024 : 0; };
  const userCount = () => db.users.length;
  let mailer = null;   // set once mail.js is ready
  const useMailer = m => { mailer = m; };
  return { cors, sameOrigin, requireUser, requireUserFiles, requireEdit, requireOwner, routes, syncCollections, storageLimit, userCount, useMailer };
};
