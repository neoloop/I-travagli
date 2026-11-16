#!/usr/bin/env python3
"""Serveur minimal pour le Gestionnaire de tâches : sert index.html et stocke les données dans data.json.
Aucune dépendance (bibliothèque standard Python 3). À placer derrière ton VPN, pas sur Internet en direct.

Variables : TACHES_PORT (8088), TACHES_HOST (0.0.0.0), TACHES_DATA (data.json à côté du script),
            TACHES_TOKEN (optionnel : si défini, /api/import exige ?token=... ou l'en-tête X-Token).

Import (Raccourcis Apple, curl…) :  POST /api/import[?sync=1][&token=...]
  - texte brut, une tâche par ligne :  Titre|Échéance|Liste        (échéance et liste facultatives)
  - ou JSON : {"items":[{"title":"…","due":"2026-11-14","list":"Achats","notes":"…","priority":"Élevée"}]}
  Les doublons (même titre + même échéance) sont ignorés. La liste devient un projet.
  sync=1 : les tâches déjà importées qui ne figurent plus dans l'envoi sont marquées faites."""
import datetime, hmac, json, os, re, shutil, threading, unicodedata, uuid
import urllib.request, urllib.error, urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get('TACHES_DATA', os.path.join(BASE, 'data.json'))
PAGE = os.path.join(BASE, 'index.html')
PORT = int(os.environ.get('TACHES_PORT', '8088'))
HOST = os.environ.get('TACHES_HOST', '0.0.0.0')
TOKEN = os.environ.get('TACHES_TOKEN', '')
APPKEY = os.environ.get('TACHES_KEY', '')
NYB_TOKEN = os.environ.get('NYBLIT_TOKEN', '')
NYB_BASE = os.environ.get('NYBLIT_BASE', 'https://api.nyblit.app/v1').rstrip('/')
MAX_BODY = 20 * 1024 * 1024
LOCK = threading.Lock()

COLORS = ['#2563eb', '#16a34a', '#f59e0b', '#7c3aed', '#0d9488', '#db2777', '#e11d48']
STATIC = {'/icon.png': ('icon.png', 'image/png'),
          '/sw.js': ('sw.js', 'application/javascript; charset=utf-8'),
          '/manifest.webmanifest': ('manifest.webmanifest', 'application/manifest+json; charset=utf-8')}
DEFAULT_LISTS = {'rappels', 'reminders', 'tasks', 'taches', 'inbox', ''}   # listes par défaut : pas de projet
MONTHS = ['janv', 'fevr', 'mars', 'avr', 'mai', 'juin', 'juil', 'aout', 'sept', 'oct', 'nov', 'dec']


def fold(s):
    s = unicodedata.normalize('NFD', str(s or ''))
    return ''.join(c for c in s if unicodedata.category(c) != 'Mn').lower().strip()


def uid():
    return uuid.uuid4().hex[:11]


def read():
    try:
        with open(DATA, encoding='utf-8') as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return {'rev': 0, 'data': None}


def write(obj):
    if os.path.exists(DATA):
        shutil.copy2(DATA, DATA + '.bak')  # dernière version précédente
    tmp = DATA + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, DATA)  # écriture atomique


# ---------- import ----------
def norm_date(x):
    """Accepte 2026-11-14, 2026-11-14T09:00…, 14/11/2026, 14/11/26, « 14 nov. 2026 », « samedi 14 novembre 2026 »."""
    x = str(x or '').strip()
    if not x:
        return ''
    m = re.match(r'(\d{4})-(\d{2})-(\d{2})', x)
    if m:
        return m.group(0)
    m = re.match(r'(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})', x)
    if m:
        y = m.group(3)
        y = ('20' + y) if len(y) == 2 else y
        return f'{y}-{int(m.group(2)):02d}-{int(m.group(1)):02d}'
    m = re.search(r'(\d{1,2})\s+([A-Za-zÀ-ÿ]+)\.?\s+(\d{4})', x)
    if m:
        mo = fold(m.group(2))
        for i, p in enumerate(MONTHS):
            if mo.startswith(p):
                return f'{m.group(3)}-{i + 1:02d}-{int(m.group(1)):02d}'
    return ''


def is_urgent(v):
    v = fold(v)
    return v in ('1', 'true', 'oui') or v.startswith(('elev', 'haut', 'high', 'urgent'))


