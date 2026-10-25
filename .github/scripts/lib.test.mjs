import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  validateConfig, versionFromTag, checkAssetAllowlist, parseUpdateYml, checkMetadata, verifyStatement,
  validateLedger, lastPublished, planRetention, semverCmp, ReleaseError,
} from './lib.mjs';

const live = validateConfig({ schema: 1, channel: 'live', appId: 'com.example.app.live', productName: 'P LIVE', repo: 'o/live', tagPattern: '^v(\\d+\\.\\d+\\.\\d+)$', installerTemplate: 'P-LIVE-Setup-{version}.exe', metadataName: 'latest.yml', statementName: 'release-statement.json', publicKeyFile: 'keys/update-public-key.txt', prerelease: false, retention: 2, approvalEnvironment: 'live-release' });
const beta = validateConfig({ ...live, channel: 'beta', appId: 'com.example.app.beta', productName: 'P BETA', repo: 'o/beta', installerTemplate: 'P-BETA-Setup-{version}.exe', approvalEnvironment: null });
const code = (f) => { try { f(); } catch (e) { assert.ok(e instanceof ReleaseError, String(e)); return e.code; } assert.fail('expected failure'); };

const kp = () => crypto.generateKeyPairSync('ed25519');
const pubB64 = k => k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const sign = (s, k) => { const b = Buffer.from(JSON.stringify(s)); return JSON.stringify({ statement: b.toString('base64'), signature: crypto.sign(null, Buffer.concat([Buffer.from('HYPE-TOOLS-UPDATE-V1\n'), b]), k.privateKey).toString('base64') }); };
const facts = { size: 1000, sha512: 'AAAA' };
const stmt = (o = {}) => ({ appId: live.appId, channel: 'live', version: '1.2.0', sequence: 5, installerName: 'P-LIVE-Setup-1.2.0.exe', size: 1000, sha512: 'AAAA', issuedAt: '2026-01-01T00:00:00Z', ...o });
const exp = { installer: 'P-LIVE-Setup-1.2.0.exe', metadata: 'latest.yml', statement: 'release-statement.json' };

test('config rules', () => {
  assert.equal(code(() => validateConfig({ ...live, prerelease: true })), 'bad-config');
  assert.equal(code(() => validateConfig({ ...live, approvalEnvironment: null })), 'bad-config');
  assert.equal(code(() => validateConfig({ ...live, appId: 'com.example.app.beta' })), 'bad-config');
  assert.equal(code(() => validateConfig({ ...live, retention: 1 })), 'bad-config');
});
test('tags', () => {
  assert.equal(versionFromTag(live, 'v1.2.0'), '1.2.0');
  for (const t of ['1.2.0', 'v1.2', 'v1.2.0-beta.1', 'v1.2.0 ', 'v01.2.0x', 'v1.2.0\n', '../v1.2.0']) assert.equal(code(() => versionFromTag(live, t)), 'bad-tag', t);
});
test('semver compare', () => { assert.ok(semverCmp('1.10.0', '1.9.0') > 0); assert.equal(semverCmp('1.0.0', '1.0.0'), 0); });

const asset = (name, size = 10, state = 'uploaded') => ({ name, size, state });
test('asset allowlist', () => {
  const ok = [asset(exp.installer), asset('latest.yml'), asset('release-statement.json')];
  checkAssetAllowlist(live, '1.2.0', ok);
  assert.equal(code(() => checkAssetAllowlist(live, '1.2.0', [...ok, asset('extra.txt')])), 'asset-not-allowed');
  assert.equal(code(() => checkAssetAllowlist(live, '1.2.0', [...ok, asset('P-LIVE-Setup-1.2.0.exe.blockmap')])), 'asset-not-allowed');
  assert.equal(code(() => checkAssetAllowlist(live, '1.2.0', ok.slice(1))), 'asset-missing');
  assert.equal(code(() => checkAssetAllowlist(live, '1.2.0', [...ok, ok[0]])), 'asset-duplicate');
  assert.equal(code(() => checkAssetAllowlist(live, '1.2.0', [asset(exp.installer, 0), ...ok.slice(1)])), 'asset-size');
  assert.equal(code(() => checkAssetAllowlist(live, '1.2.0', [asset(exp.installer, 3e9), ...ok.slice(1)])), 'asset-too-large');
  assert.equal(code(() => checkAssetAllowlist(live, '1.2.0', [asset(exp.installer, 10, 'starter'), ...ok.slice(1)])), 'asset-state');
  assert.equal(code(() => checkAssetAllowlist(live, '1.2.0', [asset('P-BETA-Setup-1.2.0.exe'), ...ok.slice(1)])), 'asset-not-allowed');
});

