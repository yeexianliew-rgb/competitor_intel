// Sentiment Feed Fetcher — App Store reviews + Claude analysis
// Cadence: weekly (GitHub Actions cron 0 4 * * 2)
// Placeholder until competitor app IDs are confirmed

import { markSectionRefreshed } from '../lib/supabase.js';

async function main() {
  const markets = process.env.MARKETS ? process.env.MARKETS.split(',') : ['mx', 'br', 'ph', 'id'];
  console.log('Sentiment feed: implementation pending app ID configuration.');
  for (const slug of markets) {
    await markSectionRefreshed(slug, 'sentiment').catch(() => {});
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
