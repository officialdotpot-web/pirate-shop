/**
 * Pirate Shop — TikTok LIVE bridge
 * ---------------------------------------------------------------
 * Serves the gift page and pushes real TikTok LIVE events to it
 * over Server-Sent Events. Run it next to the page:
 *
 *   cd server
 *   npm install
 *   npm start
 *
 * then open http://localhost:8787
 *
 * Endpoints
 *   GET  /                     the gift page
 *   GET  /api/health           { ok, connected, username, viewers, demo }
 *   POST /api/connect          { username, demo }   -> starts a connection
 *   POST /api/disconnect       -> stops it
 *   POST /api/demo             { type, username, comment, coins }  (demo only)
 *   GET  /api/events           Server-Sent Events stream
 */

import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 8787);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const HOME_PAGE = 'pirate-gift-shop-v8.html';
const BRIDGE_PASSWORD = process.env.BRIDGE_PASSWORD || '';
if (process.env.RENDER && !BRIDGE_PASSWORD) {
  console.error('BRIDGE_PASSWORD must be configured on Render. Refusing to start an unprotected bridge.');
  process.exit(1);
}
function authorized(req){
  if (!BRIDGE_PASSWORD) return true; // local development only
  const match = /^Basic (.+)$/i.exec(req.headers.authorization || '');
  if (!match) return false;
  let decoded; try { decoded = Buffer.from(match[1], 'base64').toString('utf8'); } catch { return false; }
  const expected = 'pirate:' + BRIDGE_PASSWORD;
  const hash = v => createHash('sha256').update(v).digest();
  return timingSafeEqual(hash(decoded), hash(expected));
}


/* ---------- live state ---------- */
const state = {
  connection: null,          // TikTokLiveConnection instance
  username: null,
  connected: false,
  connecting: false,
  viewers: 0,
  demo: false,
  demoTimer: null,
  error: null,
  startedAt: null,
  seq: 0
};

const clients = new Set();  // SSE response objects

/* turn library errors into something a human can act on */
function friendlyError(raw, username){
  const msg = String(raw || '').replace(/^Error:\s*/, '');
  const at = username ? '@' + username : 'that account';
  if (/room id|not live|offline|roomId/i.test(msg))
    return `No LIVE found for ${at} — start your LIVE on TikTok, then press Connect again.`;
  if (/user ?not ?found|does not exist|404/i.test(msg))
    return `TikTok account ${at} not found — check the spelling.`;
  if (/sign|session|cookie|token/i.test(msg))
    return `TikTok refused the session for ${at} — try again in a minute.`;
  return msg;
}

/* ---------- helpers ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.ico': 'image/x-icon'
};

function cors(res){
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function json(res, code, body){
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function broadcast(event){
  const payload = 'data: ' + JSON.stringify(event) + '\n\n';
  for (const client of clients){
    try { client.write(payload); } catch(e){ clients.delete(client); }
  }
}

function statusEvent(extra = {}){
  broadcast(Object.assign({
    type: 'status',
    seq: state.seq,
    connected: state.connected,
    connecting: state.connecting,
    username: state.username,
    viewers: state.viewers,
    demo: state.demo,
    error: state.error
  }, extra));
}

/* ---------- event normalisation ---------- */
function person(user){
  if (!user) return { username: 'viewer', nickname: 'Viewer', avatar: null };
  return {
    username: user.uniqueId || user.nickname || 'viewer',
    nickname: user.nickname || user.uniqueId || 'Viewer',
    avatar: (user.profilePicture && (user.profilePicture.url || user.profilePicture[0])) || null
  };
}

function emitChat(data){
  broadcast({ type: 'chat', user: person(data.user), comment: data.comment || '', ts: Date.now() });
}
function emitGift(data){
  // TikTok streaks emit progress and an end event. Only process the final event.
  const giftType = data.giftDetails?.giftType ?? data.giftType;
  if (Number(giftType) === 1 && !data.repeatEnd) return;
  const repeat = data.repeatCount || 1;
  const coins = (data.diamondCount || data.giftDetails?.diamondCount || 1) * repeat;
  broadcast({
    type: 'gift', user: person(data.user),
    giftName: data.giftName || data.giftDetails?.giftName || data.extendedGiftInfo?.name || 'Gift',
    giftId: data.giftId || null,
    coins, repeatCount: repeat, ts: Date.now()
  });
}
function emitJoin(data){ broadcast({ type: 'join', user: person(data.user), ts: Date.now() }); }
function emitFollow(data){ broadcast({ type: 'follow', user: person(data.user), ts: Date.now() }); }
function emitShare(data){ broadcast({ type: 'share', user: person(data.user), ts: Date.now() }); }
function emitLike(data){ broadcast({ type: 'like', user: person(data.user), count: data.likeCount || 1, ts: Date.now() }); }

