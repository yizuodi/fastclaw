const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');

// ============ Load Config ============
const CONFIG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CONFIG_PATH)) {
  console.error('❌ config.json not found! Copy config.example.json to config.json and fill in your values.');
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

const PORT = process.env.PORT || config.server?.port || 23456;
const HOST = config.server?.host || '0.0.0.0';
const AUTH_TOKEN = process.env.AUTH_TOKEN || config.auth?.password || '';
const GW_WS_URL = process.env.GW_WS_URL || config.gateway?.wsUrl || 'ws://127.0.0.1:18789';
const GW_TOKEN = process.env.GW_TOKEN || config.gateway?.token || '';
const SESSION_KEY = config.session?.key || 'webchat-shared';
const HISTORY_LIMIT = config.session?.historyLimit || 500;
const BRAND = config.branding || {};

// ============ State ============
const sessions = new Map();
const pendingPollReplies = new Map();
const sessionKeyMap = new Map();
const activeSessions = new Map();

let gwWs = null;
let gwReady = false;
let rpcId = 0;
const rpcPending = new Map();

// ============ Helpers ============
function base64UrlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function extractText(msg) {
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  return '';
}

function extractImages(msg) {
  const content = msg.content;
  if (!Array.isArray(content)) return [];
  const urls = [];
  for (const c of content) {
    if (c.type === 'image_url' && c.image_url?.url) urls.push(c.image_url.url);
    else if (c.type === 'image' && c.url) urls.push(c.url);
  }
  return urls;
}

// ============ Device Identity ============
const deviceIdentity = loadOrCreateIdentity();

function loadOrCreateIdentity() {
  const IDENTITY_PATH = path.join(__dirname, 'device-identity.json');
  if (fs.existsSync(IDENTITY_PATH)) return JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf8'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });
  const rawPubKey = spkiDer.subarray(ED25519_SPKI_PREFIX.length);
  const deviceId = crypto.createHash('sha256').update(rawPubKey).digest('hex');
  const identity = { deviceId, publicKeyPem: pubPem, privateKeyPem: privPem };
  fs.writeFileSync(IDENTITY_PATH, JSON.stringify(identity, null, 2));
  fs.chmodSync(IDENTITY_PATH, 0o600);
  return identity;
}

// ============ Gateway WebSocket ============
function connectGateway() {
  console.log('[GW] Connecting to', GW_WS_URL);
  gwWs = new WebSocket(GW_WS_URL);
  gwWs.on('open', () => console.log('[GW] Connected'));
  gwWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'event' && msg.event === 'connect.challenge') return sendConnect(msg.payload.nonce);
    if (msg.type === 'res') {
      if (msg.id === '0') { gwReady = msg.ok; if (!gwReady) console.error('[GW] Auth failed'); return; }
      const p = rpcPending.get(msg.id);
      if (p) { p.resolve(msg); rpcPending.delete(msg.id); }
    }
  });
  gwWs.on('close', () => { console.log('[GW] Disconnected, reconnecting...'); gwReady = false; setTimeout(connectGateway, 3000); });
  gwWs.on('error', (err) => console.error('[GW] Error:', err.message));
}

function sendConnect(nonce) {
  const { deviceId, publicKeyPem, privateKeyPem } = deviceIdentity;
  const t = Date.now();
  const v3 = ['v3', deviceId, 'cli', 'cli', 'operator', 'operator.read,operator.write', String(t), GW_TOKEN, nonce, 'linux', 'server'].join('|');
  const sig = base64UrlEncode(crypto.sign(null, Buffer.from(v3, 'utf8'), crypto.createPrivateKey(privateKeyPem)));
  gwWs.send(JSON.stringify({ type: 'req', id: '0', method: 'connect', params: {
    minProtocol: 3, maxProtocol: 3,
    client: { id: 'cli', version: '1.0.0', platform: 'linux', mode: 'cli', deviceFamily: 'server' },
    role: 'operator', scopes: ['operator.read','operator.write'], caps: [], commands: [], permissions: {},
    auth: { token: GW_TOKEN }, locale: 'zh-CN', userAgent: 'fastclaw-webchat/1.0.0',
    device: { id: deviceId, publicKey: publicKeyPem, signature: sig, signedAt: t, nonce: nonce },
  }}));
}

