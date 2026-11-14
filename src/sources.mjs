// Benchmark sources: subreddits rendered through soci.ly, with weak labels
// taken from each community's rules. The labels are noisy, so look at the
// disagreements (the reports list them) before trusting any numbers.

export const SOURCES = [
  // AI-generated communities
  { sub: 'midjourney', label: 'ai', note: 'Midjourney output' },
  { sub: 'StableDiffusion', label: 'ai', note: 'mixed: outputs + UI screenshots/tutorials' },
  { sub: 'aiArt', label: 'ai', note: 'assorted generators' },
  { sub: 'dalle2', label: 'ai', note: 'DALL·E output' },
  { sub: 'weirddalle', label: 'ai', note: 'DALL·E / mixed generators' },
  { sub: 'FluxAI', label: 'ai', note: 'Flux output' },
  // Real-photo communities (their rules require real photos)
  { sub: 'EarthPorn', label: 'real', note: 'landscape photos; AI banned' },
  { sub: 'itookapicture', label: 'real', note: 'amateur photography' },
  { sub: 'analog', label: 'real', note: 'film photography' },
  { sub: 'pics', label: 'real', note: 'mostly real; some memes/screenshots' },
  { sub: 'aww', label: 'real', note: 'animal photos/videos' },
  { sub: 'food', label: 'real', note: 'food photos; hard negatives (product-like shots)' },
  // Video / GIF heavy
  { sub: 'aivideo', label: 'ai', note: 'AI-generated video (Sora, Veo, Kling, …)' },
  { sub: 'gifs', label: 'unknown', note: 'GIFs and short clips' },
  // Hard cases, unlabelled. Handy for checking flag rates on memes and screenshots
  { sub: 'funny', label: 'unknown', note: 'memes, screenshots, video' },
  { sub: 'photoshopbattles', label: 'unknown', note: 'manual edits and composites' },
];
