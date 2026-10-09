// Anifighters live PvP server: Classic + Ranked matchmaking and real-time team duels.
// Two players fight each other live with their own teams. The server pairs players,
// relays each player's moves to the other, checks the numbers, and decides the winner.
// Also runs the social layer: online presence, friend search/requests and friend chat.
// No dependencies (Node 18+). Run: node server.js
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;
const DUEL_MS = +(process.env.DUEL_MS || 180000);   // length of a live duel
const CLASSIC_RANGE = 5;                             // classic: preferred level gap
const CLASSIC_WAIT_MS = 15000;                       // classic: after this, match with anyone
const RANK_RANGE = 150;                              // ranked: starting rating gap
const RANK_STEP_MS = 10000;                          // ranked: widen the gap every 10 s
const RANK_ANY_MS = 45000;                           // ranked: after this, match with anyone
const ACT_GAP_MS = 400;                              // min time between a player's attack messages
const MAX_HP = 600000, MAX_ATK = 80000;

const BAD = ['fuck','shit','bitch','cunt','nigg','fag','rape','nazi','hitler','whore','slut','dick','pussy'];
function cleanName(raw) {
  let n = String(raw || '').replace(/[^\w \-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
  const t = n.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/[@4]/g, 'a').replace(/[$5]/g, 's').replace(/[^a-z]/g, '');
  if (n.length < 3 || BAD.some((w) => t.includes(w))) n = 'PLAYER' + crypto.randomBytes(2).toString('hex').toUpperCase();
  return n;
}

const players = new Map();    // id -> player
const matches = new Map();    // matchId -> match
const queues = { classic: [], ranked: [] };
let seq = 0;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function json(res, code, obj) { cors(res); res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 6000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function sendEvent(p, event, data) { if (p && p.res) { try { p.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {} } }
const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(+v || 0)));

function startMatch(a, b, mode) {
  const id = 'm' + (++seq) + crypto.randomBytes(3).toString('hex');
  const m = { id, mode, players: [a, b], endsAt: Date.now() + DUEL_MS, done: false, timer: null };
  matches.set(id, m);
  for (const p of [a, b]) {
    p.matchId = id; p.queuedAt = 0; p.team = null; p.hpLast = null; p.pct = 1; p.lastAct = 0; p.atkMax = 1000;
  }
  for (const p of [a, b]) {
    const rival = p === a ? b : a;
    sendEvent(p, 'match', { matchId: id, mode, endsIn: DUEL_MS, rival: { name: rival.name, level: rival.level, rating: rival.rating } });
  }
  m.timer = setTimeout(() => {
    const [x, y] = m.players;
    const diff = x.pct - y.pct;
    finish(m, Math.abs(diff) < 0.005 ? null : (diff > 0 ? x : y), 'time');
  }, DUEL_MS);
}

function finish(m, winner, reason) {
  if (m.done) return;
  m.done = true;
  clearTimeout(m.timer);
  for (const p of m.players) {
    const rival = m.players.find((x) => x !== p);
    sendEvent(p, 'end', { won: winner === p, draw: !winner, reason, mode: m.mode, rival: { name: rival.name, rating: rival.rating }, myPct: p.pct, rivalPct: rival.pct });
    p.matchId = null; p.team = null;
  }
  matches.delete(m.id);
}

function pairUp(mode) {
  const q = queues[mode];
  let found = true;
  while (found) {
    found = false;
    const now = Date.now();
    for (let i = 0; i < q.length && !found; i++) {
      const a = q[i];
      let best = -1, bestGap = Infinity;
      for (let j = 0; j < q.length; j++) {
        if (j === i) continue;
        const b = q[j];
        const waited = now - Math.min(a.queuedAt, b.queuedAt);
        let ok, gap;
        if (mode === 'classic') { gap = Math.abs(a.level - b.level); ok = gap <= CLASSIC_RANGE || waited > CLASSIC_WAIT_MS; }
        else { gap = Math.abs(a.rating - b.rating); ok = gap <= RANK_RANGE + Math.floor(waited / RANK_STEP_MS) * RANK_RANGE || waited > RANK_ANY_MS; }
        if (ok && gap < bestGap) { best = j; bestGap = gap; }
      }
      if (best >= 0) {
        const b = q[best];
        queues[mode] = q.filter((x) => x !== a && x !== b);
        startMatch(a, b, mode);
        found = true;
        return pairUp(mode);
      }
    }
  }
}
function pairAll() { pairUp('classic'); pairUp('ranked'); }
setInterval(pairAll, 1000);

function dropPlayer(p) {
  queues.classic = queues.classic.filter((x) => x !== p);
  queues.ranked = queues.ranked.filter((x) => x !== p);
  if (p.matchId && matches.has(p.matchId)) {
    const m = matches.get(p.matchId);
    finish(m, m.players.find((x) => x !== p), 'forfeit');
  }
  p.matchId = null;
}

function relay(p, m, msg) {
  const other = m.players.find((x) => x !== p);
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'team': {
      if (p.team || !Array.isArray(msg.team)) return;
      const team = msg.team.slice(0, 3).map((f) => ({
        id: String((f && f.id) || 'kairo').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 14) || 'kairo',
        hp: num(f && f.hp, 1, MAX_HP), atk: num(f && f.atk, 1, MAX_ATK),
        lv: num(f && f.lv, 1, 60), st: num(f && f.st, 1, 14),
      }));
      if (!team.length) return;
      p.team = team; p.hpLast = team.map((f) => f.hp); p.atkMax = Math.max(...team.map((f) => f.atk));
      sendEvent(other, 'msg', { t: 'team', team });
      break;
    }
    case 'act': {
      if (!p.team) return;
      const now = Date.now();
      if (now - p.lastAct < ACT_GAP_MS) return;
      p.lastAct = now;
      const k = ['strike', 'blast', 'special', 'ult'].includes(msg.k) ? msg.k : 'strike';
      const tot = num(msg.tot, 0, p.atkMax * 6);       // a single attack can never exceed 6x attack
      sendEvent(other, 'msg', { t: 'act', k, tot });
      break;
    }
    case 'st': {
      if (!p.team || !Array.isArray(msg.hps)) return;
      const hps = p.team.map((f, i) => Math.min(num(msg.hps[i], 0, f.hp), p.hpLast[i]));   // HP can only go down
      p.hpLast = hps;
      const sumMax = p.team.reduce((s, f) => s + f.hp, 0);
      p.pct = sumMax ? hps.reduce((s, v) => s + v, 0) / sumMax : 0;
      const a = num(msg.a, 0, p.team.length - 1);
      sendEvent(other, 'msg', { t: 'st', hps, a, pct: p.pct });
      if (hps.every((v) => v <= 0)) finish(m, other, 'ko');
      break;
    }
    case 'lost': {
      if (p.pct <= 0.02 || (p.hpLast && p.hpLast.every((v) => v <= 0))) finish(m, other, 'ko');
      break;
    }
  }
}


