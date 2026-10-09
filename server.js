// Anifighters live PvP server: Classic + Ranked matchmaking and real-time team duels.
// Two players fight each other live with their own teams. The server pairs players,
// relays each player's moves to the other, checks the numbers, and decides the winner.
// Co-op: two players team up against a shared boss. The server matches players on the same
// mission, keeps the boss HP, and runs the boss AI (it switches targets between the two players).
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
const PICK_MS = 45000;                               // time to pick a team and ready up

const BAD = ['fuck','shit','bitch','cunt','nigg','fag','rape','nazi','hitler','whore','slut','dick','pussy'];
function cleanName(raw) {
  let n = String(raw || '').replace(/[^\w \-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
  const t = n.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/[@4]/g, 'a').replace(/[$5]/g, 's').replace(/[^a-z]/g, '');
  if (n.length < 3 || BAD.some((w) => t.includes(w))) n = 'PLAYER' + crypto.randomBytes(2).toString('hex').toUpperCase();
  return n;
}

const players = new Map();    // id -> player
const matches = new Map();    // matchId -> match
const queues = { classic: [], ranked: [], coop: [] };
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
  const m = { id, mode, players: [a, b], endsAt: 0, done: false, timer: null, started: false };
  matches.set(id, m);
  for (const p of [a, b]) {
    p.matchId = id; p.queuedAt = 0; p.team = null; p.hpLast = null; p.pct = 1; p.lastAct = 0; p.atkMax = 1000;
  }
  for (const p of [a, b]) {
    const rival = p === a ? b : a;
    sendEvent(p, 'match', { matchId: id, mode, endsIn: DUEL_MS, rival: { name: rival.name, level: rival.level, rating: rival.rating } });
  }
  // team select: both players pick in secret and press READY (their team). If someone never readies, the match ends.
  m.timer = setTimeout(() => {
    const ready = m.players.filter((p) => p.team);
    finish(m, ready.length === 1 ? ready[0] : null, 'noready');
  }, PICK_MS);
}
function startDuel(m) {
  if (m.started) return;
  m.started = true; clearTimeout(m.timer);
  m.endsAt = Date.now() + DUEL_MS;
  for (const p of m.players) sendEvent(p, 'msg', { t: 'go', endsIn: DUEL_MS });
  m.timer = setTimeout(() => {
    const [x, y] = m.players;
    const diff = x.pct - y.pct;
    finish(m, Math.abs(diff) < 0.005 ? null : (diff > 0 ? x : y), 'time');
  }, DUEL_MS);
}

