// Focused tests for post-publication verification and recovery. In-memory fakes only: no network, no GitHub, nothing published.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { validateConfig, lookupRelease, ReleaseError, validateLedger, planRetention, previousGood, unresolvedPublications } from './lib.mjs';
import { verifyPublication, restorePreviousLatest, completePublication, incidentReport } from './postpublish.mjs';

const config = validateConfig({ schema: 1, channel: 'beta', appId: 'com.example.app.beta', productName: 'P BETA', repo: 'o/beta', tagPattern: '^v(\\d+\\.\\d+\\.\\d+)$', installerTemplate: 'P-{version}.bin', metadataName: 'latest.yml', statementName: 'release-statement.json', publicKeyFile: 'keys/k.txt', prerelease: false, retention: 2, approvalEnvironment: null });
const TAG = 'v2.0.0', VER = '2.0.0';
const exp = { installer: 'P-2.0.0.bin', metadata: 'latest.yml', statement: 'release-statement.json' };
const sha = (b, a) => crypto.createHash(a).update(b).digest(a === 'sha256' ? 'hex' : 'base64');
const key = crypto.generateKeyPairSync('ed25519');
const publicKey = key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

// A synthetic published release: three files, the matching release JSON and the "expected" facts the draft verification produces.
function world({ metaSha512, stmtSha512, stmtKey = key, sequence = 5 } = {}) {
  const installer = Buffer.from('synthetic installer bytes '.repeat(50));
  const s512 = sha(installer, 'sha512');
  const yml = Buffer.from(`version: ${VER}\nfiles:\n  - url: ${exp.installer}\n    sha512: ${metaSha512 || s512}\n    size: ${installer.length}\npath: ${exp.installer}\nsha512: ${metaSha512 || s512}\nreleaseDate: '2026-01-01T00:00:00.000Z'\n`);
  const st = Buffer.from(JSON.stringify({ appId: config.appId, channel: 'beta', version: VER, sequence, installerName: exp.installer, size: installer.length, sha512: stmtSha512 || s512, issuedAt: '2026-01-01T00:00:00Z' }));
  const stmt = Buffer.from(JSON.stringify({ statement: st.toString('base64'), signature: crypto.sign(null, Buffer.concat([Buffer.from('HYPE-TOOLS-UPDATE-V1\n'), st]), stmtKey.privateKey).toString('base64') }));
  const files = { [exp.installer]: installer, [exp.metadata]: yml, [exp.statement]: stmt };
  const assets = Object.entries(files).map(([name, b], i) => ({ id: 100 + i, name, size: b.length, digest: `sha256:${sha(b, 'sha256')}`, download_count: 0 }));
  const release = { tag_name: TAG, draft: false, prerelease: false, immutable: true, html_url: 'https://example.invalid/r', published_at: '2026-01-02T00:00:00Z', assets };
  const expected = { assets: Object.fromEntries(Object.entries(files).map(([n, b]) => [n, { size: b.length, sha256: sha(b, 'sha256') }])), installer: { size: installer.length, sha512: s512 } };
  const snapshot = assets.map(({ id, name, size }) => ({ id, name, size }));
  return { files, release, expected, snapshot, installer, s512 };
}

