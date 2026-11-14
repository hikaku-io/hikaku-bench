// Runs the scraped videos and GIFs through the real extension in Chrome for
// Testing, since Node can't decode them. Videos play in a grid so the content
// script samples frames the same way it would on a real website.
//
// Usage: npm run media   (first build the extension: npm run build in its repo)
// Env:   EXT_DIR=…/dist/hikaku-x.y.z (default: newest build in the extension repo)
// Output: results/media.jsonl, results/media.md
import puppeteer from 'puppeteer';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync, createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';
import { DATA as BENCH, RESULTS, builtExtension } from './hikaku.mjs';

const EXT = builtExtension();
if (!EXT || !existsSync(join(EXT, 'manifest.json'))) { console.error(`No built extension (${EXT}). Run npm run build in the extension repo, or set EXT_DIR`); process.exit(1); }
mkdirSync(RESULTS, { recursive: true });
const FLAGGED = new Set(['ai', 'ai-edited', 'likely-ai']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const items = readFileSync(join(BENCH, 'manifest.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((x) => x.kind === 'video' || x.kind === 'gif');
const byId = new Map(items.map((x) => [x.id, x]));

// Local server: /m/<id> serves the media file, with Range support so <video> can seek.
const server = http.createServer((req, res) => {
  const m = req.url.match(/^\/m\/([0-9a-f]{40})/);
  if (m && byId.has(m[1])) {
    const it = byId.get(m[1]);
    const f = join(BENCH, it.file);
    const size = statSync(f).size;
    const type = it.kind === 'gif' ? 'image/gif' : 'video/mp4';
    const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
    if (range) {
      const start = Number(range[1]), end = range[2] ? Number(range[2]) : size - 1;
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
      return createReadStream(f, { start, end }).pipe(res);
    }
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
    return createReadStream(f).pipe(res);
  }
  if (req.url.startsWith('/batch')) {
    const ids = new URL(req.url, 'http://x').searchParams.get('ids').split(',');
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<!doctype html><style>body{margin:0;background:#111;display:grid;grid-template-columns:repeat(2,620px);gap:16px;padding:16px}video{width:620px;height:349px;background:#000}</style>
${ids.map((id) => `<video src="/m/${id}" muted loop autoplay playsinline></video>`).join('')}`);
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await puppeteer.launch({ headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'] });
const results = [];
try {
  const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('background.js'));
  const extId = new URL(sw.url()).host;
  const ext = await browser.newPage();
  await ext.goto(`chrome-extension://${extId}/popup/popup.html`);
  console.log('loading model…', JSON.stringify(await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'modelWarmup' }))));

  // GIFs go through the same path as an <img> on a page.
  for (const it of items.filter((x) => x.kind === 'gif')) {
    const r = await ext.evaluate((u) => chrome.runtime.sendMessage({ type: 'analyze', url: u }), `${base}/m/${it.id}`);
    const c = r.classifier || {};
    results.push({ id: it.id, kind: 'gif', subreddit: it.subreddit, label: it.label, title: it.title, permalink: it.permalink, verdict: r.verdict, flagged: FLAGGED.has(r.verdict), p: c.status === 'ok' ? c.score : null, frames: c.perFrame, skipped: c.status !== 'ok' ? c.reason : null });
    process.stdout.write(`gif   ${r.verdict.padEnd(10)} ${c.status === 'ok' ? c.score.toFixed(3) : c.reason}  r/${it.subreddit}\n`);
  }

  // Videos: 4 per page, while the content script samples frames as they play.
  const vids = items.filter((x) => x.kind === 'video');
  const tab = await browser.newPage();
  await tab.setViewport({ width: 1300, height: 760 });
  for (let i = 0; i < vids.length; i += 4) {
    const batch = vids.slice(i, i + 4);
    await tab.goto(`${base}/batch?ids=${batch.map((b) => b.id).join(',')}`, { waitUntil: 'load' });
    await tab.bringToFront();
    let stats = null;
    for (let w = 0; w < 50; w++) { // wait up to ~25 s per batch
      await sleep(500);
      await tab.bringToFront();
      stats = await ext.evaluate(async (u) => {
        const [t] = await chrome.tabs.query({ url: u + '/batch*' });
        return t ? chrome.tabs.sendMessage(t.id, { type: 'stats' }, { frameId: 0 }).catch(() => null) : null;
      }, base);
      if ((stats?.videos?.filter((v) => v.frames > 0).length || 0) >= batch.length) break;
    }
    const playable = await tab.evaluate(() => [...document.querySelectorAll('video')].map((v) => ({ src: v.currentSrc, ok: v.readyState >= 2, err: v.error?.code || null })));
    for (const it of batch) {
      const v = stats?.videos?.find((x) => x.src?.endsWith(`/m/${it.id}`));
      const pl = playable.find((x) => x.src.endsWith(`/m/${it.id}`));
      results.push({
        id: it.id, kind: 'video', subreddit: it.subreddit, label: it.label, title: it.title, permalink: it.permalink,
        verdict: v?.verdict || (pl?.ok ? 'no-frames' : 'not-playable'), flagged: FLAGGED.has(v?.verdict), p: v?.perFrame?.length ? median(v.perFrame) : null,
        frames: v?.perFrame, times: v?.times, skipped: v?.frames ? null : (pl?.err ? `media error ${pl.err}` : pl?.ok ? 'no usable frames (graphic/black?)' : 'not playable'),
      });
      const last = results.at(-1);
      process.stdout.write(`video ${last.verdict.padEnd(12)} ${last.p != null ? last.p.toFixed(3) + ' ' + JSON.stringify(last.frames?.map((x) => +x.toFixed(2))) : last.skipped}  r/${it.subreddit}\n`);
    }
  }
} finally {
  await browser.close();
  server.close();
}

writeFileSync(join(RESULTS, 'media.jsonl'), results.map((r) => JSON.stringify(r)).join('\n') + '\n');
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(0)}%` : 'n/a');
const out = ['# Hikaku benchmark: video and GIF (real extension, Chrome for Testing)', '', `Generated ${new Date().toISOString()} · ${results.length} items`, '',
  '| Kind | Label | Items | Scored | Flagged | Median P(AI) |', '|---|---|---:|---:|---:|---:|'];
for (const kind of ['video', 'gif']) for (const label of ['ai', 'real', 'unknown']) {
  const rs = results.filter((r) => r.kind === kind && r.label === label);
  if (!rs.length) continue;
  const ps = rs.map((r) => r.p).filter((x) => x != null).sort((a, b) => a - b);
  out.push(`| ${kind} | ${label} | ${rs.length} | ${ps.length} | ${pct(rs.filter((r) => r.flagged).length, rs.length)} | ${ps.length ? ps[ps.length >> 1].toFixed(2) : 'n/a'} |`);
}
out.push('', '## Items', '');
for (const r of results) out.push(`- ${r.kind} · r/${r.subreddit} (${r.label}) · **${r.verdict}**${r.p != null ? ` · P=${r.p.toFixed(2)}` : ''}${r.skipped ? ` · ${r.skipped}` : ''} · [${(r.title || r.id).replace(/[[\]]/g, '')}](${r.permalink || '#'})`);
writeFileSync(join(RESULTS, 'media.md'), out.join('\n') + '\n');
console.log('\n' + out.slice(0, 12).join('\n'));