const YML = `version: 1.2.0\nfiles:\n  - url: P-LIVE-Setup-1.2.0.exe\n    sha512: AAAA\n    size: 1000\npath: P-LIVE-Setup-1.2.0.exe\nsha512: AAAA\nreleaseDate: '2026-01-01T00:00:00.000Z'\n`;
test('update yml strict parse and cross-check', () => {
  const y = parseUpdateYml(YML);
  checkMetadata(live, '1.2.0', exp, y, facts);
  assert.equal(code(() => checkMetadata(live, '1.3.0', exp, y, facts)), 'meta-version');
  assert.equal(code(() => checkMetadata(live, '1.2.0', exp, y, { ...facts, size: 5 })), 'meta-size');
  assert.equal(code(() => checkMetadata(live, '1.2.0', exp, y, { ...facts, sha512: 'BBBB' })), 'meta-hash');
  assert.equal(code(() => checkMetadata(live, '1.2.0', { ...exp, installer: 'other.exe' }, y, facts)), 'meta-name');
  assert.equal(code(() => parseUpdateYml(YML + 'extra: 1\n')), 'yml-unknown-key');
  assert.equal(code(() => parseUpdateYml(YML.replace('version: 1.2.0\n', 'version: 1.2.0\nversion: 1.2.1\n'))), 'yml-duplicate-key');
  assert.equal(code(() => parseUpdateYml(YML.replace('    size: 1000\n', ''))), 'yml-missing-key');
  assert.equal(code(() => parseUpdateYml(YML + '  - url: second.exe\n')), 'yml-shape');
  assert.equal(code(() => parseUpdateYml(YML.replace('files:\n', 'files: x\n'))), 'yml-shape');
  assert.equal(code(() => parseUpdateYml('!!python/object: x\n')), 'yml-shape');
});

test('statement verification fails closed', () => {
  const k = kp(), other = kp();
  const ok = sign(stmt(), k);
  assert.equal(verifyStatement(ok, pubB64(k), live, '1.2.0', exp, facts, 4).sequence, 5);
  assert.equal(code(() => verifyStatement(ok, '', live, '1.2.0', exp, facts, 4)), 'no-public-key');
  assert.equal(code(() => verifyStatement(ok, 'UNSET', live, '1.2.0', exp, facts, 4)), 'no-public-key');
  assert.equal(code(() => verifyStatement(ok, pubB64(other), live, '1.2.0', exp, facts, 4)), 'stmt-signature');
  assert.equal(code(() => verifyStatement(sign(stmt({ channel: 'beta' }), k), pubB64(k), live, '1.2.0', exp, facts, 4)), 'stmt-channel');
  assert.equal(code(() => verifyStatement(sign(stmt({ appId: beta.appId }), k), pubB64(k), live, '1.2.0', exp, facts, 4)), 'stmt-app');
  assert.equal(code(() => verifyStatement(sign(stmt({ version: '1.2.1' }), k), pubB64(k), live, '1.2.0', exp, facts, 4)), 'stmt-version');
  assert.equal(code(() => verifyStatement(sign(stmt({ installerName: 'x.exe' }), k), pubB64(k), live, '1.2.0', exp, facts, 4)), 'stmt-name');
  assert.equal(code(() => verifyStatement(sign(stmt({ size: 1 }), k), pubB64(k), live, '1.2.0', exp, facts, 4)), 'stmt-size');
  assert.equal(code(() => verifyStatement(sign(stmt({ sha512: 'CCCC' }), k), pubB64(k), live, '1.2.0', exp, facts, 4)), 'stmt-hash');
  assert.equal(code(() => verifyStatement(ok, pubB64(k), live, '1.2.0', exp, facts, 5)), 'stmt-replay');
  assert.equal(code(() => verifyStatement(sign({ ...stmt(), extra: 1 }, k), pubB64(k), live, '1.2.0', exp, facts, 4)), 'stmt-shape');
  assert.equal(code(() => verifyStatement('garbage', pubB64(k), live, '1.2.0', exp, facts, 4)), 'stmt-envelope');
  const e = JSON.parse(ok); e.statement = Buffer.from(JSON.stringify(stmt({ sequence: 99 }))).toString('base64');
  assert.equal(code(() => verifyStatement(JSON.stringify(e), pubB64(k), live, '1.2.0', exp, facts, 4)), 'stmt-signature');
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.equal(code(() => verifyStatement(ok, rsa.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), live, '1.2.0', exp, facts, 4)), 'no-public-key');
});