// ---------- rank points (Elo for ranked), wins and losses ----------
// Kept in memory: a server restart clears it (players re-appear as soon as they queue again).
const board = new Map();   // player id -> { id, name, rating, w, l, lv, t }
function lbTouch(p) {
  let e = board.get(p.id);
  if (!e) { e = { id: p.id, name: p.name, rating: p.rating, w: p.w || 0, l: p.l || 0, lv: p.level, t: 0 }; board.set(p.id, e); }
  e.name = p.name; e.lv = p.level; e.t = Date.now();
  if (!e.fromServer) { e.rating = p.rating; e.w = Math.max(e.w, p.w || 0); e.l = Math.max(e.l, p.l || 0); }
  return e;
}
function finish(m, winner, reason) {
  if (m.done) return;
  m.done = true;
  clearTimeout(m.timer);
  const counted = m.started && reason !== 'noready';
  const newR = new Map();
  if (counted) {
    const [a, b] = m.players;
    if (m.mode === 'ranked') {
      const ea = 1 / (1 + Math.pow(10, (b.rating - a.rating) / 400)), sa = !winner ? 0.5 : winner === a ? 1 : 0;
      const d = Math.round(32 * (sa - ea));
      newR.set(a, Math.max(0, a.rating + d)); newR.set(b, Math.max(0, b.rating - d));
    }
    for (const p of m.players) {
      const e = lbTouch(p); e.fromServer = true;
      if (newR.has(p)) { e.rating = newR.get(p); p.rating = e.rating; }
      if (winner === p) e.w++; else if (winner) e.l++;
    }
  }
  for (const p of m.players) {
    const rival = m.players.find((x) => x !== p);
    sendEvent(p, 'end', { won: winner === p, draw: !winner, reason, mode: m.mode, rival: { name: rival.name, rating: rival.rating }, myPct: p.pct, rivalPct: rival.pct, newRating: newR.has(p) ? newR.get(p) : undefined });
    p.matchId = null; p.team = null; p.party = null;
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
function pairCoop() {
  const q = queues.coop;
  for (let i = 0; i < q.length; i++) {
    const a = q[i], b = q.find((x) => x !== a && x.mission === a.mission && (x.invite || '') === (a.invite || ''));
    if (b) { queues.coop = q.filter((x) => x !== a && x !== b); startCoop(a, b); return pairCoop(); }
  }
}
function pairAll() { pairUp('classic'); pairUp('ranked'); pairCoop(); }
setInterval(pairAll, 1000);

function dropPlayer(p) {
  queues.classic = queues.classic.filter((x) => x !== p);
  queues.ranked = queues.ranked.filter((x) => x !== p);
  queues.coop = queues.coop.filter((x) => x !== p);
  if (p.matchId && matches.has(p.matchId)) {
    const m = matches.get(p.matchId);
    if (m.mode === 'coop') coopGone(m, p);
    else finish(m, m.players.find((x) => x !== p), 'forfeit');
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
      if (m.players.every((x) => x.team)) startDuel(m);
      break;
    }
    case 'party': {
      if (m.started || !Array.isArray(msg.ids) || p.party) return;
      p.party = msg.ids.slice(0, 6).map((v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 14)).filter(Boolean);
      sendEvent(other, 'msg', { t: 'party', ids: p.party });
      break;
    }
    case 'stun': {
      // a parry dizzies the rival's active fighter on their screen
      if (!p.team || !m.started) return;
      const now = Date.now();
      if (now - (p.lastStun || 0) < 1500) return;
      p.lastStun = now;
      sendEvent(other, 'msg', { t: 'stun' });
      break;
    }
    case 'act': {
      if (!p.team || !m.started) return;
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


// ---------- co-op: 2 players vs a shared boss ----------
const COOP_MAX_MS = 420000;
const rnd = (a, b) => a + Math.random() * (b - a);
function coopSend(m, event, data) { for (const p of m.players) if (!p.gone) sendEvent(p, event, data); }
function startCoop(a, b) {
  const id = 'c' + (++seq) + crypto.randomBytes(3).toString('hex');
  const ms = Math.min(COOP_MAX_MS, a.coopMs || 240000);
  const m = { id, mode: 'coop', mission: a.mission, players: [a, b], ms, tempo: a.tempo || 1, boss: { hp: 0, max: 0 }, started: false, done: false,
    timer: null, ai: null, lastT: -1, ultMarks: [0.7, 0.35], endsAt: 0 };
  matches.set(id, m);
  [a, b].forEach((p, i) => {
    p.matchId = id; p.queuedAt = 0; p.team = null; p.hpLast = null; p.pct = 1; p.lastAct = 0; p.lastDmg = 0; p.atkMax = 1000;
    p.slot = i; p.down = false; p.gone = false; p.prop = 0;
  });
  [a, b].forEach((p) => {
    const o = p === a ? b : a;
    sendEvent(p, 'match', { matchId: id, mode: 'coop', mission: m.mission, slot: p.slot, endsIn: ms, rival: { name: o.name, level: o.level } });
  });
  // if the partner never sends a team, end the match
  m.timer = setTimeout(() => { if (!m.started) finishCoop(m, false, 'nostart'); }, PICK_MS);
}
function coopGo(m) {
  m.started = true; clearTimeout(m.timer);
  m.boss.max = m.boss.hp = m.players.reduce((s, p) => s + p.prop, 0);
  m.endsAt = Date.now() + m.ms;
  coopSend(m, 'msg', { t: 'cgo', hp: m.boss.hp, endsIn: m.ms });
  m.next = Math.random() < 0.5 ? 0 : 1;
  coopSend(m, 'msg', { t: 'tgt', who: m.next });
  m.timer = setTimeout(() => finishCoop(m, false, 'time'), m.ms + 2500);
  m.ai = setTimeout(() => bossTick(m), 4500);
}
function bossTick(m) {
  if (m.done) return;
  const alive = m.players.filter((p) => !p.down && !p.gone);
  if (!alive.length) return finishCoop(m, false, 'ko');
  // attack the fighter marked as the target, then pick (and announce) the next one - usually the other player
  const t = alive.find((p) => p.slot === m.next) || alive[0];
  m.lastT = t.slot;
  const frac = m.boss.max ? m.boss.hp / m.boss.max : 1;
  let k, wait = rnd(2.4, 3.8) * m.tempo;
  if (m.ultMarks.length && frac <= m.ultMarks[0]) { m.ultMarks.shift(); k = 'ult'; wait += 4; }
  else { const r = Math.random(); k = r < 0.5 ? 'strike' : r < 0.8 ? 'blast' : 'special'; }
  coopSend(m, 'msg', { t: 'batk', who: t.slot, k });
  m.next = alive.length === 2 ? (Math.random() < 0.3 ? t.slot : 1 - t.slot) : alive[0].slot;
  setTimeout(() => { if (!m.done) coopSend(m, 'msg', { t: 'tgt', who: m.next }); }, 900);
  m.ai = setTimeout(() => bossTick(m), wait * 1000);
}
function coopGone(m, p) {
  p.gone = true; p.matchId = null;
  const o = m.players.find((x) => x !== p);
  if (!m.started || o.gone || o.down) return finishCoop(m, false, 'left');
  sendEvent(o, 'msg', { t: 'gone' });
  if (m.next === p.slot) { m.next = o.slot; sendEvent(o, 'msg', { t: 'tgt', who: o.slot }); }
}
function finishCoop(m, won, reason) {
  if (m.done) return;
  m.done = true; clearTimeout(m.timer); clearTimeout(m.ai);
  const bossPct = m.boss.max ? Math.max(0, m.boss.hp) / m.boss.max : 1;
  for (const p of m.players) {
    if (!p.gone) sendEvent(p, 'end', { won, reason, mode: 'coop', bossPct });
    p.matchId = null; p.team = null;
  }
  matches.delete(m.id);
}
function relayCoop(p, m, msg) {
  const o = m.players.find((x) => x !== p);
  if (!msg || typeof msg !== 'object' || p.gone) return;
  const toO = (d) => { if (!o.gone) sendEvent(o, 'msg', d); };
  switch (msg.t) {
    case 'team': {
      if (p.team || !Array.isArray(msg.team)) return;
      const team = msg.team.slice(0, 3).map((f) => ({
        id: String((f && f.id) || 'kairo').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 14) || 'kairo',
        hp: num(f && f.hp, 1, MAX_HP), atk: num(f && f.atk, 1, MAX_ATK), lv: num(f && f.lv, 1, 60), st: num(f && f.st, 1, 14),
      }));
      if (!team.length) return;
      p.team = team; p.hpLast = team.map((f) => f.hp); p.atkMax = Math.max(...team.map((f) => f.atk));
      const avg = team.reduce((s, f) => s + f.atk, 0) / team.length;
      p.prop = num(msg.bossHp, 1000, avg * 200);
      toO({ t: 'team', team, name: p.name, level: p.level });
      if (m.players.every((x) => x.team)) coopGo(m);
      break;
    }
    case 'pick': {
      if (m.started || !Array.isArray(msg.sel)) return;
      const sel = msg.sel.slice(0, 3).map((v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 14)).filter(Boolean);
      toO({ t: 'pick', sel });
      break;
    }
    case 'act': {
      if (!m.started) return;
      const now = Date.now();
      if (now - p.lastAct < 300) return;
      p.lastAct = now;
      const k = ['strike', 'blast', 'special', 'ult'].includes(msg.k) ? msg.k : 'strike';
      toO({ t: 'act', k });
      break;
    }
    case 'dmg': {
      if (!m.started || p.down) return;
      const now = Date.now();
      if (now - p.lastDmg < 100) return;
      p.lastDmg = now;
      const d = num(msg.d, 0, p.atkMax * 12);
      if (!d) return;
      m.boss.hp = Math.max(0, m.boss.hp - d);
      coopSend(m, 'msg', { t: 'boss', hp: m.boss.hp });
      if (m.boss.hp <= 0) finishCoop(m, true, 'boss');
      break;
    }
    case 'st': {
      if (!p.team || !Array.isArray(msg.hps)) return;
      const hps = p.team.map((f, i) => Math.min(num(msg.hps[i], 0, f.hp), p.hpLast[i]));
      p.hpLast = hps;
      const a = num(msg.a, 0, p.team.length - 1);
      toO({ t: 'st', hps, a });
      if (hps.every((v) => v <= 0)) {
        p.down = true;
        if (m.players.every((x) => x.down || x.gone)) finishCoop(m, false, 'ko');
        else if (m.next === p.slot) { m.next = o.slot; coopSend(m, 'msg', { t: 'tgt', who: o.slot }); }
      }
      break;
    }
    case 'lost': {
      p.down = true;
      if (m.players.every((x) => x.down || x.gone)) finishCoop(m, false, 'ko');
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
  if (req.method !== 'POST' || !['/me', '/status', '/friend', '/chat', '/invite'].includes(p)) return false;
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
  if (p === '/invite') {
    // co-op invites between friends: invite / decline / cancel
    if (now - (u.lastInv || 0) < 700) { json(res, 429, { error: 'slow down' }); return true; }
    u.lastInv = now;
    const allowed = t.claims.has(u.uid) || (t.claims.size === 0 && u.claims.has(t.uid)) || u.claims.has(t.uid);
    if (!allowed) { json(res, 403, { error: 'not friends' }); return true; }
    const token = /^[a-f0-9]{8,24}$/.test(String(body.token || '')) ? String(body.token) : '';
    const mission = /^[cr]\d{1,2}$/.test(String(body.mission || '')) ? String(body.mission) : 'c1';
    if (body.action === 'invite') {
      if (!t.res) { json(res, 200, { ok: false, offline: true }); return true; }
      deliver(t, 'coopinv', { from: pub(u), mission, token });
    } else if (body.action === 'decline') deliver(t, 'coopdec', { from: pub(u), token, busy: !!body.busy });
    else if (body.action === 'cancel') { if (t.res) deliver(t, 'coopcan', { from: pub(u), token }); }
    else { json(res, 400, { error: 'bad action' }); return true; }
    json(res, 200, { ok: true });
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

  if (url.pathname === '/health') return json(res, 200, { ok: true, classic: queues.classic.length, ranked: queues.ranked.length, coop: queues.coop.length, matches: matches.size, online: [...users.values()].filter((u) => u.res).length });
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
    const mode = body.mode === 'ranked' ? 'ranked' : body.mode === 'coop' ? 'coop' : 'classic';
    p.name = cleanName(body.name);
    p.level = num(body.level, 1, 60);
    p.rating = num(body.rating, 0, 5000);
    p.w = num(body.w, 0, 1e6); p.l = num(body.l, 0, 1e6);
    if (body.mode === 'ranked' || body.mode === 'classic') { const e = lbTouch(p); if (e.fromServer) p.rating = e.rating; }
    if (mode === 'coop') {
      p.mission = /^[cr]\d{1,2}$/.test(String(body.mission || '')) ? String(body.mission) : 'c1';
      p.coopMs = num(body.time, 60, 400) * 1000;
      p.tempo = Math.max(0.5, Math.min(1.5, +body.tempo || 1));
      p.invite = /^[a-f0-9]{8,24}$/.test(String(body.invite || '')) ? String(body.invite) : '';   // private match with a friend
    }
    queues.classic = queues.classic.filter((x) => x !== p);
    queues.ranked = queues.ranked.filter((x) => x !== p);
    queues.coop = queues.coop.filter((x) => x !== p);
    p.queuedAt = Date.now();
    queues[mode].push(p);
    pairAll();
    return json(res, 200, { ok: true, status: 'queued', mode });
  }

  if (url.pathname === '/send' && req.method === 'POST') {
    const body = await readBody(req);
    const p = players.get(String(body.id || ''));
    const m = p && matches.get(String(body.matchId || ''));
    if (!p || !m || m.done || !m.players.includes(p) || p.gone) return json(res, 200, { ok: false });
    if (m.mode === 'coop') relayCoop(p, m, body.msg); else relay(p, m, body.msg);
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
