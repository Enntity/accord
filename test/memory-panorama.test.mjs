// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { MemoryPanorama, memoryConfig, adapters } from '../src/memory-panorama.mjs';
import { request } from '../src/common.mjs';
import { harness, eventually, link } from './helpers.mjs';
import { randomUUID } from 'node:crypto';

function fixture(env = {}) {
  const root = mkdtempSync(join(tmpdir(), 'accord-mem-'));
  const zcode = join(root, 'projects', 'proj', 'memory');
  mkdirSync(zcode, { recursive: true });
  writeFileSync(join(zcode, 'alpha.md'), '---\nname: alpha\ntype: project\ndescription: SparkGLM serves Atlas main\n---\nbody\n');
  writeFileSync(join(zcode, 'beta.md'), '---\nname: beta\ntype: project\n---\n# First heading wins as description\n');
  writeFileSync(join(zcode, 'MEMORY.md'), '- [Index line](alpha.md) — index entries are facts too\n');
  writeFileSync(join(zcode, 'long.md'), `---\nname: long\ndescription: ${'x'.repeat(400)}\n---\nbody\n`);
  writeFileSync(join(zcode, 'my-token.md'), '---\nname: hidden\n---\nsecret body\n');
  writeFileSync(join(zcode, 'body-heavy.md'), `---\nname: heavy\ndescription: big body\n---\n${'y'.repeat(17 * 1024)}\n`);
  const agents = join(root, 'workspace');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, 'AGENTS.md'), '# Workspace agent guide\n\nDo the right thing.\n');
  symlinkSync(join(zcode, 'alpha.md'), join(zcode, 'dangling-alias.md'));
  return { root, zcode, agents };
}

test('adapters index frontmatter, truncate descriptions, and refuse unsafe paths', () => {
  const f = fixture();
  const entries = adapters.zcode(f.zcode);
  const byName = Object.fromEntries(entries.map(e => [e.name, e]));
  assert.equal(byName.alpha.description, 'SparkGLM serves Atlas main');
  assert.equal(byName.beta.description, 'First heading wins as description');
  assert.ok(byName.MEMORY.description.length > 0);
  assert.equal(byName.long.description.length, 200);
  assert.equal(byName.hidden, undefined); // credential-shaped name is never indexed
  assert.ok(!entries.some(e => e.name === 'dangling-alias')); // symlinks are refused
  assert.equal(byName.alpha.type, 'project');
  assert.equal(byName.alpha.scope, 'shared');
  assert.equal(adapters['agents-md']([f.agents]).length, 1);
  assert.equal(adapters['agents-md']([f.agents])[0].type, 'authority');
  assert.equal(adapters['agents-md']([join(f.root, 'absent')]).length, 0); // missing store is absent, not stale
  rmSync(f.root, { recursive: true, force: true });
});

function panorama(f, sources = ['zcode', 'agents-md'], env = {}) {
  const store = new Store(join(f.root, 'coordinator.sqlite'));
  store.takeLeadership();
  const config = { enabled: true, sources, pollMs: 1000, learnings: false,
    roots: { zcode: f.zcode, 'agents-md': [f.agents], claude: undefined, codex: undefined }, ...env };
  const p = new MemoryPanorama(store, config);
  return { store, p };
}

test('search is conjunctive, capped, and provenance-carrying; stale entries survive a failed scan', async () => {
  const f = fixture(), { store, p } = panorama(f);
  await p.scan();
  const all = p.list({ limit: 20 });
  assert.ok(all.entries.length >= 6);
  assert(all.entries.every(e => e.source.host === store.authority));
  const hits = p.list({ query: 'sparkglm atlas', limit: 20 });
  assert.equal(hits.entries.length, 1);
  assert.equal(hits.entries[0].name, 'alpha');
  assert.equal(p.list({ query: 'sparkglm nothing', limit: 20 }).entries.length, 0);
  assert.equal(p.list({ query: '', limit: 2 }).entries.length, 2);
  assert.throws(() => p.list({ limit: 21 }), /limit/);
  // A vanished store leaves entries stale rather than erased.
  rmSync(f.zcode, { recursive: true, force: true });
  await p.scan();
  const stale = p.list({ query: 'alpha', limit: 20 });
  assert.equal(stale.entries[0].stale, true);
  assert.equal(p.status.sources.zcode.ok, false);
  store.close();
  rmSync(f.root, { recursive: true, force: true });
});

test('read is capped, refuses authority bodies, and goes stale when the body is gone', async () => {
  const f = fixture(), { store, p } = panorama(f);
  await p.scan();
  const heavy = p.list({ query: 'heavy' }).entries[0];
  const body = p.read(heavy.id);
  assert.equal(body.body.length, 16 * 1024);
  assert.equal(readFileSync(f.zcode + '/body-heavy.md').length > 16 * 1024, true);
  const authority = p.list({ query: 'agents guide', limit: 20 }).entries[0];
  assert.equal(authority.type, 'authority');
  assert.throws(() => p.read(authority.id), e => e.code === 'AUTHORITY_BODY');
  rmSync(join(f.zcode, 'body-heavy.md'));
  assert.throws(() => p.read(heavy.id), e => e.code === 'STALE_ENTRY');
  store.close();
  rmSync(f.root, { recursive: true, force: true });
});

test('the entry cap bounds a runaway store', async () => {
  const f = fixture();
  for (let i = 0; i < 2050; i++) writeFileSync(join(f.zcode, `bulk-${String(i).padStart(4, '0')}.md`), `---\nname: bulk-${i}\ndescription: filler\n---\n`);
  const { store, p } = panorama(f);
  await p.scan();
  assert.equal(p.status.sources.zcode.entries, 2000);
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
