// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { MemoryPanorama, adapters, memoryConfig, peerEntries } from '../src/memory-panorama.mjs';
import { request } from '../src/common.mjs';
import { harness, eventually, link } from './helpers.mjs';
import { randomUUID } from 'node:crypto';

function fixture(env = {}) {
  const root = mkdtempSync(join(tmpdir(), 'accord-mem-'));
  const zcode = join(root, 'projects', 'proj', 'memory');
  mkdirSync(zcode, { recursive: true });
  writeFileSync(join(zcode, 'alpha.md'), '---\nname: alpha\ntype: project\ndescription: Model gateway serves the main branch\n---\nbody\n');
  writeFileSync(join(zcode, 'beta.md'), '---\nname: beta\ntype: project\n---\n# First heading wins as description\n');
  writeFileSync(join(zcode, 'MEMORY.md'), '- [Index line](alpha.md) — index entries are facts too\n');
  writeFileSync(join(zcode, 'long.md'), `---\nname: long\ndescription: ${'x'.repeat(400)}\n---\nbody\n`);
  writeFileSync(join(zcode, 'my-token.md'), '---\nname: hidden\n---\nsecret body\n');
  writeFileSync(join(zcode, 'body-heavy.md'), `---\nname: heavy\ndescription: big body\n---\n${'y'.repeat(17 * 1024)}\n`);
  writeFileSync(join(zcode, 'leaky.md'), '---\nname: leaky\ndescription: config with sk-ant-synthetic0000000000000 inside\n---\npassword is synthetic_9876543210\n');
  writeFileSync(join(zcode, 'private.md'), '---\nname: quiet\ntype: project\nscope: private\ndescription: private fact\n---\nprivate body\n');
  const agents = join(root, 'workspace');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, 'AGENTS.md'), '# Workspace agent guide\n\nDo the right thing.\n');
  symlinkSync(join(zcode, 'alpha.md'), join(zcode, 'dangling-alias.md'));
  return { root, zcode, agents };
}

test('adapters index frontmatter, truncate descriptions, redact secrets, and refuse unsafe paths', () => {
  const f = fixture();
  const entries = adapters.zcode(f.zcode);
  const byName = Object.fromEntries(entries.map(e => [e.name, e]));
  assert.equal(byName.alpha.description, 'Model gateway serves the main branch');
  assert.equal(byName.beta.description, 'First heading wins as description');
  assert.ok(byName.MEMORY.description.length > 0);
  assert.equal(byName.long.description.length, 200);
  assert.equal(byName.hidden, undefined); // credential-shaped name is never indexed
  assert.ok(!entries.some(e => e.name === 'dangling-alias')); // symlinks are refused
  assert.ok(byName.leaky.description.includes('[secret]')); // descriptions are redacted
  assert.ok(!byName.leaky.description.includes('sk-ant-synthetic'));
  assert.equal(byName.quiet, undefined); // private scope never enters the index
  assert.equal(byName.alpha.type, 'project');
  assert.equal(byName.alpha.scope, 'shared');
  assert.equal(adapters['agents-md']([f.agents]).length, 1);
  assert.equal(adapters['agents-md']([f.agents])[0].type, 'authority');
  // One missing root never hides the others.
  assert.deepEqual(adapters['agents-md']([join(f.root, 'absent'), f.agents]).map(e => e.type), ['authority']);
  assert.deepEqual(adapters['agents-md']([join(f.root, 'absent')]), []);
  rmSync(f.root, { recursive: true, force: true });
});

test('entries are identified by full canonical path, so two roots cannot collide', () => {
  const f = fixture();
  const second = join(f.root, 'workspace-2');
  mkdirSync(second, { recursive: true });
  writeFileSync(join(second, 'AGENTS.md'), '# Second workspace guide\n');
  const first = adapters['agents-md']([f.agents]), both = adapters['agents-md']([f.agents, second]);
  assert.equal(both.length, 2);
  assert.notEqual(both[0].id, both[1].id);
  assert.equal(first[0].id, both[0].id); // id is stable per source path
  rmSync(f.root, { recursive: true, force: true });
});

function panorama(f, sources = ['zcode', 'agents-md'], config = {}) {
  const store = new Store(join(f.root, 'coordinator.sqlite'));
  store.takeLeadership();
  const p = new MemoryPanorama(store, { enabled: true, sources, pollMs: 1000, learnings: false,
    roots: { zcode: f.zcode, 'agents-md': [f.agents], claude: undefined, codex: undefined }, ...config });
  return { store, p };
}

