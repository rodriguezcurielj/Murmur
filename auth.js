// Murmur sign-in: one owner plus people the owner adds, each with a name and a 4-digit PIN.
// PINs are stored as salted scrypt hashes. Sessions are random tokens kept in an
// HttpOnly cookie; only a SHA-256 of each token is saved on disk.
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;

const HOUR = 3600e3, DAY = 24 * HOUR;
const REMEMBER_MS = 90 * DAY;   // "Remember this computer"
const SESSION_MS = 12 * HOUR;   // everyone else
const COOKIE = 'murmur_session';

module.exports = function createAuth(file) {
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
  prune(); setInterval(prune, HOUR).unref();

  const id = (n = 8) => crypto.randomBytes(n).toString('hex');
  const sha = s => crypto.createHash('sha256').update(s).digest('hex');
  const hashPin = (pin, salt) => crypto.scryptSync(String(pin), salt, 32).toString('hex');
  const validPin = p => typeof p === 'string' && /^\d{4}$/.test(p);
  const cleanName = n => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const findByName = n => db.users.find(u => u.name.toLowerCase() === cleanName(n).toLowerCase());
  const canEdit = u => u.role === 'owner' || !!u.canEdit;
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
  const waitFor = key => { const f = fails.get(key); return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0; };
  function fail(key) {
    const f = fails.get(key) || { n: 0, until: 0 };
    f.n++;
    if (f.n >= 5) f.until = Date.now() + Math.min(15, 2 ** (f.n - 5)) * 60e3;
    fails.set(key, f);
  }

  /* --- cookies & sessions --- */
  function readToken(req) {
    const m = (req.headers.cookie || '').split(/;\s*/).map(c => c.split('=')).find(([k]) => k === COOKIE);
    return m ? decodeURIComponent(m.slice(1).join('=')) : null;
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
    const s = { id: id(6), tokenHash: sha(token), userId: user.id, createdAt: now, expiresAt: now + SESSION_MS, remember: false, device: deviceName(req.headers['user-agent']), lastSeen: now };
    db.sessions.push(s); save();
    setCookie(req, res, token);   // session cookie: gone when the browser closes
    return s;
  }
  function current(req) {
    const token = readToken(req); if (!token) return null;
    const h = sha(token), s = db.sessions.find(x => x.tokenHash === h);
    if (!s) return null;
    if (s.expiresAt <= Date.now()) { db.sessions = db.sessions.filter(x => x !== s); save(); return null; }
    const u = db.users.find(x => x.id === s.userId); if (!u) return null;
    if (Date.now() - s.lastSeen > 60e3) { s.lastSeen = Date.now(); save(); }
    return { user: u, session: s, token };
  }
  const publicUser = (u, s) => ({ id: u.id, name: u.name, role: u.role, canEdit: canEdit(u), expiresAt: s ? s.expiresAt : null, remembered: s ? s.remember : false });
  const personView = (u, s) => ({ id: u.id, name: u.name, role: u.role, canEdit: canEdit(u), createdAt: u.createdAt,
    sessions: db.sessions.filter(x => x.userId === u.id).map(x => ({ id: x.id, device: x.device, createdAt: x.createdAt, expiresAt: x.expiresAt, remember: x.remember, lastSeen: x.lastSeen, current: !!s && x.id === s.id })) });

  /* --- middleware --- */
  const PUBLIC = new Set(['/auth/status', '/auth/login', '/auth/setup', '/health']);
  function sameOrigin(req, res, next) {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    const o = req.headers.origin;
    if (o) { try { if (new URL(o).host !== req.headers.host) throw new Error(); } catch { return res.status(403).json({ error: 'Blocked a request from another website.' }); } }
    next();
  }
  function requireUser(req, res, next) {
    if (PUBLIC.has(req.path)) return next();
    const a = current(req);
    if (!a) return res.status(401).json({ error: 'Please sign in.' });
    req.user = a.user; req.session = a.session; req.token = a.token;
    next();
  }
  function requireUserFiles(req, res, next) {
    const a = current(req);
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
      res.json({ setup: db.users.some(u => u.role === 'owner'), user: a ? publicUser(a.user, a.session) : null });
    });

    app.post('/api/auth/setup', (req, res) => {
      if (db.users.some(u => u.role === 'owner')) return res.status(409).json({ error: 'Murmur is already set up. Sign in instead.' });
      const name = cleanName(req.body && req.body.name), pin = req.body && req.body.pin;
      if (!name) return res.status(400).json({ error: 'Enter your name.' });
      if (!validPin(pin)) return res.status(400).json({ error: 'Your PIN must be exactly 4 digits.' });
      const u = { id: id(), name, role: 'owner', canEdit: true, createdAt: Date.now() };
      setPin(u, pin); db.users.push(u);
      const s = startSession(req, res, u);
      console.log(`Owner account created for ${name}`);
      res.json({ user: publicUser(u, s) });
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
      const s = startSession(req, res, u);
      res.json({ user: publicUser(u, s) });
    });

    app.post('/api/auth/remember', (req, res) => {
      if (req.body && req.body.remember) {
        req.session.remember = true;
        req.session.expiresAt = Date.now() + REMEMBER_MS;
        save();
        setCookie(req, res, req.token, REMEMBER_MS);
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

    app.get('/api/users', requireOwner, (req, res) => {
      const order = u => (u.role === 'owner' ? 0 : 1);
      res.json({ users: db.users.slice().sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name)).map(u => personView(u, req.session)) });
    });

    app.post('/api/users', requireOwner, (req, res) => {
      const name = cleanName(req.body && req.body.name), pin = req.body && req.body.pin;
      if (!name) return res.status(400).json({ error: 'Enter a name.' });
      if (findByName(name)) return res.status(409).json({ error: `Someone called ${name} is already on the list. Use a different name.` });
      if (!validPin(pin)) return res.status(400).json({ error: 'The PIN must be exactly 4 digits.' });
      const u = { id: id(), name, role: 'member', canEdit: !!(req.body && req.body.canEdit), createdAt: Date.now() };
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

    app.delete('/api/sessions/:id', (req, res) => {
      const s = db.sessions.find(x => x.id === req.params.id);
      if (!s) return res.status(404).json({ error: 'That device is already signed out.' });
      if (s.userId !== req.user.id && req.user.role !== 'owner') return res.status(403).json({ error: 'Only the owner can do that.' });
      db.sessions = db.sessions.filter(x => x !== s); save();
      if (s === req.session) setCookie(req, res, '', 0);
      res.json({ ok: true });
    });
  }

  return { sameOrigin, requireUser, requireUserFiles, requireEdit, requireOwner, routes };
};
