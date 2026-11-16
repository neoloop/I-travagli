// Test du service worker avec un faux environnement (fetch / caches simulés)
const fs = require('fs'), vm = require('vm');
const code = fs.readFileSync(require('path').join(__dirname, '..', 'sw.js'), 'utf8');
let fails = 0;
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fails++; };

function env({ online = true, status = 200, cacheBroken = false } = {}) {
  const store = new Map(), listeners = {};
  const cache = {
    put: async (k, r) => { if (cacheBroken) throw new TypeError('put'); store.set(new URL(k, 'https://h/').href, r); },
    keys: async () => [...store.keys()].map(u => ({ url: u })),
    match: async k => { if (cacheBroken) throw new Error('match'); const r = store.get(new URL(k, 'https://h/').href); return r ? r.clone() : undefined; },
  };
  const ctx = {
    console, URL, Response, AbortController, setTimeout, clearTimeout, Promise, Map, Error, TypeError,
    location: { origin: 'https://h' },
    caches: { open: async () => { if (cacheBroken && false) throw 1; return cache; }, keys: async () => [], delete: async () => true },
    fetch: async () => { if (!ctx.online) throw new TypeError('offline'); return new Response('<html>APP</html>', { status: ctx.srvStatus, headers: { 'Content-Type': 'text/html', 'Vary': 'Accept-Encoding', 'Cache-Control': 'no-store' } }); },
    online, srvStatus: status,
    self: { addEventListener: (t, f) => listeners[t] = f, skipWaiting() {}, clients: { claim() {} } },
  };
  vm.createContext(ctx); vm.runInContext(code, ctx);
  ctx.nav = async (url = 'https://h/', mode = 'navigate') => {
    let resp, waits = [];
    const e = { request: { method: 'GET', url, mode }, respondWith: p => { resp = p }, waitUntil: p => waits.push(p) };
    listeners.fetch(e);
    const r = await resp; await Promise.all(waits);
    return r;
  };
  ctx.cstore = store;
  return ctx;
}
(async () => {
  let c = env();
  let r = await c.nav();
  ok(r.status === 200 && (await r.text()).includes('APP'), 'en ligne : la réponse du serveur est servie');
  ok(c.cstore.size === 1, 'en ligne : une copie est mise en cache');
  c.online = false;
  r = await c.nav();
  ok(r.status === 200 && (await r.text()).includes('APP'), 'serveur coupé : la copie en cache est servie');
  r = await c.nav('https://h/?x=1');
  ok(r.status === 200 && (await r.text()).includes('APP'), 'serveur coupé + paramètre : copie servie');

  c = env({ online: false });
  r = await c.nav();
  ok(r.status === 503 && (await r.text()).includes('Hors ligne'), 'serveur coupé + cache vide : message « Hors ligne »');

  c = env({ cacheBroken: true });
  r = await c.nav();
  ok(r.status === 200 && (await r.text()).includes('APP'), 'cache en panne + serveur actif : la page est quand même servie');

  c = env({ status: 502 });
  r = await c.nav();
  ok(r.status === 502, '502 du proxy + cache vide : on laisse passer la réponse (pas de masquage)');
  c = env();
  await c.nav(); c.srvStatus = 502;
  r = await c.nav();
  ok(r.status === 200 && (await r.text()).includes('APP'), '502 du proxy avec cache rempli : copie en cache servie');

  c = env();
  r = await c.nav('https://h/sw-status');
  const j = JSON.parse(await r.text());
  ok(j.version === 'taches-v4' && j.reseau_index.startsWith('200') && j.test_ecriture_cache === 'OK' && j.en_cache_apres.length === 1, '/sw-status : diagnostic complet et test d\'écriture dans le cache');
  c = env({ online: false });
  r = await c.nav('https://h/sw-status');
  const j2 = JSON.parse(await r.text());
  ok(j2.reseau_index.startsWith('ERREUR'), '/sw-status serveur coupé : indique l\'erreur réseau');

  console.log(fails ? `\n${fails} ÉCHEC(S)` : '\nTOUS LES TESTS PASSENT');
  process.exit(fails ? 1 : 0);
})();
