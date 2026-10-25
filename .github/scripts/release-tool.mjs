#!/usr/bin/env node
// Release manager for one HYPE TOOLS release-only repository.
// Usage: node release-tool.mjs <verify|publish|retention|gate-check> --tag vX.Y.Z [--dry-run]
// Needs only: node, the gh CLI, and the job's GITHUB_TOKEN (as GH_TOKEN). No third-party packages.
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ReleaseError, fail, validateConfig, versionFromTag, checkAssetAllowlist, parseUpdateYml, checkMetadata,
  verifyStatement, validateLedger, lastPublished, planRetention, semverCmp,
} from './lib.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const readJson = f => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const args = process.argv.slice(2);
const cmd = args[0];
const opt = n => { const i = args.indexOf('--' + n); return i < 0 ? null : args[i + 1]; };
const DRY = args.includes('--dry-run');
const log = (...a) => console.log(...a);
const summary = [];
const note = (...a) => { const l = a.join(' '); summary.push(l); log(l); };

function gh(argv, { input } = {}) {
  return execFileSync('gh', argv, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
}
const ghJson = argv => JSON.parse(gh(argv));
function listReleases(repo) {
  const all = [];
  for (let page = 1; page < 20; page++) {
    const part = ghJson(['api', `repos/${repo}/releases?per_page=100&page=${page}`]);
    all.push(...part);
    if (part.length < 100) break;
  }
  return all;
}
function downloadAsset(repo, id, dest) {
  return new Promise((resolve, reject) => {
    const p = spawn('gh', ['api', '-H', 'Accept: application/octet-stream', `repos/${repo}/releases/assets/${id}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = fs.createWriteStream(dest), s256 = crypto.createHash('sha256'), s512 = crypto.createHash('sha512');
    let size = 0, err = '';
    p.stdout.on('data', d => { size += d.length; s256.update(d); s512.update(d); out.write(d); });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => out.end(() => code === 0 ? resolve({ size, sha256: s256.digest('hex'), sha512: s512.digest('base64') }) : reject(new ReleaseError('download-failed', `asset ${id}: ${err.slice(0, 200)}`))));
  });
}

function context() {
  const config = validateConfig(readJson('release-config.json'));
  const repo = process.env.GITHUB_REPOSITORY;
  if (repo !== config.repo) fail('wrong-repository', `this configuration is for ${config.repo}, running in ${repo}`);
  const ledger = validateLedger(readJson('ledger/releases.json'));
  const tag = opt('tag');
  if (!tag) fail('usage', '--tag is required');
  return { config, repo, ledger, tag, version: versionFromTag(config, tag) };
}

async function verifyDraft(ctx) {
  const { config, repo, tag, version, ledger } = ctx;
  const releases = listReleases(repo);
  const matches = releases.filter(r => r.tag_name === tag);
  if (matches.length !== 1) fail('release-lookup', `expected exactly one release for ${tag}, found ${matches.length}`);
  const rel = matches[0];
  if (!rel.draft) fail('not-draft', `${tag} is already published; only drafts can be verified for publication`);
  if (rel.prerelease !== config.prerelease) fail('prerelease-flag', `prerelease must be ${config.prerelease}`);
  const def = ghJson(['api', `repos/${repo}`]).default_branch;
  if (rel.target_commitish !== def) fail('bad-target', `release target must be ${def}, got ${rel.target_commitish}`);
  if (ledger.releases.some(r => r.tag === tag)) fail('tag-reused', `${tag} is already in the ledger; tag names are never reused`);
  const exp = checkAssetAllowlist(config, version, rel.assets);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hype-release-'));
  const facts = {};
  for (const a of rel.assets) {
    const dest = path.join(dir, a.name);
    const f = await downloadAsset(repo, a.id, dest);
    if (f.size !== a.size) fail('asset-size-mismatch', `${a.name}: downloaded ${f.size}, API says ${a.size}`);
    if (a.digest && a.digest !== `sha256:${f.sha256}`) fail('asset-digest-mismatch', a.name);
    facts[a.name] = { ...f, id: a.id, updated_at: a.updated_at };
  }
  const yml = parseUpdateYml(fs.readFileSync(path.join(dir, exp.metadata), 'utf8'));
  checkMetadata(config, version, exp, yml, facts[exp.installer]);
  const keyFile = path.join(ROOT, config.publicKeyFile);
  const publicKey = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8').trim() : '';
  const last = lastPublished(ledger);
  const stmt = verifyStatement(fs.readFileSync(path.join(dir, exp.statement), 'utf8'), publicKey, config, version, exp, facts[exp.installer], last.sequence);
  if (semverCmp(version, last.version) <= 0) fail('version-not-newer', `${version} is not newer than the last published ${last.version}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const snapshot = rel.assets.map(a => ({ id: a.id, name: a.name, size: a.size, updated_at: a.updated_at })).sort((x, y) => x.id - y.id);
  note(`verified draft ${tag}: ${rel.assets.length} allowlisted assets, installer ${facts[exp.installer].size} bytes, statement sequence ${stmt.sequence}`);
  return { release: rel, snapshot, statement: stmt, installerSha512: facts[exp.installer].sha512, exp };
}

function gateCheck(ctx) {
  const { config, repo } = ctx;
  if (!config.approvalEnvironment) { note('gate-check: no approval environment required for this channel'); return; }
  let env;
  try { env = ghJson(['api', `repos/${repo}/environments/${config.approvalEnvironment}`]); }
  catch (e) { fail('gate-unverifiable', `cannot read environment ${config.approvalEnvironment}: ${String(e.stderr || e.message).slice(0, 160)}`); }
  const rule = (env.protection_rules || []).find(r => r.type === 'required_reviewers');
  if (!rule || !(rule.reviewers || []).length) fail('gate-missing', `environment ${config.approvalEnvironment} has no required reviewers; LIVE publication is blocked`);
  note(`gate-check: environment ${config.approvalEnvironment} requires ${rule.reviewers.length} reviewer(s)`);
}

function putLedger(repo, mutate) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = ghJson(['api', `repos/${repo}/contents/ledger/releases.json`]);
    const ledger = validateLedger(JSON.parse(Buffer.from(cur.content, 'base64').toString('utf8')));
    mutate(ledger);
    validateLedger(ledger);
    const body = { message: 'Update release ledger', content: Buffer.from(JSON.stringify(ledger, null, 2) + '\n').toString('base64'), sha: cur.sha };
    try { gh(['api', '-X', 'PUT', `repos/${repo}/contents/ledger/releases.json`, '--input', '-'], { input: JSON.stringify(body) }); return ledger; }
    catch (e) { if (attempt === 2) throw e; }
  }
}

async function publish(ctx) {
  const { config, repo, tag, version } = ctx;
  gateCheck(ctx);
  const v = await verifyDraft(ctx);
  if (DRY) { note(`dry run: would publish ${tag} with --latest and then apply retention (keep ${config.retention})`); return; }
  const again = listReleases(repo).find(r => r.tag_name === tag);
  const snap2 = again.assets.map(a => ({ id: a.id, name: a.name, size: a.size, updated_at: a.updated_at })).sort((x, y) => x.id - y.id);
  if (JSON.stringify(snap2) !== JSON.stringify(v.snapshot)) fail('draft-changed', 'draft assets changed after verification; aborting');
  gh(['release', 'edit', tag, '--repo', repo, '--draft=false', '--latest']);
  note(`published ${tag}`);
  const pub = ghJson(['api', `repos/${repo}/releases/tags/${tag}`]);
  const problems = [];
  if (pub.draft) problems.push('still a draft');
  if (pub.prerelease !== config.prerelease) problems.push('prerelease flag changed');
  const immutable = pub.immutable === true;
  if (!immutable) problems.push('release is NOT immutable: enable Immutable releases in repository settings');
  const latest = ghJson(['api', `repos/${repo}/releases/latest`]);
  if (latest.tag_name !== tag) problems.push(`/releases/latest is ${latest.tag_name}, expected ${tag}`);
  const pubSnap = pub.assets.map(a => ({ id: a.id, name: a.name, size: a.size })).sort((x, y) => x.id - y.id);
  if (JSON.stringify(pubSnap) !== JSON.stringify(v.snapshot.map(({ id, name, size }) => ({ id, name, size })))) problems.push('asset set changed during publish');
  for (const n of [v.exp.metadata, v.exp.statement]) {
    const res = await fetch(`https://github.com/${repo}/releases/download/${tag}/${n}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const a = pub.assets.find(x => x.name === n);
    if (!res.ok || (a.digest && a.digest !== `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`)) problems.push(`public download of ${n} does not match`);
  }
  const atom = await (await fetch(`https://github.com/${repo}/releases.atom`)).text();
  const first = /<entry>[\s\S]*?releases\/tag\/([^"]+)"/.exec(atom);
  if (!first || decodeURIComponent(first[1]) !== tag) problems.push(`releases.atom first entry is ${first && first[1]}`);
  putLedger(repo, l => l.releases.push({ tag, version, sequence: v.statement.sequence, status: immutable ? 'published' : 'not-immutable', publishedAt: pub.published_at, installerSha512: v.installerSha512 }));
  note(`ledger updated for ${tag}`);
  if (problems.length) { for (const p of problems) note(`PROBLEM: ${p}`); fail('post-publish-check', problems.join('; ')); }
  note('post-publish checks passed (draft cleared, immutable, latest, assets, public downloads, atom feed)');
  await retention(ctx);
}

async function retention(ctx) {
  const { config, repo } = ctx;
  const ledger = validateLedger(JSON.parse(Buffer.from(ghJson(['api', `repos/${repo}/contents/ledger/releases.json`]).content, 'base64').toString('utf8')));
  const plan = planRetention({ ledger, liveReleases: listReleases(repo), keep: config.retention });
  note(`retention plan: keep ${JSON.stringify(plan.keep)}, delete ${JSON.stringify(plan.delete)}, unowned (never touched) ${JSON.stringify(plan.unowned)}, owned but not immutable ${JSON.stringify(plan.notImmutableOwned)}`);
  if (DRY) return;
  for (const tag of plan.delete) {
    gh(['release', 'delete', tag, '--repo', repo, '--yes']);
    putLedger(repo, l => { l.releases.find(r => r.tag === tag).status = 'retired'; });
    note(`retired ${tag} (release deleted; tag kept; tag name stays unusable)`);
  }
}

try {
  const ctx = context();
  if (cmd === 'verify') { await verifyDraft(ctx); }
  else if (cmd === 'gate-check') gateCheck(ctx);
  else if (cmd === 'publish') await publish(ctx);
  else if (cmd === 'retention') await retention(ctx);
  else fail('usage', 'command must be verify, publish, retention or gate-check');
  note(`result: OK (${cmd}${DRY ? ', dry run' : ''})`);
} catch (e) {
  note(`result: FAILED [${e.code || 'error'}] ${e.message}`);
  process.exitCode = 1;
} finally {
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### release-tool\n\n' + summary.map(s => '- ' + s).join('\n') + '\n');
}
