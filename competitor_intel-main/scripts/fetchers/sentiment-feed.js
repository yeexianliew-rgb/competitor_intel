// Sentiment Feed Fetcher — App Store reviews + Claude analysis
// Cadence: weekly (GitHub Actions cron 0 4 * * 2)
// Uses: google-play-scraper (add to package.json when implementing)

import { markSectionRefreshed } from '../lib/supabase.js';

const markets = process.env.MARKETS ? process.env.MARKETS.split(',') : ['mx', 'br', 'ph', 'id'];

// App store scraping requires additional dependencies and app IDs per competitor.
// Placeholder until app IDs are confirmed and google-play-scraper is added.
console.log('Sentiment feed: implementation pending app ID configuration.');
console.log('Next step: add competitor app IDs to config and install google-play-scraper.');

for (const slug of markets) {
  await markSectionRefreshed(slug, 'sentiment').catch(() => {});
}
process.exit(0);
