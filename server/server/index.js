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
  seq: 0,
  desiredUsername: String(process.env.TIKTOK_USERNAME || '').replace(/^@+/, '').trim()
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

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
function originAllowed(req){
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host || ALLOWED_ORIGINS.includes(origin); }
  catch { return false; }
}
function cors(res){
  const origin = res.req?.headers.origin;
  if (origin && originAllowed(res.req)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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

/* Shared in-memory queue: maintained by the bridge even when the browser is closed. */
let queue = [], nextQueueId = 1;
let queueRules = { enabled:true, names:['Hand Hearts','Money Gun','Galaxy'], ids:['','',''] };
const MAX_QUEUE = 500;
let activeRequest=null, queueCooldown=false, completed=[];
function queueEvent(){ broadcast({type:'queue', items: queue}); pumpQueue(); }
function pumpQueue(){
  if(activeRequest || queueCooldown || !queue.length || !queue[0].fn) return;
  activeRequest={...queue[0]};
  broadcast({type:'auto_started', item:activeRequest});
  setTimeout(()=>{
    const done=activeRequest; if(!done) return;
    queue=queue.filter(item=>item.id!==done.id);
    activeRequest=null; queueCooldown=true;
    completed.unshift({...done, completedAt:Date.now()});completed=completed.slice(0,50);
    broadcast({type:'auto_done', item:done});queueEvent();
    setTimeout(()=>{queueCooldown=false;pumpQueue();},1800);
  },2000);
}
function key(v){ return String(v || '').toLocaleLowerCase().replace(/[^a-z0-9]/g,''); }
function sameUser(a,b){ return String(a || '').toLocaleLowerCase() === String(b || '').toLocaleLowerCase(); }
const CHAT_FILLER = new Set(('please pls plz plss plzzz pleasse thank thanks thankyou thankyouu you yours your yourself can could would should wanna want wanted gonna gotta doing does doesnot dont donttt just really actually maybe take pick choose send give gift gifted gifting username user epic fortnite account name named accounts mine minee hello hey hi there this that those these with without will wont from then them they their there here again againnn first next other another everyone everybody whoever someone anyone anyoneee somebody people person player players random comment comments message chat twitch tiktok live stream streamer bro bruh dude boss friend buddy man girl boy mate dude awesome amazing nice great cool pleaseee pleaseeee plssss thats thats great okay okayy yeah yess yes no nope now right left time today tonight game playing good well better best wanttt lets gooooo trying tryinggg hurry hurryup little littlee plssssssss do it for me and the you are have has its itsmy my me to is i of a an in on at up as by or if we us im am be so do for my fn epic id userr').split(' '));
function parseChatName(message){
  const text=String(message || '').trim().slice(0,200);
  if(!text) return null;
  const clean=s=>String(s || '').trim().replace(/^@+/, '');
  const valid=s=>s.length>=5 && s.length<=32 && /^[\p{L}\p{N} ._\-]+$/u.test(s);
  const explicit=text.match(/^!gift\s+(.+)$/i) || text.match(/["“]([^"”]+)["”]/);
  if(explicit){const v=clean(explicit[1]);return valid(v)?v:null;}
  const tokens=text.match(/@?[\p{L}\p{N}_.-]+/gu) || [];
  let best=null, score=-Infinity;
  for(const raw of tokens){
    const v=clean(raw).replace(/^[.\-]+|[.\-]+$/g,'');
    if(!valid(v) || CHAT_FILLER.has(v.toLocaleLowerCase()) || !/[\p{L}\p{N}]/u.test(v)) continue;
    let n=(raw.startsWith('@')?100:0)+(/[0-9_.-]/.test(v)?20:0)+(/[a-z][A-Z]/.test(v)?8:0)+Math.min(v.length,16)/10;
    if(n>=score){best=v;score=n;}
  }
  return best;
}
function matchGift(name,id){
  const n=key(name), gid=String(id || '');
  return queueRules.names.findIndex((rule,i)=>{
    const r=key(rule); if(!r) return false;
    if(r==='handheart'||r==='handhearts') return n.includes('handheart') || ['5660','5924','6968','8343'].includes(gid);
    if(gid && queueRules.ids[i]) return gid === String(queueRules.ids[i]);
    return !!n && n === r;
  });
}
function queueChat(who,comment){
  if(!queueRules.enabled || !who) return;
  const fn=parseChatName(comment); if(!fn) return;
  const existing=queue.find(x=>sameUser(x.who,who) && x.id!==activeRequest?.id);
  if(existing){ existing.fn=fn; }
  else if(activeRequest && sameUser(activeRequest.who,who)) return;
  else if(queue.length<MAX_QUEUE){ queue.push({id:String(nextQueueId++),who,fn,bundle:1,gift:null,priority:false}); }
  queueEvent();
}
function queueGift(who,name,id){
  if(!queueRules.enabled || !who) return;
  const bundle=matchGift(name,id);if(bundle<0) return;
  const index=queue.findIndex(x=>sameUser(x.who,who) && x.id!==activeRequest?.id);
  let entry=index>=0 ? queue.splice(index,1)[0] : null;
  if(!entry && queue.length>=MAX_QUEUE) return;
  if(!entry) entry={id:String(nextQueueId++),who,fn:activeRequest && sameUser(activeRequest.who,who) ? activeRequest.fn : null};
  entry.bundle=bundle;entry.gift=name;entry.priority=true;
  queue.unshift(entry);queueEvent();
}

/* ---------- event normalisation ---------- */
function person(user){
  if (!user) return { username: '', nickname: 'Viewer', avatar: null };
  return {
    username: user.uniqueId || '',
    nickname: user.nickname || user.uniqueId || 'Viewer',
    avatar: (user.profilePicture && (user.profilePicture.url || user.profilePicture[0])) || null
  };
}

function emitChat(data){
  const user=person(data.user), comment=data.comment || '';
  broadcast({ type: 'chat', user, comment, serverQueue:true, ts: Date.now() });
  queueChat(user.username,comment);
}
function emitGift(data){
  // TikTok streaks emit progress and an end event. Only process the final event.
  const giftType = data.giftDetails?.giftType ?? data.giftType;
  if (Number(giftType) === 1 && !data.repeatEnd) return;
  const repeat = data.repeatCount || 1;
  const coins = (data.diamondCount || data.giftDetails?.diamondCount || 1) * repeat;
  const user=person(data.user), giftName=data.giftName || data.giftDetails?.giftName || data.extendedGiftInfo?.name || 'Gift';
  const giftId=data.giftId || null;
  broadcast({type:'gift',user,giftName,giftId,coins,repeatCount:repeat,serverQueue:true,ts:Date.now()});
  queueGift(user.username,giftName,giftId);
}
function emitJoin(data){ broadcast({ type: 'join', user: person(data.user), ts: Date.now() }); }
function emitFollow(data){ broadcast({ type: 'follow', user: person(data.user), ts: Date.now() }); }
function emitShare(data){ broadcast({ type: 'share', user: person(data.user), ts: Date.now() }); }
function emitLike(data){ broadcast({ type: 'like', user: person(data.user), count: data.likeCount || 1, ts: Date.now() }); }

/* ---------- connection ---------- */
async function connectLive(username, demo){
  disconnectLive(false);

  state.seq++;
  const session = state.seq;
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
    if (state.seq !== session) return;
    state.connected = false; state.connecting = false; state.connection = null;
    statusEvent({ message: 'Disconnected from TikTok' });
  });
  connection.on('error', err => {
    if (state.seq !== session) return;
    state.error = friendlyError(err?.message || err, state.username);
    statusEvent();
  });

  try {
    await connection.connect();
    if (state.seq !== session){ try { await connection.disconnect(); } catch {} return; }
    state.connected = true;
    state.connecting = false;
    state.startedAt = Date.now();
    statusEvent();
    console.log(`[bridge] connected to @${state.username}`);
  } catch (err){
    if (state.seq !== session) return;
    state.connected = false;
    state.connecting = false;
    state.connection = null;
    state.error = friendlyError(err?.message || err, state.username);
    statusEvent();
    console.log('[bridge] connect failed:', state.error);
  }
}

function disconnectLive(disableAuto = true){
  if (disableAuto) state.desiredUsername = '';
  if (state.demoTimer){ clearInterval(state.demoTimer); state.demoTimer = null; }
  state.seq++;
  state.error = null;
  state.demo = false;
  if (state.connection){
    try { Promise.resolve(state.connection.disconnect()).catch(() => {}); } catch(e){}
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
  if (process.env.DEMO_RANDOM === 'false') return; // deterministic testing
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
  // Allow only the configured website origin; preflight must not require credentials.
  if (req.headers.origin && !originAllowed(req)) return json(res, 403, {ok:false, error:'Origin not allowed'});
  if (req.method === 'OPTIONS'){ cors(res); res.writeHead(204); return res.end(); }
  if (!authorized(req)){
    cors(res);
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Pirate Shop Bridge", charset="UTF-8"', 'Cache-Control':'no-store', 'Content-Type':'text/plain; charset=utf-8' });
    return res.end('Authentication required');
  }

  /* --- api --- */
  if (pathname === '/api/health'){
    return json(res, 200, {
      ok: true, connected: state.connected, connecting: state.connecting,
      username: state.username, viewers: state.viewers, demo: state.demo, error: state.error
    });
  }

  if (pathname === '/api/config' && req.method === 'GET') return json(res, 200, {ok:true, rules:queueRules});
  if (pathname === '/api/config' && req.method === 'POST'){
    const body=await readBody(req);
    if(!Array.isArray(body.names) || body.names.length!==3 || !Array.isArray(body.ids) || body.ids.length!==3) return json(res,400,{ok:false});
    queueRules={enabled:!!body.enabled,names:body.names.map(x=>String(x || '').slice(0,100)),ids:body.ids.map(x=>String(x || '').slice(0,50))};
    return json(res,200,{ok:true,rules:queueRules});
  }
  if (pathname === '/api/queue' && req.method === 'GET') return json(res,200,{ok:true,items:queue,active:activeRequest,completed});
  if (pathname === '/api/queue/remove' && req.method === 'POST'){
    const body=await readBody(req), old=queue.length;
    if(activeRequest && activeRequest.id === String(body.id || '')) return json(res,409,{ok:false,error:'Request already processing'});
    queue=queue.filter(x=>x.id!==String(body.id || ''));
    if(queue.length!==old) queueEvent();
    return json(res,200,{ok:true,removed:queue.length!==old});
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
    state.desiredUsername = demo ? '' : username.replace(/^@+/, '').trim();
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
    res.write('data: ' + JSON.stringify({type:'queue',items:queue}) + '\n\n');
    res.write('data: ' + JSON.stringify({type:'history',items:completed}) + '\n\n');
    if(activeRequest) res.write('data: ' + JSON.stringify({type:'auto_started',item:activeRequest}) + '\n\n');
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
  if (state.desiredUsername) connectLive(state.desiredUsername, false);
  setInterval(() => {
    if (state.desiredUsername && !state.connected && !state.connecting && !state.demo) {
      console.log('[bridge] retrying LIVE connection');
      connectLive(state.desiredUsername, false);
    }
  }, 60000);

});
