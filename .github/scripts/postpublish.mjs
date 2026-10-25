// Post-publication verification and recovery for one release. No network of its own: every GitHub or HTTP call goes
// through the `io` object so the logic can be tested with in-memory fakes.
//
// io.getRelease(tag)   -> release JSON as the API returns it (assets with id, name, size, digest)
// io.getLatest()       -> { tag_name } of /releases/latest
// io.download(url)     -> { ok, status, size, sha256, sha512, body } (body only for small files, otherwise null)
// io.atomFirstTag()    -> tag of the first releases.atom entry, or null
// io.setLatest(tag)    -> make `tag` the latest release (throws on failure)
import {
  checkMetadata, expectedAssets, MAX_SMALL_FILE_BYTES, parseUpdateYml, verifyStatement,
} from './lib.mjs';

const msg = e => String((e && (e.code ? `${e.code}: ${e.message}` : e.message)) || e).slice(0, 240);

// `expected` comes from the verified draft: { assets: { [name]: { size, sha256 } }, installer: { size, sha512 } }.
// Returns every problem found (not just the first) so the owner sees the whole picture.
export async function verifyPublication({ io, config, repo, tag, version, exp, expected, snapshot, lastSequence, publicKey }) {
  const problems = [];
  const add = (code, text) => problems.push(`${code}: ${text}`);
  const names = [exp.installer, exp.metadata, exp.statement];
  let pub = null;
  try { pub = await io.getRelease(tag); } catch (e) { add('release-read', msg(e)); }
  const apiAssets = new Map();
  if (pub) {
    if (pub.draft) add('still-draft', 'release is still a draft');
    if (pub.prerelease !== config.prerelease) add('prerelease-flag', 'prerelease flag changed');
    if (pub.immutable !== true) add('not-immutable', 'release is NOT immutable: enable Immutable releases in repository settings');
    for (const a of pub.assets || []) apiAssets.set(a.name, a);
    const got = (pub.assets || []).map(a => ({ id: a.id, name: a.name, size: a.size })).sort((x, y) => x.id - y.id);
    const want = snapshot.map(({ id, name, size }) => ({ id, name, size })).sort((x, y) => x.id - y.id);
    if (JSON.stringify(got) !== JSON.stringify(want)) add('asset-set-changed', 'asset set differs from the verified draft');
  }
  try {
    const latest = await io.getLatest();
    if (latest.tag_name !== tag) add('latest-pointer', `/releases/latest is ${latest.tag_name}, expected ${tag}`);
  } catch (e) { add('latest-read', msg(e)); }

  // Every expected asset: download from the public URL and compare size and SHA-256 with the verified draft and GitHub's digest.
  const pubFacts = {};
  for (const n of names) {
    const api = apiAssets.get(n);
    if (pub && !api) { add('asset-missing', `${n} is not on the published release`); continue; }
    let d;
    try { d = await io.download(`https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(n)}`); }
    catch (e) { add('download-failed', `${n}: ${msg(e)}`); continue; }
    if (!d || !d.ok) { add('download-failed', `${n}: HTTP ${d && d.status}`); continue; }
    pubFacts[n] = d;
    const want = expected.assets[n];
    if (d.size !== want.size) add('size-mismatch', `${n}: public download ${d.size} bytes, verified draft ${want.size}`);
    if (api && api.size !== d.size) add('size-mismatch', `${n}: public download ${d.size} bytes, release API ${api.size}`);
    if (d.sha256 !== want.sha256) add('digest-mismatch', `${n}: public sha256 differs from the verified draft`);
    if (api) {
      if (!api.digest) add('digest-missing', `${n}: release API reports no digest`);
      else if (api.digest !== `sha256:${d.sha256}`) add('digest-mismatch', `${n}: public sha256 differs from GitHub's digest`);
    }
  }

  // Installer against metadata and signed statement, using the bytes that were actually downloaded publicly.
  const inst = pubFacts[exp.installer];
  if (inst) {
    const facts = { size: inst.size, sha512: inst.sha512 };
    if (facts.sha512 !== expected.installer.sha512 || facts.size !== expected.installer.size) add('installer-changed', 'public installer size or sha512 differs from the verified draft');
    for (const [n, check] of [
      [exp.metadata, text => checkMetadata(config, version, exp, parseUpdateYml(text), facts)],
      [exp.statement, text => verifyStatement(text, publicKey, config, version, exp, facts, lastSequence)],
    ]) {
      const f = pubFacts[n];
      if (!f) continue; // already reported as missing or failed download
      if (!f.body || f.size > MAX_SMALL_FILE_BYTES) { add('body-unavailable', `${n}: content not available for checking`); continue; }
      try { check(f.body.toString('utf8')); } catch (e) { add('installer-mismatch', `${n}: ${msg(e)}`); }
    }
  }
  try {
    const first = await io.atomFirstTag();
    if (first !== tag) add('atom-feed', `releases.atom first entry is ${first}`);
  } catch (e) { add('atom-read', msg(e)); }
  return { problems, published: pub && { url: pub.html_url, publishedAt: pub.published_at, immutable: pub.immutable === true, downloads: [...apiAssets.values()].map(a => `${a.name}: ${a.download_count ?? '?'}`) } };
}

