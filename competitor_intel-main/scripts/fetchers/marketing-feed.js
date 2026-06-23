// Marketing Feed Fetcher — Public ad intelligence via web scraping
// Sources:
//   1. Facebook Ads Library (public, no token needed at search level)
//   2. Google Ads Transparency Center (public search)
//   3. Google News search for ad campaign coverage
// Cadence: weekly (GitHub Actions cron 0 3 * * 1)

import fetch from 'node-fetch';
import Parser from 'rss-parser';
import { extractStructured } from '../lib/claude.js';
import { createRun, markSectionRefreshed, rebuildSnapshot, logChange, batchInsert } from '../lib/supabase.js';

const rss = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  }
});

// ── Market competitor config ──────────────────────────────────────────────────

const MARKETS = {
  mx: {
    name: 'Mexico',
    country: 'MX',
    locale: 'es_MX',
    currency: 'MXN',
    competitors: [
      { name: 'Nu Mexico',    fbPageId: 'nubank.mx',     searchName: 'Nu Mexico nubank' },
      { name: 'Mercado Pago', fbPageId: 'MercadoPagoMX', searchName: 'Mercado Pago Mexico' },
      { name: 'Kueski',       fbPageId: 'kueski',        searchName: 'Kueski Mexico' },
      { name: 'Plata',        fbPageId: 'bancoplata',    searchName: 'Banco Plata Mexico' },
      { name: 'Klar',         fbPageId: 'klarmexico',    searchName: 'Klar Mexico tarjeta' },
      { name: 'Stori',        fbPageId: 'storicard',     searchName: 'Stori Mexico credito' },
    ]
  },
  br: {
    name: 'Brazil',
    country: 'BR',
    locale: 'pt_BR',
    currency: 'BRL',
    competitors: [
      { name: 'Nubank',          fbPageId: 'nubank',           searchName: 'Nubank Brasil cartão' },
      { name: 'Mercado Pago BR', fbPageId: 'mercadopago',      searchName: 'Mercado Pago Brasil credito' },
      { name: 'PicPay',          fbPageId: 'PicPay',           searchName: 'PicPay Brasil credito' },
      { name: 'C6 Bank',         fbPageId: 'c6bank',           searchName: 'C6 Bank Brasil credito' },
      { name: 'Creditas',        fbPageId: 'creditas.brasil',  searchName: 'Creditas Brasil emprestimo' },
      { name: 'PagBank',         fbPageId: 'pagbank',          searchName: 'PagBank Brasil credito' },
    ]
  },
  ph: {
    name: 'Philippines',
    country: 'PH',
    locale: 'en_PH',
    currency: 'PHP',
    competitors: [
      { name: 'GCash',      fbPageId: 'GCashOfficial',  searchName: 'GCash Philippines loans credit' },
      { name: 'Maya',       fbPageId: 'MayaOfficial',   searchName: 'Maya Philippines credit loans' },
      { name: 'BillEase',   fbPageId: 'BillEasePH',     searchName: 'BillEase Philippines BNPL' },
      { name: 'Tonik Bank', fbPageId: 'tonikbank',      searchName: 'Tonik Bank Philippines loans' },
    ]
  },
  id: {
    name: 'Indonesia',
    country: 'ID',
    locale: 'id_ID',
    currency: 'IDR',
    competitors: [
      { name: 'Kredivo',   fbPageId: 'Kredivo',      searchName: 'Kredivo Indonesia cicilan kredit' },
      { name: 'Akulaku',   fbPageId: 'akulakuid',    searchName: 'Akulaku Indonesia pinjaman kredit' },
      { name: 'GoPay',     fbPageId: 'GoPay',        searchName: 'GoPay Indonesia kredit paylater' },
      { name: 'OVO',       fbPageId: 'OVO.id',       searchName: 'OVO Indonesia paylater kredit' },
      { name: 'Dana',      fbPageId: 'danaapp',      searchName: 'Dana Indonesia pinjaman kredit' },
    ]
  }
};

// ── FB Ads Library public scrape (no token) ───────────────────────────────────
// Uses the publicly accessible Ad Library search page — extracts ad copy snippets
// visible in the page HTML without authentication.

