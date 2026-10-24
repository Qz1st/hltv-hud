// HLTV Score Widget — v3 (локально в exe и на сервере)
//
// ЛОКАЛЬНО (exe на своём ПК):
//   Плашка: http://localhost:<порт>/widget     Пульт: http://localhost:<порт>/
// НА СЕРВЕРЕ (CLOUD=1 или хостинг Render):
//   Главная  https://<домен>/              — кнопка «Новый худ»
//   Плашка   https://<домен>/w/<id>        — в OBS
//   Пульт    https://<домен>/p/<id>/<ключ> — управление (ключ = пароль худа)
//
// Данные: прямой запрос к странице матча HLTV; если Cloudflare блокирует — невидимый
// Chrome/Edge (если есть). Раунды — вживую из скорбота HLTV.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

// ---------- окружение ----------
const exeName = path.basename(process.execPath).toLowerCase();
const IS_EXE = !/^(node|bun)(\.exe)?$/.test(exeName);
const IS_WIN = process.platform === 'win32';
const CLOUD = process.env.CLOUD === '1' || !!process.env.RENDER;
const BASE_DIR = process.env.WIDGET_DIR || process.env.DATA_DIR || (IS_EXE ? path.dirname(process.execPath) : __dirname);
const APP_ID = 'hltv-score-widget';
const VERSION = '3.0.0';
const DEFAULT_PORT = 52713;
const HLTV_BASE = (process.env.HLTV_BASE || 'https://www.hltv.org').replace(/\/$/, '');
const MOCK = process.env.MOCK === '1' || process.argv.includes('--demo');
const MATCH_POLL_MS = Number(process.env.POLL_MS) || 30000;
const BROWSER_READ_MS = 3000;
const BROWSER_RELOAD_MS = 120000;
const IDLE_MS = 3 * 60000;          // худ никто не смотрит 3 мин — перестаём дёргать HLTV
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 40;
const BROWSER_ALLOWED = process.env.BROWSER_FALLBACK !== '0';
const CONFIG_FILE = path.join(BASE_DIR, 'config.json');
const ROOMS_FILE = path.join(BASE_DIR, 'rooms.json');
const LOG_FILE = path.join(BASE_DIR, 'hltv-widget.log');
const FIRST_RUN = !CLOUD && !fs.existsSync(CONFIG_FILE);

if (IS_EXE || process.env.LOG_TO_FILE) {
  try { if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1e6) fs.unlinkSync(LOG_FILE); } catch {}
  const write = (lvl) => (...a) => { try { fs.appendFileSync(LOG_FILE, `[${new Date().toLocaleString()}] ${lvl}${a.join(' ')}\n`); } catch {} };
  console.log = write(''); console.error = write('ERROR ');
}
console.log(`=== HLTV Score Widget ${VERSION} ${CLOUD ? 'СЕРВЕР' : 'локально'}, папка: ${BASE_DIR}`);

let cheerio, io;
try { cheerio = require('cheerio'); } catch (e) { console.error('cheerio:', e.message); }
try { io = require('socket.io-client'); } catch (e) { console.error('socket.io-client:', e.message); }

let ASSETS = {};
try { ASSETS = require('./assets.js'); } catch {}
function getPage(name) {
  try { return fs.readFileSync(path.join(__dirname, 'public', name), 'utf8'); } catch {}
  return ASSETS[name] || null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- секрет для ключей пультов ----------
const SECRET = (() => {
  if (process.env.SECRET) return process.env.SECRET;
  const f = path.join(BASE_DIR, 'secret.txt');
  try { const s = fs.readFileSync(f, 'utf8').trim(); if (s) return s; } catch {}
  const s = crypto.randomBytes(24).toString('hex');
  try { fs.writeFileSync(f, s); } catch { if (CLOUD) console.error('ВНИМАНИЕ: нет SECRET и некуда сохранить — ссылки на пульты сменятся после перезапуска'); }
  return s;
})();
const keyFor = (id) => crypto.createHmac('sha256', SECRET).update('hud:' + id).digest('base64url').slice(0, 16);
const validId = (id) => typeof id === 'string' && (/^[a-z0-9]{6,16}$/.test(id) || (id === 'local' && !CLOUD));
function safeEq(a, b) { a = Buffer.from(String(a || '')); b = Buffer.from(String(b || '')); return a.length === b.length && crypto.timingSafeEqual(a, b); }

// ---------- HTTP-загрузчик ----------
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const cookieJar = new Map();
function fetchUrl(url, { timeout = 20000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const cookie = [...cookieJar.entries()].map(([k, v]) => k + '=' + v).join('; ');
    const req = mod.request(u, {
      method: 'GET', timeout,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache', 'Pragma': 'no-cache',
        'Sec-Ch-Ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0', 'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none', 'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1',
        ...(cookie ? { Cookie: cookie } : {})
      }
    }, (res) => {
      for (const c of [].concat(res.headers['set-cookie'] || [])) { const m = String(c).match(/^([^=;\s]+)=([^;]*)/); if (m) cookieJar.set(m[1], m[2]); }
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(fetchUrl(new URL(res.headers.location, u).href, { timeout, redirects: redirects - 1 }));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
        } catch (e) { return reject(new Error('распаковка: ' + e.message)); }
        resolve({ statusCode: res.statusCode, headers: res.headers, body: buf });
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
async function httpJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, timeout: 3000 }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('timeout'))); req.end();
  });
}

