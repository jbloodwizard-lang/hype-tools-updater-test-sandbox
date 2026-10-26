// SANDBOX ONLY. The single owner-approved real-GitHub recovery rehearsal (hype-tools Issue #30), run by
// .github/workflows/recovery-rehearsal.yml. It publishes v4.1.0 with the normal release tool, lets the real
// post-publication checks run, and only if they all pass adds one clearly labelled test-injected failure, so the real
// recovery restores v3.0.0 as latest. No asset is changed. Guarded: refuses to run for any other repository or tag.
// ops: baseline | wait-draft | publish | final
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { context, publish, notes } from './release-tool.mjs';
import { publicDownload } from './publicio.mjs';

const REPO = 'jbloodwizard-lang/hype-tools-updater-test-sandbox';
const TAG = 'v4.1.0', VERSION = '4.1.0', SEQUENCE = 4;
const PREV = 'v3.0.0', PREV_SEQUENCE = 3;
const ASSETS = v => [`SandboxApp-${v}.AppImage`, 'latest-linux.yml', 'release-statement.json'];
const INJECTED = 'test-injected-failure';

const op = process.argv[2];
const out = (...a) => console.log(...a);
const gh = a => execFileSync('gh', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const ghJson = a => JSON.parse(gh(a));
const tmp = n => path.join(process.env.RUNNER_TEMP || '/tmp', `recovery-rehearsal-${n}.json`);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const summary = lines => { if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.map(l => `- ${l}`).join('\n') + '\n'); };

// The guard: repository identity (environment and checked-in config) and the designated tag must all match.
function guard() {
  const cfg = JSON.parse(fs.readFileSync('release-config.json', 'utf8'));
  const why = [];
  if (process.env.GITHUB_REPOSITORY !== REPO) why.push(`GITHUB_REPOSITORY is ${process.env.GITHUB_REPOSITORY}`);
  if (cfg.repo !== REPO) why.push(`release-config.json repo is ${cfg.repo}`);
  if (cfg.channel !== 'beta' || cfg.appId !== 'com.hypetools.sandbox.beta') why.push(`config identity is ${cfg.channel}/${cfg.appId}, not the synthetic sandbox channel`);
  if (process.env.REHEARSAL_TAG !== TAG) why.push(`REHEARSAL_TAG is ${JSON.stringify(process.env.REHEARSAL_TAG)}, the approved tag is ${TAG}`);
  if (why.length) { out(`REFUSED: this rehearsal runs only in ${REPO} for ${TAG}: ${why.join('; ')}`); process.exit(2); }
  return cfg;
}

const listReleases = () => ghJson(['api', `repos/${REPO}/releases?per_page=100`]);
const readLedger = () => JSON.parse(Buffer.from(ghJson(['api', `repos/${REPO}/contents/ledger/releases.json`]).content, 'base64').toString('utf8'));
const tagRefs = () => ghJson(['api', `repos/${REPO}/git/matching-refs/tags`]).filter(r => r.ref.startsWith('refs/tags/')).map(r => r.ref.slice('refs/tags/'.length)).sort();
const releaseView = r => ({ id: r.id, tag: r.tag_name, draft: r.draft, prerelease: r.prerelease, immutable: r.immutable === true, assets: (r.assets || []).map(a => `${a.id}:${a.name}:${a.size}:${a.digest}`).sort() });
const facts = () => ({ releases: listReleases().map(releaseView).sort((a, b) => a.id - b.id), tags: tagRefs(), ledger: readLedger(), head: ghJson(['api', `repos/${REPO}/commits/main`]).sha });