function sendRpc(method, params) {
  return new Promise((resolve, reject) => {
    if (!gwWs || gwWs.readyState !== WebSocket.OPEN) return reject(new Error('GW not connected'));
    const id = String(++rpcId);
    rpcPending.set(id, { resolve, reject });
    gwWs.send(JSON.stringify({ type: 'req', id, method, params }));
    setTimeout(() => { if (rpcPending.has(id)) { rpcPending.delete(id); reject(new Error('RPC timeout')); } }, 120000);
  });
}

// ============ History Poller ============
setInterval(() => {
  for (const [sid, state] of activeSessions) checkHistory(sid, state);
}, 2000);

async function checkHistory(sid, state) {
  const gwKey = sessionKeyMap.get(sid);
  if (!gwKey) return;
  const fullKey = gwKey.startsWith('agent:') ? gwKey : `agent:main:${gwKey}`;

  // 5 min safety timeout
  if (Date.now() - state.sendTime > 300000) {
    if (state.lastReplies.length > 0) {
      pendingPollReplies.set(sid, { replies: state.lastReplies, status: 'done', timestamp: Date.now() });
    } else {
      pendingPollReplies.set(sid, { replies: [{ content: [{ type: 'text', text: 'Agent timed out' }] }], status: 'done', timestamp: Date.now() });
    }
    activeSessions.delete(sid);
    console.log(`[Poller] Timeout ${sid}`);
    return;
  }

  try {
    const res = await sendRpc('chat.history', { sessionKey: fullKey, limit: HISTORY_LIMIT });
    const messages = res.payload?.messages || [];

    // Find our sent message by content (last match)
    let anchorIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const t = extractText(messages[i]);
      if (messages[i].role === 'user' && t === state.sentMessage) { anchorIdx = i; break; }
    }
    if (anchorIdx < 0) return;

    // Collect assistant/toolResult messages after the anchor
    const newReplies = [];
    for (let i = anchorIdx + 1; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === 'toolResult') {
        const text = extractText(m);
        const content = [];
        if (text) content.push({ type: 'toolResult', text: text.slice(0, 500) });
        if (content.length > 0) newReplies.push({ role: 'toolResult', content });
        continue;
      }
      if (m.role !== 'assistant') continue;
      const text = extractText(m);
      const images = extractImages(m);
      const content = [];
      if (text) content.push({ type: 'text', text });
      for (const url of images) content.push({ type: 'image', url });
      if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c.type === 'toolCall' && c.name) content.push({ type: 'toolCall', name: c.name, arguments: c.arguments });
        }
      }
      newReplies.push({ role: 'assistant', content });
    }

    if (newReplies.length === 0) return;
    const repliesJson = JSON.stringify(newReplies);

    if (repliesJson !== state.lastRepliesJson) {
      state.lastReplies = newReplies;
      state.lastRepliesJson = repliesJson;
      state.doneSince = null;
      pendingPollReplies.set(sid, { replies: newReplies, status: 'streaming', timestamp: Date.now() });
      return;
    }

    if (!state.doneSince) state.doneSince = Date.now();
    if (Date.now() - state.doneSince >= 5000) {
      pendingPollReplies.set(sid, { replies: newReplies, status: 'done', timestamp: Date.now() });
      activeSessions.delete(sid);
      console.log(`[Poller] Done ${sid} (${newReplies.length} replies)`);
    }
  } catch (err) {
    console.error('[Poller] Error:', err.message);
  }
}

