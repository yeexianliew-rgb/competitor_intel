// Marketing Feed Fetcher — Facebook Ads Library + Claude vision
// Cadence: weekly (GitHub Actions cron 0 3 * * 1)
// Requires: FB_ADS_API_TOKEN in GitHub Secrets (not yet available)

import '../lib/bootstrap.js';
import { markSectionRefreshed } from '../lib/supabase.js';

async function main() {
  const FB_TOKEN = process.env.FB_ADS_API_TOKEN;
  const markets = process.env.MARKETS ? process.env.MARKETS.split(',') : ['mx', 'br', 'ph', 'id'];

  if (!FB_TOKEN) {
    console.log('FB_ADS_API_TOKEN not set — marketing feed skipped.');
    console.log('To enable: add FB_ADS_API_TOKEN to GitHub repository secrets.');
    for (const slug of markets) {
      await markSectionRefreshed(slug, 'marketing').catch(() => {});
    }
    return;
  }

  // Full implementation added once FB token is available.
  console.log('Marketing feed: FB token present but full implementation pending.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
