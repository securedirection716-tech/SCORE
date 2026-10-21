// Live Scoreboard server - zero dependencies (Node 16+)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, 'data.json');
const MAX_USERS = 5;

const rnd = (n) => crypto.randomBytes(n).toString('hex');

let db = null;
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { db = null; }
if (!db) {
  db = { secret: rnd(16), admin: rnd(6), users: [] };
  for (let i = 1; i <= MAX_USERS; i++) {
    db.users.push({ id: i, win: 0, lose: 0, winLabel: 'WIN', loseLabel: 'LOSE', title: 'SCORE' });
  }
}
// Env overrides keep links stable across redeploys even if the disk is wiped
if (process.env.SECRET) db.secret = process.env.SECRET;
if (process.env.ADMIN_KEY) db.admin = process.env.ADMIN_KEY;

const token = (kind, id) =>
  crypto.createHmac('sha256', db.secret).update(kind + ':' + id).digest('hex').slice(0, 16);

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch (e) { console.error('save failed', e.message); }
  }, 300);
}
save();

function findUser(t) {
  for (const u of db.users) {
    if (token('control', u.id) === t) return { user: u, role: 'control' };
    if (token('overlay', u.id) === t) return { user: u, role: 'overlay' };
  }
  return null;
}

const publicState = (u) => ({
  win: u.win, lose: u.lose, winLabel: u.winLabel, loseLabel: u.loseLabel, title: u.title,
});

const clients = new Map(); // userId -> Set(res)
function broadcast(u) {
  const set = clients.get(u.id);
  if (!set) return;
  const msg = 'data: ' + JSON.stringify(publicState(u)) + '\n\n';
  for (const res of set) res.write(msg);
}
setInterval(() => {
  for (const set of clients.values()) for (const res of set) res.write(': ping\n\n');
}, 20000);

const clean = (s, max) => String(s == null ? '' : s).replace(/[<>]/g, '').trim().slice(0, max);

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 5000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
  });
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function sendFile(res, file) {
  const candidates = [
    path.join(__dirname, 'public', file),
    path.join(__dirname, file),
    path.join(process.cwd(), 'public', file),
    path.join(process.cwd(), file),
  ];
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Error: ' + file + ' is missing from your upload. Put it in a folder named "public" next to server.js.');
  }
  fs.readFile(hit, (err, buf) => {
    if (err) { res.writeHead(500); return res.end('Error reading ' + file); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return proto.split(',')[0] + '://' + req.headers.host;
}

function adminPage(req) {
  const base = baseUrl(req);
  const rows = db.users.map((u) => {
    const c = `${base}/c/${token('control', u.id)}`;
    const o = `${base}/o/${token('overlay', u.id)}`;
    return `<tr><td>User ${u.id}</td>
      <td><a href="${c}" target="_blank">${c}</a></td>
      <td><a href="${o}" target="_blank">${o}</a></td></tr>`;
  }).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Scoreboard admin</title>
  <style>body{font-family:system-ui;background:#0f1218;color:#e8ecf3;padding:24px}
  table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #2a3140;padding:10px;text-align:left;font-size:14px;word-break:break-all}
  a{color:#7db4ff}h1{margin-top:0}.n{color:#9aa4b5;font-size:13px}</style>
  <h1>Scoreboard admin</h1>
  <p class="n">Give each user ONLY their own row. <b>Controller link</b> = private (keep secret). <b>Overlay link</b> = paste into TikTok LIVE Studio.</p>
  <table><tr><th>User</th><th>Controller link (private)</th><th>Overlay link (for stream)</th></tr>${rows}</table>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;background:#0f1218;color:#e8ecf3;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h1>Live Scoreboard</h1><p>Open your private controller link to get started.</p></div>');
  }

  if (url.pathname === '/admin') {
    if (url.searchParams.get('key') !== db.admin) { res.writeHead(403); return res.end('Forbidden'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(adminPage(req));
  }

  if (parts[0] === 'c' && parts[1]) {
    const f = findUser(parts[1]);
    if (!f || f.role !== 'control') { res.writeHead(404); return res.end('Not found'); }
    return sendFile(res, 'control.html');
  }
  if (parts[0] === 'o' && parts[1]) {
    const f = findUser(parts[1]);
    if (!f || f.role !== 'overlay') { res.writeHead(404); return res.end('Not found'); }
    return sendFile(res, 'overlay.html');
  }

  // GET /api/state/:token
  if (parts[0] === 'api' && parts[1] === 'state' && parts[2]) {
    const f = findUser(parts[2]);
    if (!f) return sendJSON(res, 404, { error: 'not found' });
    const out = publicState(f.user);
    if (f.role === 'control') {
      out.userId = f.user.id;
      out.overlayUrl = `${baseUrl(req)}/o/${token('overlay', f.user.id)}`;
    }
    return sendJSON(res, 200, out);
  }

  // GET /api/events/:token  (SSE)
  if (parts[0] === 'api' && parts[1] === 'events' && parts[2]) {
    const f = findUser(parts[2]);
    if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1500\n\n');
    res.write('data: ' + JSON.stringify(publicState(f.user)) + '\n\n');
    if (!clients.has(f.user.id)) clients.set(f.user.id, new Set());
    clients.get(f.user.id).add(res);
    req.on('close', () => clients.get(f.user.id).delete(res));
    return;
  }

  // POST /api/action/:controlToken
  if (parts[0] === 'api' && parts[1] === 'action' && parts[2] && req.method === 'POST') {
    const f = findUser(parts[2]);
    if (!f || f.role !== 'control') return sendJSON(res, 403, { error: 'forbidden' });
    const u = f.user;
    const b = await readBody(req);
    const side = b.side === 'win' || b.side === 'lose' ? b.side : null;

    if (b.action === 'add' && side) {
      const amt = Number(b.amount);
      if ([1, 10, 100, 1000, -1, -10, -100, -1000].includes(amt)) {
        u[side] = Math.max(0, Math.min(999999999, u[side] + amt));
      }
    } else if (b.action === 'reset') {
      if (side) u[side] = 0; else { u.win = 0; u.lose = 0; }
    } else if (b.action === 'labels') {
      if (b.winLabel !== undefined) u.winLabel = clean(b.winLabel, 12) || 'WIN';
      if (b.loseLabel !== undefined) u.loseLabel = clean(b.loseLabel, 12) || 'LOSE';
      if (b.title !== undefined) u.title = clean(b.title, 12) || 'SCORE';
    } else {
      return sendJSON(res, 400, { error: 'bad action' });
    }
    save();
    broadcast(u);
    return sendJSON(res, 200, publicState(u));
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`\nScoreboard running on port ${PORT}`);
  console.log(`Admin page (all links):  /admin?key=${db.admin}\n`);
  const base = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
  db.users.forEach((u) => {
    console.log(`User ${u.id}\n  Controller: ${base}/c/${token('control', u.id)}\n  Overlay:    ${base}/o/${token('overlay', u.id)}`);
  });
  console.log('');
});