// Fake GitHub: `served` is what the public URL returns (can differ from `release.assets` to simulate corruption).
function fakeIo(w, o = {}) {
  const served = { ...w.files, ...(o.served || {}) };
  const st = { latest: o.latest ?? TAG, atom: o.atom ?? TAG, release: o.release || w.release, calls: [], releases: o.releases || {}, sleeps: [], downloads: {} };
  // `o.seq` holds answers served once each, in order, before the normal answer: seq.latest / seq.atom entries are a tag or
  // 'throw'; seq[assetName] entries are an HTTP status or 'throw'; seq.latestAfterSet entries are served after setLatest.
  const seq = Object.fromEntries(Object.entries(o.seq || {}).map(([k, v]) => [k, [...v]]));
  const next = k => (seq[k] && seq[k].length ? seq[k].shift() : undefined);
  return {
    st,
    getRelease: async tag => { if (o.getReleaseThrows) throw new Error('boom'); return tag === TAG ? st.release : (st.releases[tag] || (() => { throw new Error('404'); })()); },
    getLatest: async () => {
      if (o.getLatestThrows) throw new Error('latest unreadable');
      const s = st.calls.some(c => c.startsWith('setLatest')) ? next('latestAfterSet') : next('latest');
      if (s === 'throw') throw new Error('HTTP 503');
      return { tag_name: s ?? st.latest };
    },
    sleep: async ms => { st.sleeps.push(ms); },
    download: async url => {
      const name = decodeURIComponent(url.split('/').pop());
      st.downloads[name] = (st.downloads[name] || 0) + 1;
      const s = next(name);
      if (s === 'throw') throw new TypeError('fetch failed: ETIMEDOUT');
      if (typeof s === 'number') return { ok: false, status: s };
      if (o.downloadThrows === name) throw new Error('connection reset');
      if (o.http && o.http[name]) return { ok: false, status: o.http[name] };
      const b = served[name];
      if (!b) return { ok: false, status: 404 };
      return { ok: true, status: 200, size: b.length, sha256: sha(b, 'sha256'), sha512: sha(b, 'sha512'), body: b.length <= 1_000_000 && name !== exp.installer ? b : null };
    },
    atomFirstTag: async () => { const s = next('atom'); if (s === 'throw') throw new Error('atom HTTP 502'); return s ?? st.atom; },
    setLatest: async tag => {
      st.calls.push(`setLatest ${tag}`);
      if (o.setLatestThrows) throw new Error('403 forbidden');
      if (!o.setLatestNoEffect) st.latest = tag;
      if (o.setLatestErrorAfter) throw new Error('HTTP 502: Bad Gateway (after the change was applied)');
    },
  };
}
const run = (w, io, extra = {}) => verifyPublication({ io, config, repo: 'o/beta', tag: TAG, version: VER, exp, expected: w.expected, snapshot: w.snapshot, lastSequence: 4, publicKey, ...extra });
const has = (r, code) => assert.ok(r.problems.some(p => p.startsWith(code + ':')), `expected ${code} in ${JSON.stringify(r.problems)}`);

test('a healthy publication has no problems and checks all three assets', async () => {
  const w = world();
  const r = await run(w, fakeIo(w));
  assert.deepEqual(r.problems, []);
  assert.equal(r.published.immutable, true);
});

test('missing published asset is reported (installer, metadata, statement)', async () => {
  for (const name of Object.values(exp)) {
    const w = world();
    const release = { ...w.release, assets: w.release.assets.filter(a => a.name !== name) };
    const r = await run(w, fakeIo(w, { release }));
    has(r, 'asset-missing'); has(r, 'asset-set-changed');
  }
});

test('failed download is reported for each asset, as HTTP error and as a thrown error', async () => {
  for (const name of Object.values(exp)) {
    const w = world();
    const r = await run(w, fakeIo(w, { http: { [name]: 404 } }));
    assert.ok(r.problems.some(p => p.startsWith('download-failed:') && p.includes(name) && p.includes('404')), JSON.stringify(r.problems));
    const t = await run(w, fakeIo(w, { downloadThrows: name }));
    assert.ok(t.problems.some(p => p.startsWith('download-failed:') && p.includes('connection reset')), JSON.stringify(t.problems));
  }
});

test('size mismatch: the public installer is shorter than the verified draft', async () => {
  const w = world();
  const r = await run(w, fakeIo(w, { served: { [exp.installer]: w.installer.subarray(0, w.installer.length - 1) } }));
  has(r, 'size-mismatch'); has(r, 'digest-mismatch'); has(r, 'installer-changed');
});

