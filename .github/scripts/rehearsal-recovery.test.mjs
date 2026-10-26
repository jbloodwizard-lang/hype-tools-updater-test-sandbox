// Offline end-to-end test of the recovery rehearsal, step by step as recovery-rehearsal.yml runs it, against a fake gh
// (test-fake-gh.mjs) and a fake fetch (test-fake-fetch.mjs). Nothing reaches GitHub or the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..', '..');
const REPO = 'jbloodwizard-lang/hype-tools-updater-test-sandbox';
const b64 = s => Buffer.from(s).toString('base64');
const crypto = await import('node:crypto');
const asset = (id, name, text) => ({ id, name, size: Buffer.byteLength(text), state: 'uploaded', digest: 'sha256:' + crypto.createHash('sha256').update(text).digest('hex'), updated_at: 't', content: b64(text) });
const release = (id, tag, order, extra = {}) => ({ id, tag_name: tag, name: tag, draft: false, prerelease: false, immutable: true, target_commitish: 'main', html_url: `https://github.com/${REPO}/releases/tag/${tag}`, published_at: '2026-10-25T05:00:00Z', publishOrder: order,
  assets: [asset(id * 10 + 1, `SandboxApp-${tag.slice(1)}.AppImage`, `installer ${tag}`), asset(id * 10 + 2, 'latest-linux.yml', `yml ${tag}`), asset(id * 10 + 3, 'release-statement.json', `stmt ${tag}`)], ...extra });

