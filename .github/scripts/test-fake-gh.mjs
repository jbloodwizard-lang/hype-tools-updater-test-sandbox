#!/usr/bin/env node
// TEST ONLY. A fake of the gh CLI calls made by rehearsal-draft.mjs, release-tool.mjs and rehearsal-recovery.mjs, for
// rehearsal-recovery.test.mjs. It never contacts GitHub. State lives in the JSON file named by $FAKE_GH_STATE; every
// mutating call is appended to `calls`. `faults`: atomStale (served by test-fake-fetch.mjs), setLatestNoop.
import crypto from 'node:crypto';
import fs from 'node:fs';

const st = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
const faults = st.faults || {};
const save = () => fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify(st));
const a = process.argv.slice(2);
const out = o => { process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o)); };
const die = (m, code = 1) => { save(); process.stderr.write(m + '\n'); process.exit(code); };
const find = tag => st.releases.find(r => r.tag_name === tag);
const pub = r => ({ ...r, assets: r.assets.map(({ content, ...x }) => x) });
const call = c => { st.calls.push(c); };
const commit = message => { st.commits.push({ sha: `c${st.commits.length + 1}`, message }); };
const recomputeLatest = () => {
  const cur = st.latest && find(st.latest);
  if (cur && !cur.draft && !cur.prerelease) return;
  const c = st.releases.filter(r => !r.draft && !r.prerelease).sort((x, y) => x.publishOrder - y.publishOrder);
  st.latest = c.length ? c.at(-1).tag_name : null;
};
const sha256 = b => 'sha256:' + crypto.createHash('sha256').update(b).digest('hex');

if (a[0] === 'api') {
  const accept = a.includes('-H') && /octet-stream/.test(a[a.indexOf('-H') + 1]);
  const method = a.includes('-X') ? a[a.indexOf('-X') + 1] : 'GET';
  const url = a.find(x => /^repos\//.test(x));
  const input = () => JSON.parse(fs.readFileSync(0, 'utf8'));
  let m;
  if ((m = /\/releases\/assets\/(\d+)$/.exec(url)) && accept) {
    const as = st.releases.flatMap(r => r.assets).find(x => x.id === Number(m[1]));
    if (!as) die('gh: Not Found (HTTP 404)');
    process.stdout.write(Buffer.from(as.content, 'base64'));
  } else if (/\/releases\?per_page/.test(url)) out(st.releases.map(pub));
  else if ((m = /\/releases\/tags\/(.+)$/.exec(url))) {
    const r = find(decodeURIComponent(m[1]));
    if (!r || r.draft) die('gh: Not Found (HTTP 404)');
    out(pub(r));
  } else if (/\/releases\/latest$/.test(url)) {
    const r = st.latest && find(st.latest);
    if (!r) die('gh: Not Found (HTTP 404)');
    out(pub(r));
  } else if ((m = /\/contents\/(.+)$/.exec(url))) {
    const file = m[1];
    if (method === 'PUT') {
      const body = input();
      if (body.sha !== st.files[file].sha) die('gh: HTTP 409: sha mismatch');
      st.files[file] = { sha: `f${st.commits.length + 1}`, content: Buffer.from(body.content, 'base64').toString('utf8') };
      commit(body.message); call(`put ${file}`); save(); out({});
    } else { const f = st.files[file]; if (!f) die('gh: Not Found (HTTP 404)'); out({ sha: f.sha, content: Buffer.from(f.content).toString('base64') }); }
  } else if (/\/git\/matching-refs\/tags$/.test(url)) out(st.tags.map(t => ({ ref: `refs/tags/${t}` })));
  else if (/\/commits\/main$/.test(url)) out({ sha: st.commits.at(-1).sha });
  else if ((m = /\/compare\/(.+)\.\.\.(.+)$/.exec(url))) {
    const i = st.commits.findIndex(c => c.sha === m[1]), j = st.commits.findIndex(c => c.sha === m[2]);
    out({ commits: st.commits.slice(i + 1, j + 1).map(c => ({ commit: { message: c.message } })) });
  } else if (/^repos\/[^/]+\/[^/]+$/.test(url)) out({ default_branch: 'main' });
  else die('fake gh: unhandled api ' + url, 2);
} else if (a[0] === 'release' && a[1] === 'create') {
  const tag = a[2];
  if (find(tag)) die('gh: release already exists');
  call(`release create ${tag} ${a.includes('--draft') ? 'draft' : 'PUBLISHED'}`);
  st.releases.push({ id: st.nextId++, tag_name: tag, name: a[a.indexOf('--title') + 1], draft: true, prerelease: a.includes('--prerelease'), immutable: false, target_commitish: a[a.indexOf('--target') + 1], html_url: `https://github.com/x/releases/tag/${tag}`, publishOrder: 0, assets: [] });
  save();
} else if (a[0] === 'release' && a[1] === 'upload') {
  const r = find(a[2]);
  if (!r || !r.draft) die('gh: can only upload to a draft here');
  for (const f of a.slice(5)) {
    const b = fs.readFileSync(f);
    r.assets.push({ id: st.nextId++, name: f.split('/').pop(), size: b.length, state: 'uploaded', digest: sha256(b), updated_at: 't0', content: b.toString('base64') });
  }
  call(`release upload ${a[2]} ${r.assets.length}`); save();
} else if (a[0] === 'release' && a[1] === 'edit') {
  const tag = a[2], flags = a.slice(3).filter(x => x.startsWith('--') && x !== '--repo');
  call(`release edit ${tag} ${flags.join(' ')}`);
  const r = find(tag);
  if (!r) die('gh: release not found');
  if (flags.includes('--draft=false')) {
    r.draft = false; r.immutable = true; r.published_at = '2026-10-26T12:00:00Z';
    r.publishOrder = Math.max(...st.releases.map(x => x.publishOrder)) + 1;
    st.tags.push(tag); st.latest = tag;
  } else if (flags.includes('--latest')) { if (!faults.setLatestNoop) st.latest = tag; }
  else die('fake gh: unhandled edit ' + flags.join(' '), 2);
  recomputeLatest(); save();
} else if (a[0] === 'release' && a[1] === 'delete') { call(`release delete ${a[2]}`); save(); die('fake gh: delete is not expected in the rehearsal', 3); }
else die('fake gh: unhandled ' + a.join(' '), 2);
