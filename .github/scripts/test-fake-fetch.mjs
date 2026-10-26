// TEST ONLY. Preloaded with `node --import` by rehearsal-recovery.test.mjs: answers public downloads and releases.atom from
// the fake gh state ($FAKE_GH_STATE), so nothing reaches the network; any other URL throws. Also makes waits instant.
import fs from 'node:fs';

const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, 0, ...rest);

globalThis.fetch = async url => {
  const st = JSON.parse(fs.readFileSync(process.env.FAKE_GH_STATE, 'utf8'));
  const u = new URL(String(url));
  let m;
  if (u.hostname !== 'github.com') throw new Error(`fake fetch: refusing ${u.href}`);
  if ((m = /^\/[^/]+\/[^/]+\/releases\/download\/([^/]+)\/([^/]+)$/.exec(u.pathname))) {
    const r = st.releases.find(x => x.tag_name === decodeURIComponent(m[1]) && !x.draft);
    const as = r && r.assets.find(x => x.name === decodeURIComponent(m[2]));
    return as ? new Response(Buffer.from(as.content, 'base64'), { status: 200 }) : new Response('Not Found', { status: 404 });
  }
  if (/^\/[^/]+\/[^/]+\/releases\.atom$/.test(u.pathname)) {
    const live = st.releases.filter(r => !r.draft).sort((x, y) => y.publishOrder - x.publishOrder);
    const entries = (st.faults && st.faults.atomStale ? live.slice(1) : live)
      .map(r => `<entry><link rel="alternate" type="text/html" href="https://github.com${u.pathname.replace(/\.atom$/, '')}/tag/${encodeURIComponent(r.tag_name)}"/></entry>`);
    return new Response(`<?xml version="1.0"?><feed>${entries.join('')}</feed>`, { status: 200 });
  }
  throw new Error(`fake fetch: unhandled ${u.href}`);
};
