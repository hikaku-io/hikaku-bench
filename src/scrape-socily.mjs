// Collects images, GIFs and videos from subreddit pages rendered by soci.ly,
// downloads them locally and writes a manifest with weak labels.
//
// Output is gitignored. The media belongs to its creators, so never commit or publish it:
//   data/media/<sha1>.<ext>
//   data/manifest.jsonl   one JSON object per item
//
// Usage: npm run scrape -- [--per-sub=40] [--subs=midjourney,EarthPorn]
import puppeteer from 'puppeteer';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { SOURCES } from './sources.mjs';

const BENCH = join(import.meta.dirname, '..', 'data');
const MEDIA = join(BENCH, 'media');
const MANIFEST = join(BENCH, 'manifest.jsonl');
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const PER_SUB = Number(arg('per-sub', 40));
const ONLY = arg('subs', '') ? new Set(arg('subs').split(',')) : null;
const MAX_BYTES = 30 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (s) => createHash('sha1').update(s).digest('hex');

mkdirSync(MEDIA, { recursive: true });
const seen = new Set(existsSync(MANIFEST)
  ? readFileSync(MANIFEST, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).url)
  : []);

// Prefer the original upload over resized previews where Reddit exposes it.
function normalize(src) {
  if (!src || src.startsWith('data:') || src.startsWith('blob:')) return null;
  try {
    const u = new URL(src);
    if (!/(^|\.)redd\.it$|redditmedia\.com$|imgur\.com$/.test(u.hostname)) return null; // skip avatars/icons/UI
    if (/\/(avatars?|icons?|emoji|award)/i.test(u.pathname)) return null;
    return u.href;
  } catch { return null; }
}

function kindFor(url, contentType) {
  if (/video\//.test(contentType) || /\.(mp4|webm)(\?|$)/i.test(url) || /format=mp4/.test(url)) return 'video';
  if (/image\/gif/.test(contentType) || /\.gif(\?|$)/i.test(url)) return 'gif';
  return 'image';
}
const extFor = (ct, kind) => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'image/avif': 'avif' }[ct.split(';')[0]] || (kind === 'video' ? 'mp4' : 'bin'));

// v.redd.it serves HLS: a master playlist points to one playlist per resolution,
// and each of those points to a single CMAF .mp4. We take the best rendition
// up to 720p and return its mp4 URL.
async function resolveRedditVideo(m3u8Url) {
  const base = m3u8Url.slice(0, m3u8Url.lastIndexOf('/') + 1);
  const master = await (await fetch(m3u8Url, { headers: { 'User-Agent': UA } })).text();
  const variants = [...master.matchAll(/#EXT-X-STREAM-INF:[^\n]*RESOLUTION=\d+x(\d+)[^\n]*\n([^\n#]+)/g)]
    .map((m) => ({ h: Number(m[1]), uri: m[2].trim() }))
    .sort((a, b) => b.h - a.h);
  const pick = variants.find((v) => v.h <= 720) || variants.at(-1);
  if (!pick) throw new Error('no video variants');
  const playlistUrl = new URL(pick.uri, base).href;
  const media = await (await fetch(playlistUrl, { headers: { 'User-Agent': UA } })).text();
  const uri = media.split('\n').find((l) => l && !l.startsWith('#') && /\.mp4/.test(l)) || media.match(/URI="([^"]+\.mp4)"/)?.[1];
  if (!uri) throw new Error('no mp4 in playlist');
  return new URL(uri.trim(), playlistUrl).href;
}

async function download(url) {
  // Ask for the originals (JPEG/PNG/GIF/MP4) instead of WebP re-encodes, where the CDN lets us.
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'image/jpeg,image/png,image/gif,video/mp4,*/*;q=0.5' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const ct = res.headers.get('content-type') || '';
  if (!/^(image|video)\//.test(ct)) throw new Error(`not media (${ct})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error('too large');
  if (/^image\//.test(ct) && buf.length < 20_000) throw new Error('thumbnail'); // link previews, icons
  return { buf, ct };
}

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setUserAgent(UA);
await page.setViewport({ width: 1440, height: 2000 });
await page.setRequestInterception(true);
page.on('request', (req) => {
  // Keep our traffic out of the site's analytics.
  if (/staat\.co|google-analytics|googletagmanager/.test(req.url())) return req.abort();
  return req.continue();
});

let total = 0;
for (const src of SOURCES) {
  if (ONLY && !ONLY.has(src.sub)) continue;
  const url = `https://soci.ly/r/${src.sub}`;
  process.stdout.write(`r/${src.sub.padEnd(18)} `);
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  } catch (e) { console.log(`load failed: ${e.message}`); continue; }

  // Keep scrolling for more posts, until we have enough candidates or nothing new shows up.
  let items = [];
  for (let i = 0, stall = 0; i < 12 && stall < 3; i++) {
    const found = await page.evaluate(() => [...document.querySelectorAll('img, video, video source')].map((el) => {
      const video = el.closest('video');
      const r = (video || el).getBoundingClientRect();
      const card = el.closest('article, a[href*="/comments/"], [class*="card"], [class*="post"]');
      const link = card?.querySelector?.('a[href*="/comments/"]')?.href || (card?.href?.includes?.('/comments/') ? card.href : '');
      return {
        src: el.currentSrc || el.src || el.getAttribute('src') || '',
        poster: video?.poster || '',
        isVideo: !!video,
        title: el.alt || card?.querySelector?.('h2,h3,[class*="title"]')?.textContent?.trim() || '',
        permalink: link,
        w: Math.round(r.width), h: Math.round(r.height),
      };
    }));
    const before = items.length;
    const map = new Map(items.map((x) => [x.src, x]));
    for (const f of found) if (f.w >= 120 && f.h >= 90 && !map.has(f.src)) map.set(f.src, f);
    items = [...map.values()];
    stall = items.length === before ? stall + 1 : 0;
    if (items.length >= PER_SUB * 1.5) break;
    await page.evaluate(() => scrollBy(0, innerHeight * 1.5));
    await sleep(1200);
  }

  let kept = 0, skipped = 0;
  for (const it of items) {
    if (kept >= PER_SUB) break;
    const candidates = [normalize(it.src)].filter(Boolean);
    for (const mediaUrl of candidates) {
      if (seen.has(mediaUrl)) { skipped++; continue; }
      try {
        const fetchUrl = /\.m3u8(\?|$)/.test(mediaUrl) ? await resolveRedditVideo(mediaUrl) : mediaUrl;
        const { buf, ct } = await download(fetchUrl);
        const kind = kindFor(mediaUrl, ct);
        const id = sha1(mediaUrl);
        const file = `media/${id}.${extFor(ct, kind)}`;
        writeFileSync(join(BENCH, file), buf);
        appendFileSync(MANIFEST, JSON.stringify({
          id, file, kind, url: mediaUrl, bytes: buf.length,
          subreddit: src.sub, label: src.label, label_source: `subreddit r/${src.sub} (weak)`,
          title: it.title.slice(0, 200), permalink: it.permalink, source_url: fetchUrl,
          fetched_at: new Date().toISOString(),
        }) + '\n');
        seen.add(mediaUrl);
        kept++;
        await sleep(250);
        break; // one file per post
      } catch { skipped++; }
    }
  }
  total += kept;
  console.log(`${String(kept).padStart(3)} saved · ${items.length} found · ${skipped} skipped  [${src.label}]`);
  await sleep(1500);
}
await browser.close();
console.log(`\n${total} new items added to ${MANIFEST}`);