test('digest mismatch: same size, one flipped byte in the installer', async () => {
  const w = world();
  const bad = Buffer.from(w.installer); bad[3] ^= 1;
  const r = await run(w, fakeIo(w, { served: { [exp.installer]: bad } }));
  has(r, 'digest-mismatch'); has(r, 'installer-changed'); has(r, 'installer-mismatch');
  assert.ok(!r.problems.some(p => p.startsWith('size-mismatch')));
});

test('digest mismatch: metadata or statement bytes changed after verification', async () => {
  for (const name of [exp.metadata, exp.statement]) {
    const w = world();
    const r = await run(w, fakeIo(w, { served: { [name]: Buffer.concat([w.files[name], Buffer.from(' ')]) } }));
    assert.ok(r.problems.some(p => p.startsWith('digest-mismatch:') && p.includes(name)), JSON.stringify(r.problems));
  }
});

test('digest mismatch against the verified draft is caught even when GitHub\'s digest agrees with the public bytes', async () => {
  const w = world();
  const swapped = Buffer.concat([w.files[exp.statement], Buffer.from(' ')]);
  const release = { ...w.release, assets: w.release.assets.map(a => a.name === exp.statement ? { ...a, size: swapped.length, digest: `sha256:${sha(swapped, 'sha256')}` } : a) };
  const r = await run(w, fakeIo(w, { release, served: { [exp.statement]: swapped } }));
  assert.ok(r.problems.some(p => p.startsWith('digest-mismatch:') && p.includes('verified draft')), JSON.stringify(r.problems));
});

test('GitHub digest that disagrees with the public bytes, or is absent, is reported', async () => {
  const w = world();
  const wrong = { ...w.release, assets: w.release.assets.map(a => a.name === exp.installer ? { ...a, digest: 'sha256:' + '0'.repeat(64) } : a) };
  has(await run(w, fakeIo(w, { release: wrong })), 'digest-mismatch');
  const none = { ...w.release, assets: w.release.assets.map(a => ({ ...a, digest: null })) };
  has(await run(w, fakeIo(w, { release: none })), 'digest-missing');
});

test('installer must match the update metadata and the signed statement (draft-consistent bytes, inconsistent contents)', async () => {
  const m = world({ metaSha512: sha(Buffer.from('another installer'), 'sha512') });
  const r1 = await run(m, fakeIo(m));
  assert.deepEqual(r1.problems.map(p => p.split(':')[0]), ['installer-mismatch']);
  assert.ok(r1.problems[0].includes(exp.metadata) && r1.problems[0].includes('meta-hash'));
  const s = world({ stmtSha512: sha(Buffer.from('another installer'), 'sha512') });
  const r2 = await run(s, fakeIo(s));
  assert.deepEqual(r2.problems.map(p => p.split(':')[0]), ['installer-mismatch']);
  assert.ok(r2.problems[0].includes(exp.statement) && r2.problems[0].includes('stmt-hash'));
  const k = world({ stmtKey: crypto.generateKeyPairSync('ed25519') });
  assert.ok((await run(k, fakeIo(k))).problems[0].includes('stmt-signature'));
  const q = world({ sequence: 4 });
  assert.ok((await run(q, fakeIo(q))).problems[0].includes('stmt-replay'));
});

test('latest pointer, atom feed, immutability, prerelease flag and draft state are each checked', async () => {
  const w = world();
  has(await run(w, fakeIo(w, { latest: 'v1.0.0' })), 'latest-pointer');
  has(await run(w, fakeIo(w, { atom: 'v1.0.0' })), 'atom-feed');
  has(await run(w, fakeIo(w, { release: { ...w.release, immutable: false } })), 'not-immutable');
  has(await run(w, fakeIo(w, { release: { ...w.release, prerelease: true } })), 'prerelease-flag');
  has(await run(w, fakeIo(w, { release: { ...w.release, draft: true } })), 'still-draft');
  has(await run(w, fakeIo(w, { getReleaseThrows: true })), 'release-read');
  has(await run(w, fakeIo(w, { getLatestThrows: true })), 'latest-read');
});

