// REHEARSAL ONLY (sandbox). Creates synthetic draft releases, with a disposable Ed25519 key generated in memory
// for each draft. Only the PUBLIC key is committed; the private key never touches disk or the log.
// ops: make | discard | add-asset
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [op, tag, version, sequenceArg, scenario = 'valid'] = process.argv.slice(2);
const repo = process.env.GITHUB_REPOSITORY;
const gh = (a, input) => execFileSync('gh', a, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
const ghJson = a => JSON.parse(gh(a));
const PREFIX = Buffer.from('HYPE-TOOLS-UPDATE-V1\n');
const cfg = JSON.parse(fs.readFileSync('release-config.json', 'utf8'));
const out = (...a) => console.log(...a);

function findDraft() {
  const all = ghJson(['api', `repos/${repo}/releases?per_page=100`]).filter(r => r.tag_name === tag && r.draft);
  return all;
}
if (op === 'discard') {
  for (const r of findDraft()) { gh(['api', '-X', 'DELETE', `repos/${repo}/releases/${r.id}`]); out(`discarded draft ${tag} (id ${r.id})`); }
  process.exit(0);
}
if (op === 'add-asset') {
  const f = path.join(os.tmpdir(), 'injected.txt'); fs.writeFileSync(f, 'injected after verification\n');
  gh(['release', 'upload', tag, '--repo', repo, f]); out(`added an extra asset to the draft ${tag}`);
  process.exit(0);
}
if (op !== 'make') throw new Error('bad op');

const keyA = crypto.generateKeyPairSync('ed25519'), keyB = crypto.generateKeyPairSync('ed25519');
const pubB64 = k => k.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const name = cfg.installerTemplate.replaceAll('{version}', version);
const installer = Buffer.concat([Buffer.from(`SYNTHETIC-INSTALLER ${tag}\n`), crypto.randomBytes(200000)]);
const sha = crypto.createHash('sha512').update(installer).digest('base64');
const ymlSha = scenario === 'bad-hash' ? crypto.createHash('sha512').update('other').digest('base64') : sha;
const yml = `version: ${scenario === 'version-mismatch' ? '0.0.1' : version}\nfiles:\n  - url: ${name}\n    sha512: ${ymlSha}\n    size: ${installer.length}\npath: ${name}\nsha512: ${ymlSha}\nreleaseDate: '${new Date().toISOString()}'\n`;
const statement = {
  appId: cfg.appId, channel: scenario === 'wrong-channel' ? 'live' : cfg.channel, version, sequence: Number(sequenceArg),
  installerName: name, size: installer.length, sha512: sha, issuedAt: new Date().toISOString(),
};
const bytes = Buffer.from(JSON.stringify(statement));
const signer = scenario === 'wrong-key' ? keyB : keyA;
const envelope = JSON.stringify({ statement: bytes.toString('base64'), signature: crypto.sign(null, Buffer.concat([PREFIX, bytes]), signer.privateKey).toString('base64') });

// commit the PUBLIC key (rotates per rehearsal draft)
const cur = ghJson(['api', `repos/${repo}/contents/keys/update-public-key.txt`]);
gh(['api', '-X', 'PUT', `repos/${repo}/contents/keys/update-public-key.txt`, '--input', '-'],
  JSON.stringify({ message: `Rehearsal: public key for ${tag}`, content: Buffer.from(pubB64(keyA) + '\n').toString('base64'), sha: cur.sha }));
out(`committed public key for ${tag} (private key discarded with this job)`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reh-'));
const files = { [name]: installer, [cfg.metadataName]: Buffer.from(yml) };
if (scenario !== 'missing-statement') files[cfg.statementName] = Buffer.from(envelope);
if (scenario === 'extra-asset') files['notes.txt'] = Buffer.from('not on the allowlist\n');
for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), c);
const flags = scenario === 'prerelease-flag' ? ['--prerelease'] : [];
gh(['release', 'create', tag, '--repo', repo, '--draft', ...flags, '--target', 'main', '--title', `Rehearsal ${version} (${scenario})`, '--notes', `Synthetic rehearsal release, scenario ${scenario}. Dummy payload only.`]);
gh(['release', 'upload', tag, '--repo', repo, ...Object.keys(files).map(n => path.join(dir, n))]);
out(`draft ${tag} created: scenario=${scenario} sequence=${sequenceArg} assets=${Object.keys(files).join(', ')} installer=${installer.length} bytes sha512=${sha.slice(0, 16)}...`);
