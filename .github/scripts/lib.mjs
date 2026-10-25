// Pure helpers for the release manager. No network, no secrets, no third-party packages.
import crypto from 'node:crypto';

export class ReleaseError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export const fail = (code, message) => { throw new ReleaseError(code, message); };

const PREFIX = Buffer.from('HYPE-TOOLS-UPDATE-V1\n', 'utf8');
const STATEMENT_KEYS = ['appId', 'channel', 'version', 'sequence', 'installerName', 'size', 'sha512', 'issuedAt'];
const SEMVER = /^\d+\.\d+\.\d+$/;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
export const MAX_INSTALLER_BYTES = 1_500_000_000; // GitHub asset limit is 2 GiB; stay well below
export const MAX_SMALL_FILE_BYTES = 1_000_000;

export function semverCmp(a, b) {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function validateConfig(c) {
  const need = ['schema', 'channel', 'appId', 'productName', 'repo', 'tagPattern', 'installerTemplate', 'metadataName', 'statementName', 'publicKeyFile', 'prerelease', 'retention', 'approvalEnvironment'];
  for (const k of need) if (!(k in c)) fail('bad-config', `missing ${k}`);
  if (c.schema !== 1) fail('bad-config', 'schema');
  if (!['beta', 'live'].includes(c.channel)) fail('bad-config', 'channel');
  if (c.prerelease !== false) fail('bad-config', 'prerelease must be false (channels are separated by repository)');
  if (!Number.isInteger(c.retention) || c.retention < 2) fail('bad-config', 'retention must be >= 2');
  if (c.channel === 'live' && c.approvalEnvironment !== 'live-release') fail('bad-config', 'live requires the live-release environment');
  if (!c.installerTemplate.includes('{version}')) fail('bad-config', 'installerTemplate');
  if (c.channel === 'beta' && !/beta/.test(c.appId)) fail('bad-config', 'beta appId');
  if (c.channel === 'live' && !/live/.test(c.appId)) fail('bad-config', 'live appId');
  return c;
}

export function versionFromTag(config, tag) {
  const m = new RegExp(config.tagPattern).exec(tag);
  if (!m) fail('bad-tag', `tag ${JSON.stringify(tag)} does not match ${config.tagPattern}`);
  return m[1];
}

export function expectedAssets(config, version) {
  return { installer: config.installerTemplate.replaceAll('{version}', version), metadata: config.metadataName, statement: config.statementName };
}

// Release assets must be exactly the allowlist: no extras, no duplicates, no missing.
export function checkAssetAllowlist(config, version, assets) {
  const exp = expectedAssets(config, version);
  const want = new Set([exp.installer, exp.metadata, exp.statement]);
  const seen = new Set();
  for (const a of assets) {
    if (!want.has(a.name)) fail('asset-not-allowed', `unexpected asset ${JSON.stringify(a.name)}`);
    if (seen.has(a.name)) fail('asset-duplicate', a.name);
    seen.add(a.name);
    if (a.state !== 'uploaded') fail('asset-state', `${a.name} state ${a.state}`);
    if (!Number.isSafeInteger(a.size) || a.size < 1) fail('asset-size', `${a.name} is empty`);
    const limit = a.name === exp.installer ? MAX_INSTALLER_BYTES : MAX_SMALL_FILE_BYTES;
    if (a.size > limit) fail('asset-too-large', `${a.name} ${a.size} > ${limit}`);
  }
  for (const n of want) if (!seen.has(n)) fail('asset-missing', n);
  return exp;
}

const unq = v => { v = v.trim(); return (v.length > 1 && (v[0] === "'" || v[0] === '"') && v.at(-1) === v[0]) ? v.slice(1, -1) : v; };

// Strict reader for the electron-builder update metadata shape. Anything unknown is an error.
export function parseUpdateYml(text) {
  const top = {}, files = [];
  let inFiles = false, cur = null;
  const TOP = new Set(['version', 'files', 'path', 'sha512', 'releaseDate']);
  const ITEM = new Set(['url', 'sha512', 'size', 'blockMapSize']);
  for (const raw of text.replace(/\r\n/g, '\n').split('\n')) {
    if (!raw.trim()) continue;
    let m;
    if ((m = /^([A-Za-z0-9]+):(?: (.*))?$/.exec(raw))) {
      if (!TOP.has(m[1])) fail('yml-unknown-key', m[1]);
      if (m[1] in top) fail('yml-duplicate-key', m[1]);
      inFiles = m[1] === 'files'; cur = null;
      if (inFiles) { if (m[2]) fail('yml-shape', 'files must be a list'); top.files = files; } else top[m[1]] = unq(m[2] ?? '');
    } else if (inFiles && (m = /^  - ([A-Za-z0-9]+): (.+)$/.exec(raw))) {
      if (!ITEM.has(m[1])) fail('yml-unknown-key', m[1]);
      cur = { [m[1]]: unq(m[2]) }; files.push(cur);
    } else if (inFiles && cur && (m = /^    ([A-Za-z0-9]+): (.+)$/.exec(raw))) {
      if (!ITEM.has(m[1])) fail('yml-unknown-key', m[1]);
      if (m[1] in cur) fail('yml-duplicate-key', m[1]);
      cur[m[1]] = unq(m[2]);
    } else fail('yml-shape', `cannot parse line ${JSON.stringify(raw.slice(0, 60))}`);
  }
  for (const k of ['version', 'files', 'path', 'sha512', 'releaseDate']) if (!(k in top)) fail('yml-missing-key', k);
  if (files.length !== 1) fail('yml-shape', 'exactly one file expected');
  const f = files[0];
  for (const k of ['url', 'sha512', 'size']) if (!(k in f)) fail('yml-missing-key', `files[0].${k}`);
  if (!/^\d+$/.test(f.size)) fail('yml-shape', 'size');
  return { version: top.version, path: top.path, sha512: top.sha512, releaseDate: top.releaseDate, file: { url: f.url, sha512: f.sha512, size: Number(f.size) } };
}

export function checkMetadata(config, version, exp, yml, installerFacts) {
  if (yml.version !== version) fail('meta-version', `${yml.version} vs ${version}`);
  if (yml.path !== exp.installer || yml.file.url !== exp.installer) fail('meta-name', 'installer name does not match the allowlist name');
  if (yml.sha512 !== yml.file.sha512) fail('meta-hash', 'top-level and file sha512 differ');
  if (yml.file.size !== installerFacts.size) fail('meta-size', `${yml.file.size} vs ${installerFacts.size}`);
  if (yml.file.sha512 !== installerFacts.sha512) fail('meta-hash', 'metadata sha512 does not match the uploaded installer');
}

export function verifyStatement(envelopeText, publicKeyB64, config, version, exp, installerFacts, lastSequence) {
  if (!publicKeyB64 || publicKeyB64 === 'UNSET' || !B64.test(publicKeyB64)) fail('no-public-key', 'update public key is not configured; publishing is blocked until the owner adds it');
  let env;
  try { env = JSON.parse(envelopeText); } catch { fail('stmt-envelope', 'not JSON'); }
  if (!env || typeof env.statement !== 'string' || typeof env.signature !== 'string') fail('stmt-envelope', 'statement or signature missing');
  if (!B64.test(env.statement) || !B64.test(env.signature)) fail('stmt-envelope', 'not base64');
  const bytes = Buffer.from(env.statement, 'base64'), sig = Buffer.from(env.signature, 'base64');
  if (sig.length !== 64) fail('stmt-signature', 'signature length');
  let pub;
  try { pub = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' }); } catch { fail('no-public-key', 'public key is not valid SPKI'); }
  if (pub.asymmetricKeyType !== 'ed25519') fail('no-public-key', 'public key is not Ed25519');
  if (!crypto.verify(null, Buffer.concat([PREFIX, bytes]), pub, sig)) fail('stmt-signature', 'signature does not verify against the configured key');
  let s;
  try { s = JSON.parse(bytes.toString('utf8')); } catch { fail('stmt-shape', 'not JSON'); }
  if (!s || typeof s !== 'object' || Array.isArray(s) || Object.keys(s).sort().join() !== [...STATEMENT_KEYS].sort().join()) fail('stmt-shape', 'unexpected key set');
  if (![s.appId, s.channel, s.version, s.installerName, s.sha512, s.issuedAt].every(v => typeof v === 'string')) fail('stmt-shape', 'types');
  if (!Number.isSafeInteger(s.sequence) || s.sequence < 1 || !Number.isSafeInteger(s.size) || s.size < 1) fail('stmt-shape', 'numeric types');
  if (!SEMVER.test(s.version)) fail('stmt-shape', 'version');
  if (s.appId !== config.appId) fail('stmt-app', `${s.appId} != ${config.appId}`);
  if (s.channel !== config.channel) fail('stmt-channel', `${s.channel} != ${config.channel}`);
  if (s.version !== version) fail('stmt-version', `${s.version} != ${version}`);
  if (s.installerName !== exp.installer) fail('stmt-name', `${s.installerName} != ${exp.installer}`);
  if (s.size !== installerFacts.size) fail('stmt-size', 'size');
  if (s.sha512 !== installerFacts.sha512) fail('stmt-hash', 'sha512');
  if (s.sequence <= lastSequence) fail('stmt-replay', `sequence ${s.sequence} <= last published ${lastSequence}`);
  return s;
}

export function validateLedger(l) {
  if (!l || l.schema !== 1 || !Array.isArray(l.releases)) fail('bad-ledger', 'shape');
  const tags = new Set();
  for (const r of l.releases) {
    if (typeof r.tag !== 'string' || !SEMVER.test(r.version) || !Number.isSafeInteger(r.sequence) || !['published', 'retired', 'not-immutable'].includes(r.status)) fail('bad-ledger', `entry ${JSON.stringify(r.tag)}`);
    if (tags.has(r.tag)) fail('bad-ledger', `duplicate ${r.tag}`);
    tags.add(r.tag);
  }
  return l;
}

export function lastPublished(ledger) {
  let seq = 0, ver = '0.0.0';
  for (const r of ledger.releases) { if (r.sequence > seq) seq = r.sequence; if (semverCmp(r.version, ver) > 0) ver = r.version; }
  return { sequence: seq, version: ver };
}

// Ownership-aware retention: only releases recorded in the ledger as published may be removed,
// and only when at least `keep` newer owned releases are live and immutable. Unknown releases are reported, never touched.
export function planRetention({ ledger, liveReleases, keep }) {
  const live = new Map(liveReleases.filter(r => !r.draft).map(r => [r.tag_name, r]));
  const owned = ledger.releases.filter(r => r.status === 'published' && live.has(r.tag)).sort((a, b) => b.sequence - a.sequence);
  const healthy = owned.filter(r => live.get(r.tag).immutable === true);
  const keepSet = new Set(owned.slice(0, keep).map(r => r.tag));
  const del = [];
  for (const r of owned.slice(keep)) {
    const newerHealthy = healthy.filter(h => h.sequence > r.sequence).length;
    if (newerHealthy >= keep) del.push(r.tag);
  }
  const unowned = [...live.keys()].filter(t => !ledger.releases.some(r => r.tag === t));
  return { keep: [...keepSet], delete: del, unowned, notImmutableOwned: owned.filter(r => live.get(r.tag).immutable !== true).map(r => r.tag) };
}