// ---- recovery ----
const PREV = { tag: 'v1.5.0', version: '1.5.0', sequence: 4 };
const prevRelease = (o = {}) => ({ tag_name: PREV.tag, draft: false, prerelease: false, immutable: true, assets: ['P-1.5.0.bin', 'latest.yml', 'release-statement.json'].map((name, i) => ({ id: i, name, size: 1, digest: 'sha256:aa' })), ...o });

test('restore: previous release becomes latest again and is read back', async () => {
  const w = world();
  const io = fakeIo(w, { releases: { [PREV.tag]: prevRelease() } });
  const r = await restorePreviousLatest({ io, config, previous: PREV });
  assert.equal(r.outcome, 'restored-and-verified');
  assert.deepEqual(io.st.calls, ['setLatest v1.5.0']);
  assert.deepEqual(io.st.sleeps, []);
});

test('restore fails closed: setting latest fails, no effect, previous unreadable, previous not healthy, no previous', async () => {
  const w = world();
  const rel = { [PREV.tag]: prevRelease() };
  assert.equal((await restorePreviousLatest({ io: fakeIo(w, { releases: rel, setLatestThrows: true }), config, previous: PREV })).outcome, 'restore-failed');
  assert.equal((await restorePreviousLatest({ io: fakeIo(w, { releases: rel, setLatestNoEffect: true }), config, previous: PREV })).outcome, 'restore-unverified');
  assert.equal((await restorePreviousLatest({ io: fakeIo(w, { releases: {} }), config, previous: PREV })).outcome, 'restore-unverified');
  assert.equal((await restorePreviousLatest({ io: fakeIo(w, { releases: rel, getLatestThrows: true }), config, previous: PREV })).outcome, 'restore-unverified');
  assert.equal((await restorePreviousLatest({ io: fakeIo(w, { releases: { [PREV.tag]: prevRelease({ immutable: false }) } }), config, previous: PREV })).outcome, 'restore-unverified');
  assert.equal((await restorePreviousLatest({ io: fakeIo(w, { releases: { [PREV.tag]: prevRelease({ draft: true }) } }), config, previous: PREV })).outcome, 'restore-unverified');
  assert.equal((await restorePreviousLatest({ io: fakeIo(w, { releases: { [PREV.tag]: prevRelease({ assets: [] }) } }), config, previous: PREV })).outcome, 'restore-unverified');
  const none = fakeIo(w);
  assert.equal((await restorePreviousLatest({ io: none, config, previous: null })).outcome, 'no-previous-good');
  assert.deepEqual(none.st.calls, []);
});

test('restore: the read-back decides; a command error with a confirmed state is restored, and the error is kept', async () => {
  const w = world();
  const io = fakeIo(w, { releases: { [PREV.tag]: prevRelease() }, setLatestErrorAfter: true });
  const r = await restorePreviousLatest({ io, config, previous: PREV });
  assert.equal(r.outcome, 'restored-and-verified');
  assert.match(r.detail, /command reported an error, but the read-back confirms/);
  assert.ok(r.steps.some(s => /reported an error: HTTP 502/.test(s)), JSON.stringify(r.steps));
  // a command error AND a wrong read-back is still restore-failed, never restored
  const bad = await restorePreviousLatest({ io: fakeIo(w, { releases: { [PREV.tag]: prevRelease() }, setLatestThrows: true }), config, previous: PREV });
  assert.equal(bad.outcome, 'restore-failed');
  assert.match(bad.detail, /403 forbidden.*expected v1\.5\.0/);
});