def parse_items(raw):
    txt = raw.decode('utf-8', 'replace').strip()
    out = []
    if txt[:1] in '[{':
        try:
            j = json.loads(txt)
        except ValueError:
            j = None
        if j is not None:
            arr = j if isinstance(j, list) else (j.get('items') or j.get('tasks') or j.get('rappels') or [])
            for x in arr:
                if isinstance(x, str):
                    out.append({'title': x})
                elif isinstance(x, dict):
                    g = lambda *k: next((x[a] for a in k if x.get(a) not in (None, '')), '')
                    out.append({
                        'title': g('title', 'titre', 'name', 'nom'),
                        'notes': g('notes', 'note', 'description'),
                        'due': g('due', 'echeance', 'échéance', 'date'),
                        'list': g('list', 'liste', 'project', 'projet'),
                        'urgent': is_urgent(g('priority', 'priorite', 'priorité', 'urgent', 'flagged')),
                        'done': fold(g('done', 'completed', 'termine', 'terminé')) in ('1', 'true', 'oui'),
                    })
            return out
    for line in txt.splitlines():
        line = line.strip()
        if not line:
            continue
        p = [c.strip() for c in line.split('|')]
        out.append({'title': p[0], 'due': p[1] if len(p) > 1 else '', 'list': p[2] if len(p) > 2 else '',
                    'notes': p[3] if len(p) > 3 else ''})
    return out


def do_import(items, sync=False):
    with LOCK:
        cur = read()
        data = cur['data'] or {'app': 'gestionnaire-taches', 'tasks': [], 'meetings': []}
        tasks = data.setdefault('tasks', [])
        groups = data.setdefault('groups', [])
        data.setdefault('meetings', [])
        seen = set()
        for t in tasks:
            seen.add(fold(t.get('title')) + '|' + (t.get('due') or ''))
            if t.get('extKey'):
                seen.add(t['extKey'])
        batch, added, skipped, closed, new_projects = set(), 0, 0, 0, []
        now = datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')
        for it in items:
            title = str(it.get('title') or '').strip()
            if not title or it.get('done'):
                continue
            due = norm_date(it.get('due'))
            key = it.get('ext') or (fold(title) + '|' + due)
            batch.add(key)
            if key in seen:
                skipped += 1
                continue
            seen.add(key)
            gid = ''
            lst = str(it.get('list') or '').strip()
            if fold(lst) not in DEFAULT_LISTS:
                g = next((g for g in groups if fold(g.get('name')) == fold(lst)), None)
                if not g:
                    g = {'id': uid(), 'name': lst, 'color': COLORS[len(groups) % len(COLORS)], 'collapsed': False, 'sort': 'urg'}
                    groups.append(g)
                    new_projects.append(lst)
                gid = g['id']
            tasks.append({
                'id': uid(), 'title': title, 'notes': str(it.get('notes') or ''), 'due': due,
                'urgent': bool(it.get('urgent')), 'done': False, 'doneAt': None, 'assignee': '',
                'carried': 0, 'mailCount': 0, 'lastMail': None, 'mailLog': [], 'meetings': [],
                'list': it.get('tlist') or 'inbox', 'group': gid, 'status': it.get('tstatus') or 'Non commencé', 'est': 0, 'subs': [],
                'source': 'nyblit' if it.get('ext') else 'apple-rappels', 'extKey': key, 'createdAt': now, 'updatedAt': now,
            })
            added += 1
        if sync:
            for t in tasks:
                if t.get('source') == 'apple-rappels' and not t.get('done') and t.get('extKey') and t['extKey'] not in batch:
                    t['done'] = True
                    t['doneAt'] = now
                    t['updatedAt'] = now
                    closed += 1
        rev = cur['rev']
        if added or closed or new_projects:
            rev += 1
            write({'rev': rev, 'data': data})
        return {'added': added, 'skipped': skipped, 'closed': closed, 'projects_created': new_projects, 'rev': rev}


def nyb_get(path, query=None):
    url = NYB_BASE + path + ('?' + urllib.parse.urlencode(query) if query else '')
    req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + NYB_TOKEN, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=25) as r:
        return json.loads(r.read().decode('utf-8'))


NYB_MAP = {'not_started': ('inbox', 'Non commencé'), 'in_progress': ('today', 'En cours'),
           'waiting': ('blocked', 'En attente'), 'on_hold': ('later', 'Non commencé')}


