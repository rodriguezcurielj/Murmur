// Email from Murmur (PIN reset links), sent through the owner's mail account over SMTP with TLS.
// Gmail works with an "app password": smtp.gmail.com, port 465. Settings live in mail.json, are synced to
// the other servers, and the password never goes back to the browser.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const tls = require('tls');
const crypto = require('crypto');

module.exports = function createMail(dataDir, auth) {
  const file = path.join(dataDir, 'mail.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { settings = {}; }
  const save = () => fsp.writeFile(file + '.tmp', JSON.stringify(settings), { mode: 0o600 }).then(() => fsp.rename(file + '.tmp', file))
    .catch(err => console.error('Could not save mail.json:', err));
  const ready = () => !!(settings.user && settings.pass);

  // One SMTP conversation: EHLO, AUTH LOGIN, MAIL, RCPT, DATA, QUIT. Each step waits for its reply code.
  function smtp(to, raw) {
    const host = settings.host || 'smtp.gmail.com', port = Number(settings.port) || 465;
    return new Promise((resolve, reject) => {
      const sock = tls.connect({ host, port, servername: host, timeout: 20000 });
      let buf = '', waiting = null, done = false;
      const finish = err => { if (done) return; done = true; sock.destroy(); err ? reject(err) : resolve(); };
      sock.on('timeout', () => finish(new Error('The mail server didn’t answer.')));
      sock.on('error', e => finish(new Error('Couldn’t reach the mail server: ' + e.message)));
      sock.on('data', d => {
        buf += d.toString('utf8');
        // A reply is complete when a line has the code followed by a space ("250 OK"), not a dash ("250-...").
        const m = buf.match(/(?:^|\r\n)(\d{3}) [^\r\n]*\r\n$/);
        if (m && waiting) { const w = waiting, text = buf; waiting = null; buf = ''; w(+m[1], text); }
      });
      const step = (line, want) => new Promise((ok, no) => {
        waiting = (code, text) => (want.includes(code) ? ok(text) : no(new Error(code === 535 || code === 534
          ? 'The mail account and app password didn’t work. Check them in Admin → Email.' : `The mail server said: ${text.trim().split('\r\n').pop()}`)));
        if (line != null) sock.write(line + '\r\n');
      });
      (async () => {
        await step(null, [220]);
        await step('EHLO murmur', [250]);
        await step('AUTH LOGIN', [334]);
        await step(Buffer.from(settings.user).toString('base64'), [334]);
        await step(Buffer.from(settings.pass).toString('base64'), [235]);
        await step(`MAIL FROM:<${settings.user}>`, [250]);
        await step(`RCPT TO:<${to}>`, [250, 251]);
        await step('DATA', [354]);
        await step(raw.replace(/\r\n\./g, '\r\n..') + '\r\n.', [250]);
        sock.write('QUIT\r\n');
        finish();
      })().catch(finish);
    });
  }

  const word = s => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
  const b64 = s => Buffer.from(s).toString('base64').replace(/.{76}/g, '$&\r\n');
  function send(to, subject, text, html) {
    if (!ready()) return Promise.reject(new Error('Email isn’t set up on this server yet.'));
    if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(to)) return Promise.reject(new Error('That email address doesn’t look right.'));
    const from = settings.user, boundary = 'm' + crypto.randomBytes(12).toString('hex');
    const raw = [
      `From: ${word(settings.fromName || 'Murmur')} <${from}>`, `To: <${to}>`, `Subject: ${word(subject)}`,
      `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${from.split('@')[1]}>`,
      'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(text),
      `--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64(html),
      `--${boundary}--`
    ].join('\r\n');
    return smtp(to, raw);
  }

  function routes(app) {
    // The owner sets the mail account. The password is write-only: the page only learns whether one is saved.
    const view = () => ({ user: settings.user || '', fromName: settings.fromName || 'Murmur', host: settings.host || 'smtp.gmail.com', port: Number(settings.port) || 465, hasPass: !!settings.pass, ready: ready() });
    app.get('/api/mail/settings', auth.requireOwner, (req, res) => res.json(view()));
    app.put('/api/mail/settings', auth.requireOwner, (req, res) => {
      const b = req.body || {};
      if (b.user != null) settings.user = String(b.user).trim().slice(0, 200);
      if (b.pass) settings.pass = String(b.pass).replace(/\s+/g, '').slice(0, 200);   // Gmail shows app passwords with spaces
      if (b.fromName != null) settings.fromName = String(b.fromName).trim().slice(0, 60) || 'Murmur';
      if (b.host != null) settings.host = String(b.host).trim().slice(0, 200) || 'smtp.gmail.com';
      if (b.port != null) settings.port = Number(b.port) === 465 || !Number(b.port) ? 465 : Number(b.port);
      if (b.clear) settings = {};
      save();
      res.json(view());
    });
    app.post('/api/mail/test', auth.requireOwner, async (req, res) => {
      const to = String((req.body && req.body.to) || req.user.email || '').trim();
      if (!to) return res.status(400).json({ error: 'Add your own email in Account first, so the test has somewhere to go.' });
      try {
        await send(to, 'Murmur email works', 'This is a test from your Murmur server. PIN reset emails will come from this address.',
          '<p>This is a test from your Murmur server.</p><p>PIN reset emails will come from this address.</p>');
        res.json({ ok: true, to });
      } catch (e) { res.status(502).json({ error: e.message }); }
    });
  }

  const syncCollection = {
    get: () => (Object.keys(settings).length ? { settings: { ...settings } } : {}),
    set: o => { settings = { ...(o.settings || {}) }; save(); }
  };
  return { send, ready, routes, syncCollection };
};