test('restore: a briefly stale latest read-back is re-read (never re-set); a persistently wrong one stays unverified', async () => {
  const w = world();
  const io = fakeIo(w, { releases: { [PREV.tag]: prevRelease() }, seq: { latestAfterSet: [TAG, 'throw'] } });
  const r = await restorePreviousLatest({ io, config, previous: PREV, delayMs: 10 });
  assert.equal(r.outcome, 'restored-and-verified');
  assert.deepEqual(io.st.calls, ['setLatest v1.5.0'], 'the set command is issued exactly once');
  assert.deepEqual(io.st.sleeps, [10, 20]);
  const stuck = fakeIo(w, { releases: { [PREV.tag]: prevRelease() }, setLatestNoEffect: true });
  const s = await restorePreviousLatest({ io: stuck, config, previous: PREV, delayMs: 10 });
  assert.equal(s.outcome, 'restore-unverified');
  assert.equal(stuck.st.sleeps.length, 3, 'bounded: 4 reads, 3 waits');
});

test('public downloads: transient errors are retried and then pass; persistent ones fail after 4 attempts', async () => {
  const w = world();
  for (const answers of [[503, 'throw'], [404, 404, 404], [429], [408, 500]]) {
    const io = fakeIo(w, { seq: { [exp.installer]: answers } });
    const r = await run(w, io, { delayMs: 1 });
    assert.deepEqual(r.problems, [], `${answers}: ${JSON.stringify(r.problems)}`);
    assert.equal(io.st.downloads[exp.installer], answers.length + 1);
  }
  const io = fakeIo(w, { seq: { [exp.metadata]: [503, 503, 503, 503, 503] } });
  const r = await run(w, io, { delayMs: 1 });
  assert.ok(r.problems.some(p => p === `download-failed: ${exp.metadata}: HTTP 503 (after 4 attempts)`), JSON.stringify(r.problems));
  assert.equal(io.st.downloads[exp.metadata], 4);
  const t = fakeIo(w, { seq: { [exp.statement]: ['throw', 'throw', 'throw', 'throw'] } });
  assert.ok((await run(w, t, { delayMs: 1 })).problems.some(p => p.startsWith('download-failed:') && p.includes('ETIMEDOUT') && p.includes('after 4 attempts')));
});

test('public downloads: a non-transient status is not retried, and an integrity mismatch is never retried or accepted', async () => {
  const w = world();
  const io = fakeIo(w, { seq: { [exp.installer]: [403] } });
  const r = await run(w, io, { delayMs: 1 });
  assert.ok(r.problems.some(p => p === `download-failed: ${exp.installer}: HTTP 403`), JSON.stringify(r.problems));
  assert.equal(io.st.downloads[exp.installer], 1);
  const bad = Buffer.from(w.installer); bad[5] ^= 1;
  const m = fakeIo(w, { served: { [exp.installer]: bad } });
  const mr = await run(w, m, { delayMs: 1 });
  has(mr, 'digest-mismatch');
  assert.equal(m.st.downloads[exp.installer], 1, 'a response that arrived is checked once');
});

test('feed and latest pointer: a stale or failed read is re-read; the last answer counts', async () => {
  const w = world();
  const ok = fakeIo(w, { seq: { atom: ['v1.0.0', 'throw', 'v1.0.0'], latest: ['v1.0.0', 'throw'] } });
  assert.deepEqual((await run(w, ok, { delayMs: 1 })).problems, []);
  const stale = fakeIo(w, { atom: 'v1.0.0' });
  const s = await run(w, stale, { delayMs: 1 });
  assert.ok(s.problems.some(p => p === 'atom-feed: releases.atom first entry is v1.0.0, expected v2.0.0 (after 4 attempts)'), JSON.stringify(s.problems));
  const broken = fakeIo(w, { seq: { atom: ['throw', 'throw', 'throw', 'throw'] } });
  has(await run(w, broken, { delayMs: 1 }), 'atom-read');
  const wrong = fakeIo(w, { latest: 'v1.0.0' });
  has(await run(w, wrong, { delayMs: 1 }), 'latest-pointer');
});

