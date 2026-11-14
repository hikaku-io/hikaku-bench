// Compare models in Chrome using the local benchmark images. Only model
// weights are downloaded; the images stay on localhost. Subreddit labels are noisy.
// npm run compare -- [--limit=140] [--examples=/path/to/local/images]
import puppeteer from 'puppeteer';
import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { cpus } from 'node:os';
import { DATA, RESULTS, HIKAKU_DIR, ROOT, MODEL, modelFile } from './hikaku.mjs';
/* global ort, preprocess, session */

const revision = 'ac6ee457bea904a373065754107451793b56db00';
const repo = 'buildborderless/CommunityForensics-DeepfakeDet-ViT';
const models = [
  { id: 'swin-uint8', file: modelFile(), size: 256, revision: MODEL.revision, output: 'softmax', threshold: 0.9 },
  { id: 'commfor-int8', remote: 'model_int8.onnx', size: 384, revision, output: 'sigmoid', threshold: 0.9 },
  { id: 'commfor-fp32', remote: 'model.onnx', size: 384, revision, output: 'sigmoid', threshold: 0.9 },
];
const arg = (key) => process.argv.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3);
const selected = arg('models')?.split(',');
const chosen = selected ? models.filter((m) => selected.includes(m.id)) : models;
if (!chosen.length) throw new Error('No matching models');
const cache = join(ROOT, '.model-cache');
mkdirSync(cache, { recursive: true }); mkdirSync(RESULTS, { recursive: true });
for (const m of chosen) {
  if (m.remote) {
    m.file = join(cache, `${m.id}-${revision.slice(0, 12)}.onnx`);
    if (!existsSync(m.file)) {
      console.log(`Downloading pinned ${m.id} weights…`);
      const res = await fetch(`https://huggingface.co/${repo}/resolve/${revision}/onnx/${m.remote}`);
      if (!res.ok) throw new Error(`Model download: HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(m.file + '.part'));
      renameSync(m.file + '.part', m.file);
    }
  }
  m.bytes = statSync(m.file).size;
}

// Round-robin by subreddit makes limited runs stratified and deterministic.
const manifest = readFileSync(join(DATA, 'manifest.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((i) => i.kind === 'image');
const groups = [...new Set(manifest.map((i) => i.subreddit))].map((s) => manifest.filter((i) => i.subreddit === s));
const items = [];
while (groups.some((g) => g.length)) for (const group of groups) if (group.length) items.push(group.shift());
const limit = Number(arg('limit') || items.length);
items.splice(limit);
const examples = arg('examples');
if (examples) for (const name of readdirSync(examples).filter((f) => /\.(png|jpe?g|webp)$/i.test(f))) {
  const file = join(examples, name), magic = readFileSync(file).subarray(0, 4);
  if (magic[0] !== 0xff && magic[0] !== 0x89 && magic.toString() !== 'RIFF') continue;
  items.push({ id: `example-${name}`, label: 'example', subreddit: 'user-examples', local: file });
}
const byId = new Map(items.map((i) => [i.id, i]));
const server = http.createServer((req, res) => {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  const url = new URL(req.url, 'http://localhost');
  let file;
  if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); return res.end('<!doctype html><title>Local model comparison</title>'); }
  if (url.pathname.startsWith('/runtime/')) file = join(HIKAKU_DIR, 'vendor/ort', url.pathname.split('/').at(-1));
  if (url.pathname.startsWith('/lib/')) file = join(HIKAKU_DIR, 'lib', url.pathname.split('/').at(-1));
  if (url.pathname.startsWith('/model/')) file = chosen.find((m) => m.id === url.pathname.split('/').at(-1))?.file;
  if (url.pathname.startsWith('/image/')) { const item = byId.get(decodeURIComponent(url.pathname.slice(7))); file = item && (item.local || join(DATA, item.file)); }
  if (!file || !existsSync(file)) { res.writeHead(404); return res.end(); }
  res.setHeader('content-type', { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm' }[extname(file)] || 'application/octet-stream');
  res.setHeader('content-length', statSync(file).size);
  createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await puppeteer.launch({ headless: true });
const resultPath = join(RESULTS, 'comparison.json');
const report = { generated: new Date().toISOString(), cpu: cpus()[0]?.model, browser: await browser.version(), threads: 4, backend: 'wasm', labels: 'weak subreddit labels; examples excluded from metrics', items: items.length, models: [] };
const previous = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null;
if (previous?.cpu === report.cpu && previous.browser === report.browser) {
  report.models = previous.models.filter((m) => chosen.some((c) => c.id === m.id && c.revision === m.revision));
  for (const model of report.models) model.results = model.results.filter((r) => byId.has(r.id));
}
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(0);
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    window.ort = await import('/runtime/ort.webgpu.min.mjs');
    window.preprocess = await import('/lib/preprocess.js');
    ort.env.wasm.wasmPaths = location.origin + '/runtime/';
    ort.env.wasm.numThreads = 4;
  });
  for (const model of chosen) {
    const saved = report.models.find((m) => m.id === model.id);
    const done = new Set(saved?.results.map((r) => r.id));
    if (done.size === items.length) { console.log(`${model.id}: reusing ${done.size} completed results`); continue; }
    const load = await page.evaluate(async (m) => {
      const t = performance.now();
      window.session = await ort.InferenceSession.create(`/model/${m.id}`, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * m.size * m.size), [1, 3, m.size, m.size]) });
      return { loadMs: performance.now() - t, inputs: session.inputNames, outputs: session.outputNames };
    }, model);
    const entry = saved || { ...model, file: undefined, ...load, results: [] };
    if (!saved) report.models.push(entry);
    console.log(`${model.id}: ${Math.round(load.loadMs)} ms initialization, ${(model.bytes / 1e6).toFixed(1)} MB`);
    for (const item of items) {
      if (done.has(item.id)) continue;
      const result = await page.evaluate(async ({ id, model: m }) => {
        const start = performance.now();
        let bitmap;
        try { bitmap = await createImageBitmap(await (await fetch(`/image/${encodeURIComponent(id)}`)).blob()); }
        catch (err) { return { skipped: 'decode failed', error: err.message }; }
        try {
          if (Math.min(bitmap.width, bitmap.height) < 160) return { skipped: 'too small' };
          const gate = new OffscreenCanvas(256, 256), g = gate.getContext('2d');
          g.fillStyle = '#fff'; g.fillRect(0, 0, 256, 256); g.drawImage(bitmap, 0, 0, 256, 256);
          if (preprocess.looksLikeGraphic(g.getImageData(0, 0, 256, 256).data)) return { skipped: 'screenshot/graphic' };
          const canvas = new OffscreenCanvas(m.size, m.size), ctx = canvas.getContext('2d');
          ctx.imageSmoothingQuality = 'high'; ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, m.size, m.size);
          if (m.output === 'sigmoid') {
            const scale = 440 / Math.min(bitmap.width, bitmap.height), w = Math.floor(bitmap.width * scale), h = Math.floor(bitmap.height * scale);
            const resized = new OffscreenCanvas(w, h), rc = resized.getContext('2d');
            rc.imageSmoothingQuality = 'high'; rc.fillStyle = '#fff'; rc.fillRect(0, 0, w, h); rc.drawImage(bitmap, 0, 0, w, h);
            ctx.drawImage(resized, Math.floor((w - 384) / 2), Math.floor((h - 384) / 2), 384, 384, 0, 0, 384, 384);
          } else ctx.drawImage(bitmap, 0, 0, m.size, m.size);
          const rgba = ctx.getImageData(0, 0, m.size, m.size).data;
          let data;
          if (m.output === 'softmax') data = preprocess.rgbaToCHW(rgba);
          else {
            data = new Float32Array(3 * m.size * m.size);
            const means = [0.48145466, 0.4578275, 0.40821073], stds = [0.26862954, 0.26130258, 0.27577711], plane = m.size * m.size;
            for (let c = 0; c < 3; c++) for (let i = 0; i < plane; i++) data[c * plane + i] = (rgba[i * 4 + c] / 255 - means[c]) / stds[c];
          }
          const t = performance.now();
          const output = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', data, [1, 3, m.size, m.size]) });
          const inferenceMs = performance.now() - t, logits = output[session.outputNames[0]].data;
          const score = m.output === 'sigmoid' ? 1 / (1 + Math.exp(-logits[0])) : preprocess.aiProbability(logits);
          return { score, inferenceMs, totalMs: performance.now() - start };
        } finally { bitmap.close(); }
      }, { id: item.id, model });
      entry.results.push({ id: item.id, label: item.label, subreddit: item.subreddit, ...result });
      if (entry.results.length % 25 === 0 || item.label === 'example') console.log(`${model.id} ${entry.results.length}/${items.length}${item.label === 'example' ? ` ${item.id}: ${JSON.stringify(result)}` : ''}`);
      if (entry.results.length % 10 === 0) writeFileSync(resultPath, JSON.stringify(report, null, 2) + '\n');
    }
    await page.evaluate(() => session.release());
    writeFileSync(resultPath, JSON.stringify(report, null, 2) + '\n');
  }
} finally { await browser.close(); server.close(); }

const percentile = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const rate = (xs, threshold) => `${xs.filter((r) => r.score >= threshold).length}/${xs.length}`;
const lines = ['# Local detector comparison', '', `Generated ${report.generated}. ${report.browser}; ${report.cpu}; WASM, four threads.`, '', 'Subreddit labels are weak. User examples are excluded from accuracy metrics. Browser canvas preprocessing; no media uploaded. Timings include one inference per image and are indicative, not repeated hardware benchmarks.', '', '| Model | MB | Warm median / p95 inference | Initialization | AI flagged at 0.90 | Real flagged at 0.90 |', '|---|---:|---:|---:|---:|---:|'];
for (const m of report.models) {
  const scored = m.results.filter((r) => r.score != null), times = scored.map((r) => r.inferenceMs);
  lines.push(`| ${m.id} | ${(m.bytes / 1e6).toFixed(1)} | ${percentile(times, 0.5)?.toFixed(0)} / ${percentile(times, 0.95)?.toFixed(0)} ms | ${m.loadMs.toFixed(0)} ms | ${rate(scored.filter((r) => r.label === 'ai'), 0.9)} | ${rate(scored.filter((r) => r.label === 'real'), 0.9)} |`);
}
lines.push('', '## Thresholds and coverage', '');
for (const m of report.models) {
  lines.push(`### ${m.id}`, '', `Revision: ${m.revision}. Scored: ${m.results.filter((r) => r.score != null).length}/${m.results.length}.`, '', '| Threshold | AI flagged / scored | Real flagged / scored |', '|---|---:|---:|');
  for (const t of [0.5, 0.7, 0.9, 0.95, 0.99]) lines.push(`| ${t} | ${rate(m.results.filter((r) => r.label === 'ai' && r.score != null), t)} | ${rate(m.results.filter((r) => r.label === 'real' && r.score != null), t)} |`);
}
lines.push('', '## User examples (diagnostics, not evaluation labels)', '');
for (const m of report.models) for (const r of m.results.filter((r) => r.label === 'example')) lines.push(`- ${m.id} / ${r.id}: ${r.score?.toFixed(5) ?? r.skipped}`);
const primary = report.models.find((m) => m.id === 'swin-uint8');
const secondary = report.models.find((m) => m.id === 'commfor-int8');
if (primary && secondary) {
  const byId = new Map(secondary.results.map((r) => [r.id, r]));
  lines.push('', '## Complementary second-opinion experiment', '', 'Flags an image when either model scores at least 0.90. The scores are estimates, not probabilities. This stays optional: it takes more work, and the noisy labels are not enough to justify changing the default.', '', '| Label | Scored by both | Primary flagged | Either flagged | Added flags |', '|---|---:|---:|---:|---:|');
  for (const label of ['ai', 'real']) {
    const rs = primary.results.filter((r) => r.label === label && r.score != null && byId.get(r.id)?.score != null);
    const base = rs.filter((r) => r.score >= 0.9).length, combined = rs.filter((r) => r.score >= 0.9 || byId.get(r.id).score >= 0.9).length;
    lines.push(`| ${label} | ${rs.length} | ${base} | ${combined} | ${combined - base} |`);
  }
}
if (existsSync(join(RESULTS, 'media.jsonl'))) {
  const videos = readFileSync(join(RESULTS, 'media.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((r) => r.kind === 'video' && Array.isArray(r.frames) && r.frames.length);
  lines.push('', '## Saved video pooling experiment', '', 'Uses the saved frame scores without running the models again. There are too few real videos here to judge the false-positive rate of an any-frame rule. More frame sampling and video-specific models need their own evaluation.', '', '| Label | Videos | Median ≥ 0.90 | Any frame ≥ 0.90 |', '|---|---:|---:|---:|');
  for (const label of ['ai', 'real', 'unknown']) {
    const rs = videos.filter((r) => r.label === label);
    lines.push(`| ${label} | ${rs.length} | ${rs.filter((r) => { const s = [...r.frames].sort((a, b) => a - b); return s[s.length >> 1] >= 0.9; }).length} | ${rs.filter((r) => r.frames.some((p) => p >= 0.9)).length} |`);
  }
}
writeFileSync(join(RESULTS, 'comparison.md'), lines.join('\n') + '\n');
console.log(lines.slice(0, 12).join('\n'));