const L = (...r) => validateLedger({ schema: 1, releases: r.map(([tag, sequence, status = 'published']) => ({ tag, version: tag.slice(1), sequence, status })) });
const R = (tag, immutable = true, draft = false) => ({ tag_name: tag, immutable, draft });
test('ledger', () => {
  assert.deepEqual(lastPublished(L()), { sequence: 0, version: '0.0.0' });
  assert.deepEqual(lastPublished(L(['v1.0.0', 3], ['v1.1.0', 4])), { sequence: 4, version: '1.1.0' });
  assert.equal(code(() => validateLedger({ schema: 1, releases: [{ tag: 'v1.0.0', version: '1.0.0', sequence: 1, status: 'x' }] })), 'bad-ledger');
  assert.equal(code(() => L(['v1.0.0', 1], ['v1.0.0', 2])), 'bad-ledger');
});
test('retention: newest two kept, older owned removed, unowned never touched', () => {
  const ledger = L(['v1.0.0', 1], ['v1.1.0', 2], ['v1.2.0', 3], ['v1.3.0', 4]);
  const live4 = ['v1.0.0', 'v1.1.0', 'v1.2.0', 'v1.3.0', 'v0.9.0'].map(t => R(t));
  const p = planRetention({ ledger, liveReleases: live4, keep: 2 });
  assert.deepEqual(p.keep.sort(), ['v1.2.0', 'v1.3.0']);
  assert.deepEqual(p.delete.sort(), ['v1.0.0', 'v1.1.0']);
  assert.deepEqual(p.unowned, ['v0.9.0']);
});
test('retention: nothing is deleted unless two newer healthy releases exist', () => {
  const ledger = L(['v1.0.0', 1], ['v1.1.0', 2], ['v1.2.0', 3]);
  const p = planRetention({ ledger, liveReleases: [R('v1.0.0'), R('v1.1.0'), R('v1.2.0', false)], keep: 2 });
  assert.deepEqual(p.delete, []);
  assert.deepEqual(p.notImmutableOwned, ['v1.2.0']);
  const p2 = planRetention({ ledger: L(['v1.0.0', 1], ['v1.1.0', 2]), liveReleases: [R('v1.0.0'), R('v1.1.0')], keep: 2 });
  assert.deepEqual(p2.delete, []);
});
test('retention: drafts, retired and missing releases are ignored', () => {
  const ledger = L(['v1.0.0', 1, 'retired'], ['v1.1.0', 2], ['v1.2.0', 3], ['v1.3.0', 4]);
  const p = planRetention({ ledger, liveReleases: [R('v1.1.0'), R('v1.2.0'), R('v1.3.0'), R('v1.4.0', true, true)], keep: 2 });
  assert.deepEqual(p.delete, ['v1.1.0']);
  assert.deepEqual(p.unowned, []);
});