// A published release that failed verification stays public (assets and tag cannot be changed or removed safely here).
// The one thing this tool can do is point `latest` back at the previous known-good release, then check that it worked.
export async function restorePreviousLatest({ io, config, previous }) {
  if (!previous) return { outcome: 'no-previous-good', detail: 'no earlier verified release exists to restore' };
  const steps = [];
  let setError = null;
  try { await io.setLatest(previous.tag); steps.push(`asked GitHub to make ${previous.tag} latest`); }
  catch (e) { setError = msg(e); steps.push(`setting ${previous.tag} as latest FAILED: ${setError}`); }
  const checks = [];
  try {
    const latest = await io.getLatest();
    if (latest.tag_name !== previous.tag) checks.push(`/releases/latest is ${latest.tag_name}, expected ${previous.tag}`);
  } catch (e) { checks.push(`could not read /releases/latest: ${msg(e)}`); }
  try {
    const rel = await io.getRelease(previous.tag);
    const exp = expectedAssets(config, previous.version);
    const have = new Set((rel.assets || []).map(a => a.name));
    if (rel.draft) checks.push(`${previous.tag} is a draft`);
    if (rel.immutable !== true) checks.push(`${previous.tag} is not immutable`);
    if (rel.prerelease !== config.prerelease) checks.push(`${previous.tag} prerelease flag differs`);
    for (const n of [exp.installer, exp.metadata, exp.statement]) if (!have.has(n)) checks.push(`${previous.tag} lacks ${n}`);
    if ((rel.assets || []).some(a => !a.digest)) checks.push(`${previous.tag} has an asset without a digest`);
  } catch (e) { checks.push(`could not read ${previous.tag}: ${msg(e)}`); }
  if (setError) return { outcome: 'restore-failed', detail: setError, steps, checks };
  if (checks.length) return { outcome: 'restore-unverified', detail: checks.join('; '), steps, checks };
  return { outcome: 'restored-and-verified', detail: `${previous.tag} is latest again`, steps, checks };
}

// Plain-language report for the workflow summary and for the owner.
export function incidentReport({ tag, version, published, problems, recovery, previous, latestBefore }) {
  const L = [];
  L.push(`POST-PUBLICATION VERIFICATION FAILED for ${tag}. This release is NOT healthy and is recorded as failed-verification.`);
  L.push(`EXPOSED: ${tag} was made public${published && published.publishedAt ? ` at ${published.publishedAt}` : ''}${published && published.url ? ` (${published.url})` : ''} and became the latest release before the checks finished.`
    + (published && published.downloads && published.downloads.length ? ` Download counts when checked: ${published.downloads.join(', ')}.` : '')
    + ' This tool cannot tell whether any client fetched it.');
  L.push(`FAILED CHECKS (${problems.length}): ${problems.join(' | ')}`);
  const r = recovery;
  if (r.outcome === 'restored-and-verified') L.push(`RESTORED: /releases/latest was set back to ${previous.tag} (it was ${latestBefore || 'unknown'} before this publication) and read back as ${previous.tag}; ${previous.tag} is still a published, immutable release with its allowlisted assets. The bytes of ${previous.tag} were not re-hashed here.`);
  else if (r.outcome === 'no-previous-good') L.push(`NOT RESTORED: ${r.detail}. ${tag} is still the latest release.`);
  else L.push(`NOT RESTORED (${r.outcome}): ${r.detail}. Treat ${tag} as still being the latest release until you confirm otherwise.`);
  L.push(`STILL PUBLIC: the ${tag} release page, its three assets, the ${tag} tag and its releases.atom entry. Restoring the latest pointer does not hide any of them, and the release is immutable so its assets cannot be edited.`);
  const manual = [`decide whether to delete the ${tag} release (the tag name stays burned either way), or leave it and publish a corrected higher version`];
  if (r.outcome !== 'restored-and-verified') manual.unshift(`MANUAL INTERVENTION REQUIRED NOW: set the latest release yourself${previous ? ` to ${previous.tag}` : ''} and confirm /releases/latest`);
  L.push(`MANUAL: ${manual.join('; then ')}. Retention was not run. The ledger keeps ${tag} (and its sequence) so it cannot be reused.`);
  return L;
}

// Everything that happens after the release has been made public. `record(fields)` writes the ledger entry for the tag and
// returns an error string or null. `v` is the verified draft (see verifyDraft). Never throws; the caller fails the workflow
// when `healthy` is false. Order matters: the ledger says pending-verification first, and only says published at the very end.
export async function completePublication({ io, config, repo, tag, version, v, previous, latestBefore, record }) {
  const entry = { version, sequence: v.statement.sequence, installerSha512: v.installerSha512 };
  const lines = [];
  const early = record({ ...entry, status: 'pending-verification' });
  let result;
  try {
    result = await verifyPublication({ io, config, repo, tag, version, exp: v.exp, expected: v.expected, snapshot: v.snapshot, lastSequence: v.lastSequence, publicKey: v.publicKey });
  } catch (e) { result = { problems: [`verification-error: ${msg(e)}`], published: null }; }
  const problems = [...(early ? [`ledger-write: ${early}`] : []), ...result.problems];
  if (problems.length) {
    const recovery = await restorePreviousLatest({ io, config, previous });
    const lf = record({ ...entry, status: 'failed-verification', publishedAt: result.published && result.published.publishedAt, problems: problems.map(p => p.slice(0, 200)).slice(0, 20), recovery: recovery.outcome });
    lines.push(...incidentReport({ tag, version, published: result.published, problems, recovery, previous, latestBefore }));
    lines.push(lf ? `LEDGER: ${lf}; ${tag} is NOT recorded as failed-verification. Fix the ledger by hand before the next release.` : `LEDGER: ${tag} recorded as failed-verification (recovery: ${recovery.outcome}).`);
    return { healthy: false, problems, recovery, lines };
  }
  const done = record({ ...entry, status: 'published', publishedAt: result.published.publishedAt });
  if (done) {
    lines.push(`LEDGER: ${done}; ${tag} is public and verified but is still recorded as pending-verification. Fix the ledger by hand before the next release.`);
    return { healthy: false, problems: [`ledger-write: ${done}`], recovery: null, lines };
  }
  return { healthy: true, problems: [], recovery: null, lines };
}
