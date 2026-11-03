// SPDX-License-Identifier: MIT
// The memory panorama indexes each harness's own memory store, read-only.
// Descriptions and provenance are served; bodies stay on their host and are
// fetched only by an explicit read. Native stores are never written.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, relative, resolve } from 'node:path';
import { hash, integer, requireThat, text } from './common.mjs';

const DESCRIPTION_MAX = 200, BODY_MAX = 16 * 1024, ENTRY_CAP = 2000, HASH_WINDOW = 1024 * 1024;
const LEARNINGS_MAX = 5, QUERY_MAX = 200;
// Credential-shaped files are refused outright, not merely unindexed.
const FORBIDDEN = /(^|\/)(\.ssh)(\/|$)|credential|token|secret|\.pem$|\.key$/i;

function frontmatter(body) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body);
  if (!match) return { meta: {}, rest: body };
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (field) meta[field[1]] = field[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, rest: body.slice(match[0].length) };
}

function describe(meta, rest) {
  let description = String(meta.description ?? '');
  if (!description) for (const line of rest.split(/\r?\n/)) {
    const candidate = line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
    // Session bookkeeping lines are identifiers, not knowledge.
    if (!candidate || /^(thread_id|session_id|run_id|id|created_at|updated_at)\s*[:=]/i.test(candidate)) continue;
    description = candidate; break;
  }
  return description.replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_MAX);
}

function fileEntry(source, root, path, type) {
  if (FORBIDDEN.test(path)) throw Object.assign(new Error('Refused: credential-shaped path'), { code: 'REFUSED_PATH' });
  const info = lstatSync(path);
  if (info.isSymbolicLink()) throw Object.assign(new Error('Refused: symlink'), { code: 'REFUSED_SYMLINK' });
  requireThat(info.isFile(), 'NOT_A_FILE', 'Indexable paths must be regular files');
  const raw = readFileSync(path).subarray(0, HASH_WINDOW);
  const { meta, rest } = frontmatter(raw.toString('utf8'));
  const name = String(meta.name ?? relative(root, path).replace(/\.md$/, '').split('/').at(-1)).trim();
  requireThat(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(name), 'INVALID_NAME', 'Memory names must be simple slugs');
  return {
    id: hash(`${source}:${relative(root, path)}`),
    source, name, type,
    description: describe(meta, rest),
    updated: new Date(Math.floor(info.mtimeMs)).toISOString(),
    hash: hash(raw),
    path: resolve(path),
    scope: 'shared',
  };
}