function setup({ faults = {}, tags = [], latest = 'v3.0.0' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearsal-'));
  for (const f of ['release-config.json', 'ledger', 'keys', '.github']) fs.cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec node ${JSON.stringify(path.join(HERE, 'test-fake-gh.mjs'))} "$@"\n`, { mode: 0o755 });
  const state = path.join(dir, 'state.json');
  fs.writeFileSync(state, JSON.stringify({
    faults, latest, calls: [], nextId: 5000, commits: [{ sha: 'c0', message: 'base' }],
    tags: ['v1.0.0', 'v1.1.0', 'v2.1.0', 'v2.2.0', 'v3.0.0', ...tags],
    releases: [release(1, 'v1.1.0', 1), release(2, 'v1.2.0-beta.1', 2, { prerelease: true }), release(3, 'v2.2.0', 3), release(4, 'v3.0.0', 4)],
    files: { 'ledger/releases.json': { sha: 'f0', content: fs.readFileSync(path.join(ROOT, 'ledger/releases.json'), 'utf8') }, 'keys/update-public-key.txt': { sha: 'k0', content: 'old\n' } },
  }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_GH_STATE: state, GITHUB_REPOSITORY: REPO, REHEARSAL_TAG: 'v4.1.0', RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: '',
    NODE_OPTIONS: `--import ${new URL('./test-fake-fetch.mjs', import.meta.url).href}` };
  const run = (script, args, extraEnv = {}) => {
    const r = spawnSync('node', [`.github/scripts/${script}`, ...args], { cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8' });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const st = () => JSON.parse(fs.readFileSync(state, 'utf8'));
  const ledger = () => JSON.parse(st().files['ledger/releases.json'].content);
  // The workflow's steps, in order; a step that fails stops the later ones, except the final-state step.
  const workflow = () => {
    const steps = {};
    steps.baseline = run('rehearsal-recovery.mjs', ['baseline']);
    if (steps.baseline.code) return steps;
    steps.draft = run('rehearsal-draft.mjs', ['make', 'v4.1.0', '4.1.0', '4', 'valid']);
    if (steps.draft.code) return steps;
    steps.wait = run('rehearsal-recovery.mjs', ['wait-draft']);
    if (steps.wait.code) return steps;
    steps.verify = run('release-tool.mjs', ['verify', '--tag', 'v4.1.0']);
    if (steps.verify.code) return steps;
    steps.publish = run('rehearsal-recovery.mjs', ['publish', '--tag', 'v4.1.0']);
    steps.final = run('rehearsal-recovery.mjs', ['final']);
    return steps;
  };
  return { run, st, ledger, workflow };
}

test('the rehearsal: real checks pass, the labelled failure is injected afterwards, v3.0.0 is restored and confirmed', () => {
  const t = setup();
  const s = t.workflow();
  for (const k of ['baseline', 'draft', 'wait', 'verify']) assert.equal(s[k].code, 0, `${k}: ${s[k].out}`);
  assert.equal(s.publish.code, 1, 'the publish step reports failure');
  assert.match(s.publish.out, /every real post-publication check passed at .* Injecting the sandbox-only test failure now/);
  assert.match(s.publish.out, /FAILED CHECKS \(1\): test-injected-failure: SANDBOX REHEARSAL ONLY/);
  assert.match(s.publish.out, /RESTORED: \/releases\/latest was set back to v3\.0\.0/);
  assert.match(s.publish.out, /STILL PUBLIC: the v4\.1\.0 release page/);
  assert.match(s.publish.out, /result: FAILED \[post-publish-check\]/);
  assert.ok(s.publish.out.indexOf('every real post-publication check passed') < s.publish.out.indexOf('FAILED CHECKS'), 'injection is reported after the real checks');
  assert.equal(s.final.code, 0, s.final.out);
  assert.match(s.final.out, /REHEARSAL VERDICT: recovery confirmed/);
  assert.doesNotMatch(s.final.out, /^FAIL /m);
  const st = t.st();
  assert.equal(st.latest, 'v3.0.0');
  // publish, ledger pending-verification, restore v3.0.0, ledger failed-verification; nothing deleted, nothing else published
  assert.deepEqual(st.calls, ['put keys/update-public-key.txt', 'release create v4.1.0 draft', 'release upload v4.1.0 3',
    'release edit v4.1.0 --draft=false --latest', 'put ledger/releases.json', 'release edit v3.0.0 --latest', 'put ledger/releases.json']);
  const e = t.ledger().releases.find(r => r.tag === 'v4.1.0');
  assert.equal(e.status, 'failed-verification'); assert.equal(e.sequence, 4); assert.equal(e.recovery, 'restored-and-verified');
  assert.equal(e.problems.length, 1); assert.match(e.problems[0], /^test-injected-failure: SANDBOX REHEARSAL ONLY\. Injected on purpose at .*No asset was changed\.$/);
  assert.ok(st.releases.find(r => r.tag_name === 'v4.1.0' && !r.draft), 'the failed release stays public');
});

test('guard: any other repository or tag is refused before anything is read or changed', () => {
  const t = setup();
  for (const op of ['baseline', 'wait-draft', 'publish', 'final']) {
    const a = t.run('rehearsal-recovery.mjs', [op, '--tag', 'v4.1.0'], { GITHUB_REPOSITORY: 'jbloodwizard-lang/hype-tools-beta-releases' });
    assert.equal(a.code, 2); assert.match(a.out, /REFUSED/);
    for (const tag of ['v4.2.0', '', 'v4.1.0 ']) {
      const b = t.run('rehearsal-recovery.mjs', [op, '--tag', 'v4.1.0'], { REHEARSAL_TAG: tag });
      assert.equal(b.code, 2); assert.match(b.out, /REFUSED/);
    }
  }
  assert.deepEqual(t.st().calls, []);
});

test('baseline: a used tag or a different latest release stops the run before anything is created', () => {
  for (const o of [{ tags: ['v4.1.0'] }, { latest: 'v2.2.0' }]) {
    const t = setup(o);
    const s = t.workflow();
    assert.equal(s.baseline.code, 1); assert.match(s.baseline.out, /BASELINE NOT CONFIRMED/);
    assert.equal(s.draft, undefined);
    assert.deepEqual(t.st().calls, []);
  }
});

test('a real check failure is not masked: nothing is injected, recovery still runs, the final state is not confirmed', () => {
  const t = setup({ faults: { atomStale: true } });
  const s = t.workflow();
  assert.equal(s.publish.code, 1);
  assert.match(s.publish.out, /real post-publication checks reported 1 problem\(s\); nothing was injected/);
  const e = t.ledger().releases.find(r => r.tag === 'v4.1.0');
  assert.ok(e.problems.some(p => p.startsWith('atom-feed:')) && !e.problems.some(p => p.startsWith('test-injected-failure')), JSON.stringify(e.problems));
  assert.equal(e.recovery, 'restored-and-verified');
  assert.equal(s.final.code, 1);
  assert.match(s.final.out, /^FAIL real checks passed with 1 problem/m);
  assert.match(s.final.out, /REHEARSAL VERDICT: NOT CONFIRMED/);
});

test('a restore that does not take effect is reported as not confirmed, and nothing else is published', () => {
  const t = setup({ faults: { setLatestNoop: true } });
  const s = t.workflow();
  assert.match(s.publish.out, /NOT RESTORED \(restore-unverified\)/);
  assert.match(s.publish.out, /MANUAL INTERVENTION REQUIRED NOW/);
  assert.equal(t.ledger().releases.find(r => r.tag === 'v4.1.0').recovery, 'restore-unverified');
  assert.equal(s.final.code, 1);
  assert.match(s.final.out, /^FAIL \/releases\/latest read back as v4\.1\.0/m);
  assert.equal(t.st().calls.filter(c => /release create|--draft=false/.test(c)).length, 2, 'one draft created, one publication');
});
