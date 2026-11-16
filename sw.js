/* Service worker du Gestionnaire de tâches (v4).
   Réseau d'abord : si le serveur répond, sa réponse est TOUJOURS servie telle quelle.
   Le cache ne sert que de secours (serveur coupé) et ses erreurs ne bloquent jamais la page.
   Les données (/api/) ne passent jamais par ici : la page les gère (copie locale + synchro). */
const V = 'taches-v4';
const LOG = [];
const note = m => { LOG.push(new Date().toISOString().slice(11, 19) + ' ' + m); if (LOG.length > 30) LOG.shift(); };
const SHELL = ['/index.html', '/manifest.webmanifest', '/icon.png'];

/* copie « propre » (sans les en-têtes du serveur / proxy qui peuvent gêner le cache) */
async function store(c, key, res) {
  const body = await res.blob();
  await c.put(key, new Response(body, { status: 200, headers: { 'Content-Type': res.headers.get('Content-Type') || 'application/octet-stream' } }));
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    try {
      const c = await caches.open(V);
      await Promise.all(SHELL.map(async u => {
        try { const r = await fetch(u, { cache: 'no-store' }); if (r.ok) await store(c, u, r); } catch (_) {}
      }));
    } catch (_) {}
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k))))
      .catch(() => {})
      .then(() => self.clients.claim())
  );
});

function net(url, ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return fetch(url, { cache: 'no-store', signal: c.signal }).finally(() => clearTimeout(t));
}

const OFFLINE = '<meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;padding:24px"><h2>Hors ligne</h2><p>Le serveur ne répond pas et la page n\'est pas encore en cache. Ouvre l\'appli une fois avec le serveur actif, puis réessaie.</p>';

async function cached(key, nav) {
  try {
    const c = await caches.open(V);
    return (await c.match(key, { ignoreSearch: true, ignoreVary: true })) || (nav ? await c.match('/index.html', { ignoreVary: true }) : null) || null;
  } catch (_) { return null; }
}

async function handle(r, key, nav) {
  let res = null;
  try { res = await net(r.url, 4000); if (!res.ok) { note('réseau ' + r.url + ' -> ' + res.status); res = null; } } catch (e) { note('réseau ' + r.url + ' ERREUR ' + e); res = null; }
  if (res) {
    /* serveur OK : on sert sa réponse, et on garde une copie en cache sans jamais bloquer la page */
    let done;
    try { const copy = res.clone(); done = caches.open(V).then(c => store(c, key, copy)).catch(e => note('cache put ' + key + ' ERREUR ' + e)); } catch (e) { note('clone ERREUR ' + e); }
    return { response: res, done };
  }
  const hit = await cached(key, nav);
  if (hit) return { response: hit };
  try { return { response: await fetch(r.url) }; } catch (_) {}      /* dernier recours : requête simple */
  return { response: nav ? new Response(OFFLINE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }) : Response.error() };
}


/* Page de diagnostic : https://<serveur>/sw-status (répondue par le service worker lui-même) */
async function status() {
  const out = { version: V, heure: new Date().toISOString(), journal: LOG.slice() };
  try { out.caches = await caches.keys(); } catch (e) { out.caches = 'ERREUR ' + e; }
  try { const c = await caches.open(V); out.en_cache = (await c.keys()).map(r => r.url); } catch (e) { out.en_cache = 'ERREUR ' + e; }
  try {
    const r = await net('/index.html', 4000);
    out.reseau_index = r.status + ' ' + (r.headers.get('content-type') || '');
    try { const c = await caches.open(V); await store(c, '/index.html', r.clone()); out.test_ecriture_cache = 'OK'; }
    catch (e) { out.test_ecriture_cache = 'ERREUR ' + e; }
  } catch (e) { out.reseau_index = 'ERREUR ' + e; }
  try { const c = await caches.open(V); out.en_cache_apres = (await c.keys()).map(r => r.url); } catch (e) {}
  return new Response(JSON.stringify(out, null, 2), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  if (u.pathname === '/sw-status') { e.respondWith(status()); return; }
  const nav = r.mode === 'navigate';
  const key = nav ? '/index.html' : u.pathname;
  const p = handle(r, key, nav);
  e.respondWith(p.then(x => x.response));
  e.waitUntil(p.then(x => x.done).catch(() => {}));
});