test('search is conjunctive, capped, and provenance-carrying; stale entries survive a failed scan', async () => {
  const f = fixture(), { store, p } = panorama(f);
  await p.scan();
  const all = p.list({ limit: 20 });
  assert.ok(all.entries.length >= 6);
  assert(all.entries.every(e => e.source.host === store.authority));
  const hits = p.list({ query: 'gateway main', limit: 20 });
  assert.equal(hits.entries.length, 1);
  assert.equal(hits.entries[0].name, 'alpha');
  assert.equal(p.list({ query: 'gateway nothing', limit: 20 }).entries.length, 0);
  assert.equal(p.list({ query: '', limit: 2 }).entries.length, 2);
  assert.throws(() => p.list({ limit: 21 }), /limit/);
  // A vanished store leaves entries stale rather than erased.
  rmSync(f.zcode, { recursive: true, force: true });
  await p.scan();
  const stale = p.list({ query: 'alpha', limit: 20 });
  assert.equal(stale.entries[0].stale, true);
  assert.equal(p.status.sources.zcode.ok, false);
  // Restoring the same bytes clears the uncertainty on the next completed scan.
  mkdirSync(f.zcode, { recursive: true });
  writeFileSync(join(f.zcode, 'alpha.md'), '---\nname: alpha\ntype: project\ndescription: Model gateway serves the main branch\n---\nbody\n');
  await p.scan();
  const restored = p.list({ query: 'alpha', limit: 20 });
  assert.equal(restored.entries[0].stale, false);
  assert.equal(p.status.sources.zcode.ok, true);
  store.close();
  rmSync(f.root, { recursive: true, force: true });
});

test('a partially unreadable store is reported stale, not silently emptied', async () => {
  const f = fixture(), { store, p } = panorama(f, ['zcode']);
  await p.scan();
  const before = p.list({ limit: 20 }).entries.length;
  assert.ok(before >= 6);
  const sub = join(f.zcode, 'locked'); // a subdirectory inside the indexed store
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, 'inside.md'), '---\nname: inside\n---\n');
  await p.scan();
  assert.equal(p.list({ limit: 20 }).entries.length, before + 1);
  chmodSync(sub, 0o000);
  try {
    await p.scan();
    assert.equal(p.status.sources.zcode.ok, false);
    assert.equal(p.list({ limit: 20 }).entries.length, before + 1); // preserved as stale, not deleted
    assert.equal(p.list({ limit: 20 }).entries.every(e => e.stale), true);
  } finally { chmodSync(sub, 0o755); }
  store.close();
  rmSync(f.root, { recursive: true, force: true });
});

test('read is capped, redacted, refuses authority bodies, and revalidates the source', async () => {
  const f = fixture(), { store, p } = panorama(f);
  await p.scan();
  const heavy = p.list({ query: 'heavy' }).entries[0];
  const body = p.read(heavy.id);
  assert.equal(body.body.length, 16 * 1024);
  assert.equal(body.truncated, true);
  assert.equal(readFileSync(join(f.zcode, 'body-heavy.md')).length > 16 * 1024, true);
  const leaky = p.list({ query: 'leaky' }).entries[0];
  assert.ok(!p.read(leaky.id).body.includes('sk-ant-synthetic'));
  assert.ok(p.read(leaky.id).body.includes('[secret]'));
  const authority = p.list({ query: 'agents guide', limit: 20 }).entries[0];
  assert.equal(authority.type, 'authority');
  assert.throws(() => p.read(authority.id), e => e.code === 'AUTHORITY_BODY');
  // A replaced source (symlink pointing outside) is refused and marks the entry stale.
  rmSync(join(f.zcode, 'alpha.md'));
  symlinkSync('/etc/hosts', join(f.zcode, 'alpha.md'));
  const alpha = p.list({ query: 'alpha', limit: 20 }).entries.find(e => e.name === 'alpha');
  assert.throws(() => p.read(alpha.id), e => e.code === 'STALE_ENTRY');
  assert.equal(p.status.sources.zcode.ok, true); // read-time refusal does not fail the whole source
  assert.equal(p.list({ query: 'alpha', limit: 20 }).entries.find(e => e.name === 'alpha').stale, true);
  store.close();
  rmSync(f.root, { recursive: true, force: true });
});