// ---------- утилиты ----------
const MAP_NAMES = { mirage: 'Mirage', inferno: 'Inferno', nuke: 'Nuke', ancient: 'Ancient', anubis: 'Anubis', dust2: 'Dust2', train: 'Train', overpass: 'Overpass', vertigo: 'Vertigo', cache: 'Cache', tba: 'TBA' };
const mapKey = (m) => String(m || '').toLowerCase().replace(/^de_/, '').replace(/[^a-z0-9]/g, '');
const prettyMap = (m) => { if (!m) return null; const k = mapKey(m); return MAP_NAMES[k] || (k.charAt(0).toUpperCase() + k.slice(1)); };
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function isFinalScore(a, b) {
  const hi = Math.max(a, b), lo = Math.min(a, b);
  if (hi === 13) return lo <= 11;
  if (hi > 13 && (hi - 13) % 3 === 0) return hi - lo >= 2 && lo >= hi - 4;
  return false;
}
function absUrl(u) {
  if (!u) return null;
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('/')) return HLTV_BASE + u;
  return u;
}
function isChallenge(html) {
  return /<title>\s*(Just a moment|Attention Required|Один момент)/i.test(html) || (/cf-browser-verification|challenge-platform|cf_chl_/i.test(html) && !/teamsBox|team1-gradient/.test(html));
}
function parseMatchId(input) {
  if (input == null) return null;
  const s = String(input).trim();
  const m = s.match(/matches\/(\d+)/) || s.match(/^(\d{4,})$/);
  return m ? Number(m[1]) : null;
}
function humanError(e) {
  const msg = String(e && e.message || e);
  if (msg === 'CLOUDFLARE') return 'HLTV (Cloudflare) не пускает запрос. Включите ручной режим — программа продолжит пробовать в фоне.';
  if (msg === 'NO_BROWSER') return CLOUD ? 'HLTV блокирует запросы с этого сервера. Включите ручной режим.' : 'HLTV блокирует прямые запросы, а Microsoft Edge/Chrome не найден. Установите Edge или включите ручной режим.';
  if (msg === '404') return 'Матч не найден — проверьте ссылку.';
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|timeout|network/i.test(msg)) return 'Нет соединения с HLTV (' + msg.slice(0, 60) + ').';
  return msg.slice(0, 200);
}

// ---------- разбор страницы матча ----------
function parseMatchPage(html) {
  if (!cheerio) throw new Error('внутренняя ошибка: нет cheerio');
  const $ = cheerio.load(html);
  if (!$('.team1-gradient').length && !$('.mapholder').length) {
    if (isChallenge(html)) { const e = new Error('CLOUDFLARE'); e.cloudflare = true; throw e; }
    const t = $('title').text().trim();
    if (/404|not found/i.test(t) || /page not found/i.test(html)) throw new Error('404');
    throw new Error('Не удалось разобрать страницу матча (' + (t || 'пусто') + ')');
  }
  const team = (n) => {
    const g = $(`.team${n}-gradient`);
    const name = g.find('.teamName').first().text().trim() || null;
    const href = g.find('a').first().attr('href') || '';
    const id = Number((href.match(/\/team\/(\d+)/) || [])[1]) || null;
    const imgs = g.find('img.logo, img');
    let logo = null;
    imgs.each((_, el) => { const c = $(el).attr('class') || ''; if (!logo && /night-only/.test(c)) logo = $(el).attr('src'); });
    if (!logo) imgs.each((_, el) => { const c = $(el).attr('class') || ''; if (!logo && !/day-only|flag/.test(c)) logo = $(el).attr('src'); });
    if (!logo && imgs.length) logo = imgs.first().attr('src');
    if (logo && /placeholder/.test(logo)) logo = null;
    return { name, id, logo: absUrl(logo) };
  };
  const t1 = team(1), t2 = team(2);
  const countdown = $('.countdown').first().text().trim().toLowerCase();
  const status = /live/.test(countdown) ? 'live' : /over|postponed|deleted/.test(countdown) ? 'over' : 'scheduled';
  const fmt = $('.preformatted-text').first().text();
  const bo = Number((fmt.match(/best of\s*(\d)/i) || [])[1]) || null;
  const event = $('.timeAndEvent .event a').first().text().trim() || $('.event a').first().text().trim() || null;
  const maps = [];
  $('.mapholder').each((_, el) => {
    const m = $(el);
    const name = prettyMap(m.find('.mapname').first().text().trim());
    const L = m.find('.results-left').first(), R = m.find('.results-right').first();
    const a = parseInt(L.find('.results-team-score').first().text().trim(), 10);
    const b = parseInt(R.find('.results-team-score').first().text().trim(), 10);
    const has = Number.isFinite(a) && Number.isFinite(b);
    const wonCls = L.hasClass('won') || R.hasClass('won') || L.hasClass('lost') || R.hasClass('lost');
    const done = has && (wonCls || isFinalScore(a, b));
    let winner = null;
    if (done) winner = L.hasClass('won') ? 1 : R.hasClass('won') ? 2 : (a > b ? 1 : b > a ? 2 : null);
    maps.push({ name, score: has ? [a, b] : null, done, winner });
  });
  const sbEl = $('#scoreboardElement');
  const scorebotUrl = (sbEl.attr('data-scorebot-url') || '').split(',').map((s) => s.trim()).filter(Boolean).pop() || null;
  const scorebotId = sbEl.attr('data-scorebot-id') || null;
  return { t1, t2, status, bo, event, maps, scorebotUrl, scorebotId };
}