test('afterVerify: an extra problem it returns fails the publication through the normal recovery path', async () => {
  const w = world(), rec = ledgerRecorder();
  const io = fakeIo(w, { releases: { [PREV.tag]: prevRelease() } });
  const seen = [];
  const out = await completePublication({ io, config, repo: 'o/beta', tag: TAG, version: VER, v: draftFacts(w), previous: PREV, latestBefore: PREV.tag, record: rec.record,
    afterVerify: async result => { seen.push(result.problems.length); return ['test-injected-failure: injected by a test'] } });
  assert.deepEqual(seen, [0], 'called once, after the real checks, with their result');
  assert.equal(out.healthy, false);
  assert.deepEqual(out.problems, ['test-injected-failure: injected by a test']);
  assert.equal(out.recovery.outcome, 'restored-and-verified');
  assert.deepEqual(rec.writes, ['pending-verification', 'failed-verification']);
  assert.equal(rec.last.problems[0], 'test-injected-failure: injected by a test');
  assert.equal(rec.last.recovery, 'restored-and-verified');
  const clean = await completePublication({ io: fakeIo(w), config, repo: 'o/beta', tag: TAG, version: VER, v: draftFacts(w), previous: PREV, latestBefore: PREV.tag, record: ledgerRecorder().record, afterVerify: async () => [] });
  assert.equal(clean.healthy, true);
  const io2 = fakeIo(w, { releases: { [PREV.tag]: prevRelease() } });
  const thrown = await completePublication({ io: io2, config, repo: 'o/beta', tag: TAG, version: VER, v: draftFacts(w), previous: PREV, latestBefore: PREV.tag, record: ledgerRecorder().record, afterVerify: async () => { throw new Error('hook broke'); } });
  assert.equal(thrown.healthy, false);
  assert.deepEqual(thrown.problems, ['after-verify-error: hook broke']);
  assert.equal(thrown.recovery.outcome, 'restored-and-verified', 'a broken hook still leads to recovery');
});

// ---- the whole post-publication path with the ledger ----
const draftFacts = w => ({ statement: { sequence: 5 }, installerSha512: w.s512, exp, expected: w.expected, snapshot: w.snapshot, lastSequence: 4, publicKey });
const ledgerRecorder = (failOn) => { const r = { writes: [], last: null }; r.record = f => { r.writes.push(f.status); r.last = f; return failOn === f.status ? `write of ${f.status} failed` : null; }; return r; };
const complete = (w, io, rec, previous = PREV) => completePublication({ io, config, repo: 'o/beta', tag: TAG, version: VER, v: draftFacts(w), previous, latestBefore: PREV.tag, record: rec.record });

test('healthy path: ledger goes pending-verification then published, nothing restored', async () => {
  const w = world(), rec = ledgerRecorder();
  const io = fakeIo(w, { releases: { [PREV.tag]: prevRelease() } });
  const out = await complete(w, io, rec);
  assert.equal(out.healthy, true);
  assert.deepEqual(rec.writes, ['pending-verification', 'published']);
  assert.deepEqual(io.st.calls, []);
});

test('post-publication asset check fails: recorded failed-verification, latest restored and verified, reported honestly', async () => {
  const w = world(), rec = ledgerRecorder();
  const bad = Buffer.from(w.installer); bad[0] ^= 1;
  const io = fakeIo(w, { served: { [exp.installer]: bad }, releases: { [PREV.tag]: prevRelease() } });
  const out = await complete(w, io, rec);
  assert.equal(out.healthy, false);
  assert.deepEqual(rec.writes, ['pending-verification', 'failed-verification']);
  assert.equal(out.recovery.outcome, 'restored-and-verified');
  assert.equal(io.st.latest, PREV.tag);
  const text = out.lines.join('\n');
  assert.match(text, /VERIFICATION FAILED for v2\.0\.0.*NOT healthy/);
  assert.match(text, /EXPOSED:/); assert.match(text, /RESTORED:/); assert.match(text, /STILL PUBLIC:/);
  assert.doesNotMatch(text, /MANUAL INTERVENTION REQUIRED NOW/);
  assert.doesNotMatch(text, /posted as healthy|published successfully/);
});

