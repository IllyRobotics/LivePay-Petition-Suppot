'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { URL } = require('url');

// ─── Config ──────────────────────────────────────────────────────────────────

const CACHE_FILE = path.join(__dirname, 'data', 'bigo-trending.json');
const CACHE_TTL  = 60 * 60 * 1000; // 1 hour

// Realistic browser User-Agents — rotated per request
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
];

// Optional proxy rotation — set PROXY_LIST env var as comma-separated URLs
// e.g. "http://1.2.3.4:8080,http://5.6.7.8:3128"
const PROXIES = (process.env.PROXY_LIST || '')
  .split(',')
  .map(p => p.trim())
  .filter(Boolean);
let _proxyIdx = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pickUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function nextProxy() {
  if (!PROXIES.length) return null;
  return PROXIES[(_proxyIdx++) % PROXIES.length];
}

function request(targetUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    const proxy  = nextProxy();
    const parsed = new URL(targetUrl);

    let options;
    if (proxy) {
      const px = new URL(proxy);
      options = {
        hostname : px.hostname,
        port     : px.port || (px.protocol === 'https:' ? 443 : 80),
        path     : targetUrl,               // full URL as path for HTTP proxy
        method   : opts.method || 'GET',
        headers  : {
          Host             : parsed.hostname,
          'User-Agent'     : pickUA(),
          Accept           : 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          ...opts.headers,
        },
      };
    } else {
      options = {
        hostname : parsed.hostname,
        port     : parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path     : parsed.pathname + parsed.search,
        method   : opts.method || 'GET',
        headers  : {
          'User-Agent'     : pickUA(),
          Accept           : 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          Origin           : 'https://www.bigo.tv',
          Referer          : 'https://www.bigo.tv/',
          ...opts.headers,
        },
      };
    }

    const mod = (proxy ? new URL(proxy).protocol === 'https:' : parsed.protocol === 'https:') ? https : http;
    const req = mod.request(options, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Request timeout')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ─── Normalise room objects from Bigo's various response shapes ───────────────

function normalise(rooms) {
  return rooms.map(r => ({
    channel_name    : r.nick || r.nickName || r.userName || r.displayName || r.roomTopic || 'Unknown',
    username        : r.siteId || r.uid || r.userId || r.userName || '',
    is_live         : true,
    current_viewers : parseInt(r.clickCount || r.audienceCount || r.userCount || r.viewerCount || 0) || 0,
    peak_viewers    : parseInt(r.peakViewers || r.clickCount || r.audienceCount || 0) || 0,
    followers_count : parseInt(r.fanCount || r.fans || r.followers || 0) || 0,
    room_topic      : r.roomTopic || r.title || r.gameInfo?.gameName || '',
    thumbnail       : r.snapshot || r.coverUrl || r.bgImageUrl || '',   // stream screenshot
    avatar          : r.headPicture || r.avatarUrl || r.snapshot || '', // profile pic
    country         : r.countryCode || r.country || '',
  }));
}

// ─── Bigo Live API endpoints (tried in order) ─────────────────────────────────

function parseRooms(json) {
  return json.rooms || json.list || json.data || json.channelList || json.roomList || [];
}

async function tryHotNewLive(limit) {
  const body = JSON.stringify({ area: 0, page: 1, pageSize: Math.min(limit, 50) });
  const r = await request('https://www.bigo.tv/api/hotnewlive', {
    method : 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    body,
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const rooms = parseRooms(JSON.parse(r.body));
  if (!rooms.length) throw new Error('empty response');
  return normalise(rooms).slice(0, limit);
}

async function tryBgapiList(limit) {
  const body = JSON.stringify({ area: 0, page: 1, pageSize: Math.min(limit, 50), type: 1 });
  const r = await request('https://www.bigo.tv/bgapi/channel/list', {
    method : 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    body,
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const rooms = parseRooms(JSON.parse(r.body));
  if (!rooms.length) throw new Error('empty response');
  return normalise(rooms).slice(0, limit);
}

async function tryBgapiHostList(limit) {
  const body = JSON.stringify({ area: 0, page: 1, pageSize: Math.min(limit, 50), type: 1 });
  const r = await request('https://bgapi.bigo.tv/bgapi/channel/list', {
    method : 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    body,
  });
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const rooms = parseRooms(JSON.parse(r.body));
  if (!rooms.length) throw new Error('empty response');
  return normalise(rooms).slice(0, limit);
}

async function tryDiscover(limit) {
  const r = await request(
    `https://www.bigo.tv/api/discover?page=1&pageSize=${Math.min(limit, 50)}&type=1`
  );
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const rooms = parseRooms(JSON.parse(r.body));
  if (!rooms.length) throw new Error('empty response');
  return normalise(rooms).slice(0, limit);
}

async function tryOBHotLive(limit) {
  const r = await request(
    `https://www.bigo.tv/OB.WEB.WEBSITE/api/bigo/hotlive?page=0&size=${Math.min(limit, 50)}`
  );
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const rooms = parseRooms(JSON.parse(r.body));
  if (!rooms.length) throw new Error('empty response');
  return normalise(rooms).slice(0, limit);
}

async function tryOBDiscover(limit) {
  const r = await request(
    `https://www.bigo.tv/OB.WEB.WEBSITE/api/bigo/discover?page=0&size=${Math.min(limit, 50)}&type=0`
  );
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const rooms = parseRooms(JSON.parse(r.body));
  if (!rooms.length) throw new Error('empty response');
  return normalise(rooms).slice(0, limit);
}

async function fetchLive(limit) {
  const fns = [tryBgapiList, tryBgapiHostList, tryHotNewLive, tryDiscover, tryOBHotLive, tryOBDiscover];
  for (const fn of fns) {
    try {
      const data = await fn(limit);
      console.log(`[bigo-scraper] fetched ${data.length} creators via ${fn.name}`);
      return data;
    } catch (e) {
      console.warn(`[bigo-scraper] ${fn.name} failed: ${e.message}`);
    }
  }
  throw new Error('All Bigo endpoints failed');
}

// ─── Cache ────────────────────────────────────────────────────────────────────

function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (_) { return null; }
}

function writeCache(data) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ timestamp: Date.now(), data }), 'utf8');
  } catch (e) { console.error('[bigo-scraper] cache write failed:', e.message); }
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function getTrending(limit = 10, forceRefresh = false) {
  const cache = readCache();

  if (!forceRefresh && cache && (Date.now() - cache.timestamp) < CACHE_TTL) {
    return {
      data      : cache.data.slice(0, limit),
      cached    : true,
      cached_at : new Date(cache.timestamp).toISOString(),
    };
  }

  try {
    const data = await fetchLive(Math.max(limit, 20));
    writeCache(data);
    return { data: data.slice(0, limit), cached: false, fetched_at: new Date().toISOString() };
  } catch (e) {
    // Serve stale cache rather than erroring — datacenter IPs often get blocked by Bigo
    if (cache) {
      console.warn('[bigo-scraper] live fetch failed, serving stale cache:', e.message);
      return {
        data      : cache.data.slice(0, limit),
        cached    : true,
        stale     : true,
        cached_at : new Date(cache.timestamp).toISOString(),
        fetch_error: e.message,
      };
    }
    throw e; // no cache at all — let caller handle it
  }
}

// Scrape live status + stats from the public Bigo profile HTML page.
// Bigo embeds JSON state in the page — try multiple field name variants
// since the schema changes between app versions.
async function tryPageScrape(username) {
  const r = await request(`https://www.bigo.tv/${encodeURIComponent(username)}`);
  if (r.status !== 200) throw new Error(`Page HTTP ${r.status}`);
  const html = r.body;

  // Display name — try several field names
  const nickMatch = html.match(/"(?:nick|nickName|displayName|userName)"\s*:\s*"([^"]{2,80})"/);
  const nick = nickMatch ? nickMatch[1] : null;
  if (!nick || nick.toLowerCase() === username.toLowerCase())
    throw new Error('No real nick in page — likely blocked or wrong page');

  // Live status — various field names Bigo uses across versions
  const isLive = /(?:"status"\s*:\s*1(?!\d)|"isLive"\s*:\s*true|"liveStatus"\s*:\s*1(?!\d)|"isLiving"\s*:\s*true|"roomStatus"\s*:\s*1(?!\d))/.test(html);

  // Find first non-zero numeric match across a list of candidate field names
  function findNum(...keys) {
    for (const key of keys) {
      const m = html.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`));
      if (m && parseInt(m[1]) > 0) return parseInt(m[1]);
    }
    return 0;
  }
  // Find first non-empty string match
  function findStr(...keys) {
    for (const key of keys) {
      const m = html.match(new RegExp(`"${key}"\\s*:\\s*"([^"]+)"`));
      if (m && m[1]) return m[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/').replace(/\\/g, '');
    }
    return '';
  }

  const viewers   = findNum('userCount', 'audienceCount', 'viewerCount', 'clickCount', 'watcherCount');
  const fans      = findNum('fanCount', 'fans', 'followers', 'followCount', 'followerCount');
  const peakView  = findNum('peakViewers', 'maxViewers', 'highestViewers', 'maxUserCount');
  const avatar    = findStr('snapshot', 'headPicture', 'avatarUrl', 'coverUrl', 'headUrl');
  const roomTopic = findStr('roomTopic', 'title', 'streamTitle');

  return {
    channel_name    : nick,
    username,
    is_live         : isLive,
    current_viewers : viewers,
    peak_viewers    : peakView || (isLive ? viewers : 0),
    followers_count : fans,
    room_topic      : roomTopic,
    avatar,
  };
}

