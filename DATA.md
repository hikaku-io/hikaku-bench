# Data policy

The benchmark uses public Reddit posts, collected through [soci.ly](https://soci.ly) (a Reddit aggregator run by the Hikaku maintainers). The media belongs to the people who made it.

## Rules

1. Never commit or publish media files. `data/` is gitignored. Don't upload it to releases, issue trackers, model hubs, or any cloud storage that anyone can read.
2. Results can contain links, not files. Reports list Reddit permalinks and post titles so reviewers can see the original in context.
3. Aggregate numbers are fine to publish. Tables of rates and scores (for example the summary tables in `results/*.md`) can be shared, on hikaku.io for instance, as long as they link back to this methodology.
4. Respect deletions. Re-scrape before each published run, so posts their authors removed drop out on their own. If someone asks you to remove an item, delete its line from `data/manifest.jsonl` and its file from `data/media/`.
5. No training. This data is for evaluation only. Don't train or fine-tune models on it.
6. People. Some posts show identifiable people. Don't crop their images, redistribute them, or single anyone out in a report.

## Labels are weak

Each item is labelled by the subreddit it came from (see [`src/sources.mjs`](src/sources.mjs)):

| Label | Meaning | Known noise |
|---|---|---|
| `ai` | Posted in an AI-generation community (r/midjourney, r/StableDiffusion, r/aivideo, …) | UI screenshots, tutorials, before/after comparisons, real reference photos |
| `real` | Posted in a community whose rules require real photos (r/EarthPorn, r/analog, r/itookapicture, …) | Occasional AI posts nobody caught, heavy edits, composites |
| `unknown` | Mixed communities (r/funny, r/gifs, r/photoshopbattles) | n/a. Used for flag rates, not accuracy |

Every report lists the biggest disagreements between label and verdict. Look through them before you quote any number. A "false positive" may just be a mislabelled AI image, and a "miss" may be a screenshot posted in an AI subreddit.

## Collection etiquette

- The scraper only renders public subreddit pages and waits between requests. It also blocks the site's analytics so benchmark runs don't inflate their traffic numbers.
- Each file is fetched once from Reddit's CDN at the size the page shows (videos: best rendition up to 720p, at most 30 MB).