test('private scope is enforced before persistence and drops out when it becomes private', async () => {
  const f = fixture(), { store, p } = panorama(f);
  await p.scan();
  assert.equal(p.list({ query: 'quiet', limit: 20 }).entries.length, 0); // never indexed
  rmSync(join(f.zcode, 'beta.md'));
  writeFileSync(join(f.zcode, 'beta.md'), '---\nname: beta\ntype: project\nscope: private\ndescription: now private\n---\n');
  await p.scan();
  assert.equal(p.list({ query: 'beta', limit: 20 }).entries.length, 0); // previously indexed, now dropped
  store.close();
  rmSync(f.root, { recursive: true, force: true });
});

test('disabled mode serves nothing and scans nothing', async () => {
  const f = fixture(), { store, p } = panorama(f, ['zcode', 'agents-md'], { enabled: false, learnings: true });
  // Persist rows directly, as a previously enabled instance would have.
  const rows = adapters.zcode(f.zcode).concat(adapters['agents-md']([f.agents]));
  p.sync('zcode', rows.filter(r => r.source === 'zcode'));
  p.sync('agents-md', rows.filter(r => r.source === 'agents-md'));
  await p.scan(); // must be a no-op
  assert.deepEqual(p.list({ limit: 20 }).entries, []);
  assert.throws(() => p.read('anything'), e => e.code === 'DISABLED');
  assert.deepEqual(p.learnings(), []);
  assert.equal(p.status.enabled, false);
  store.close();
  rmSync(f.root, { recursive: true, force: true });
});

test('an overflowing store is reported stale instead of silently truncated', async () => {
  const f = fixture();
  for (let i = 0; i < 2050; i++) writeFileSync(join(f.zcode, `bulk-${String(i).padStart(4, '0')}.md`), `---\nname: bulk-${i}\ndescription: filler\n---\n`);
  const { store, p } = panorama(f, ['zcode']);
  await p.scan();
  assert.equal(p.status.sources.zcode.ok, false);
  assert.equal(p.status.sources.zcode.error, 'ENTRY_CAP');
  assert.equal(p.list({ limit: 20 }).entries.every(e => e.stale), true);
  store.close();
  rmSync(f.root, { recursive: true, force: true });
});

test('learnings stay off until enabled and are bounded when on', async () => {
  const f = fixture(), { store, p } = panorama(f);
  await p.scan();
  assert.deepEqual(p.learnings(), []);
  p.config.learnings = true;
  const learnings = p.learnings();
  assert.ok(learnings.length <= 5);
  assert(learnings.every(l => typeof l.name === 'string' && typeof l.source === 'string'));
  store.close();
  rmSync(f.root, { recursive: true, force: true });
});

test('accord_recall spans linked hosts; memory-read fetches the owning body; sharing is refusable', { timeout: 30000 }, async t => {
  const f = fixture();
  const prior = {};
  const setEnv = (name, value) => {
    if (!(name in prior)) prior[name] = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  };
  setEnv('ACCORD_MEMORY', 'on');
  setEnv('ACCORD_MEMORY_SOURCES', 'zcode,agents-md');
  setEnv('ACCORD_MEMORY_ZCODE', f.zcode);
  setEnv('ACCORD_MEMORY_AGENTS_MD', f.agents);
  setEnv('ACCORD_MEMORY_POLL_MS', '250');
  t.after(() => {
    for (const [name, value] of Object.entries(prior)) setEnv(name, value);
    rmSync(f.root, { recursive: true, force: true });
  });
  const a = await harness(), b = await harness({ dir: null });
  t.after(async () => { await a.close(); await b.close(); });
  const [aAuth, bAuth] = [(await a.client('admin').host()).authority, (await b.client('admin').host()).authority];
  await link(a, b);
  // New links share nothing by default; memory search needs the explicit opt-in.
  await request(a.url, a.credential('admin'), '/v1/links/share', { key: randomUUID(), authority: bAuth, share: true });
  await request(b.url, b.credential('admin'), '/v1/links/share', { key: randomUUID(), authority: aAuth, share: true });
  await eventually(async () => {
    const local = await a.client('agent-a').collaborate('memories', { limit: 20 });
    return local.entries.filter(e => e.source.host === aAuth).length >= 6;
  });
  const combined = await a.client('agent-a').collaborate('memories', { limit: 20 });
  const remote = combined.entries.filter(e => e.source.host !== aAuth);
  assert.ok(remote.length >= 1, 'linked host entries appear with provenance');
  assert(combined.entries.every(e => e.source.harness === 'zcode' || e.source.harness === 'agents-md'));
  const onlyRemote = await a.client('agent-a').collaborate('memories', {}, bAuth);
  assert(onlyRemote.entries.every(e => e.source.host === bAuth));
  const target = onlyRemote.entries.find(e => e.type !== 'authority');
  const body = await a.client('agent-a').collaborate('memory-read', { id: target.id }, bAuth);
  assert.equal(body.name, target.name);
  assert.equal(typeof body.body, 'string');
  // A link can stop sharing memory without breaking anything else: B decides what B shares with A.
  await request(b.url, b.credential('admin'), '/v1/links/share', { key: randomUUID(), authority: aAuth, share: false });
  const after = await a.client('agent-a').collaborate('memories', { limit: 20 });
  assert.equal(after.entries.filter(e => e.source.host === bAuth).length, 0);
});

