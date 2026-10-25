// Plain HTTP reads of public release data, exactly as a client would make them. No GitHub token, no gh.
import crypto from 'node:crypto';
import { MAX_SMALL_FILE_BYTES } from './lib.mjs';

// Streams the response (redirects followed), hashing as it goes. The body is kept only for small files (metadata and
// statement) so the installer is never held in memory.
export async function publicDownload(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) { await res.body?.cancel(); return { ok: false, status: res.status }; }
  const s256 = crypto.createHash('sha256'), s512 = crypto.createHash('sha512');
  const keep = []; let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length; s256.update(chunk); s512.update(chunk);
    if (size <= MAX_SMALL_FILE_BYTES) keep.push(Buffer.from(chunk));
  }
  return { ok: true, status: res.status, size, sha256: s256.digest('hex'), sha512: s512.digest('base64'), body: size <= MAX_SMALL_FILE_BYTES ? Buffer.concat(keep) : null };
}

export function atomFirstTag(text) {
  const first = /<entry>[\s\S]*?releases\/tag\/([^"]+)"/.exec(text);
  return first ? decodeURIComponent(first[1]) : null;
}
