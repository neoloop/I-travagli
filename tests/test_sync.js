// Test de la synchro contre le vrai taches_server.py (2 "appareils" simulés)
const vm = require('vm'), fs = require('fs');
const html = fs.readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const src = scripts[scripts.length - 1][1];
const a = src.indexOf('/* ============ Utilitaires');
const b = src.indexOf('/* ============ Rendu');
const code = src.slice(a, b);
const BASE = 'http://127.0.0.1:18088/';
let fails = 0;
const ok = (c, m) => { console.log((c ? 'OK   ' : 'FAIL ') + m); if (!c) fails++; };

function device(name, preset) {
  const store = new Map(preset || []);
  const dev = { name, offline: false, renders: 0 };
  const ctx = {
    console, setTimeout, clearTimeout, AbortController, JSON, Math, Date, Object, Array, Set, Map, Promise, Error, String, Number, Boolean, RegExp, Symbol,
    location: { protocol: 'https:', origin: 'https://x' },
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) },
    navigator: { onLine: true, storage: {} },
    document: { activeElement: null, hidden: false, addEventListener() {}, querySelector: () => null },
    addEventListener() {}, setInterval() {}, prompt: () => null,
    fetch: (u, o) => dev.offline ? Promise.reject(new TypeError('offline')) : fetch(BASE + u, o),
    render() { dev.renders++; }, ensureRecur() {},
  };
  vm.createContext(ctx);
  vm.runInContext(code, ctx);
  dev.run = s => vm.runInContext(s, ctx);
  dev.store = store;
  return dev;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const A = device('A'), B = device('B');

  // 1. A démarre (serveur vide), crée 2 tâches
  await A.run('init()');
  A.run("S.tasks.push(mkTask({id:'t1',title:'Tâche 1'}));S.tasks.push(mkTask({id:'t2',title:'Tâche 2'}));save()");
  await sleep(700);
  ok(A.run('DIRTY') === false && A.run('SYNC') === 'ok', 'A : 2 tâches envoyées au serveur (synchronisé)');

  // 2. B démarre à vide : récupère les données du serveur
  await B.run('init()');
  ok(B.run('S.tasks.length') === 2, 'B : récupère les 2 tâches du serveur');

  // 3. B perd le serveur et modifie hors ligne
  B.offline = true;
  B.run("T('t1').title='Tâche 1 (modifiée sur B hors ligne)';mkTaskAdd=S.tasks.push(mkTask({id:'t3',title:'Tâche 3 créée hors ligne'}));S.tasks=S.tasks.filter(t=>t.id!=='t2');save()");
  await sleep(700);
  ok(B.run('DIRTY') === true && B.run('SYNC') === 'off', 'B : hors ligne, modifications gardées (DIRTY, état « off »)');
  ok(B.run('S.tasks.length') === 2, 'B : copie locale utilisable hors ligne');

  // 4. Pendant ce temps A modifie t2 (que B a supprimé) et crée t4
  A.run("T('t2').notes='note ajoutée sur A';S.tasks.push(mkTask({id:'t4',title:'Tâche 4 de A'}));save()");
  await sleep(700);

  // 5. B recouvre le serveur → fusion
  B.offline = false;
  await B.run('sync()');
  const ids = B.run('S.tasks.map(t=>t.id).sort().join(",")');
  ok(B.run('DIRTY') === false && B.run('SYNC') === 'ok', 'B : resynchronisé après retour du serveur');
  ok(ids === 't1,t2,t3,t4', 'B : fusion = t1,t2,t3,t4 (t2 modifiée par A après sa suppression sur B → conservée) — obtenu : ' + ids);
  ok(B.run("T('t1').title").includes('hors ligne'), 'B : modification hors ligne de t1 conservée');
  ok(B.run("T('t2').notes") === 'note ajoutée sur A', 'B : modification de A sur t2 présente');

  // 6. A récupère la fusion
  await A.run('sync()');
  ok(A.run('S.tasks.map(t=>t.id).sort().join(",")') === 't1,t2,t3,t4', 'A : récupère t1..t4 après fusion');
  ok(A.run("T('t1').title").includes('hors ligne'), 'A : voit la modification faite hors ligne sur B');

  // 7. Suppression propagée (sans conflit)
  B.run("S.tasks=S.tasks.filter(t=>t.id!=='t3');save()");
  await sleep(700);
  await A.run('sync()');
  ok(!A.run("S.tasks.some(t=>t.id==='t3')"), 'A : suppression de t3 faite sur B propagée');

  // 8. Conflit sur la même tâche : le plus récent gagne
  A.offline = true;
  A.run("T('t4').title='A hors ligne';save()");
  await sleep(50);
  B.run("T('t4').title='B en ligne (plus récent)';save()");
  await sleep(700);
  A.offline = false;
  await A.run('sync()');
  ok(A.run("T('t4').title") === 'B en ligne (plus récent)' || A.run("T('t4').title") === 'A hors ligne', 'A : conflit résolu sans perte de tâche — titre = ' + A.run("T('t4').title"));
  // A a modifié AVANT B → B (plus récent) doit gagner
  ok(A.run("T('t4').title") === 'B en ligne (plus récent)', 'A : conflit sur t4 → la modification la plus récente (B) gagne');

  // 9. Redémarrage hors ligne : la page repart depuis la copie locale
  const C = device('C', [['gestionnaire-taches-v1', B.store.get('gestionnaire-taches-v1')], ['taches-sync', B.store.get('taches-sync')]]);
  C.offline = true;
  await C.run('init()');
  ok(C.run('S.tasks.length') >= 3 && C.renders >= 1, 'C : démarrage serveur coupé → données locales affichées (' + C.run('S.tasks.length') + ' tâches)');

  // 10. Écran « local» : tâche ajoutée hors ligne sur C après redémarrage, puis serveur de retour
  C.run("S.tasks.push(mkTask({id:'t9',title:'Ajoutée après redémarrage hors ligne'}));save()");
  await sleep(700);
  C.offline = false;
  await C.run('sync()');
  await A.run('sync()');
  ok(A.run("S.tasks.some(t=>t.id==='t9')"), 'A : reçoit la tâche créée sur C hors ligne après redémarrage');

  console.log(fails ? `\n${fails} ÉCHEC(S)` : '\nTOUS LES TESTS PASSENT');
  process.exit(fails ? 1 : 0);
})();
