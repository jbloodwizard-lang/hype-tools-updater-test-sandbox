// publicDownload against a local HTTP server: redirect, hashing, 404, and that large bodies are not kept in memory.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { publicDownload, atomFirstTag } from './publicio.mjs';
import { MAX_SMALL_FILE_BYTES } from './lib.mjs';

const small = Buffer.from('small file\n'), big = crypto.randomBytes(MAX_SMALL_FILE_BYTES + 5000);
const srv = http.createServer((req, res) => {
  if (req.url === '/redirect') { res.writeHead(302, { location: '/small' }); return res.end(); }
  if (req.url === '/small') return res.end(small);
  if (req.url === '/big') return res.end(big);
  res.writeHead(404); res.end('nope');
});
await new Promise(r => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;
const h = (b, a) => crypto.createHash(a).update(b).digest(a === 'sha256' ? 'hex' : 'base64');

test('public download follows redirects, hashes, and keeps small bodies', async () => {
  const d = await publicDownload(`${base}/redirect`);
  assert.equal(d.ok, true); assert.equal(d.size, small.length);
  assert.equal(d.sha256, h(small, 'sha256')); assert.equal(d.sha512, h(small, 'sha512'));
  assert.deepEqual(d.body, small);
});
test('public download does not keep large bodies but hashes all of them', async () => {
  const d = await publicDownload(`${base}/big`);
  assert.equal(d.size, big.length); assert.equal(d.body, null);
  assert.equal(d.sha256, h(big, 'sha256')); assert.equal(d.sha512, h(big, 'sha512'));
});
test('public download reports HTTP errors', async () => {
  const d = await publicDownload(`${base}/missing`);
  assert.equal(d.ok, false); assert.equal(d.status, 404);
});
test('atom first entry', () => {
  assert.equal(atomFirstTag('<feed><entry><link href="https://github.com/o/r/releases/tag/v1.2.3"/></entry><entry><link href="https://github.com/o/r/releases/tag/v1.0.0"/></entry></feed>'), 'v1.2.3');
  assert.equal(atomFirstTag('<feed></feed>'), null);
});
test.after(() => srv.close());