// ---------- social: presence, friend search, friend requests, friend chat ----------
// Players are identified by a random id + secret key that the game creates on first launch.
// Everything is kept in memory: messages and requests for an offline player wait in an inbox (last 60).
const users = new Map();   // uid -> user
const okId = (v) => /^[a-f0-9]{16}$/.test(String(v || ''));
const okKey = (v) => /^[a-f0-9]{24}$/.test(String(v || ''));
function auth(uid, key) {
  if (!okId(uid) || !okKey(key)) return null;
  let u = users.get(uid);
  if (!u) { u = { uid, key, name: 'PLAYER', lv: 1, res: null, lastSeen: 0, inbox: [], claims: new Set(), lastChat: 0, lastFriend: 0 }; users.set(uid, u); }
  return u.key === key ? u : null;
}
const pub = (u) => ({ uid: u.uid, name: u.name, lv: u.lv, online: !!u.res, lastSeen: u.lastSeen });
function deliver(u, event, data) {
  if (u.res) { try { u.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); return; } catch (e) {} }
  u.inbox.push({ event, data });
  if (u.inbox.length > 60) u.inbox.splice(0, u.inbox.length - 60);
}
function cleanText(raw) {
  let s = String(raw || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  for (const w of BAD) s = s.replace(new RegExp(w, 'gi'), '*'.repeat(w.length));
  return s;
}
async function social(req, res, url) {
  const p = url.pathname;
  if (p === '/social' && req.method === 'GET') {
    const u = auth(url.searchParams.get('uid'), url.searchParams.get('key'));
    if (!u) return json(res, 403, { error: 'bad id' });
    u.name = cleanName(url.searchParams.get('name')); u.lv = num(url.searchParams.get('lv'), 1, 999);
    if (u.res) { try { u.res.end(); } catch (e) {} }
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    u.res = res;
    res.write(`event: hello\ndata: ${JSON.stringify({ me: pub(u) })}\n\n`);
    const box = u.inbox.splice(0);
    for (const m of box) deliver(u, m.event, m.data);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 15000);
    req.on('close', () => { clearInterval(ping); if (u.res === res) { u.res = null; u.lastSeen = Date.now(); } });
    return true;
  }
  if (p === '/search' && req.method === 'GET') {
    const q = String(url.searchParams.get('q') || '').toLowerCase().replace(/[^\w \-]/g, '').trim().slice(0, 14);
    const me = String(url.searchParams.get('uid') || '');
    if (q.length < 2) return json(res, 200, { users: [] }), true;
    const out = [...users.values()].filter((u) => u.uid !== me && u.name.toLowerCase().includes(q))
      .sort((a, b) => (+!!b.res) - (+!!a.res) || (a.name.toLowerCase().indexOf(q) - b.name.toLowerCase().indexOf(q)))
      .slice(0, 12).map(pub);
    json(res, 200, { users: out });
    return true;
  }
  if (req.method !== 'POST' || !['/me', '/status', '/friend', '/chat'].includes(p)) return false;
  const body = await readBody(req);
  const u = auth(body.uid, body.key);
  if (!u) { json(res, 403, { error: 'bad id' }); return true; }
  if (p === '/me') { u.name = cleanName(body.name); u.lv = num(body.lv, 1, 999); json(res, 200, { me: pub(u) }); return true; }
  if (p === '/status') {
    const ids = (Array.isArray(body.friends) ? body.friends : []).filter(okId).slice(0, 200);
    u.claims = new Set(ids);
    json(res, 200, { users: ids.map((id) => (users.has(id) ? pub(users.get(id)) : { uid: id, online: false, unknown: true })) });
    return true;
  }
  const t = users.get(String(body.to || ''));
  if (!t || t === u) { json(res, 404, { error: 'player not found' }); return true; }
  const now = Date.now();
  if (p === '/friend') {
    if (now - u.lastFriend < 800) { json(res, 429, { error: 'slow down' }); return true; }
    u.lastFriend = now;
    const a = body.action;
    if (a === 'request') deliver(t, 'freq', { from: pub(u) });
    else if (a === 'accept') { u.claims.add(t.uid); deliver(t, 'facc', { from: pub(u) }); }
    else if (a === 'decline') deliver(t, 'fdec', { from: { uid: u.uid } });
    else if (a === 'remove') { u.claims.delete(t.uid); deliver(t, 'frem', { from: { uid: u.uid } }); }
    else { json(res, 400, { error: 'bad action' }); return true; }
    json(res, 200, { ok: true, to: pub(t) });
    return true;
  }
  if (p === '/chat') {
    if (now - u.lastChat < 600) { json(res, 429, { error: 'slow down' }); return true; }
    // only friends can chat: the receiver must have the sender in their friend list
    // (if the receiver has not been seen since the server started, the sender must list them)
    const allowed = t.claims.has(u.uid) || (t.claims.size === 0 && u.claims.has(t.uid));
    if (!allowed) { json(res, 403, { error: 'not friends' }); return true; }
    const text = cleanText(body.text);
    if (!text) { json(res, 400, { error: 'empty' }); return true; }
    u.lastChat = now;
    deliver(t, 'chat', { from: u.uid, name: u.name, lv: u.lv, text, ts: now });
    json(res, 200, { ok: true, text, ts: now, online: !!t.res });
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/health') return json(res, 200, { ok: true, classic: queues.classic.length, ranked: queues.ranked.length, matches: matches.size, online: [...users.values()].filter((u) => u.res).length });
  if (await social(req, res, url)) return;

  if (url.pathname === '/events' && req.method === 'GET') {
    const id = String(url.searchParams.get('id') || '').slice(0, 40);
    if (!id) return json(res, 400, { error: 'id required' });
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    let p = players.get(id);
    if (p && p.res) { try { p.res.end(); } catch (e) {} dropPlayer(p); }
    p = { id, name: 'PLAYER', level: 1, rating: 1000, res, queuedAt: 0, matchId: null, team: null, hpLast: null, pct: 1, lastAct: 0, atkMax: 1000 };
    players.set(id, p);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 15000);
    req.on('close', () => { clearInterval(ping); if (players.get(id) === p) { dropPlayer(p); players.delete(id); } });
    return;
  }

  if (url.pathname === '/queue' && req.method === 'POST') {
    const body = await readBody(req);
    const p = players.get(String(body.id || ''));
    if (!p || !p.res) return json(res, 400, { error: 'open /events first' });
    if (p.matchId) return json(res, 200, { ok: true, status: 'in-match' });
    const mode = body.mode === 'ranked' ? 'ranked' : 'classic';
    p.name = cleanName(body.name);
    p.level = num(body.level, 1, 60);
    p.rating = num(body.rating, 0, 5000);
    queues.classic = queues.classic.filter((x) => x !== p);
    queues.ranked = queues.ranked.filter((x) => x !== p);
    p.queuedAt = Date.now();
    queues[mode].push(p);
    pairAll();
    return json(res, 200, { ok: true, status: 'queued', mode });
  }

  if (url.pathname === '/send' && req.method === 'POST') {
    const body = await readBody(req);
    const p = players.get(String(body.id || ''));
    const m = p && matches.get(String(body.matchId || ''));
    if (!p || !m || m.done || !m.players.includes(p)) return json(res, 200, { ok: false });
    relay(p, m, body.msg);
    return json(res, 200, { ok: true });
  }

  if (url.pathname === '/leave' && req.method === 'POST') {
    const body = await readBody(req);
    const p = players.get(String(body.id || ''));
    if (p) dropPlayer(p);
    return json(res, 200, { ok: true });
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => console.log(`Anifighters PvP server on port ${PORT}`));