test('the join digest stays off by default', { timeout: 30000 }, async t => {
  const f = fixture();
  const prior = {};
  const setEnv = (name, value) => {
    if (!(name in prior)) prior[name] = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  };
  setEnv('ACCORD_MEMORY', 'on');
  setEnv('ACCORD_MEMORY_SOURCES', 'zcode');
  setEnv('ACCORD_MEMORY_ZCODE', f.zcode);
  setEnv('ACCORD_MEMORY_POLL_MS', '250');
  t.after(() => {
    for (const [name, value] of Object.entries(prior)) setEnv(name, value);
    rmSync(f.root, { recursive: true, force: true });
  });
  const h = await harness();
  t.after(async () => h.close());
  await eventually(async () => {
    const view = await request(h.url, h.credential('admin'), '/v1/bootstrap');
    return (view.learnings ?? []).length === 0;
  });
});

test('the join digest carries bounded learnings when enabled', { timeout: 30000 }, async t => {
  const f = fixture();
  const prior = {};
  const setEnv = (name, value) => {
    if (!(name in prior)) prior[name] = process.env[name];
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  };
  setEnv('ACCORD_MEMORY', 'on');
  setEnv('ACCORD_MEMORY_SOURCES', 'zcode');
  setEnv('ACCORD_MEMORY_ZCODE', f.zcode);
  setEnv('ACCORD_MEMORY_POLL_MS', '250');
  setEnv('ACCORD_MEMORY_LEARNINGS', 'on');
  t.after(() => {
    for (const [name, value] of Object.entries(prior)) setEnv(name, value);
    rmSync(f.root, { recursive: true, force: true });
  });
  const h = await harness();
  t.after(async () => h.close());
  await eventually(async () => {
    const view = await request(h.url, h.credential('admin'), '/v1/bootstrap');
    return Array.isArray(view.learnings) && view.learnings.length >= 1;
  });
  const view = await request(h.url, h.credential('admin'), '/v1/bootstrap');
  assert(view.learnings.length <= 5);
  assert(view.learnings.every(l => l.name && l.description && l.source));
});

test('session bookkeeping never stands in for a description', () => {
  const root = mkdtempSync(join(tmpdir(), 'accord-mem-codex-'));
  writeFileSync(join(root, 'summary.md'), 'thread_id: 1\nupdated_at: 2026-01-01\nrollout_path: /home/a/sessions/r.jsonl\ncwd: /home/a/project\n\n# Faster startup by caching the index\n');
  assert.equal(adapters.codex(root)[0].description, 'Faster startup by caching the index');
  rmSync(root, { recursive: true, force: true });
});

test('Claude memory is read from each project memory folder and nothing beside it', () => {
  const root = mkdtempSync(join(tmpdir(), 'accord-mem-claude-'));
  const memory = join(root, 'project-a', 'memory'), results = join(root, 'project-a', 'session-1', 'tool-results');
  mkdirSync(memory, { recursive: true }); mkdirSync(results, { recursive: true });
  writeFileSync(join(memory, 'deploy-steps.md'), '---\nname: deploy-steps\ndescription: Deploys need a manual dispatch\n---\nbody\n');
  writeFileSync(join(results, 'output.txt'), 'tool output is not memory\n');
  writeFileSync(join(root, 'project-a', 'session-1.jsonl'), '{}\n');
  writeFileSync(join(root, 'project-a', 'session-1', 'plan.md'), '# A session file, not a memory\n');
  writeFileSync(join(root, 'project-a', 'notes.txt'), 'loose project file\n');
  mkdirSync(join(root, 'project-b'));
  assert.deepEqual(adapters.claude(root).map(e => e.name), ['deploy-steps']);
  rmSync(root, { recursive: true, force: true });
});