async function fetchFbAdsLibrary(competitor, country) {
  const query = encodeURIComponent(competitor.fbPageId);
  // Public search endpoint — returns HTML with ad cards embedded in JSON state
  const url = `https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=${country}&q=${query}&search_type=keyword_unordered&media_type=all`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache'
      },
      signal: AbortSignal.timeout(20000)
    });

    if (!res.ok) return { source: 'fb_ads_library', ads: [], error: `HTTP ${res.status}` };

    const html = await res.text();

    // Extract ad body text snippets from embedded JSON (FB embeds ad data in __bbox JSON)
    const adSnippets = [];

    // Extract text between ad body markers
    const bodyMatches = html.matchAll(/"body"\s*:\s*\{"__typename":"[^"]*","text"\s*:\s*"([^"]{20,400})"/g);
    for (const m of bodyMatches) {
      const text = m[1].replace(/\\n/g, ' ').replace(/\\u[\dA-Fa-f]{4}/g, '').trim();
      if (text && !adSnippets.includes(text)) adSnippets.push(text);
    }

    // Fallback: extract from page_name + ad_creative_link_titles
    const titleMatches = html.matchAll(/"title"\s*:\s*"([^"]{10,150})"/g);
    for (const m of titleMatches) {
      const text = m[1].replace(/\\n/g, ' ').trim();
      if (text && text.length > 15 && !adSnippets.includes(text)) adSnippets.push(text);
    }

    return { source: 'fb_ads_library', ads: adSnippets.slice(0, 10) };
  } catch (e) {
    return { source: 'fb_ads_library', ads: [], error: e.message };
  }
}

// ── Google Ads Transparency Center public scrape ─────────────────────────────

