// Anifighters live PvP server: matchmaking + real-time shared-boss race.
// No dependencies (Node 18+). Run: node server.js
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 8787;
const MATCH_MS = +(process.env.MATCH_MS || 90000);     // length of a live match
const BOSS_BASE = 400000;                               // shared boss HP
const BOSS_PER_LV = 10000;                              // extra HP per average team level
const QUEUE_WAIT_MS = 15000;                            // after this, match with anyone
const LEVEL_RANGE = 5;                                  // preferred level gap
const MAX_HIT = 40000;                                  // max damage accepted per report
const HIT_GAP_MS = 250;                                 // min time between reports per player

const players = new Map();   // id -> { id, name, level, res, queuedAt, matchId, lastHit }
const matches = new Map();   // matchId -> match
let queue = [];
let seq = 0;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function json(res, code, obj) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function sendEvent(p, event, data) {
  if (p && p.res) p.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function startMatch(a, b) {
  const id = 'm' + (++seq) + crypto.randomBytes(3).toString('hex');
  const avgLv = Math.round((a.level + b.level) / 2);
  const hpMax = BOSS_BASE + avgLv * BOSS_PER_LV;
  const m = {
    id, players: [a, b], hpMax, hp: hpMax, dmg: { [a.id]: 0, [b.id]: 0 },
    endsAt: Date.now() + MATCH_MS, done: false, timer: null,
  };
  matches.set(id, m);
  a.matchId = id; b.matchId = id; a.queuedAt = b.queuedAt = 0;
  for (const p of [a, b]) {
    const rival = p === a ? b : a;
    sendEvent(p, 'match', { matchId: id, hpMax, endsIn: MATCH_MS, rival: { name: rival.name, level: rival.level } });
  }
  broadcast(m);
  m.timer = setTimeout(() => finish(m, 'time'), MATCH_MS);
}

function broadcast(m) {
  const msLeft = Math.max(0, m.endsAt - Date.now());
  for (const p of m.players) {
    const rival = m.players.find((x) => x !== p);
    sendEvent(p, 'state', { hp: m.hp, hpMax: m.hpMax, me: m.dmg[p.id], rival: m.dmg[rival.id], rivalName: rival.name, msLeft });
  }
}

function finish(m, reason, leaver) {
  if (m.done) return;
  m.done = true;
  clearTimeout(m.timer);
  const [a, b] = m.players;
  let winnerIds;
  if (leaver) winnerIds = [m.players.find((p) => p !== leaver).id];
  else {
    const da = m.dmg[a.id], db = m.dmg[b.id];
    winnerIds = da === db ? [a.id, b.id] : [da > db ? a.id : b.id];
  }
  for (const p of m.players) {
    const rival = m.players.find((x) => x !== p);
    sendEvent(p, 'end', { won: winnerIds.includes(p.id), reason, myDmg: m.dmg[p.id], rivalDmg: m.dmg[rival.id] });
    p.matchId = null;
  }
  matches.delete(m.id);
}

function tryMatch() {
  let found = true;
  while (found) {
    found = false;
    queue.sort((x, y) => x.level - y.level);
    const now = Date.now();
    for (let i = 0; i < queue.length && !found; i++) {
      const a = queue[i];
      let best = -1, bestGap = Infinity;
      for (let j = 0; j < queue.length; j++) {
        if (j === i) continue;
        const b = queue[j];
        const gap = Math.abs(a.level - b.level);
        const waited = now - Math.min(a.queuedAt, b.queuedAt);
        if ((gap <= LEVEL_RANGE || waited > QUEUE_WAIT_MS) && gap < bestGap) { best = j; bestGap = gap; }
      }
      if (best >= 0) {
        const b = queue[best];
        queue = queue.filter((x) => x !== a && x !== b);
        startMatch(a, b);
        found = true;
      }
    }
  }
}

function dropPlayer(p) {
  queue = queue.filter((x) => x !== p);
  if (p.matchId && matches.has(p.matchId)) finish(matches.get(p.matchId), 'forfeit', p);
  p.matchId = null;
}

setInterval(tryMatch, 1000); // also re-checks people who have waited a long time

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); return res.end(); }
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/health') return json(res, 200, { ok: true, queue: queue.length, matches: matches.size });

  if (url.pathname === '/events' && req.method === 'GET') {
    const id = String(url.searchParams.get('id') || '').slice(0, 40);
    if (!id) return json(res, 400, { error: 'id required' });
    cors(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    let p = players.get(id);
    if (p && p.res) { try { p.res.end(); } catch (e) {} dropPlayer(p); }
    p = { id, name: 'PLAYER', level: 1, res, queuedAt: 0, matchId: null, lastHit: 0 };
    players.set(id, p);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(ping);
      if (players.get(id) === p) { dropPlayer(p); players.delete(id); }
    });
    return;
  }

  if (url.pathname === '/queue' && req.method === 'POST') {
    const body = await readBody(req);
    const p = players.get(String(body.id || ''));
    if (!p || !p.res) return json(res, 400, { error: 'open /events first' });
    if (p.matchId) return json(res, 200, { ok: true, status: 'in-match' });
    p.name = String(body.name || 'PLAYER').replace(/[^\w \-]/g, '').slice(0, 14) || 'PLAYER';
    p.level = Math.max(1, Math.min(60, +body.level || 1));
    if (!queue.includes(p)) { p.queuedAt = Date.now(); queue.push(p); }
    tryMatch();
    return json(res, 200, { ok: true, status: 'queued' });
  }

  if (url.pathname === '/hit' && req.method === 'POST') {
    const body = await readBody(req);
    const p = players.get(String(body.id || ''));
    const m = p && matches.get(String(body.matchId || ''));
    if (!p || !m || m.done || !m.players.includes(p)) return json(res, 200, { ok: false });
    const now = Date.now();
    if (now - p.lastHit < HIT_GAP_MS) return json(res, 200, { ok: false, throttled: true });
    p.lastHit = now;
    const dmg = Math.min(MAX_HIT, Math.max(0, Math.floor(+body.dmg || 0)));
    m.dmg[p.id] += dmg;
    m.hp = Math.max(0, m.hp - dmg);
    broadcast(m);
    if (m.hp <= 0) finish(m, 'boss');
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
