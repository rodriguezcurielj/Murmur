// Email from Murmur (PIN reset links), sent through the owner's own mail account over SMTP.
// Any provider works: the mail server is guessed from the address (Gmail, Outlook, Yahoo, iCloud, ...) and can
// be changed. Port 465 uses TLS from the start; 587 (and 25) start plain and switch to TLS (STARTTLS).
// Settings live in mail.json, are synced to the other servers, and the password never goes back to the browser.
const fs = require('fs');
const net = require('net');
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

  // Mail servers of common providers, by the part after the @. Anything else: smtp.<domain>, port 465.
  const PRESETS = [
    [/^(gmail|googlemail)\.com$/, 'smtp.gmail.com', 465],
    [/^(outlook|hotmail|live|msn)\.[a-z.]+$/, 'smtp-mail.outlook.com', 587],
    [/^(yahoo|ymail|rocketmail)\.[a-z.]+$/, 'smtp.mail.yahoo.com', 465],
    [/^(icloud|me|mac)\.com$/, 'smtp.mail.me.com', 587],
    [/^(aol|aim)\.com$/, 'smtp.aol.com', 465],
    [/^zoho(mail)?\.[a-z.]+$/, 'smtp.zoho.com', 465],
    [/^(gmx|gmx\.[a-z]+)\.[a-z.]+$|^gmx\.[a-z]+$/, 'mail.gmx.com', 465],
    [/^(mail|inbox)\.com$/, 'smtp.mail.com', 465],
    [/^(comcast|xfinity)\.net$/, 'smtp.comcast.net', 587],
    [/^att\.net$/, 'smtp.mail.att.net', 465]
  ];
  function guessServer(user) {
    const domain = String(user || '').split('@')[1] || '';
    const hit = PRESETS.find(([re]) => re.test(domain.toLowerCase()));
    return hit ? { host: hit[1], port: hit[2] } : { host: domain ? 'smtp.' + domain.toLowerCase() : '', port: 465 };
  }
  const server = () => { const g = guessServer(settings.user); return { host: settings.host || g.host, port: Number(settings.port) || g.port }; };

  // One SMTP conversation: EHLO, AUTH LOGIN, MAIL, RCPT, DATA, QUIT. Each step waits for its reply code.
  function smtp(to, raw) {
    const { host, port } = server();
    if (!host) return Promise.reject(new Error('Set the mail server in Admin → Email.'));
    return new Promise((resolve, reject) => {
      const direct = port === 465;
      let sock, buf = '', waiting = null, done = false;
      const finish = err => { if (done) return; done = true; if (sock) sock.destroy(); err ? reject(err) : resolve(); };
      const listen = so => {
        sock = so;
        so.setTimeout(20000);
        so.on('timeout', () => finish(new Error(`The mail server (${host}) didn’t answer.`)));
        so.on('error', e => finish(new Error(`Couldn’t reach the mail server (${host}): ${e.message}`)));
        so.on('data', d => {
          buf += d.toString('utf8');
          // A reply is complete when a line has the code followed by a space ("250 OK"), not a dash ("250-...").
          const m = buf.match(/(?:^|\r\n)(\d{3}) [^\r\n]*\r\n$/);
          if (m && waiting) { const w = waiting, text = buf; waiting = null; buf = ''; w(+m[1], text); }
        });
      };
      listen(direct ? tls.connect({ host, port, servername: host }) : net.connect({ host, port }));
      const step = (line, want) => new Promise((ok, no) => {
        waiting = (code, text) => (want.includes(code) ? ok(text) : no(new Error(code === 535 || code === 534
          ? 'The email address and password didn’t work. Many providers need an app password for this. Check Admin → Email.' : `The mail server said: ${text.trim().split('\r\n').pop()}`)));
        if (line != null) sock.write(line + '\r\n');
      });
      (async () => {
        await step(null, [220]);
        const hello = await step('EHLO murmur', [250]);
        if (!direct) {
          if (!/STARTTLS/i.test(hello)) throw new Error(`The mail server (${host}) doesn’t offer a secure connection on port ${port}. Try port 465.`);
          await step('STARTTLS', [220]);
          sock.removeAllListeners('data'); sock.removeAllListeners('timeout'); sock.removeAllListeners('error');
          const plain = sock;
          plain.on('error', () => {});   // errors now arrive on the TLS socket
          await new Promise((ok, no) => { const t = tls.connect({ socket: plain, servername: host }, ok); t.once('error', no); listen(t); });
          await step('EHLO murmur', [250]);
        }
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
    const view = () => ({ user: settings.user || '', fromName: settings.fromName || 'Murmur', ...server(), custom: !!settings.host, hasPass: !!settings.pass, ready: ready() });
    app.get('/api/mail/settings', auth.requireOwner, (req, res) => res.json(view()));
    app.put('/api/mail/settings', auth.requireOwner, (req, res) => {
      const b = req.body || {};
      if (b.user != null) settings.user = String(b.user).trim().slice(0, 200);
      if (b.pass) settings.pass = String(b.pass).replace(/\s+/g, '').slice(0, 200);   // Gmail shows app passwords with spaces
      if (b.fromName != null) settings.fromName = String(b.fromName).trim().slice(0, 60) || 'Murmur';
      // A server the person typed is kept; left empty, it's guessed from the address each time.
      if (b.host != null) { const h = String(b.host).trim().toLowerCase().slice(0, 200); if (h && h !== guessServer(settings.user).host) settings.host = h; else delete settings.host; }
      if (b.port != null) { const n = Math.round(Number(b.port)); if (n > 0 && n < 65536 && (settings.host || n !== guessServer(settings.user).port)) settings.port = n; else delete settings.port; }
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
  return { send, ready, routes, syncCollection, guessServer };
};