def nyblit_import():
    """Importe les tâches Nyblit actives (hors terminées/archivées) ; les projets Nyblit deviennent des projets."""
    if not NYB_TOKEN:
        return 400, {'error': 'NYBLIT_TOKEN non défini sur le serveur'}
    try:
        projects = {}
        r = nyb_get('/projects', {'limit': 100})
        for p in r.get('data', []):
            projects[p['id']] = p.get('name', '')
        items, cursor, pages = [], '', 0
        while True:
            q = {'limit': 100}
            if cursor:
                q['cursor'] = cursor
            r = nyb_get('/tasks', q)
            for t in r.get('data', []):
                if t.get('archived') or t.get('disposition') == 'done':
                    continue
                tl, ts = NYB_MAP.get(t.get('disposition'), ('inbox', 'Non commencé'))
                items.append({'title': t.get('title'), 'notes': t.get('notes') or '',
                              'due': (t.get('due_date') or '')[:10], 'list': projects.get(t.get('project_id'), ''),
                              'urgent': bool(t.get('is_urgent')), 'ext': 'nyblit:' + str(t.get('id')),
                              'tlist': tl, 'tstatus': ts})
            cursor = r.get('next_cursor') or ''
            pages += 1
            if not (r.get('has_more') and cursor) or pages >= 20:
                break
    except urllib.error.HTTPError as e:
        return 502, {'error': 'Nyblit a répondu ' + str(e.code)}
    except Exception as e:
        return 502, {'error': 'Nyblit injoignable : ' + str(e)[:120]}
    if not items:
        return 200, {'added': 0, 'skipped': 0, 'closed': 0, 'projects_created': [], 'note': 'aucune tâche active'}
    return 200, do_import(items, False)


class H(BaseHTTPRequestHandler):
    server_version = 'taches/1.3'

    def _send(self, code, body, ctype='application/json; charset=utf-8'):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        if not APPKEY:
            return True
        q = parse_qs(urlparse(self.path).query)
        given = self.headers.get('X-Key', '') or q.get('key', [''])[0]
        return hmac.compare_digest(given.encode(), APPKEY.encode())

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/api/data':
            if not self._auth():
                return self._send(401, {'error': 'code requis'})
            with LOCK:
                return self._send(200, read())
        if path == '/api/ping':
            return self._send(200, {'ok': True, 'token_required': bool(TOKEN), 'key_required': bool(APPKEY), 'nyblit': bool(NYB_TOKEN)})
        if path in STATIC:
            fn, ctype = STATIC[path]
            try:
                with open(os.path.join(BASE, fn), 'rb') as f:
                    return self._send(200, f.read(), ctype)
            except FileNotFoundError:
                return self._send(404, {'error': fn + ' manquant'})
        if path in ('/', '/index.html'):
            try:
                with open(PAGE, 'rb') as f:
                    return self._send(200, f.read(), 'text/html; charset=utf-8')
            except FileNotFoundError:
                return self._send(404, {'error': 'index.html manquant'})
        self._send(404, {'error': 'introuvable'})

    def do_POST(self):
        u = urlparse(self.path)
        if u.path not in ('/api/import', '/api/nyblit-import'):
            return self._send(404, {'error': 'introuvable'})
        if not self._auth():
            return self._send(401, {'error': 'code requis'})
        q = parse_qs(u.query)
        if TOKEN:
            given = (q.get('token', [''])[0] or self.headers.get('X-Token', ''))
            if not hmac.compare_digest(given.encode(), TOKEN.encode()):
                return self._send(403, {'error': 'jeton invalide'})
        if u.path == '/api/nyblit-import':
            code, res = nyblit_import()
            return self._send(code, res)
        try:
            n = int(self.headers.get('Content-Length', '0'))
            if n <= 0 or n > MAX_BODY:
                return self._send(413, {'error': 'taille invalide'})
            items = parse_items(self.rfile.read(n))
        except Exception:
            return self._send(400, {'error': 'requête invalide'})
        if not items:
            return self._send(400, {'error': 'aucune tâche reconnue'})
        sync = q.get('sync', ['0'])[0] in ('1', 'true', 'oui')
        self._send(200, do_import(items, sync))

    def do_PUT(self):
        if not self._auth():
            return self._send(401, {'error': 'code requis'})
        if self.path.split('?')[0] != '/api/data':
            return self._send(404, {'error': 'introuvable'})
        try:
            n = int(self.headers.get('Content-Length', '0'))
            if n <= 0 or n > MAX_BODY:
                return self._send(413, {'error': 'taille invalide'})
            body = json.loads(self.rfile.read(n))
            data, rev = body['data'], body['rev']
            if not isinstance(data, dict) or not isinstance(data.get('tasks'), list):
                raise ValueError('format')
        except Exception:
            return self._send(400, {'error': 'requête invalide'})
        with LOCK:
            cur = read()
            if rev != -1 and rev != cur['rev']:
                return self._send(409, {'rev': cur['rev']})
            new = {'rev': cur['rev'] + 1, 'data': data}
            write(new)
        self._send(200, {'rev': new['rev']})


if __name__ == '__main__':
    print(f'Gestionnaire de tâches sur http://{HOST}:{PORT}  (données : {DATA})')
    ThreadingHTTPServer((HOST, PORT), H).serve_forever()