function baseline(cfg) {
  const checks = [];
  const ok = (pass, text) => checks.push(`${pass ? 'PASS' : 'FAIL'} ${text}`);
  const latest = ghJson(['api', `repos/${REPO}/releases/latest`]);
  ok(latest.tag_name === PREV, `/releases/latest is ${latest.tag_name} (expected ${PREV})`);
  const f = facts();
  const entry = f.ledger.releases.find(r => r.tag === PREV);
  ok(entry && entry.status === 'published' && entry.sequence === PREV_SEQUENCE, `ledger records ${PREV} as ${entry && entry.status} at sequence ${entry && entry.sequence}`);
  ok(Math.max(...f.ledger.releases.map(r => r.sequence)) === PREV_SEQUENCE, `highest ledger sequence is ${Math.max(...f.ledger.releases.map(r => r.sequence))}`);
  ok(!f.ledger.releases.some(r => r.status === 'pending-verification'), 'no ledger entry is pending-verification');
  const prev = f.releases.find(r => r.tag === PREV);
  ok(prev && !prev.draft && prev.immutable && !prev.prerelease, `${PREV} is published=${prev && !prev.draft}, immutable=${prev && prev.immutable}, prerelease=${prev && prev.prerelease}`);
  const names = prev ? prev.assets.map(a => a.split(':')[1]).sort() : [];
  ok(JSON.stringify(names) === JSON.stringify(ASSETS('3.0.0').sort()), `${PREV} assets: ${names.join(', ')}`);
  ok(!f.releases.some(r => r.tag === TAG), `no release or draft carries ${TAG}`);
  ok(!f.tags.includes(TAG), `no tag ${TAG} exists`);
  ok(!f.ledger.releases.some(r => r.tag === TAG || r.version === VERSION || r.sequence >= SEQUENCE), `ledger has no ${TAG}, version ${VERSION} or sequence >= ${SEQUENCE}`);
  ok(ghJson(['api', `repos/${REPO}`]).default_branch === 'main' && cfg.repo === REPO, `default branch is main and release-config.json names ${cfg.repo} (${cfg.channel}, ${cfg.appId})`);
  for (const c of checks) out(c);
  fs.writeFileSync(tmp('baseline'), JSON.stringify(f));
  summary(['**Baseline**', ...checks]);
  if (checks.some(c => c.startsWith('FAIL'))) { out('BASELINE NOT CONFIRMED: stopping before anything is created'); process.exit(1); }
  out(`baseline confirmed at main ${f.head}; ${f.releases.length} releases, ${f.tags.length} tags, ${f.ledger.releases.length} ledger entries`);
}

// The releases list can miss a new draft for a moment; wait (bounded) until three reads in a row list exactly one draft
// for the tag, so the verification that follows does not trip over a stale listing.
async function waitDraft() {
  const seen = [];
  for (let i = 0, run = 0; i < 30; i++) {
    const n = listReleases().filter(r => r.tag_name === TAG && r.draft).length;
    seen.push(n);
    if (n > 1) { out(`${n} drafts carry ${TAG}; stopping`); process.exit(1); }
    run = n === 1 ? run + 1 : 0;
    if (run === 3) { out(`draft ${TAG} is visible in the release list (reads: ${seen.join(',')})`); return; }
    await sleep(500);
  }
  out(`draft ${TAG} never became visible; stopping`); process.exit(1);
}

async function rehearsePublish() {
  const marker = { normalChecksPassedAt: null, injected: false, realProblems: null };
  const save = () => fs.writeFileSync(tmp('injection'), JSON.stringify(marker));
  save();
  const ctx = context();
  if (ctx.repo !== REPO || ctx.tag !== TAG || ctx.version !== VERSION) { out('REFUSED: context does not match the approved rehearsal'); process.exit(2); }
  const afterVerify = async ({ problems }) => {
    const at = new Date().toISOString();
    marker.realProblems = problems.length;
    if (problems.length || ctx.repo !== REPO || ctx.tag !== TAG) {
      out(`REHEARSAL: the real post-publication checks reported ${problems.length} problem(s); nothing was injected`);
      save(); return [];
    }
    marker.normalChecksPassedAt = at; marker.injected = true; save();
    out(`REHEARSAL: every real post-publication check passed at ${at} (0 problems). Injecting the sandbox-only test failure now; no asset is changed.`);
    return [`${INJECTED}: SANDBOX REHEARSAL ONLY. Injected on purpose at ${at}, after every real post-publication check passed. No asset was changed.`];
  };
  let error = null;
  try { await publish(ctx, { afterVerify }); } catch (e) { error = e; }
  summary(['**Publish, checks, injected failure, recovery**', ...notes, error ? `result: FAILED [${error.code || 'error'}] ${error.message}` : 'result: OK (no failure; unexpected for this rehearsal)']);
  out(error ? `result: FAILED [${error.code || 'error'}] ${error.message}` : 'result: OK');
  // This step always fails: either the publication failed as the rehearsal intends, or something else went wrong.
  process.exit(1);
}