async function fetchGoogleAdsTransparency(competitor, country) {
  const query = encodeURIComponent(competitor.searchName);
  const url = `https://adstransparency.google.com/advertiser?advertiser=${query}&region=${country}`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,*/*',
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return { source: 'google_ads', ads: [], error: `HTTP ${res.status}` };

    const html = await res.text();
    const adSnippets = [];

    // Google Ads Transparency embeds data in <script> JSON — extract headline text
    const textMatches = html.matchAll(/"text":"([^"]{15,200})"/g);
    for (const m of textMatches) {
      const text = m[1].replace(/\\n/g, ' ').trim();
      if (text && !adSnippets.includes(text)) adSnippets.push(text);
    }

    return { source: 'google_ads', ads: adSnippets.slice(0, 10) };
  } catch (e) {
    return { source: 'google_ads', ads: [], error: e.message };
  }
}

// ── Google News: campaign/marketing coverage via RSS ─────────────────────────

async function fetchMarketingNews(competitor, marketName) {
  const langMap = {
    'Mexico': 'es-419&gl=MX&ceid=MX:es-419',
    'Brazil': 'pt-BR&gl=BR&ceid=BR:pt-BR',
    'Philippines': 'en-PH&gl=PH&ceid=PH:en',
    'Indonesia': 'id&gl=ID&ceid=ID:id'
  };
  const lang = langMap[marketName] || 'en-US&gl=US&ceid=US:en';
  const query = encodeURIComponent(`${competitor.searchName} campaña publicidad promocion OR campaign advertisement promotion`);
  const url = `https://news.google.com/rss/search?q=${query}&hl=${lang}`;

  try {
    const parsed = await rss.parseURL(url);
    return (parsed.items || []).slice(0, 5).map(item => ({
      title: item.title || '',
      url: item.link || '',
      date: item.pubDate ? new Date(item.pubDate).toISOString().split('T')[0] : ''
    }));
  } catch (e) {
    return [];
  }
}

// ── Claude: synthesize ad intelligence ───────────────────────────────────────

const SYSTEM_PROMPT = `You are a marketing intelligence analyst specializing in fintech advertising.
Analyze ad copy snippets and campaign news to extract strategic insights.
Respond only with valid JSON.`;

function buildMarketingPrompt(competitor, marketName, fbAds, googleAds, newsItems) {
  const adSamples = [
    ...fbAds.map(t => `[FB] ${t}`),
    ...googleAds.map(t => `[Google] ${t}`)
  ].slice(0, 15).join('\n');

  const newsSamples = newsItems.map((n, i) => `${i + 1}. ${n.title} (${n.date})`).join('\n');

  return `Competitor: ${competitor.name}
Market: ${marketName}

Ad copy samples collected from public Facebook Ads Library and Google Ads Transparency Center:
${adSamples || '(none found — ad library may be restricted in this region)'}

Recent campaign/marketing news:
${newsSamples || '(none found)'}

Based on the above, extract:
1. Main value propositions being promoted (e.g. "0% interest first 3 months", "no annual fee", "instant approval")
2. Target audience signals (e.g. "first-time credit users", "salaried workers", "students")
3. Promotional mechanics (e.g. cashback %, referral bonus, instalment offers)
4. Dominant messaging theme (one sentence)
5. Channel mix observation (FB heavy, Google heavy, or balanced)

Return JSON:
{
  "valueProps": ["string array of key claims being advertised"],
  "targetAudience": "inferred primary target segment",
  "promotions": ["string array of specific offers or mechanics observed"],
  "messagingTheme": "one sentence dominant theme",
  "channelObservation": "fb_heavy|google_heavy|balanced|unknown",
  "adsFound": ${fbAds.length + googleAds.length},
  "confidence": "high|medium|low"
}

If no meaningful signal found, return minimal JSON with empty arrays and confidence: "low".`;
}

// ── Main per-market logic ────────────────────────────────────────────────────

async function processMarket(marketSlug) {
  const market = MARKETS[marketSlug];
  console.log(`\n=== Marketing Feed: ${market.name} ===`);

  const runId = await createRun(marketSlug, 'weekly_marketing', {});
  const allRows = [];

  for (const competitor of market.competitors) {
    console.log(`  ${competitor.name}...`);

    // Fetch from all 3 sources in parallel
    const [fbResult, googleResult, newsItems] = await Promise.all([
      fetchFbAdsLibrary(competitor, market.country),
      fetchGoogleAdsTransparency(competitor, market.country),
      fetchMarketingNews(competitor, market.name)
    ]);

    const fbAds = fbResult.ads || [];
    const googleAds = googleResult.ads || [];

    console.log(`    FB: ${fbAds.length} snippets | Google: ${googleAds.length} snippets | News: ${newsItems.length}`);

    // Skip Claude if nothing at all was found
    if (!fbAds.length && !googleAds.length && !newsItems.length) {
      console.log(`    No data for ${competitor.name}, skipping`);
      continue;
    }

    let extracted;
    try {
      extracted = await extractStructured(
        SYSTEM_PROMPT,
        buildMarketingPrompt(competitor, market.name, fbAds, googleAds, newsItems)
      );
    } catch (e) {
      console.warn(`    Claude failed: ${e.message}`);
      continue;
    }

    if (!extracted || extracted.confidence === 'low') {
      console.log(`    Low confidence for ${competitor.name}, skipping`);
      continue;
    }

    allRows.push({
      run_id: runId,
      market_slug: marketSlug,
      company_slug: competitor.name.toLowerCase().replace(/\s+/g, '_'),
      value_props: extracted.valueProps || [],
      target_audience: extracted.targetAudience || null,
      promotions: extracted.promotions || [],
      messaging_theme: extracted.messagingTheme || null,
      channel_observation: extracted.channelObservation || 'unknown',
      ads_found_count: extracted.adsFound || 0,
      confidence: extracted.confidence || 'low',
      raw_payload: extracted
    });

    // Polite delay
    await new Promise(r => setTimeout(r, 1500));
  }

  if (!allRows.length) {
    console.log(`  No marketing data extracted for ${market.name}`);
    await markSectionRefreshed(marketSlug, 'marketing');
    return;
  }

  await batchInsert('intel_marketing_signals', allRows);
  console.log(`  Inserted ${allRows.length} marketing signal rows`);

  await logChange(marketSlug, 'marketing', 'modified', allRows.length,
    `Marketing signals: ${allRows.length} competitors updated`, runId);
  await markSectionRefreshed(marketSlug, 'marketing');
  await rebuildSnapshot(marketSlug);
  console.log(`  Snapshot rebuilt for ${marketSlug}`);
}

async function main() {
  const markets = process.env.MARKETS ? process.env.MARKETS.split(',') : ['mx', 'br', 'ph', 'id'];
  let failed = 0;
  for (const slug of markets) {
    try {
      await processMarket(slug);
    } catch (e) {
      console.error(`ERROR processing ${slug}: ${e.message}`);
      failed++;
    }
  }
  if (failed) process.exit(1);
}

main();