async function loadDirect(url) {
  const res = await fetchUrl(url);
  const body = res.body.toString('utf8');
  if (res.statusCode === 403 || res.statusCode === 503 || isChallenge(body)) { const e = new Error('CLOUDFLARE'); e.cloudflare = true; throw e; }
  if (res.statusCode === 404) throw new Error('404');
  if (res.statusCode >= 400) throw new Error('HTTP ' + res.statusCode);
  return body;
}

// ---------- невидимый Chrome/Edge (один процесс, вкладка на каждый худ) ----------
function findBrowser() {
  if (!BROWSER_ALLOWED) return null;
  const c = [];
  if (process.env.BROWSER_PATH) c.push(process.env.BROWSER_PATH);
  if (IS_WIN) {
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const la = process.env['LOCALAPPDATA'] || '';
    c.push(path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      la && path.join(la, 'Google', 'Chrome', 'Application', 'chrome.exe'), la && path.join(la, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  } else {
    c.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/microsoft-edge',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  }
  return c.filter(Boolean).find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

const browserProc = {
  proc: null, port: 0, visible: false, starting: null,
  get alive() { return !!this.proc; },
  async ensure(visible = false) {
    if (this.proc && this.visible === visible) return;
    if (this.starting) return this.starting;
    this.starting = this._start(visible).finally(() => { this.starting = null; });
    return this.starting;
  },
  async _start(visible) {
    this.stop();
    const exe = findBrowser();
    if (!exe) throw new Error('NO_BROWSER');
    this.visible = visible;
    this.port = 20000 + Math.floor(Math.random() * 20000);
    const args = [
      `--remote-debugging-port=${this.port}`, '--remote-allow-origins=*', `--user-data-dir=${path.join(BASE_DIR, 'browser-profile')}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--mute-audio',
      '--disable-features=msEdgeSidebarV2,msHubApps,Translate,MediaRouter', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--window-size=1280,900',
      '--disable-dev-shm-usage', '--blink-settings=imagesEnabled=false'
    ];
    if (visible) args.push('--window-position=-2400,-2400'); else args.push('--headless=new', '--disable-gpu');
    if ((process.getuid && process.getuid() === 0) || CLOUD) args.push('--no-sandbox');
    args.push('about:blank');
    console.log('[browser] запуск', exe, visible ? '(скрытое окно)' : '(headless)');
    const p = spawn(exe, args, { windowsHide: true, stdio: 'ignore' });
    this.proc = p;
    p.on('exit', (code) => { console.log('[browser] завершён', code); if (this.proc === p) this.proc = null; });
    p.on('error', (e) => console.error('[browser] spawn:', e.message));
    for (let i = 0; i < 60; i++) {
      await sleep(250);
      try { await httpJson(`http://127.0.0.1:${this.port}/json/version`); console.log('[browser] готов'); return; } catch {}
    }
    this.stop();
    throw new Error('браузер не запустился');
  },
  async newTarget() {
    const t = await httpJson(`http://127.0.0.1:${this.port}/json/new?about:blank`, 'PUT').catch(() => httpJson(`http://127.0.0.1:${this.port}/json/new?about:blank`));
    return t;
  },
  stop() {
    if (this.proc) {
      const pid = this.proc.pid;
      try { this.proc.kill(); } catch {}
      if (IS_WIN && pid) execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
      this.proc = null;
    }
  }
};

class Tab {
  constructor(onFrame) { this.ws = null; this.msgId = 0; this.pending = new Map(); this.url = null; this.loadedAt = 0; this.onFrame = onFrame; this.targetId = null; this.procPort = 0; }
  get alive() { return !!(this.ws && this.ws.readyState === 1 && browserProc.alive && browserProc.port === this.procPort); }
  async open() {
    const t = await browserProc.newTarget();
    this.targetId = t.id; this.procPort = browserProc.port;
    await new Promise((resolve, reject) => {
      const WS = globalThis.WebSocket || require('ws');
      const ws = new WS(t.webSocketDebuggerUrl);
      this.ws = ws;
      const to = setTimeout(() => reject(new Error('CDP timeout')), 8000);
      ws.onopen = () => { clearTimeout(to); resolve(); };
      ws.onerror = (e) => { clearTimeout(to); reject(new Error('CDP: ' + (e.message || 'ошибка'))); };
      ws.onclose = () => { if (this.ws === ws) this.ws = null; for (const p of this.pending.values()) p.reject(new Error('CDP закрыт')); this.pending.clear(); };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
        if (m.id && this.pending.has(m.id)) {
          const p = this.pending.get(m.id); this.pending.delete(m.id);
          m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result || {});
        } else if (m.method === 'Network.webSocketFrameReceived' && this.onFrame) {
          try { this.onFrame(m.params.response.payloadData); } catch {}
        }
      };
    });
    await this.send('Page.enable'); await this.send('Network.enable'); await this.send('Runtime.enable');
    try {
      const v = await this.send('Browser.getVersion');
      const ua = String(v.userAgent || '').replace(/HeadlessChrome/g, 'Chrome').replace(/Headless/g, '');
      await this.send('Network.setUserAgentOverride', { userAgent: ua, acceptLanguage: 'ru-RU,ru;q=0.9,en;q=0.8', platform: IS_WIN ? 'Win32' : 'Linux x86_64' });
    } catch {}
    this.url = null;
  }
  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('CDP не подключён'));
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' timeout')); } }, 20000);
    });
  }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result ? r.result.value : undefined; }
  async navigate(url) { this.url = url; this.loadedAt = Date.now(); await this.send('Page.navigate', { url }); return this.waitForMatchPage(); }
  async reload() { this.loadedAt = Date.now(); await this.send('Page.reload', { ignoreCache: true }); return this.waitForMatchPage(); }
  async html() { return (await this.eval('document.documentElement.outerHTML')) || ''; }
  async waitForMatchPage(timeoutMs = 30000) {
    const until = Date.now() + timeoutMs;
    let html = '';
    while (Date.now() < until) {
      await sleep(700);
      try {
        html = await this.html();
        if (/team1-gradient|mapholder/.test(html) && !isChallenge(html)) return html;
        if (/page not found|404 - /i.test(html) && !isChallenge(html)) throw new Error('404');
      } catch (e) { if (e.message === '404') throw e; }
    }
    if (isChallenge(html)) { const e = new Error('CLOUDFLARE'); e.cloudflare = true; throw e; }
    throw new Error('страница матча не загрузилась');
  }
  close() {
    try { this.ws && this.ws.close(); } catch {}
    this.ws = null;
    if (this.targetId && browserProc.alive && browserProc.port === this.procPort) httpJson(`http://127.0.0.1:${browserProc.port}/json/close/${this.targetId}`).catch(() => {});
    this.targetId = null;
  }
}

