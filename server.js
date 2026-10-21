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

const DEFAULT_NAMES = { 1: 'Mayssa', 2: 'Khouloud' };
db.users.forEach((u) => {
  if (DEFAULT_NAMES[u.id]) u.name = DEFAULT_NAMES[u.id];
  else if (!u.name) u.name = 'User ' + u.id;
});

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
const PAGES = {
  'control.html': "<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,maximum-scale=1\">\n<title>Scoreboard Controller</title>\n<style>\n  :root { --bg:#0f1218; --card:#181d27; --line:#2a3140; --txt:#e8ecf3; --mut:#9aa4b5; --red:#b02530; --blue:#1d44cc; }\n  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }\n  body { margin:0; background:var(--bg); color:var(--txt); font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding:16px; max-width:900px; margin-inline:auto; }\n  h1 { font-size:18px; margin:0 0 4px; }\n  .sub { color:var(--mut); font-size:13px; margin-bottom:14px; }\n  .link { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px; margin-bottom:16px; }\n  .link label { font-size:12px; color:var(--mut); display:block; margin-bottom:6px; }\n  .row { display:flex; gap:8px; }\n  .row input { flex:1; min-width:0; background:#0f1218; color:var(--txt); border:1px solid var(--line); border-radius:8px; padding:10px; font-size:13px; }\n  button { font:inherit; cursor:pointer; border:0; border-radius:10px; color:#fff; font-weight:600; }\n  .copy { background:#2f6bff; padding:0 16px; }\n  .grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }\n  @media (max-width:560px){ .grid{ grid-template-columns:1fr; } }\n  .panel { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:14px; }\n  .panel.win { border-top:4px solid var(--red); }\n  .panel.lose { border-top:4px solid var(--blue); }\n  .name { display:flex; justify-content:space-between; align-items:center; font-size:14px; color:var(--mut); }\n  .big { font-size:64px; font-weight:800; text-align:center; margin:6px 0 12px; font-variant-numeric:tabular-nums; }\n  .btns { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin-bottom:8px; }\n  .btns button { padding:14px 0; font-size:16px; }\n  .plus button { background:#1f8f4d; }\n  .minus button { background:#b4373d; }\n  .btns button:active { transform:scale(.96); filter:brightness(1.15); }\n  .reset-side { width:100%; padding:10px; background:#3a4254; font-size:13px; }\n  .reset-all { width:100%; padding:16px; margin-top:14px; background:#6b2fd1; font-size:16px; }\n  .labels { margin-top:16px; background:var(--card); border:1px solid var(--line); border-radius:12px; padding:12px; }\n  .labels .row { margin-top:8px; }\n  .labels input { text-transform:uppercase; }\n  .save { background:#3a4254; padding:0 16px; }\n  .status { font-size:12px; color:var(--mut); margin-top:10px; text-align:center; }\n</style>\n</head>\n<body>\n  <h1>Scoreboard Controller <span id=\"who\" style=\"color:var(--mut)\"></span></h1>\n  <div class=\"sub\">Keep this page private. Changes appear on your stream instantly.</div>\n\n  <div class=\"link\">\n    <label>Overlay link for TikTok LIVE Studio</label>\n    <div class=\"row\">\n      <input id=\"olink\" readonly>\n      <button class=\"copy\" id=\"copy\">Copy</button>\n    </div>\n  </div>\n\n  <div class=\"grid\">\n    <div class=\"panel win\">\n      <div class=\"name\"><span id=\"wname\">WIN</span></div>\n      <div class=\"big\" id=\"w\">0</div>\n      <div class=\"btns plus\">\n        <button data-s=\"win\" data-a=\"1\">+1</button><button data-s=\"win\" data-a=\"10\">+10</button>\n        <button data-s=\"win\" data-a=\"100\">+100</button><button data-s=\"win\" data-a=\"1000\">+1000</button>\n      </div>\n      <div class=\"btns minus\">\n        <button data-s=\"win\" data-a=\"-1\">-1</button><button data-s=\"win\" data-a=\"-10\">-10</button>\n        <button data-s=\"win\" data-a=\"-100\">-100</button><button data-s=\"win\" data-a=\"-1000\">-1000</button>\n      </div>\n      <button class=\"reset-side\" data-reset=\"win\">Reset this side to 0</button>\n    </div>\n\n    <div class=\"panel lose\">\n      <div class=\"name\"><span id=\"lname\">LOSE</span></div>\n      <div class=\"big\" id=\"l\">0</div>\n      <div class=\"btns plus\">\n        <button data-s=\"lose\" data-a=\"1\">+1</button><button data-s=\"lose\" data-a=\"10\">+10</button>\n        <button data-s=\"lose\" data-a=\"100\">+100</button><button data-s=\"lose\" data-a=\"1000\">+1000</button>\n      </div>\n      <div class=\"btns minus\">\n        <button data-s=\"lose\" data-a=\"-1\">-1</button><button data-s=\"lose\" data-a=\"-10\">-10</button>\n        <button data-s=\"lose\" data-a=\"-100\">-100</button><button data-s=\"lose\" data-a=\"-1000\">-1000</button>\n      </div>\n      <button class=\"reset-side\" data-reset=\"lose\">Reset this side to 0</button>\n    </div>\n  </div>\n\n  <button class=\"reset-all\" id=\"resetAll\">Reset both scores to 0</button>\n\n  <div class=\"labels\">\n    <div style=\"font-size:13px;color:var(--mut)\">Custom names (optional, max 12 characters)</div>\n    <div class=\"row\">\n      <input id=\"inWin\" placeholder=\"Left name\" maxlength=\"12\">\n      <input id=\"inTitle\" placeholder=\"Top title\" maxlength=\"12\">\n      <input id=\"inLose\" placeholder=\"Right name\" maxlength=\"12\">\n      <button class=\"save\" id=\"saveLabels\">Save</button>\n    </div>\n  </div>\n  <div class=\"status\" id=\"status\">Connecting...</div>\n\n<script>\n  const token = location.pathname.split('/').pop();\n  const $ = (id) => document.getElementById(id);\n  let filled = false;\n\n  function render(s) {\n    $('w').textContent = s.win; $('l').textContent = s.lose;\n    $('wname').textContent = s.winLabel; $('lname').textContent = s.loseLabel;\n    if (!filled) { $('inWin').value = s.winLabel; $('inLose').value = s.loseLabel; $('inTitle').value = s.title; filled = true; }\n  }\n\n  async function act(body) {\n    try {\n      const r = await fetch('/api/action/' + token, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });\n      if (!r.ok) throw new Error();\n      render(await r.json());\n      $('status').textContent = 'Live';\n    } catch (e) { $('status').textContent = 'Connection problem, try again'; }\n  }\n\n  document.querySelectorAll('button[data-a]').forEach(b => b.onclick = () =>\n    act({ action:'add', side:b.dataset.s, amount:Number(b.dataset.a) }));\n  document.querySelectorAll('button[data-reset]').forEach(b => b.onclick = () =>\n    act({ action:'reset', side:b.dataset.reset }));\n  $('resetAll').onclick = () => { if (confirm('Reset both scores to 0?')) act({ action:'reset' }); };\n  $('saveLabels').onclick = () => act({ action:'labels', winLabel:$('inWin').value, loseLabel:$('inLose').value, title:$('inTitle').value });\n  $('copy').onclick = async () => {\n    try { await navigator.clipboard.writeText($('olink').value); } catch (e) { $('olink').select(); document.execCommand('copy'); }\n    $('copy').textContent = 'Copied'; setTimeout(() => $('copy').textContent = 'Copy', 1500);\n  };\n\n  fetch('/api/state/' + token).then(r => r.json()).then(s => {\n    $('olink').value = s.overlayUrl; $('who').textContent = '- ' + (s.name || '#' + s.userId); render(s); $('status').textContent = 'Live';\n  });\n  function connect() {\n    const es = new EventSource('/api/events/' + token);\n    es.onmessage = (e) => render(JSON.parse(e.data));\n    es.onerror = () => { es.close(); setTimeout(connect, 2000); };\n  }\n  connect();\n</script>\n</body>\n</html>\n",
  'overlay.html': "<!doctype html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>Scoreboard Overlay</title>\n<link href=\"https://fonts.googleapis.com/css2?family=Oswald:wght@500;700&display=swap\" rel=\"stylesheet\">\n<style>\n  html, body { margin: 0; padding: 0; background: transparent !important; overflow: hidden; height: 100%; }\n  body { display: flex; align-items: center; justify-content: center; font-family: 'Oswald', 'Impact', 'Arial Narrow', sans-serif; }\n\n  /* Everything scales from the --u unit so it fits any window size */\n  #board { --u: min(1vw, 1.7vh); position: relative; width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; }\n  .wrap { position: relative; width: calc(var(--u) * 96); height: calc(var(--u) * 30); }\n\n  .layer { position: absolute; display: flex; align-items: center; justify-content: center; color: #fff; text-transform: uppercase; }\n\n  /* top tab */\n  .tab { left: 30%; width: 40%; top: 0; height: 30%;\n    clip-path: polygon(8% 0, 92% 0, 100% 100%, 0 100%);\n    background: linear-gradient(#2a2f3a, #14171e); }\n  .tab span { font-size: calc(var(--u) * 4.2); font-weight: 700; letter-spacing: .04em; white-space: nowrap; text-shadow: 0 0 .4em rgba(255,255,255,.3); margin-bottom: 4%; }\n\n  /* left (blue) */\n  .left { left: 0; width: 50%; top: 34%; height: 52%;\n    clip-path: polygon(0 0, 88% 0, 100% 100%, 8% 100%);\n    background: linear-gradient(90deg, #0b1d64, #1b3fc2 60%, #1636a8); padding-right: calc(var(--u) * 16); box-sizing: border-box; }\n\n  /* right (red) */\n  .right { right: 0; width: 50%; top: 34%; height: 52%;\n    clip-path: polygon(12% 0, 100% 0, 92% 100%, 0 100%);\n    background: linear-gradient(90deg, #8f1c26, #b02530 40%, #6e1219); padding-left: calc(var(--u) * 16); box-sizing: border-box; }\n\n  .label { font-size: calc(var(--u) * 6.5); font-weight: 700; letter-spacing: .05em; white-space: nowrap;\n    -webkit-text-stroke: calc(var(--u) * .12) rgba(255,255,255,.9);\n    text-shadow: 0 .06em 0 rgba(0,0,0,.55), 0 0 .5em rgba(0,0,0,.5); }\n\n  /* centre hex */\n  .mid { --ns: 8; left: 32%; width: 36%; top: 30%; height: 62%;\n    clip-path: polygon(8% 0, 92% 0, 100% 50%, 92% 100%, 8% 100%, 0 50%);\n    background: linear-gradient(#3a404c, #1b1f27 55%, #12151b); gap: calc(var(--u) * 1.4); }\n  .mid .num { font-size: calc(var(--u) * var(--ns)); font-weight: 700; line-height: 1; min-width: 1.4ch; text-align: center; font-variant-numeric: tabular-nums;\n    text-shadow: 0 .06em .12em rgba(0,0,0,.5); }\n  .mid .slash { width: calc(var(--u) * .5); height: 52%; background: #fff; transform: skewX(-14deg); border-radius: 2px; }\n\n  .bump { animation: bump .35s ease; }\n  @keyframes bump { 0% { transform: scale(1); } 40% { transform: scale(1.18); } 100% { transform: scale(1); } }\n</style>\n</head>\n<body>\n<div id=\"board\">\n  <div class=\"wrap\">\n    <div class=\"layer left\"><span class=\"label\" id=\"wl\">WIN</span></div>\n    <div class=\"layer right\"><span class=\"label\" id=\"ll\">LOSE</span></div>\n    <div class=\"layer tab\"><span id=\"title\">SCORE</span></div>\n    <div class=\"layer mid\">\n      <div class=\"num\" id=\"w\">0</div>\n      <div class=\"slash\"></div>\n      <div class=\"num\" id=\"l\">0</div>\n    </div>\n  </div>\n</div>\n<script>\n  const token = location.pathname.split('/').pop();\n  const el = (id) => document.getElementById(id);\n  let last = { win: null, lose: null };\n\n  function bump(node) { node.classList.remove('bump'); void node.offsetWidth; node.classList.add('bump'); }\n\n  function render(s) {\n    el('wl').textContent = s.winLabel;\n    el('ll').textContent = s.loseLabel;\n    el('title').textContent = s.title;\n    el('w').textContent = s.win;\n    el('l').textContent = s.lose;\n    if (last.win !== null && last.win !== s.win) bump(el('w'));\n    if (last.lose !== null && last.lose !== s.lose) bump(el('l'));\n    const n = String(s.win).length + String(s.lose).length;\n    document.querySelector('.mid').style.setProperty('--ns', n <= 4 ? 8 : n <= 6 ? 7 : n <= 8 ? 5.8 : 4.8);\n    last = { win: s.win, lose: s.lose };\n  }\n\n  function connect() {\n    const es = new EventSource('/api/events/' + token);\n    es.onmessage = (e) => render(JSON.parse(e.data));\n    es.onerror = () => { es.close(); setTimeout(connect, 2000); };\n  }\n  // initial paint + live updates + safety polling in case the stream is interrupted\n  fetch('/api/state/' + token).then(r => r.json()).then(render).catch(() => {});\n  connect();\n  setInterval(() => fetch('/api/state/' + token).then(r => r.json()).then(render).catch(() => {}), 5000);\n</script>\n</body>\n</html>\n",
};

function sendFile(res, file) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(PAGES[file]);
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
    return `<tr><td>${u.name}</td>
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
      out.name = f.user.name;
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
    console.log(`${u.name}\n  Controller: ${base}/c/${token('control', u.id)}\n  Overlay:    ${base}/o/${token('overlay', u.id)}`);
  });
  console.log('');
});