// ============ HTTP Server ============
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Static files (no auth needed)
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html'))
    return serveFile(res, path.join(__dirname, 'public', 'index.html'), 'text/html');
  if (req.method === 'GET' && url.pathname === '/style.css')
    return serveFile(res, path.join(__dirname, 'public', 'style.css'), 'text/css');
  if (req.method === 'GET' && url.pathname === '/app.js')
    return serveFile(res, path.join(__dirname, 'public', 'app.js'), 'application/javascript');
  // Serve config branding to frontend
  if (req.method === 'GET' && url.pathname === '/api/config')
    return serveBranding(res);

  // Auth check for API routes
  if (AUTH_TOKEN) {
    const auth = req.headers['authorization'];
    if (auth !== `Bearer ${AUTH_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/send') return handleSend(req, res);
  if (req.method === 'GET' && url.pathname === '/api/poll') return handlePoll(req, res, url);
  if (req.method === 'GET' && url.pathname === '/api/history') return handleHistory(req, res);
  if (req.method === 'GET' && url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ gateway: gwReady ? 'connected' : 'disconnected' }));
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// ============ Handlers ============

function serveBranding(res) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    name: BRAND.name || 'FastClaw',
    emoji: BRAND.emoji || '🐾',
    avatarBot: BRAND.avatarBot || 'FC',
    avatarUser: BRAND.avatarUser || 'U'
  }));
}

function handleSend(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const { message } = JSON.parse(body);
      if (!message || !message.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Message is required' }));
      }

      const sid = SESSION_KEY;
      const trimmed = message.trim();
      if (!sessions.has(sid)) sessions.set(sid, { messages: [] });

      if (!gwReady) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Gateway not connected' }));
      }

      sendRpc('agent', {
        sessionKey: sid,
        message: trimmed,
        bestEffortDeliver: true,
        idempotencyKey: 'wc-' + crypto.randomUUID(),
      })
        .then(rpcRes => {
          const returnedKey = rpcRes.payload?.sessionKey || sid;
          sessionKeyMap.set(sid, returnedKey);
          activeSessions.set(sid, {
            sentMessage: trimmed,
            lastReplies: [],
            lastRepliesJson: '',
            doneSince: null,
            sendTime: Date.now(),
          });
          console.log(`[Agent] Sent sid=${sid} anchor="${trimmed.slice(0, 30)}"`);
        })
        .catch(err => {
          console.error('[Agent] Error:', err.message);
          pendingPollReplies.set(sid, { error: err.message, timestamp: Date.now() });
        });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessionId: sid, status: 'processing' }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
    }
  });
}

function handlePoll(req, res, url) {
  const sessionId = url.searchParams.get('sessionId');
  if (!sessionId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'sessionId required' }));
  }

  const pending = pendingPollReplies.get(sessionId);
  if (pending) {
    pendingPollReplies.delete(sessionId);
    if (pending.error) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'error', error: pending.error }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: pending.status || 'done', replies: pending.replies || [] }));
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'processing' }));
}

function handleHistory(req, res) {
  const fullKey = `agent:main:${SESSION_KEY}`;
  sendRpc('chat.history', { sessionKey: fullKey, limit: HISTORY_LIMIT })
    .then(rpcRes => {
      const messages = rpcRes.payload?.messages || [];
      const formatted = messages.map(m => {
        const parts = [];
        if (Array.isArray(m.content)) {
          for (const c of m.content) {
            if (c.type === 'text' && c.text) {
              const partType = m.role === 'toolResult' ? 'toolResult' : 'text';
              parts.push({ type: partType, text: c.text });
            } else if (c.type === 'image_url' && c.image_url?.url) {
              parts.push({ type: 'image', url: c.image_url.url });
            } else if (c.type === 'image' && c.url) {
              parts.push({ type: 'image', url: c.url });
            } else if (c.type === 'toolCall' && c.name) {
              parts.push({ type: 'toolCall', name: c.name, arguments: c.arguments });
            } else if (c.type === 'toolResult') {
              parts.push({ type: 'toolResult', text: c.text || c.content || '' });
            }
          }
        } else if (typeof m.content === 'string') {
          const partType = m.role === 'toolResult' ? 'toolResult' : 'text';
          parts.push({ type: partType, text: m.content });
        }
        return { role: m.role, content: parts, timestamp: m.timestamp };
      }).filter(m => m.content.length > 0);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages: formatted }));
    })
    .catch(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages: [] }));
    });
}

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8' });
    res.end(data);
  });
}

// ============ Start ============
console.log(`\n🚀 ${BRAND.name || 'FastClaw'} WebChat`);
console.log(`   Config: ${CONFIG_PATH}`);
console.log(`   Port: ${PORT}`);
console.log(`   Gateway: ${GW_WS_URL}`);
console.log(`   Session: ${SESSION_KEY}\n`);

connectGateway();
server.listen(PORT, HOST, () => {
  console.log(`✅ Listening on http://${HOST}:${PORT}`);
});