test('a folder swapped for a link after indexing is refused at read', async () => {
  const f = fixture(), { store, p } = panorama(f, ['zcode']);
  const sub = join(f.zcode, 'notes');
  mkdirSync(sub); writeFileSync(join(sub, 'inside.md'), '---\nname: inside\ndescription: nested fact\n---\nsame bytes\n');
  await p.scan();
  const inside = p.list({ query: 'nested' }).entries[0];
  assert.equal(p.read(inside.id).name, 'inside');
  const elsewhere = join(f.root, 'elsewhere');
  mkdirSync(elsewhere); writeFileSync(join(elsewhere, 'inside.md'), readFileSync(join(sub, 'inside.md')));
  rmSync(sub, { recursive: true }); symlinkSync(elsewhere, sub);
  assert.throws(() => p.read(inside.id), e => e.code === 'STALE_ENTRY');
  store.close();
  rmSync(f.root, { recursive: true, force: true });
});

test('the panorama is off until the operator turns it on, and off clears what an earlier run indexed', () => {
  assert.equal(memoryConfig({}).enabled, false);
  assert.equal(memoryConfig({ ACCORD_MEMORY: 'on' }).enabled, true);
  const f = fixture(), { store, p } = panorama(f, ['zcode'], { enabled: false });
  p.sync('zcode', adapters.zcode(f.zcode));
  p.start();
  assert.equal(store.db.prepare('SELECT count(*) n FROM memory_entries').get().n, 0);
  store.close();
  rmSync(f.root, { recursive: true, force: true });
});

test('a memory whose name is not a slug is indexed under its file name', () => {
  const f = fixture();
  writeFileSync(join(f.zcode, 'two-words.md'), '---\nname: Two words\ndescription: named in prose\n---\nbody\n');
  assert.equal(adapters.zcode(f.zcode).find(e => e.description === 'named in prose').name, 'two-words');
  rmSync(f.root, { recursive: true, force: true });
});

test('a source taken out of the list stops being served and is cleared', async () => {
  const f = fixture(), { store, p } = panorama(f, ['zcode', 'agents-md']);
  await p.scan();
  const authority = p.list({ query: 'agents guide', limit: 20 }).entries[0];
  p.config.sources = ['zcode'];
  assert.equal(p.list({ query: 'agents guide', limit: 20 }).entries.length, 0);
  assert.throws(() => p.read(authority.id), e => e.code === 'NOT_FOUND');
  p.start(); p.close();
  assert.equal(store.db.prepare("SELECT count(*) n FROM memory_entries WHERE source='agents-md'").get().n, 0);
  store.close();
  rmSync(f.root, { recursive: true, force: true });
});

test('one file Accord cannot index is skipped and the rest of its source stays current', async () => {
  const f = fixture(), { store, p } = panorama(f, ['zcode']);
  writeFileSync(join(f.zcode, 'Meeting notes.md'), '# Notes without a slug name\n');
  await p.scan();
  assert.equal(p.status.sources.zcode.ok, true);
  assert.ok(p.list({ query: 'gateway', limit: 20 }).entries.length === 1);
  rmSync(join(f.zcode, 'beta.md'));
  writeFileSync(join(f.zcode, 'beta.md'), '---\nname: beta\nscope: private\ndescription: now private\n---\n');
  await p.scan();
  assert.equal(p.list({ query: 'beta', limit: 20 }).entries.length, 0);
  const claude = mkdtempSync(join(tmpdir(), 'accord-mem-claude-link-'));
  mkdirSync(join(claude, 'real', 'memory'), { recursive: true });
  writeFileSync(join(claude, 'real', 'memory', 'kept.md'), '---\nname: kept\ndescription: kept\n---\n');
  mkdirSync(join(claude, 'linked')); symlinkSync(f.zcode, join(claude, 'linked', 'memory'));
  assert.deepEqual(adapters.claude(claude).map(e => e.name), ['kept']);
  rmSync(claude, { recursive: true, force: true });
  store.close();
  rmSync(f.root, { recursive: true, force: true });
});

test('a linked host answer is checked and capped before an agent sees it', () => {
  const good = { id: 'a', name: 'n', type: 'project', description: 'd'.repeat(500), updated: '2026-01-01T00:00:00.000Z', source: { host: 'peer', harness: 'zcode', label: 'zcode' }, scope: 'shared', stale: false };
  const entries = peerEntries({ entries: [good, { ...good, updated: 7 }, { ...good, source: { host: 'other' } }, 'junk', { ...good, scope: 'private' }] }, 'peer');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].description.length, 200);
  assert.deepEqual(peerEntries({ entries: 'nope' }, 'peer'), []);
  assert.deepEqual(peerEntries(null, 'peer'), []);
});
