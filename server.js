// MANJAM Archive gateway (aggregator): SELF catalog local + FARFETCH proxied live.
// Serves the strict contract validated by the kitchen archive-catalog module.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8787);
// Defaults hardcoded: Coolify turns app envs into build-time ARGs only, so
// runtime may not see them. Env vars still win when present.
const ORIGIN = process.env.GATEWAY_PUBLIC_ORIGIN || 'https://xbp8hj1avpmauk7ajwxi74hz.72.61.148.211.sslip.io';
// Legacy Farfetch reference gateway (store-b-v2 shadow). Proxied read-only so
// the nightly crawler imports keep flowing into the public Archive untouched.
const UPSTREAM = process.env.LEGACY_GATEWAY_ORIGIN || 'https://5yzedsdnsbgudiy3q1ogu6bh.72.61.148.211.sslip.io';
const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, 'catalog.json'), 'utf8'));
// Serve-time origin rewrite: catalog is built once with a placeholder host.
const PLACEHOLDER = 'https://REPLACE.sslip.io';
if (ORIGIN && ORIGIN !== PLACEHOLDER) {
  catalog.items = JSON.parse(JSON.stringify(catalog.items).split(PLACEHOLDER).join(ORIGIN));
}
const local = catalog.items;

const SORTS = ['NEWEST', 'PRICE_LOW', 'PRICE_HIGH', 'BRAND_AZ'];
const CACHE_MS = 300_000;
let upstreamCache = { at: 0, items: [], promise: null };

function getJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 15000, rejectUnauthorized: false }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('upstream ' + res.statusCode));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('upstream timeout')); });
  });
}

async function upstreamItems() {
  if (!UPSTREAM) return [];
  const fresh = Date.now() - upstreamCache.at < CACHE_MS;
  if (fresh && upstreamCache.items.length) return upstreamCache.items;
  if (upstreamCache.promise) return upstreamCache.promise;
  upstreamCache.promise = (async () => {
    const out = [];
    let page = 1;
    for (;;) {
      const d = await getJson(`${UPSTREAM}/api/v1/mobile/archive?page=${page}&limit=100`);
      out.push(...(d.data || []));
      if (page >= (d.pages || 1)) break;
      page += 1;
      if (page > 40) break;
    }
    upstreamCache = { at: Date.now(), items: out, promise: null };
    return out;
  })().catch((e) => {
    upstreamCache.promise = null;
    console.error('upstream fetch failed:', String(e).slice(0, 120));
    return upstreamCache.items; // stale-while-error: keep last good copy
  });
  return upstreamCache.promise;
}

function brandKey(v) {
  return String(v || '').trim().normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function matches(i, q) {
  if (q.category && i.category !== q.category) return false;
  if (q.condition && i.condition !== q.condition) return false;
  if (q.brand) {
    const key = brandKey(q.brand);
    if (i.canonicalBrandKey !== key && i.canonicalBrand !== q.brand) return false;
  }
  const fts = String(q.fullTextSearch || '').trim().toLowerCase();
  if (fts) {
    const hit =
      (i.title || '').toLowerCase().includes(fts) ||
      (i.canonicalBrand || '').toLowerCase().includes(fts) ||
      String(i.sourceProductId) === fts;
    if (!hit) return false;
  }
  return true;
}

function sortItems(list, sort) {
  const out = list.slice();
  if (sort === 'PRICE_LOW') out.sort((a, b) => a.usdPrice - b.usdPrice);
  else if (sort === 'PRICE_HIGH') out.sort((a, b) => b.usdPrice - a.usdPrice);
  else if (sort === 'BRAND_AZ') out.sort((a, b) => String(a.canonicalBrandKey).localeCompare(String(b.canonicalBrandKey)));
  else out.sort((a, b) => (b.observedAt || 0) - (a.observedAt || 0));
  return out;
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: 20000, rejectUnauthorized: false }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('upstream ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ buf: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN || 'http://127.0.0.1');
  const send = (code, body, type, extra) => {
    res.writeHead(code, { 'Content-Type': type || 'application/json', ...(extra || {}) });
    res.end(body);
  };
  try {
    if (url.pathname === '/healthz') {
      return send(200, JSON.stringify({ ok: true, local: local.length, upstream: upstreamCache.items.length }));
    }

    if (url.pathname === '/api/v1/mobile/archive' && req.method === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      const page = Math.max(1, Number(q.page || 1) || 1);
      const limit = Math.min(100, Math.max(1, Number(q.limit || 20) || 20));
      const sort = SORTS.includes(q.sort) ? q.sort : 'NEWEST';
      const [up, all] = [await upstreamItems(), local];
      const merged = [...all, ...up].filter((i) => matches(i, q));
      const sorted = sortItems(merged, sort);
      const total = sorted.length;
      const data = sorted.slice((page - 1) * limit, page * limit);
      return send(200, JSON.stringify({ pages: Math.ceil(total / limit), total, page, limit, data }));
    }

    const detail = url.pathname.match(/^\/api\/v1\/mobile\/archive\/(ar_[a-f0-9]{24})$/);
    if (detail && req.method === 'GET') {
      const mine = local.find((i) => i.archiveItemId === detail[1]);
      if (mine) return send(200, JSON.stringify(mine));
      if (UPSTREAM) {
        const data = await getJson(`${UPSTREAM}/api/v1/mobile/archive/${detail[1]}`);
        return send(200, JSON.stringify(data));
      }
      return send(404, JSON.stringify({ error: 'not found' }));
    }

    const asset = url.pathname.match(/^\/archive-assets\/([a-f0-9]{64})\.png$/);
    if (asset && req.method === 'GET') {
      const file = path.join(__dirname, 'assets', asset[1] + '.png');
      if (fs.existsSync(file)) {
        const buf = fs.readFileSync(file);
        res.writeHead(200, {
          'Content-Type': 'image/png', 'Content-Length': buf.length,
          'Cache-Control': 'public, max-age=31536000, immutable', ETag: '"' + asset[1] + '"',
        });
        return res.end(buf);
      }
      if (UPSTREAM) {
        const { buf, headers } = await fetchBuffer(`${UPSTREAM}/archive-assets/${asset[1]}.png`);
        res.writeHead(200, {
          'Content-Type': headers['content-type'] || 'image/png',
          'Content-Length': buf.length,
          'Cache-Control': headers['cache-control'] || 'public, max-age=31536000, immutable',
          ETag: headers.etag || '"' + asset[1] + '"',
        });
        return res.end(buf);
      }
      return send(404, 'not found', 'text/plain');
    }

    const item = url.pathname.match(/^\/item\/(ar_[a-f0-9]{24})$/);
    if (item && req.method === 'GET') {
      const it = local.find((i) => i.archiveItemId === item[1]);
      if (!it) return send(404, 'not found', 'text/plain');
      return send(
        200,
        `<!doctype html><meta charset=utf-8><meta name=robots content=noindex><title>${it.title}</title><h1>${it.title}</h1><p>${it.canonicalBrand} — $${it.usdPrice} (${it.originalCurrency} ${it.originalPrice})</p><p>Size: ${it.size} | ${it.condition} | ${it.category}</p><img src=${JSON.stringify(it.imageUrls[0])} width=480>`,
        'text/html',
      );
    }

    return send(404, JSON.stringify({ error: 'not found' }));
  } catch (e) {
    return send(502, JSON.stringify({ error: 'gateway upstream error' }));
  }
});

server.listen(PORT, () => console.log(`archive-gateway listening on ${PORT}, local=${local.length}, upstream=${UPSTREAM || 'none'}`));