// One markdown directory, N levels deep. Covers ZCode's project memory layout
// and Claude's memory directories; MEMORY.md style index files are entries too.
// Credential-shaped paths are skipped by the walker, never indexed.
function markdownFiles(root, depth = 1) {
  if (FORBIDDEN.test(root)) return [];
  const files = [];
  let items;
  try { items = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  for (const item of items) {
    const path = join(root, item.name);
    if (item.isDirectory() && depth > 0) files.push(...markdownFiles(path, depth - 1));
    else if (item.isFile() && ['.md', '.markdown', '.txt'].includes(extname(item.name)) && !FORBIDDEN.test(path)) files.push(path);
  }
  return files.sort();
}

export const DEFAULT_ROOTS = {
  zcode: join(homedir(), '.enntity-zcode', 'cli', 'memories', 'projects'),
  claude: join(homedir(), '.claude', 'memories'),
  codex: join(homedir(), '.codex', 'memories'),
};

export const adapters = {
  zcode: root => markdownFiles(root ?? DEFAULT_ROOTS.zcode, 3)
    .filter(p => p.endsWith('.md') || p.endsWith('.markdown'))
    .map(path => fileEntry('zcode', root ?? DEFAULT_ROOTS.zcode, path, 'project')),
  claude: root => markdownFiles(root ?? DEFAULT_ROOTS.claude, 2)
    .map(path => fileEntry('claude', root ?? DEFAULT_ROOTS.claude, path, 'project')),
  codex: root => markdownFiles(root ?? DEFAULT_ROOTS.codex, 1)
    .map(path => fileEntry('codex', root ?? DEFAULT_ROOTS.codex, path, 'project')),
  'agents-md': roots => roots.flatMap(root => {
    const path = join(root, 'AGENTS.md');
    try { return [fileEntry('agents-md', root, path, 'authority')]; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }),
};

export function memoryConfig(env = process.env) {
  const enabled = env.ACCORD_MEMORY !== 'off';
  const sources = (env.ACCORD_MEMORY_SOURCES ?? 'zcode,claude,codex,agents-md').split(',').map(s => s.trim()).filter(Boolean);
  const pollMs = Math.min(600000, Math.max(250, Number(env.ACCORD_MEMORY_POLL_MS ?? 30000) || 30000));
  const roots = {
    zcode: env.ACCORD_MEMORY_ZCODE, claude: env.ACCORD_MEMORY_CLAUDE,
    codex: env.ACCORD_MEMORY_CODEX,
    'agents-md': env.ACCORD_MEMORY_AGENTS_MD
      ? env.ACCORD_MEMORY_AGENTS_MD.split(':').map(s => s.trim()).filter(Boolean)
      : [process.cwd(), homedir()],
  };
  const learnings = env.ACCORD_MEMORY_LEARNINGS === 'on';
  return { enabled, sources, pollMs, roots, learnings };
}

// Index state lives in the coordinator store; a failed scan marks entries stale
// instead of deleting them, so transient I/O errors never erase collective knowledge.
export class MemoryPanorama {
  constructor(store, config = memoryConfig()) {
    this.store = store; this.config = config;
    this.status = { enabled: config.enabled, sources: {}, lastScan: null };
    this.scanning = false;
    this.timer = null;
  }
  start() {
    if (!this.config.enabled) return;
    const tick = () => { if (!this.scanning) void this.scan().catch(() => {}); };
    this.timer = setInterval(tick, this.config.pollMs);
    this.timer.unref?.();
    void this.scan().catch(() => {});
  }
  close() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  sync(source, entries) {
    entries = entries.slice(0, ENTRY_CAP);
    this.store.mutate(() => {
      const known = new Map(this.store.db.prepare('SELECT id,hash FROM memory_entries WHERE source=?').all(source).map(r => [r.id, r.hash]));
      for (const entry of entries) {
        if (known.get(entry.id) === entry.hash) continue;
        this.store.db.prepare(`INSERT INTO memory_entries(id,source,name,type,description,updated,hash,path,scope,stale)
          VALUES(?,?,?,?,?,?,?,?,'shared',0) ON CONFLICT(id) DO UPDATE SET name=excluded.name,type=excluded.type,description=excluded.description,
          updated=excluded.updated,hash=excluded.hash,path=excluded.path,stale=0`).run(
          entry.id, entry.source, entry.name, entry.type, entry.description, entry.updated, entry.hash, entry.path);
      }
      const keep = new Set(entries.map(e => e.id));
      for (const id of known.keys()) if (!keep.has(id))
        this.store.db.prepare('DELETE FROM memory_entries WHERE id=?').run(id);
    });
    this.status.sources[source] = { ok: true, entries: entries.length, at: Date.now() };
  }
  markStale(source, error) {
    this.store.mutate(() => this.store.db.prepare('UPDATE memory_entries SET stale=1 WHERE source=?').run(source));
    this.status.sources[source] = { ok: false, error: error.code ?? 'SCAN_FAILED', at: Date.now() };
  }
  async scan() {
    if (this.scanning) return; this.scanning = true;
    try {
      for (const source of this.config.sources) {
        const adapter = adapters[source];
        if (!adapter) { this.status.sources[source] = { ok: false, error: 'UNKNOWN_SOURCE', at: Date.now() }; continue; }
        const root = this.config.roots[source];
        try {
          const existing = this.store.db.prepare('SELECT count(*) n FROM memory_entries WHERE source=?').get(source).n;
          const rootMissing = DEFAULT_ROOTS[source] !== undefined && (() => {
            try { return !lstatSync(resolve(this.config.roots[source] ?? DEFAULT_ROOTS[source])).isDirectory(); } catch { return true; }
          })();
          if (rootMissing && existing) {
            // A store that disappears leaves its entries uncertain, not erased.
            this.markStale(source, { code: 'ROOT_MISSING' });
            continue;
          }
          const entries = adapter(root);
          if (!entries.length && !existing && !this.status.sources[source]) {
            // Absent store: the harness is simply not installed here.
            this.status.sources[source] = { ok: true, entries: 0, at: Date.now() };
            continue;
          }
          this.sync(source, entries);
        } catch (error) { this.markStale(source, error); }
      }
      this.status.lastScan = Date.now();
    } finally { this.scanning = false; }
  }

  list(args = {}) {
    requireThat(args.query === undefined || typeof args.query === 'string' && args.query.length <= QUERY_MAX,
      'INVALID_INPUT', 'query must be a string of at most 200 characters', 400);
    integer(args.limit ?? 10, 'limit', 1, 20);
    const query = String(args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const rows = this.store.db.prepare('SELECT * FROM memory_entries ORDER BY updated DESC, name').all();
    const entries = rows
      .filter(row => query.every(term => `${row.name} ${row.description} ${row.type}`.toLowerCase().includes(term)))
      .slice(0, args.limit ?? 10)
      .map(row => ({ id: row.id, name: row.name, type: row.type, description: row.description, updated: row.updated,
        source: { host: this.store.authority, harness: row.source, label: row.source }, scope: row.scope, stale: Boolean(row.stale) }));
    return { entries, sources: this.status.sources, lastScan: this.status.lastScan };
  }

  read(entryId) {
    text(entryId, 'id', 100);
    const row = this.store.db.prepare('SELECT * FROM memory_entries WHERE id=?').get(entryId);
    requireThat(row, 'NOT_FOUND', 'Unknown memory entry', 404);
    requireThat(row.type !== 'authority', 'AUTHORITY_BODY', 'Instruction files are read from disk; the index only locates them', 403);
    let body;
    try { body = readFileSync(row.path).subarray(0, BODY_MAX).toString('utf8'); }
    catch { this.markStale(row.source, { code: 'BODY_UNAVAILABLE' }); }
    requireThat(body !== undefined, 'STALE_ENTRY', 'The entry body is unavailable on this host', 410);
    return { id: row.id, name: row.name, type: row.type, description: row.description, updated: row.updated, hash: row.hash,
      body, path: row.path };
  }

  learnings() {
    if (!this.config.learnings) return [];
    const rows = this.store.db.prepare("SELECT * FROM memory_entries WHERE stale=0 ORDER BY updated DESC LIMIT ?").all(LEARNINGS_MAX);
    return rows.map(row => ({ name: row.name, type: row.type, description: row.description, updated: row.updated, source: row.source }));
  }
}