// ---------- худ (комната) ----------
const defaultCfg = () => ({
  source: 'auto', matchId: null, manual: false,
  manualData: { team1: 'TEAM 1', team2: 'TEAM 2', maps1: 0, maps2: 0, rounds1: 0, rounds2: 0, map: '', bestOf: 3 },
  display: { showLogos: true, showMap: true }
});
const emptyState = () => ({
  status: 'idle', error: null, team1: null, team2: null, team1Id: null, team2Id: null, logo1: null, logo2: null,
  maps1: 0, maps2: 0, rounds1: null, rounds2: null, side1: null, side2: null, round: null, map: null,
  bestOf: null, event: null, mapsList: [], scorebot: 'off', source: null, updatedAt: null
});
function mergeCfg(c) {
  const d = defaultCfg();
  c = c && typeof c === 'object' ? c : {};
  const out = { ...d, ...pick(c, ['source', 'matchId', 'manual']), manualData: { ...d.manualData, ...(c.manualData || {}) }, display: { ...d.display, ...(c.display || {}) } };
  if (!['auto', 'direct', 'browser'].includes(out.source)) out.source = 'auto';
  out.matchId = parseMatchId(out.matchId);
  out.manual = !!out.manual;
  for (const k of Object.keys(out.manualData)) if (typeof out.manualData[k] === 'string') out.manualData[k] = out.manualData[k].slice(0, 40);
  return out;
}
function pick(o, keys) { const r = {}; for (const k of keys) if (k in o) r[k] = o[k]; return r; }

class Room {
  constructor(id, cfg) {
    this.id = id; this.cfg = mergeCfg(cfg); this.state = emptyState();
    this.timer = null; this.busy = false; this.gen = 0; this.useBrowser = false;
    this.sb = null; this.sbFor = null; this.lastSb = null; this.tab = null; this.mockTimer = null;
    this.lastSeen = Date.now(); this.paused = true;
  }
  touch() {
    this.lastSeen = Date.now();
    if (this.paused) { this.paused = false; if (this.cfg.matchId && !this.cfg.manual) this.setMatch(this.cfg.matchId, true); }
  }
  pause() {
    if (this.paused) return;
    console.log(`[${this.id}] никто не смотрит — пауза`);
    this.paused = true; this.stopLive();
    if (this.timer) clearTimeout(this.timer);
  }
  stopLive() { this.stopScorebot(); this.stopMock(); if (this.tab) { this.tab.close(); this.tab = null; } }
  destroy() { this.paused = true; this.stopLive(); if (this.timer) clearTimeout(this.timer); }

  save() { saveRooms(); }