/* ---------- connection ---------- */
async function connectLive(username, demo){
  disconnectLive();

  state.seq++;
  state.username = String(username || '').replace(/^@+/, '').trim();
  state.error = null;

  if (demo || !state.username){
    startDemo(state.username || 'demo_streamer');
    return;
  }

  state.connecting = true;
  statusEvent();

  let TikTokLiveConnection;
  try { ({ TikTokLiveConnection } = await import('tiktok-live-connector')); }
  catch (err){
    state.connecting = false;
    state.error = 'tiktok-live-connector is not installed — run "npm install" in the server folder.';
    statusEvent();
    return;
  }

  const connection = new TikTokLiveConnection(state.username, {
    processInitialData: false, fetchRoomInfoOnConnect: true
  });
  state.connection = connection;

  connection.on('chat', emitChat);
  connection.on('gift', emitGift);
  connection.on('member', emitJoin);
  connection.on('follow', emitFollow);
  connection.on('share', emitShare);
  connection.on('like', emitLike);
  connection.on('roomUser', data => {
    const count = data?.viewerCount ?? 0;
    if (count !== state.viewers){ state.viewers = count; broadcast({ type: 'viewers', count, ts: Date.now() }); }
  });
  connection.on('disconnect', () => {
    state.connected = false; state.connecting = false; state.connection = null;
    statusEvent({ message: 'Disconnected from TikTok' });
  });
  connection.on('error', err => {
    state.error = friendlyError(err?.message || err, state.username);
    statusEvent();
  });

  try {
    await connection.connect();
    state.connected = true;
    state.connecting = false;
    state.startedAt = Date.now();
    statusEvent();
    console.log(`[bridge] connected to @${state.username}`);
  } catch (err){
    state.connected = false;
    state.connecting = false;
    state.connection = null;
    state.error = friendlyError(err?.message || err, state.username);
    statusEvent();
    console.log('[bridge] connect failed:', state.error);
  }
}

function disconnectLive(){
  if (state.demoTimer){ clearInterval(state.demoTimer); state.demoTimer = null; }
  state.seq++;
  state.error = null;
  state.demo = false;
  if (state.connection){
    try { state.connection.disconnect(); } catch(e){}
  }
  state.connection = null;
  state.connected = false;
  state.connecting = false;
  state.viewers = 0;
  statusEvent({ message: 'Stopped' });
}

/* ---------- demo stream (for testing without a real LIVE) ---------- */
const DEMO_NAMES = ['BenFN4561','Kaptein669','xXFaze_99','MidnightMuse','NovaPlays','SlyFoxx','PixelPirate','GhostyBoi','LunaLoot','TurboTina'];
const DEMO_GIFTS = [['Rose', 1], ['TikTok', 1], ['Finger Heart', 5], ['Ice Cream Cone', 5], ['Donut', 30], ['Hand Hearts', 100], ['Money Gun', 500], ['Galaxy', 1000]];

function startDemo(username){
  state.error = null;
  state.demo = true;
  state.connected = true;
  state.connecting = false;
  state.viewers = 42;
  state.username = username;
  statusEvent();

  let tick = 0;
  state.demoTimer = setInterval(() => {
    tick++;
    const user = DEMO_NAMES[Math.floor(Math.random() * DEMO_NAMES.length)];
    const roll = Math.random();
    if (roll < 0.42){
      emitChat({ user: { uniqueId: user, nickname: user }, comment: tick % 4 === 0 ? '!gift ' + DEMO_NAMES[(tick + 3) % DEMO_NAMES.length] : 'love the stream 🔥' });
    } else if (roll < 0.78){
      const [giftName, coins] = DEMO_GIFTS[Math.floor(Math.random() * DEMO_GIFTS.length)];
      emitGift({ user: { uniqueId: user, nickname: user }, giftName, diamondCount: coins, repeatCount: 1 });
    } else if (roll < 0.9){
      emitJoin({ user: { uniqueId: user, nickname: user } });
    } else {
      emitFollow({ user: { uniqueId: user, nickname: user } });
    }
    if (Math.random() < 0.3){
      state.viewers = Math.max(1, state.viewers + Math.floor(Math.random() * 7) - 2);
      broadcast({ type: 'viewers', count: state.viewers, ts: Date.now() });
    }
  }, 2200);
}