test('asset check fails AND restoring the previous latest fails: never reported as recovered, manual action demanded', async () => {
  const w = world(), rec = ledgerRecorder();
  const bad = Buffer.from(w.installer); bad[0] ^= 1;
  const io = fakeIo(w, { served: { [exp.installer]: bad }, releases: { [PREV.tag]: prevRelease() }, setLatestThrows: true });
  const out = await complete(w, io, rec);
  assert.equal(out.healthy, false);
  assert.equal(out.recovery.outcome, 'restore-failed');
  assert.equal(io.st.latest, TAG, 'the bad release is still latest, and the report must say so');
  assert.deepEqual(rec.writes, ['pending-verification', 'failed-verification']);
  const text = out.lines.join('\n');
  assert.match(text, /NOT RESTORED \(restore-failed\)/);
  assert.match(text, /MANUAL INTERVENTION REQUIRED NOW/);
  assert.doesNotMatch(text, /RESTORED: \/releases\/latest/);
});

test('asset check fails and the restore cannot be verified (latest reads back wrong)', async () => {
  const w = world(), rec = ledgerRecorder();
  const bad = Buffer.from(w.installer); bad[0] ^= 1;
  const io = fakeIo(w, { served: { [exp.installer]: bad }, releases: { [PREV.tag]: prevRelease() }, setLatestNoEffect: true });
  const out = await complete(w, io, rec);
  assert.equal(out.recovery.outcome, 'restore-unverified');
  assert.match(out.lines.join('\n'), /MANUAL INTERVENTION REQUIRED NOW/);
});

test('first release (no previous known-good) cannot be restored and says so', async () => {
  const w = world(), rec = ledgerRecorder();
  const io = fakeIo(w, { http: { [exp.installer]: 500 } });
  const out = await complete(w, io, rec, null);
  assert.equal(out.recovery.outcome, 'no-previous-good');
  assert.match(out.lines.join('\n'), /NOT RESTORED: no earlier verified release exists.*still the latest/);
  assert.deepEqual(io.st.calls, []);
});

test('ledger write failures are visible, not silent', async () => {
  const w = world();
  const io = () => fakeIo(w, { releases: { [PREV.tag]: prevRelease() } });
  const a = await complete(w, io(), ledgerRecorder('published'));
  assert.equal(a.healthy, false);
  assert.match(a.lines.join('\n'), /still recorded as pending-verification/);
  const rec = ledgerRecorder('failed-verification');
  const bad = Buffer.from(w.installer); bad[0] ^= 1;
  const b = await complete(w, fakeIo(w, { served: { [exp.installer]: bad }, releases: { [PREV.tag]: prevRelease() } }), rec);
  assert.match(b.lines.join('\n'), /is NOT recorded as failed-verification/);
  const c = await complete(w, io(), ledgerRecorder('pending-verification'));
  assert.equal(c.healthy, false, 'if the pending record could not be written the release is not reported healthy');
});

test('an unexpected exception during verification becomes a failed publication, not a crash', async () => {
  const w = world(), rec = ledgerRecorder();
  const io = fakeIo(w, { releases: { [PREV.tag]: prevRelease() } });
  io.download = () => { throw new TypeError('unexpected'); };
  const out = await complete(w, io, rec);
  assert.equal(out.healthy, false);
  assert.ok(out.problems.some(p => p.startsWith('download-failed:')));
});

test('incident report for a failed first publication names the exposure without claiming recovery', () => {
  const lines = incidentReport({ tag: TAG, version: VER, published: { url: 'u', publishedAt: 't', downloads: ['a: 3'] }, problems: ['x: y'], recovery: { outcome: 'no-previous-good', detail: 'none' }, previous: null, latestBefore: null });
  assert.ok(lines.some(l => l.includes('a: 3')));
  assert.ok(lines.some(l => l.startsWith('MANUAL:')));
});