async function final() {
  const base = JSON.parse(fs.readFileSync(tmp('baseline'), 'utf8'));
  const marker = fs.existsSync(tmp('injection')) ? JSON.parse(fs.readFileSync(tmp('injection'), 'utf8')) : {};
  const checks = [];
  const ok = (pass, text) => checks.push(`${pass ? 'PASS' : 'FAIL'} ${text}`);
  // /releases/latest, read up to 4 times in case of a briefly stale answer; every read is printed.
  const reads = [];
  for (let i = 0; i < 4; i++) {
    try { reads.push(ghJson(['api', `repos/${REPO}/releases/latest`]).tag_name); } catch (e) { reads.push(`error ${String(e.stderr || e.message).trim().slice(0, 80)}`); }
    if (reads.at(-1) === PREV) break;
    await sleep(3000 * (i + 1));
  }
  ok(reads.at(-1) === PREV, `/releases/latest read back as ${reads.at(-1)} (reads: ${reads.join(', ')})`);
  const now = facts();
  const rel = now.releases.find(r => r.tag === TAG);
  ok(rel && !rel.draft && rel.immutable && !rel.prerelease, `${TAG} is published=${rel && !rel.draft}, immutable=${rel && rel.immutable}, prerelease=${rel && rel.prerelease}`);
  ok(rel && JSON.stringify(rel.assets.map(a => a.split(':')[1]).sort()) === JSON.stringify(ASSETS(VERSION).sort()), `${TAG} still has its three allowlisted assets`);
  if (rel) {
    const inst = rel.assets.find(a => a.split(':')[1] === ASSETS(VERSION)[0]);
    const d = await publicDownload(`https://github.com/${REPO}/releases/download/${TAG}/${ASSETS(VERSION)[0]}`);
    ok(d.ok && `sha256:${d.sha256}` === inst.split(':').slice(3).join(':'), `${TAG} installer is still publicly downloadable (HTTP ${d.status}, sha256 ${d.ok ? 'matches GitHub digest' : 'n/a'})`);
  }
  const prev = now.releases.find(r => r.tag === PREV);
  ok(prev && JSON.stringify(prev) === JSON.stringify(base.releases.find(r => r.tag === PREV)), `${PREV} is unchanged (published, immutable, same assets)`);
  const entry = now.ledger.releases.find(r => r.tag === TAG);
  ok(entry && entry.status === 'failed-verification' && entry.version === VERSION && entry.sequence === SEQUENCE, `ledger ${TAG}: status ${entry && entry.status}, version ${entry && entry.version}, sequence ${entry && entry.sequence}`);
  ok(entry && Array.isArray(entry.problems) && entry.problems.length === 1 && entry.problems[0].startsWith(`${INJECTED}: SANDBOX REHEARSAL ONLY`), `ledger ${TAG} problems: ${JSON.stringify(entry && entry.problems)}`);
  ok(entry && entry.recovery === 'restored-and-verified', `ledger ${TAG} recovery: ${entry && entry.recovery}`);
  ok(marker.injected === true && marker.realProblems === 0 && !!marker.normalChecksPassedAt, `real checks passed with ${marker.realProblems} problem(s) before the injection at ${marker.normalChecksPassedAt}`);
  const pg = now.ledger.releases.find(r => r.tag === PREV);
  ok(pg && pg.status === 'published' && pg.sequence === PREV_SEQUENCE, `ledger ${PREV} is still published at sequence ${pg && pg.sequence} (the healthy previous release)`);
  const others = l => JSON.stringify(l.releases.filter(r => r.tag !== TAG));
  ok(others(now.ledger) === others(base.ledger) && now.ledger.releases.length === base.ledger.releases.length + 1, 'no other ledger entry changed; exactly one entry was added');
  const baseIds = new Set(base.releases.map(r => r.id));
  const added = now.releases.filter(r => !baseIds.has(r.id)).map(r => r.tag);
  const changed = base.releases.filter(b => JSON.stringify(now.releases.find(r => r.id === b.id)) !== JSON.stringify(b)).map(b => b.tag);
  ok(JSON.stringify(added) === JSON.stringify([TAG]) && changed.length === 0, `releases added: ${JSON.stringify(added)}; existing releases changed or deleted: ${JSON.stringify(changed)}`);
  const newTags = now.tags.filter(t => !base.tags.includes(t)), goneTags = base.tags.filter(t => !now.tags.includes(t));
  ok(JSON.stringify(newTags) === JSON.stringify([TAG]) && goneTags.length === 0, `tags added: ${JSON.stringify(newTags)}; tags removed: ${JSON.stringify(goneTags)}`);
  const commits = ghJson(['api', `repos/${REPO}/compare/${base.head}...${now.head}`]).commits.map(c => c.commit.message.split('\n')[0]);
  ok(JSON.stringify(commits) === JSON.stringify([`Rehearsal: public key for ${TAG}`, 'Update release ledger', 'Update release ledger']), `commits on main during the run: ${JSON.stringify(commits)} (public key, ledger pending, ledger failed)`);
  for (const c of checks) out(c);
  const pass = !checks.some(c => c.startsWith('FAIL'));
  out(pass ? `REHEARSAL VERDICT: recovery confirmed. ${TAG} failed (test-injected) and stays public; ${PREV} is latest again.` : 'REHEARSAL VERDICT: NOT CONFIRMED. Do not publish again; see the FAIL lines and restore latest by hand if needed.');
  summary(['**Final state**', ...checks, pass ? 'REHEARSAL VERDICT: recovery confirmed' : 'REHEARSAL VERDICT: NOT CONFIRMED']);
  if (!pass) process.exit(1);
}

const cfg = guard();
if (op === 'baseline') baseline(cfg);
else if (op === 'wait-draft') await waitDraft();
else if (op === 'publish') await rehearsePublish();
else if (op === 'final') await final();
else { out('usage: rehearsal-recovery.mjs baseline|wait-draft|publish|final'); process.exit(2); }
