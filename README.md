# hikaku-bench

Real-world benchmarks for [Hikaku](https://github.com/hikaku-io/hikaku-extension) ([hikaku.io](https://hikaku.io)), the free, open-source browser extension that flags AI-generated images and video.

Instead of a curated research dataset, this tests what people actually run into: images, GIFs and videos from public Reddit communities (collected through [soci.ly](https://soci.ly)). Everything goes through the extension's real detection code: the metadata check, then the screenshot filter, then the visual model.

> Heads up: the labels are weak. Each item is labelled by its subreddit (r/midjourney counts as AI, r/EarthPorn counts as real). Read [DATA.md](DATA.md) before quoting any numbers.

## Latest results (2026-11-14, Hikaku 0.1.0)

### Images (548 images, SwinV2 uint8)

| | AI-labelled (234 scored) | Real-labelled (237 scored) |
|---|---:|---:|
| Flagged at the default threshold (P ≥ 0.90) | 65% caught | 6% wrongly flagged |
| Same, leaving out r/analog (film scans) | n/a | 2.5% |
| Metadata/provenance hits | 0 | 0 |

| Subreddit | Label | Flagged | | Subreddit | Label | Flagged |
|---|---|---:|---|---|---|---:|
| r/aiArt | ai | 75% | | r/EarthPorn | real | 0% |
| r/dalle2 | ai | 68% | | r/aww | real | 0% |
| r/weirddalle | ai | 65% | | r/pics | real | 3% |
| r/midjourney | ai | 63% | | r/food | real | 3% |
| r/FluxAI | ai | 63% | | r/itookapicture | real | 8% |
| r/StableDiffusion | ai | 48% | | r/analog | real | 25% |

### Video and GIF (53 items, real extension in Chrome, 3 sampled frames each)

| | Items | Flagged |
|---|---:|---:|
| AI video (r/aivideo) | 18 | 22% |
| Real video (r/aww) | 6 | 0% |
| Other video (r/funny) | 4 | 0% |
| GIFs (r/gifs, unlabelled) | 25 | 16% |

### What I take from this

1. Provenance never survived. Reddit strips metadata and Content Credentials from every upload, and we found 0 hits in 548 images. On social media the visual model is doing all the work.
2. On images the model is okay, not great. About 2 in 3 AI images get caught, and ordinary photos are rarely flagged (around 2.5%).
3. Film photography causes the most false positives (25% of r/analog). Grain, colour shifts and scanner artefacts look "generated" to the model. This needs a hard-negative test set, and probably a better model or calibration.
4. Most AI video is missed (only 22% flagged). The image model doesn't carry over well to compressed video frames, so video likely needs a model trained on video frames.
5. r/StableDiffusion scores lower partly because of label noise (UI screenshots, comparisons, tutorials). Three of those were correctly skipped as screenshots.

Full per-item reports, with Reddit links for review, get written to `results/` (gitignored).

## Run it

You need Node 20 or newer, plus the extension repo checked out next to this one (or `HIKAKU_DIR` pointing at it).

```sh
# in the extension repo
npm install && npm run setup -- --model=uint8 && npm run build

# here
npm install
npm run scrape -- --per-sub=40        # writes data/manifest.jsonl + data/media/ (gitignored)
npm run images                        # writes results/images.md
npm run media                         # writes results/media.md (videos + GIFs, real extension in Chrome)
npm run compare                       # compare browser/WASM SwinV2, Community Forensics INT8 and FP32
npm run compare -- --examples=/path/to/images # additional diagnostics, excluded from accuracy metrics
```

Some useful variations: `npm run scrape -- --subs=midjourney,EarthPorn`, `npm run images -- --limit=50`, and `EXT_DIR=…/dist/hikaku-x.y.z npm run media`.

Sources and weak labels live in [`src/sources.mjs`](src/sources.mjs). If you want to stress the false-positive rate, add hard negatives there (film, 3D renders, product photography).

### Model comparison

The browser comparison downloads pinned candidate weights to `.model-cache/`, serves evaluation media only on localhost, and writes `results/comparison.json` and `results/comparison.md`. It can resume completed items on the same CPU/browser. Limited runs use `--limit=N` with deterministic round-robin sampling by subreddit. Compare coverage, false-positive counts, initialization, warm inference, and error overlap; a smaller model is not necessarily a better replacement. The report includes a separate saved-video pooling experiment and a complementary second-opinion policy. Subreddit labels remain weak. No media or per-item reports are committed.

## Layout

```
src/hikaku.mjs          finds the extension checkout; loads its detection modules, model and build
src/sources.mjs         subreddits + weak labels
src/scrape-socily.mjs   renders soci.ly pages, downloads media (HLS video → best ≤720p MP4)
src/run-images.mjs      images in Node (metadata → screenshot filter → visual model)
src/run-media.mjs       videos + GIFs through the built extension in Chrome for Testing
src/compare-models.mjs  browser comparison of candidate models (npm run compare)
data/                   scraped media + manifest (gitignored, see DATA.md)
results/                reports (gitignored; publish aggregate tables only)
```

## License

The code is [Apache-2.0](LICENSE). The scraped media is not covered by that license and is never distributed. See [DATA.md](DATA.md).