/* ---------- static files ---------- */
async function serveFile(res, filePath){
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error('not a file');
    const data = await readFile(filePath);
    cors(res);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length
    });
    res.end(data);
  } catch(e){
    cors(res);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

/* ---------- http server ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(url.pathname);

  // Only a minimal unauthenticated liveness endpoint is public.
  if (pathname === '/healthz' && req.method === 'GET') return json(res, 200, { ok: true });
  // Prevent cross-site form requests from controlling the authenticated bridge.
  if (BRIDGE_PASSWORD && ['POST','PUT','PATCH','DELETE'].includes(req.method) && req.headers.origin){
    try { if (new URL(req.headers.origin).host !== req.headers.host) return json(res, 403, {ok:false, error:'Origin not allowed'}); }
    catch { return json(res, 403, {ok:false, error:'Origin not allowed'}); }
  }
  if (!authorized(req)){
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Pirate Shop Bridge", charset="UTF-8"', 'Cache-Control':'no-store', 'Content-Type':'text/plain; charset=utf-8' });
    return res.end('Authentication required');
  }
  if (req.method === 'OPTIONS'){ cors(res); res.writeHead(204); return res.end(); }

  /* --- api --- */
  if (pathname === '/api/health'){
    return json(res, 200, {
      ok: true, connected: state.connected, connecting: state.connecting,
      username: state.username, viewers: state.viewers, demo: state.demo, error: state.error
    });
  }

  if (pathname === '/api/gifts' && req.method === 'GET'){
    if (state.demo) return json(res, 200, { gifts: DEMO_GIFTS.map(([name, coins]) => ({name, coins})) });
    if (!state.connection || !state.connected) return json(res, 503, { gifts: [], error: 'Connect LIVE to load the available gifts.' });
    try {
      const raw = await state.connection.fetchAvailableGifts();
      const list = Array.isArray(raw) ? raw : (raw?.gifts || raw?.data?.gifts || []);
      const gifts = list.map(g => ({ id: String(g.id || g.gift_id || ''), name: g.name || g.gift_name || '', coins: Number(g.diamond_count || g.diamondCount || 0), url: typeof g.icon === 'string' ? g.icon : (g.icon?.url_list?.[0] || g.icon?.urlList?.[0] || g.icon?.url || g.image?.url_list?.[0] || '') })).filter(g => g.name);
      return json(res, 200, { gifts });
    } catch(err){ return json(res, 502, { gifts: [], error: 'TikTok gift catalog unavailable: ' + String(err.message || err) }); }
  }

  if (pathname === '/api/connect' && req.method === 'POST'){
    const body = await readBody(req);
    const username = (body.username || '').toString();
    const demo = !!body.demo;
    if (!username && !demo) return json(res, 400, { ok: false, error: 'username required' });
    connectLive(username, demo);          // fire and forget; status arrives over SSE
    return json(res, 202, { ok: true, connecting: true, username, demo });
  }

  if (pathname === '/api/disconnect' && req.method === 'POST'){
    disconnectLive();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/demo' && req.method === 'POST'){
    if (!state.demo) return json(res, 400, { ok: false, error: 'bridge is not in demo mode' });
    const body = await readBody(req);
    const user = { uniqueId: body.username || 'DemoViewer', nickname: body.username || 'DemoViewer' };
    if (body.type === 'gift') emitGift({ user, giftName: body.giftName || 'Rose', diamondCount: body.coins || 1, repeatCount: 1 });
    else emitChat({ user, comment: body.comment || 'hello' });
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/events'){
    cors(res);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');
    clients.add(res);
    res.write('data: ' + JSON.stringify({
      type: 'status', seq: state.seq, connected: state.connected, connecting: state.connecting,
      username: state.username, viewers: state.viewers, demo: state.demo, error: state.error
    }) + '\n\n');
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch(e){} }, 15000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  /* --- static --- */
  if (pathname === '/' || pathname === '') return serveFile(res, path.join(ROOT, HOME_PAGE));
  return json(res, 404, { ok: false, error: 'Not found' });
});

function readBody(req){
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch(e){ resolve({}); } });
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Pirate Shop bridge running\n  page:  http://localhost:${PORT}\n  api:   http://localhost:${PORT}/api/health\n`);
});