  // --- скорбот ---
  connectScorebot(url, listId) {
    const key = url + '|' + listId;
    if (this.sbFor === key && this.sb) return;
    this.stopScorebot();
    if (!io || !url || !listId) return;
    this.sbFor = key; this.state.scorebot = 'connecting';
    console.log(`[${this.id}] скорбот`, url, listId);
    try {
      const s = io.connect(url, { reconnection: true, reconnectionDelay: 3000, timeout: 15000, transports: ['websocket', 'polling'], forceNew: true });
      this.sb = s;
      const init = JSON.stringify({ token: '', listId });
      s.on('connect', () => { this.state.scorebot = 'on'; s.emit('readyForMatch', init); });
      s.on('reconnect', () => s.emit('readyForMatch', init));
      s.on('scoreboard', (d) => { this.state.scorebot = 'on'; try { this.applyScoreboard(typeof d === 'string' ? JSON.parse(d) : d); } catch {} });
      s.on('disconnect', () => { if (this.sb === s) this.state.scorebot = 'connecting'; });
      s.on('connect_error', (e) => console.error(`[${this.id}] скорбот connect_error`, e && e.message || e));
    } catch (e) { console.error('[scorebot]', e.message); this.state.scorebot = 'off'; }
  }
  stopScorebot() { if (this.sb) { try { this.sb.close(); } catch {} } this.sb = null; this.sbFor = null; this.lastSb = null; this.state.scorebot = 'off'; }
  onFrame(payload) {
    if (typeof payload !== 'string' || !/^4\d*\[/.test(payload)) return;
    let arr; try { arr = JSON.parse(payload.slice(payload.indexOf('['))); } catch { return; }
    if (arr[0] === 'scoreboard' && arr[1]) { this.state.scorebot = 'on'; try { this.applyScoreboard(typeof arr[1] === 'string' ? JSON.parse(arr[1]) : arr[1]); } catch {} }
  }
  applyScoreboard(sb) {
    if (!sb || typeof sb !== 'object') return;
    const st = this.state;
    this.lastSb = { at: Date.now() };
    const ct = Number(sb.counterTerroristScore ?? sb.ctTeamScore ?? 0), t = Number(sb.terroristScore ?? sb.tTeamScore ?? 0);
    let team1IsCT;
    if (st.team1Id && sb.ctTeamId) team1IsCT = Number(sb.ctTeamId) === st.team1Id;
    else if (st.team2Id && sb.tTeamId) team1IsCT = Number(sb.tTeamId) === st.team2Id;
    else team1IsCT = norm(sb.ctTeamName) === norm(st.team1) || norm(sb.terroristTeamName) === norm(st.team2);
    st.rounds1 = team1IsCT ? ct : t; st.rounds2 = team1IsCT ? t : ct;
    st.side1 = team1IsCT ? 'CT' : 'T'; st.side2 = team1IsCT ? 'T' : 'CT';
    st.round = Number(sb.currentRound) || (ct + t + 1);
    if (sb.mapName) st.map = prettyMap(sb.mapName);
    st.updatedAt = Date.now();
  }

  applyParsed(p) {
    const st = this.state;
    st.team1 = p.t1.name || 'TBD'; st.team2 = p.t2.name || 'TBD';
    st.team1Id = p.t1.id; st.team2Id = p.t2.id; st.logo1 = p.t1.logo; st.logo2 = p.t2.logo;
    st.event = p.event; st.bestOf = p.bo || (p.maps.length || null); st.status = p.status; st.mapsList = p.maps;
    let w1 = 0, w2 = 0;
    for (const m of p.maps) if (m.done) { if (m.winner === 1) w1++; else if (m.winner === 2) w2++; }
    st.maps1 = w1; st.maps2 = w2;
    const sbFresh = this.lastSb && Date.now() - this.lastSb.at < 5 * 60000;
    const cur = p.maps.find((m) => m.score && !m.done) || null;
    if (!sbFresh) {
      if (p.status === 'live') {
        const next = cur || p.maps.find((m) => !m.done);
        st.map = next ? next.name : null;
        st.rounds1 = cur ? cur.score[0] : 0; st.rounds2 = cur ? cur.score[1] : 0;
        st.round = cur ? cur.score[0] + cur.score[1] + 1 : null; st.side1 = st.side2 = null;
      } else { st.rounds1 = st.rounds2 = null; st.round = null; st.map = null; }
    } else if (cur && st.rounds1 != null && cur.score[0] + cur.score[1] > st.rounds1 + st.rounds2 && mapKey(cur.name) === mapKey(st.map)) {
      st.rounds1 = cur.score[0]; st.rounds2 = cur.score[1];
    }
    if (p.status === 'over') { st.rounds1 = st.rounds2 = null; st.round = null; }
    st.error = null; st.updatedAt = Date.now();
  }

  async loadViaBrowser(url, force) {
    await browserProc.ensure(browserProc.visible);
    if (!this.tab || !this.tab.alive) { if (this.tab) this.tab.close(); this.tab = new Tab((f) => this.onFrame(f)); await this.tab.open(); }
    try {
      if (this.tab.url !== url) return await this.tab.navigate(url);
      if (force || Date.now() - this.tab.loadedAt > BROWSER_RELOAD_MS) return await this.tab.reload();
      const html = await this.tab.html();
      if (/team1-gradient|mapholder/.test(html)) return html;
      return await this.tab.reload();
    } catch (e) {
      if (e.cloudflare && !browserProc.visible && !CLOUD) {
        console.log('[browser] Cloudflare не пускает headless — скрытое окно');
        await browserProc.ensure(true);
        this.tab = new Tab((f) => this.onFrame(f)); await this.tab.open();
        return await this.tab.navigate(url);
      }
      throw e;
    }
  }

  async refresh(force) {
    const id = this.cfg.matchId;
    if (!id || this.cfg.manual || this.busy || this.paused) return;
    const myGen = this.gen;
    this.busy = true;
    const st = this.state;
    try {
      if (MOCK) { this.applyParsed(mockParsed()); this.ensureMock(); st.source = 'demo'; return; }
      const url = `${HLTV_BASE}/matches/${id}/match`;
      let html;
      const mode = this.cfg.source;
      const viaBrowser = async () => { html = await this.loadViaBrowser(url, force); st.source = browserProc.visible ? 'browser-window' : 'browser'; };
      if (mode === 'browser' || (mode === 'auto' && this.useBrowser)) await viaBrowser();
      else {
        try { html = await loadDirect(url); st.source = 'direct'; }
        catch (e) {
          if (mode === 'auto' && (e.cloudflare || /ECONNRESET|socket hang up|EPROTO|certificate/i.test(e.message)) && findBrowser()) {
            console.log(`[${this.id}] прямой запрос заблокирован (${e.message}) — через браузер`);
            this.useBrowser = true; await viaBrowser();
          } else if (e.cloudflare && !findBrowser()) throw new Error(CLOUD ? 'NO_BROWSER' : (mode === 'auto' ? 'NO_BROWSER' : 'CLOUDFLARE'));
          else throw e;
        }
      }
      if (myGen !== this.gen) return;
      const p = parseMatchPage(html);
      this.applyParsed(p);
      if (p.status === 'live' && st.source === 'direct' && p.scorebotUrl && p.scorebotId) this.connectScorebot(p.scorebotUrl, p.scorebotId);
      if (p.status !== 'live' && this.sb) this.stopScorebot();
      if (st.source.startsWith('browser') && p.status === 'live' && st.scorebot === 'off') st.scorebot = 'connecting';
    } catch (e) {
      if (myGen !== this.gen) return;
      st.error = humanError(e);
      if (st.status === 'loading') st.status = 'error';
      console.error(`[${this.id}] матч:`, e.message);
    } finally { this.busy = false; }
  }
  schedule() {
    if (this.timer) clearTimeout(this.timer);
    if (!this.cfg.matchId || this.cfg.manual || this.paused) return;
    const inBrowser = this.state.source && this.state.source.startsWith('browser');
    const delay = inBrowser ? BROWSER_READ_MS : (this.state.error ? 15000 : MATCH_POLL_MS);
    this.timer = setTimeout(async () => { await this.refresh(false); this.schedule(); }, delay);
  }
  async setMatch(id, keepState) {
    this.gen++;
    this.stopScorebot(); this.stopMock();
    if (this.timer) clearTimeout(this.timer);
    const changed = this.cfg.matchId !== id;
    this.cfg.matchId = id;
    if (changed) this.save();
    if (!keepState || changed) Object.assign(this.state, emptyState(), { status: id ? 'loading' : 'idle' });
    else if (id && this.state.status === 'idle') this.state.status = 'loading';
    if (!id) { if (this.tab) { this.tab.close(); this.tab = null; } return; }
    this.busy = false;
    await this.refresh(true);
    this.schedule();
  }
  publicState() {
    const d = this.cfg.display;
    const snap = { matchId: this.cfg.matchId, manual: this.cfg.manual, manualData: this.cfg.manualData, display: d, source: this.cfg.source };
    if (this.cfg.manual) {
      const md = this.cfg.manualData;
      const r1 = md.rounds1 === '' ? null : +md.rounds1, r2 = md.rounds2 === '' ? null : +md.rounds2;
      return {
        mode: 'manual', status: 'live', display: d, snap,
        team1: md.team1, team2: md.team2, logo1: null, logo2: null,
        maps1: +md.maps1 || 0, maps2: +md.maps2 || 0, rounds1: r1, rounds2: r2,
        side1: null, side2: null, round: r1 != null && r2 != null ? r1 + r2 + 1 : null,
        map: md.map || null, bestOf: +md.bestOf || 3, event: null,
        error: null, scorebot: 'off', source: 'manual', updatedAt: Date.now()
      };
    }
    return { mode: 'hltv', matchId: this.cfg.matchId, display: d, snap, ...this.state };
  }
  // демо
  ensureMock() {
    if (this.mockTimer) return;
    let ct = 5, t = 9;
    const tick = () => {
      if (Math.random() < 0.5) ct++; else t++;
      if (isFinalScore(ct, t)) { ct = 0; t = 0; }
      this.state.scorebot = 'on';
      this.applyScoreboard({ mapName: 'de_ancient', ctTeamId: 1, tTeamId: 2, counterTerroristScore: ct, terroristScore: t, currentRound: ct + t + 1 });
    };
    tick(); this.mockTimer = setInterval(tick, 4000);
  }
  stopMock() { if (this.mockTimer) clearInterval(this.mockTimer); this.mockTimer = null; }
}
function mockParsed() {
  return {
    t1: { name: 'Legacy', id: 1, logo: null }, t2: { name: 'Nemiga', id: 2, logo: null }, status: 'live', bo: 3, event: 'PGL Masters Bucharest 2026',
    maps: [{ name: 'Mirage', score: [10, 13], done: true, winner: 2 }, { name: 'Ancient', score: [5, 9], done: false }, { name: 'Nuke', score: null, done: false }]
  };
}

// ---------- хранилище худов ----------
const rooms = new Map();
let appCfg = { port: DEFAULT_PORT };
function loadAll() {
  if (CLOUD) {
    try {
      const data = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
      for (const [id, c] of Object.entries(data.rooms || {})) if (validId(id)) rooms.set(id, new Room(id, c));
      console.log('загружено худов:', rooms.size);
    } catch {}
  } else {
    let c = {};
    try { c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
    appCfg.port = Number(c.port) || DEFAULT_PORT;
    rooms.set('local', new Room('local', c));
  }
}
let saveTimer = null;
function saveRooms() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      if (CLOUD) {
        const out = {}; for (const [id, r] of rooms) out[id] = r.cfg;
        fs.writeFileSync(ROOMS_FILE, JSON.stringify({ rooms: out }));
      } else {
        const r = rooms.get('local');
        fs.writeFileSync(CONFIG_FILE, JSON.stringify({ port: appCfg.port, ...r.cfg }, null, 2));
      }
    } catch (e) { console.error('сохранение:', e.message); }
  }, 300);
}
function newRoomId() { let id; do { id = crypto.randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8); } while (id.length < 8 || rooms.has(id)); return id; }