// ---- ledger / retention treat unhealthy releases correctly ----
const L = (...r) => validateLedger({ schema: 1, releases: r.map(([tag, sequence, status]) => ({ tag, version: tag.slice(1), sequence, status })) });
const R = (tag, immutable = true) => ({ tag_name: tag, immutable, draft: false, prerelease: false });
test('failed-verification releases are never healthy, never kept as healthy, never deleted; previous known-good ignores them', () => {
  const ledger = L(['v1.0.0', 1, 'published'], ['v1.1.0', 2, 'published'], ['v1.2.0', 3, 'published'], ['v1.3.0', 4, 'failed-verification']);
  const live = ['v1.0.0', 'v1.1.0', 'v1.2.0', 'v1.3.0'].map(t => R(t));
  const p = planRetention({ ledger, liveReleases: live, keep: 2 });
  assert.deepEqual(p.keep.sort(), ['v1.1.0', 'v1.2.0']);
  assert.deepEqual(p.delete, ['v1.0.0']);
  assert.deepEqual(p.unhealthyOwned, ['v1.3.0']);
  assert.equal(p.unowned.length, 0);
  assert.equal(previousGood(ledger, live).tag, 'v1.2.0');
  assert.equal(previousGood(L(['v1.0.0', 1, 'failed-verification']), [R('v1.0.0')]), null);
  assert.equal(previousGood(L(['v1.0.0', 1, 'published']), [R('v1.0.0', false)]), null);
});
test('a publication stuck in pending-verification blocks the next one', () => {
  assert.deepEqual(unresolvedPublications(L(['v1.0.0', 1, 'published'], ['v1.1.0', 2, 'pending-verification'])), ['v1.1.0']);
  assert.deepEqual(unresolvedPublications(L(['v1.0.0', 1, 'failed-verification'])), []);
});

// ---- draft lookup (the intermittent "found 0") ----
const rel = (tag, draft = true, name = `Rehearsal ${tag.slice(1)}`) => ({ tag_name: tag, name, draft });
const code = f => { try { f(); } catch (e) { assert.ok(e instanceof ReleaseError); return e; } assert.fail('expected failure'); };
test('lookup: exactly one match passes; zero or two fail closed with evidence in the message', () => {
  assert.equal(lookupRelease([rel('v1.9.0'), rel('v1.9.1')], 'v1.9.0', '1.9.0').tag_name, 'v1.9.0');
  const none = code(() => lookupRelease([rel('v1.9.1')], 'v1.9.0', '1.9.0'));
  assert.equal(none.code, 'release-lookup');
  assert.match(none.message, /found 0.*1 drafts.*v1\.9\.1/);
  assert.equal(code(() => lookupRelease([rel('v1.9.0'), rel('v1.9.0', false)], 'v1.9.0', '1.9.0')).message.includes('found 2'), true);
});
test('lookup: a later read that sees the draft is only evidence; the failure is not masked and relist is not used as the answer', () => {
  let relists = 0;
  const e = code(() => lookupRelease([rel('v1.9.1')], 'v1.9.0', '1.9.0', () => { relists++; return [rel('v1.9.0')]; }));
  assert.equal(e.code, 'release-lookup');
  assert.match(e.message, /second listing found 1/);
  assert.equal(relists, 1);
  assert.equal(code(() => lookupRelease([rel('v1.9.1')], 'v1.9.0', '1.9.0', () => { throw new Error('net'); })).code, 'release-lookup');
  // a release whose tag differs but whose title carries the version is listed as "similar" so a naming problem is visible
  assert.match(code(() => lookupRelease([rel('untagged-abc', true, 'Rehearsal 1.9.0 (valid)')], 'v1.9.0', '1.9.0')).message, /similar.*untagged-abc/);
});