async function getCreator(username) {
  const uid = encodeURIComponent(username);
  // Try multiple Bigo endpoints in sequence (JSON API, then public page HTML)
  const attempts = [
    () => request(`https://www.bigo.tv/api/getRoomInfo?siteId=${uid}`),
    () => request(`https://www.bigo.tv/OB.WEB.WEBSITE/api/bigo/userinfo?siteId=${uid}`),
    () => request('https://www.bigo.tv/api/user/info', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(`{"siteId":"${username}"}`) },
      body   : `{"siteId":"${username}"}`,
    }),
  ];
  for (const attempt of attempts) {
    try {
      const r = await attempt();
      if (r.status !== 200) continue;
      const json = JSON.parse(r.body);
      const d = json.roomInfo || json.userInfo || json.data || json;
      if (!d || typeof d !== 'object') continue;
      const name = d.nick || d.nickName || d.userName || d.displayName;
      if (!name || name === username) continue; // empty / passthrough — endpoint probably blocked
      return {
        channel_name    : name,
        username,
        is_live         : d.status === 1 || d.isLive === true || d.liveStatus === 1,
        current_viewers : parseInt(d.clickCount || d.audienceCount || d.userCount || 0) || 0,
        peak_viewers    : parseInt(d.peakViewers || d.clickCount || 0) || 0,
        followers_count : parseInt(d.fanCount || d.followers || 0) || 0,
        room_topic      : d.roomTopic || d.gameInfo?.gameName || '',
        avatar          : d.snapshot || d.headPicture || d.coverUrl || d.avatarUrl || '',
      };
    } catch (_) {}
  }
  // Last resort: scrape the public profile HTML page
  try {
    return await tryPageScrape(username);
  } catch (e) {
    console.warn(`[bigo-scraper] page scrape failed for ${username}: ${e.message}`);
  }
  throw new Error(`Could not fetch creator ${username}: all endpoints blocked or returned no data`);
}

// ─── Daily auto-refresh ───────────────────────────────────────────────────────

function scheduleDailyRefresh() {
  // Refresh immediately on startup, then every 24h
  getTrending(50, true).catch(e => console.error('[bigo-scraper] startup refresh failed:', e.message));
  setInterval(() => {
    getTrending(50, true).catch(e => console.error('[bigo-scraper] daily refresh failed:', e.message));
  }, CACHE_TTL);
}

module.exports = { getTrending, getCreator, scheduleDailyRefresh, rawRequest: request };