// худы, которые никто не смотрит, — на паузу; совсем старые в облаке удаляем
setInterval(() => {
  for (const r of rooms.values()) if (!r.paused && Date.now() - r.lastSeen > IDLE_MS) r.pause();
  if (!rooms.size || ![...rooms.values()].some((r) => !r.paused && r.tab)) { if (browserProc.alive) { console.log('[browser] не нужен — закрываю'); browserProc.stop(); } }
}, 30000);

// ---------- HTTP ----------
const send = (res, code, body, type = 'application/json; charset=utf-8', extra = {}) => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Allow-Headers': 'Content-Type, X-Key', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((resolve) => {
  let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e5) req.destroy(); });
  req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } });
});

const STARTUP_FILE = process.env.APPDATA ? path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'HLTV Score Widget.vbs') : null;
const autostartEnabled = () => !!STARTUP_FILE && fs.existsSync(STARTUP_FILE);
function setAutostart(on) {
  if (!STARTUP_FILE || !IS_EXE) return;
  if (on) fs.writeFileSync(STARTUP_FILE, `CreateObject("WScript.Shell").Run """${process.execPath}""", 0, False\r\n`);
  else if (fs.existsSync(STARTUP_FILE)) fs.unlinkSync(STARTUP_FILE);
}

const logoCache = new Map();
async function serveLogo(res, u) {
  if (!/^https:\/\/([a-z0-9-]+\.)*hltv\.org\//i.test(u) && !u.startsWith(HLTV_BASE + '/')) return send(res, 400, 'bad', 'text/plain');
  if (logoCache.has(u)) { const c = logoCache.get(u); res.writeHead(200, { 'Content-Type': c.type, 'Cache-Control': 'max-age=86400' }); return res.end(c.body); }
  try {
    const r = await fetchUrl(u, { timeout: 10000 });
    if (r.statusCode !== 200) throw new Error('HTTP ' + r.statusCode);
    const type = String(r.headers['content-type'] || (u.endsWith('.svg') ? 'image/svg+xml' : 'image/png'));
    if (!/^image\//.test(type)) throw new Error('не картинка');
    if (logoCache.size > 300) logoCache.clear();
    logoCache.set(u, { type, body: r.body });
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=86400' }); res.end(r.body);
  } catch { res.writeHead(302, { Location: u }); res.end(); }
}

// простая защита от массового создания худов
const createLog = [];
function canCreate() { const now = Date.now(); while (createLog.length && now - createLog[0] > 3600000) createLog.shift(); return createLog.length < 20 && rooms.size < MAX_ROOMS; }

async function handleApi(req, res, room, action, authed) {
  if (action === 'state' && req.method === 'GET') { room.touch(); return send(res, 200, room.publicState()); }
  if (action === 'config' && req.method === 'GET') return authed ? send(res, 200, room.cfg) : send(res, 403, { error: 'Нет доступа: неверный ключ пульта' });
  if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
  const body = await readBody(req);
  if (!authed) return send(res, 403, { error: 'Нет доступа: неверный ключ пульта' });
  room.touch();
  const cfg = room.cfg;
  switch (action) {
    case 'match': {
      const empty = body.url === '' || body.url == null;
      const id = empty ? null : parseMatchId(body.url);
      if (!empty && !id) return send(res, 400, { error: 'Не удалось найти номер матча в ссылке. Нужна ссылка вида hltv.org/matches/2399724/...' });
      cfg.manual = false; room.save(); room.setMatch(id);
      return send(res, 200, { ok: true, matchId: id });
    }
    case 'manual': {
      if (body.data && typeof body.data === 'object') cfg.manualData = mergeCfg({ manualData: { ...cfg.manualData, ...body.data } }).manualData;
      if (typeof body.enabled === 'boolean' && body.enabled !== cfg.manual) {
        cfg.manual = body.enabled;
        if (cfg.manual) { room.stopLive(); if (room.timer) clearTimeout(room.timer); }
        else if (cfg.matchId) setTimeout(() => room.setMatch(cfg.matchId), 10);
      }
      room.save(); return send(res, 200, { ok: true });
    }
    case 'display': cfg.display = { ...cfg.display, showLogos: body.showLogos ?? cfg.display.showLogos, showMap: body.showMap ?? cfg.display.showMap }; room.save(); return send(res, 200, { ok: true });
    case 'source':
      if (['auto', 'direct', 'browser'].includes(body.source)) { cfg.source = body.source; room.useBrowser = body.source === 'browser'; room.save(); if (body.source === 'direct' && room.tab) { room.tab.close(); room.tab = null; } if (cfg.matchId) room.setMatch(cfg.matchId); }
      return send(res, 200, { ok: true });
    case 'refresh': await room.refresh(true); return send(res, 200, { ok: true });
    case 'config': return send(res, 200, cfg);
    case 'delete':
      if (!CLOUD) return send(res, 400, { error: 'нельзя' });
      room.destroy(); rooms.delete(room.id); saveRooms(); return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (p === '/healthz') return send(res, 200, { ok: true });
    if (p === '/api/app') return send(res, 200, { app: APP_ID, version: VERSION, cloud: CLOUD, exe: IS_EXE, demo: MOCK, port: activePort, autostart: autostartEnabled(), canAutostart: IS_EXE && !!STARTUP_FILE, browserFound: !!findBrowser(), rooms: CLOUD ? undefined : 1 });
    if (p === '/logo') return serveLogo(res, url.searchParams.get('u') || '');

    // API худа: /api/h/<id>/<действие>
    let m = p.match(/^\/api\/h\/([a-z0-9]+)\/([a-z]+)$/);
    if (m) {
      const [, id, action] = m;
      if (!validId(id)) return send(res, 404, { error: 'нет такого худа' });
      if (action === 'restore' && req.method === 'POST') {
        // сервер перезапустился и забыл худ — плашка/пульт присылают последние настройки
        const body = await readBody(req);
        if (rooms.has(id)) return send(res, 200, { ok: true, existed: true });
        if (rooms.size >= MAX_ROOMS) return send(res, 429, { error: 'слишком много худов' });
        const r = new Room(id, body.snap || {}); rooms.set(id, r); saveRooms(); r.touch();
        console.log(`[${id}] восстановлен после перезапуска`);
        return send(res, 200, { ok: true, restored: true });
      }
      const room = rooms.get(id);
      if (!room) return send(res, 200, { missing: true });
      const authed = !CLOUD || safeEq(req.headers['x-key'] || url.searchParams.get('k'), keyFor(id));
      return handleApi(req, res, room, action, authed);
    }
    // создать худ (только сервер)
    if (p === '/api/hud' && req.method === 'POST') {
      if (!CLOUD) return send(res, 400, { error: 'только на сервере' });
      if (!canCreate()) return send(res, 429, { error: 'Слишком много худов. Удалите ненужные или попробуйте позже.' });
      const id = newRoomId(); rooms.set(id, new Room(id, {})); createLog.push(Date.now()); saveRooms();
      console.log(`[${id}] создан`);
      return send(res, 200, { id, key: keyFor(id), widget: `/w/${id}`, panel: `/p/${id}/${keyFor(id)}` });
    }
    // только для exe
    if (!CLOUD && req.method === 'POST') {
      const body = await readBody(req);
      if (p === '/api/autostart') { try { setAutostart(!!body.enabled); } catch (e) { return send(res, 500, { error: e.message }); } return send(res, 200, { ok: true, autostart: autostartEnabled() }); }
      if (p === '/api/shutdown') { send(res, 200, { ok: true }); console.log('Выключение из пульта'); shutdown(); return; }
    }

    // страницы
    const html = (name) => { const h = getPage(name); return h ? send(res, 200, h, 'text/html; charset=utf-8') : send(res, 404, 'not found', 'text/plain'); };
    if (CLOUD) {
      if (p === '/') return html('home.html');
      if (/^\/w\/[a-z0-9]+\/?$/.test(p)) return html('widget.html');
      if (/^\/p\/[a-z0-9]+\/[A-Za-z0-9_-]+\/?$/.test(p)) return html('control.html');
    } else {
      if (p === '/' || p === '/control') return html('control.html');
      if (p === '/widget') return html('widget.html');
    }
    send(res, 404, 'Страница не найдена', 'text/plain; charset=utf-8');
  } catch (e) { console.error('http', p, e.stack || e); try { send(res, 500, { error: e.message }); } catch {} }
});

function shutdown() {
  for (const r of rooms.values()) r.destroy();
  browserProc.stop();
  saveRooms();
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
process.on('exit', () => browserProc.stop());
process.on('uncaughtException', (e) => console.error('uncaught:', e && e.stack || e));
process.on('unhandledRejection', (e) => console.error('unhandled:', e && e.stack || e));

// ---------- запуск ----------
loadAll();
let activePort = Number(process.env.PORT) || appCfg.port || DEFAULT_PORT;
function openInBrowser(url) {
  try {
    if (IS_WIN) spawn('explorer.exe', [url], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
    else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {}
}
function messageBox(text) {
  console.log('MESSAGE:', text);
  if (!IS_WIN) return;
  const ps = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(@'\n${text}\n'@, 'HLTV Score Widget') | Out-Null`;
  try { spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { detached: true, windowsHide: true, stdio: 'ignore' }).unref(); } catch {}
}
async function isOurs(port) { try { const j = await httpJson(`http://127.0.0.1:${port}/api/app`); return j && j.app === APP_ID; } catch { return false; } }
function tryListen(port, host) {
  return new Promise((resolve) => {
    const onErr = (e) => { server.removeListener('listening', onOk); resolve(e.code || 'ERR'); };
    const onOk = () => { server.removeListener('error', onErr); resolve('OK'); };
    server.once('error', onErr); server.once('listening', onOk);
    server.listen(port, host);
  });
}
(async () => {
  if (CLOUD) {
    const r = await tryListen(activePort, '0.0.0.0');
    if (r !== 'OK') { console.error('порт занят', activePort); process.exit(1); }
    console.log(`Сервер запущен на порту ${activePort}`);
    return;
  }
  const wanted = activePort;
  const r = await tryListen(wanted, '127.0.0.1');
  if (r !== 'OK') {
    if (await isOurs(wanted)) { console.log('Уже запущен на порту ' + wanted + ', открываю пульт'); openInBrowser(`http://localhost:${wanted}/`); return setTimeout(() => process.exit(0), 500); }
    let found = null;
    for (let p = wanted + 1; p < wanted + 40 && !found; p++) {
      if (await isOurs(p)) { openInBrowser(`http://localhost:${p}/`); return setTimeout(() => process.exit(0), 500); }
      if ((await tryListen(p, '127.0.0.1')) === 'OK') found = p;
    }
    if (!found) { messageBox(`Не удалось запустить: порты ${wanted}-${wanted + 40} заняты.\nУкажите другой порт в config.json рядом с программой.`); return process.exit(1); }
    activePort = found; appCfg.port = found; saveRooms();
    messageBox(`Порт ${wanted} занят другой программой, поэтому виджет запущен на порту ${found}.\n\nАдрес для OBS:\nhttp://localhost:${found}/widget\n\nПульт:\nhttp://localhost:${found}/`);
  } else if (appCfg.port !== wanted && !process.env.PORT) { appCfg.port = wanted; saveRooms(); }
  console.log(`Запущен${MOCK ? ' (ДЕМО)' : ''}: пульт http://localhost:${activePort}/  плашка http://localhost:${activePort}/widget`);
  if (FIRST_RUN) saveRooms();
  if (IS_EXE && (FIRST_RUN || MOCK)) openInBrowser(`http://localhost:${activePort}/`);
  const local = rooms.get('local');
  if (local.cfg.matchId && !local.cfg.manual) local.touch();
})();
