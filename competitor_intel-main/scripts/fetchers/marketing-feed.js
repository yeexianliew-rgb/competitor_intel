// Marketing Feed Fetcher — Facebook Ads Library + Claude vision
// Cadence: weekly (GitHub Actions cron 0 3 * * 1)
// Requires: FB_ADS_API_TOKEN in GitHub Secrets (not yet available)

import { markSectionRefreshed } from '../lib/supabase.js';

const FB_TOKEN = process.env.FB_ADS_API_TOKEN;
const markets = process.env.MARKETS ? process.env.MARKETS.split(',') : ['mx', 'br', 'ph', 'id'];

if (!FB_TOKEN) {
  console.log('FB_ADS_API_TOKEN not set — marketing feed skipped.');
  console.log('To enable: add FB_ADS_API_TOKEN to GitHub repository secrets.');
  console.log('Get a token at: https://developers.facebook.com/docs/marketing-api/reference/ads-archive/');
  // Mark section as attempted so freshness badge doesn't show stale forever
  for (const slug of markets) {
    await markSectionRefreshed(slug, 'marketing').catch(() => {});
  }
  process.exit(0);
}

// Full implementation added once FB token is available.
// Flow: FB Ads Library API → Claude extracts structured ad schema → upsert intel_marketing_ad_examples
console.log('Marketing feed: FB token present but full implementation pending.');
process.exit(0);
