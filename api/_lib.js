const crypto = require('crypto');
const E = process.env;

const DB_URL = E.UPSTASH_REDIS_REST_URL || E.KV_REST_API_URL;      // Upstash direct, or Vercel Marketplace integration
const DB_TOKEN = E.UPSTASH_REDIS_REST_TOKEN || E.KV_REST_API_TOKEN;
const upstash = async (...cmd) => {
  const r = await fetch(DB_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${DB_TOKEN}` },
    body: JSON.stringify(cmd),
  });
  return (await r.json()).result;
};


// ---- Firebase Realtime Database adapter (set DB_PROVIDER=firebase) ---------------
// Implements only the Redis-style commands this project uses.
const FB = {};
async function fbToken() {
  if (FB.tok && FB.exp > Date.now() + 60000) return FB.tok;
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const claim = b64({ iss: E.FIREBASE_CLIENT_EMAIL, scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign((E.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'), 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error('Firebase auth failed: ' + (j.error_description || j.error));
  FB.tok = j.access_token; FB.exp = Date.now() + (j.expires_in || 3600) * 1000;
  return FB.tok;
}
const k64 = s => Buffer.from(String(s)).toString('base64url'); // Firebase-safe key
async function fb(method, path, body, { q = '', headers = {} } = {}) {
  const url = `${E.FIREBASE_DB_URL.replace(/\/$/, '')}/${path}.json?${q ? q + '&' : ''}access_token=${await fbToken()}`;
  return fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
}
async function fbNode(key) {
  const r = await fb('GET', 'kv/' + k64(key), undefined, { headers: { 'X-Firebase-ETag': 'true' } });
  const node = await r.json();
  return { node: node && (!node.x || node.x > Date.now()) ? node : null, etag: r.headers.get('etag') || 'null_etag' };
}
async function fbRedis(cmd, key, ...a) {
  const path = 'kv/' + k64(key);
  switch (cmd) {
    case 'GET': { const { node } = await fbNode(key); return node ? node.v : null; }
    case 'SET': {
      const nx = a.includes('NX'), ex = a.includes('EX') ? Number(a[a.indexOf('EX') + 1]) : 0;
      const rec = { v: String(a[0]), x: ex ? Date.now() + ex * 1000 : 0 };
      if (!nx) { await fb('PUT', path, rec); return 'OK'; }
      const { node, etag } = await fbNode(key);
      if (node) return null;
      return (await fb('PUT', path, rec, { headers: { 'if-match': etag } })).ok ? 'OK' : null;
    }
    case 'INCR':
      for (let i = 0; i < 6; i++) {
        const { node, etag } = await fbNode(key);
        const n = (node ? parseInt(node.v) || 0 : 0) + 1;
        const r = await fb('PUT', path, { v: String(n), x: node ? node.x : 0 }, { headers: { 'if-match': etag } });
        if (r.ok) return n;
      }
      throw new Error('INCR conflict');
    case 'EXPIRE': await fb('PATCH', path, { x: Date.now() + Number(a[0]) * 1000 }); return 1;
    case 'DEL': await fb('DELETE', path); return 1;
    case 'LPUSH': await fb('POST', 'lists/' + k64(key), String(a[0])); return 1;
    case 'LRANGE': {
      const r = await fb('GET', 'lists/' + k64(key), undefined, { q: `orderBy=%22%24key%22&limitToLast=${Number(a[1]) + 1}` });
      const o = (await r.json()) || {};
      return Object.keys(o).sort().reverse().map(x => o[x]); // newest first
    }
    case 'LTRIM': {
      const keep = Number(a[1]) + 1;
      const ks = Object.keys((await (await fb('GET', 'lists/' + k64(key), undefined, { q: 'shallow=true' })).json()) || {}).sort();
      if (ks.length > keep) { const del = {}; ks.slice(0, ks.length - keep).forEach(x => (del[x] = null)); await fb('PATCH', 'lists/' + k64(key), del); }
      return 'OK';
    }
  }
  throw new Error('Unsupported command ' + cmd);
}
const redis = E.DB_PROVIDER === 'firebase' ? fbRedis : upstash;

const tg = async (method, body) => {
  const r = await fetch(`https://api.telegram.org/bot${E.TG_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return r.json();
};

async function bn(path, params) {
  const q = new URLSearchParams({ ...params, timestamp: Date.now(), recvWindow: 10000 }).toString();
  const sig = crypto.createHmac('sha256', E.BINANCE_API_SECRET).update(q).digest('hex');
  const r = await fetch(`https://api.binance.com${path}?${q}&signature=${sig}`, { headers: { 'X-MBX-APIKEY': E.BINANCE_API_KEY } });
  if (!r.ok) { let m = ''; try { m = (await r.json()).msg || ''; } catch { /* ignore */ } throw new Error(`Binance ${r.status}${m ? ': ' + m : ''}`); }
  return r.json();
}

const THEMES = ['ledger', 'exchange', 'pass', 'neon', 'bold', 'club'];
const DEFAULTS = {
  theme: { mode: 'fixed', fixed: 'club', rotate: [] },
  groupId: '', groupName: 'Your Group Name', tagline: 'A private community. Pay once, get instant access.',
  price: 10, supportUrl: '', plans: [],
  methods: [{ id: 'm0', label: 'USDT · TRC20', field: 'Deposit address', addr: '', note: 'Send on the TRON (TRC20) network only.' }],
};
const getSettings = async () => {
  const s = await redis('GET', 'settings');
  return { ...DEFAULTS, ...(s ? JSON.parse(s) : {}) };
};


const getJ = async k => { const v = await redis('GET', k); return v ? JSON.parse(v) : null; };
const setJ = (k, o) => redis('SET', k, JSON.stringify(o));
const send = (chat, text) => tg('sendMessage', { chat_id: chat, text, disable_web_page_preview: true });
let BOT = '';
const botName = async () => BOT || (BOT = ((await tg('getMe', {})).result || {}).username || '');
const rate = async (key, max, sec) => {
  const n = await redis('INCR', 'rl:' + key);
  if (n === 1) await redis('EXPIRE', 'rl:' + key, sec);
  return n <= max;
};

module.exports = { getJ, setJ, send, botName, rate, E, crypto, redis, tg, bn, getSettings, DEFAULTS, THEMES };
