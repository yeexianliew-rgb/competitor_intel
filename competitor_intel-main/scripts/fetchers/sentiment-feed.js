// Sentiment Feed Fetcher — App Store reviews + local forums + Claude analysis
// Sources:
//   1. Apple App Store public reviews (RSS feed per app)
//   2. Google Play Store public reviews (scraped from HTML)
//   3. Reclame Aqui (Brazil consumer complaints — public)
//   4. Reddit (r/mexico, r/brasil, r/Philippines, r/indonesia)
// Cadence: weekly (GitHub Actions cron 0 4 * * 2)

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

// ── Competitor app config per market ─────────────────────────────────────────

const MARKETS = {
  mx: {
    name: 'Mexico',
    subreddit: 'mexico',
    redditSearchTerms: ['fintech credito', 'kueski prestamo', 'nu mexico', 'mercado pago prestamo', 'klar stori tarjeta'],
    apps: [
      { name: 'Nu Mexico',    appleId: '814456780',  playId: 'com.nu.production',    raSlug: null },
      { name: 'Mercado Pago', appleId: '925436649',  playId: 'com.mercadopago.wallet', raSlug: null },
      { name: 'Kueski',       appleId: '1523236041', playId: 'com.kueski.os',         raSlug: null },
      { name: 'Plata',        appleId: '6443932656', playId: 'dif.tech.plata',        raSlug: null },
      { name: 'Klar',         appleId: '1472755899', playId: 'mx.klar.app',           raSlug: null },
      { name: 'Stori',        appleId: '1486481718', playId: 'ai.powerup.stori',      raSlug: null },
    ]
  },
  br: {
    name: 'Brazil',
    subreddit: 'brasil',
    redditSearchTerms: ['nubank reclamação', 'credito digital problema', 'picpay credito', 'c6 bank cartão'],
    apps: [
      { name: 'Nubank',          appleId: '814456780',  playId: 'com.nu.production',        raSlug: 'nubank' },
      { name: 'Mercado Pago BR', appleId: '925436649',  playId: 'com.mercadopago.wallet',   raSlug: 'mercado-pago' },
      { name: 'PicPay',          appleId: '561524792',  playId: 'com.picpay',               raSlug: 'picpay' },
      { name: 'Creditas',        appleId: '1270180256', playId: 'br.com.creditas.mobile',   raSlug: 'creditas' },
      { name: 'C6 Bank',         appleId: '1463463143', playId: 'com.c6bank.app',           raSlug: 'c6-bank' },
      { name: 'PagBank',         appleId: '1186059012', playId: 'br.com.uol.ps.myaccount',  raSlug: 'pagbank' },
      // SParcelado and SCredito are features inside the Shopee BR app — use Shopee IDs,
      // filter reviews to SParcelado/SCredito mentions via the Claude prompt focus field
      { name: 'SParcelado',  appleId: '1481812175', playId: 'com.shopee.br', raSlug: 'shopee',
        promptFocus: 'SParcelado parcelamento BNPL installments credit',
        filterKeywords: ['sparcelado', 's parcelado', 'parcelado shopee', 'shopee parcelado', 'parcelamento', 'bnpl shopee', 'compra parcelada shopee'] },
      { name: 'SCredito',    appleId: '1481812175', playId: 'com.shopee.br', raSlug: 'shopee',
        promptFocus: 'SCrédito SCredito emprestimo pessoal personal loan credit',
        filterKeywords: ['scredito', 'scrédito', 's crédito', 'emprestimo shopee', 'empréstimo shopee', 'credito shopee', 'crédito shopee', 'shopee credito', 'shopee emprestimo'] },
    ]
  },
  ph: {
    name: 'Philippines',
    subreddit: 'Philippines',
    redditSearchTerms: ['gcash loan complaint', 'maya credit review', 'billease problem', 'online lending Philippines'],
    apps: [
      { name: 'GCash',      appleId: '520020791',  playId: 'com.globe.gcash.android', raSlug: null },
      { name: 'Maya',       appleId: '991673877',  playId: 'com.paymaya',             raSlug: null },
      { name: 'BillEase',   appleId: '1484485168', playId: 'ph.billeasev2.mobile',    raSlug: null },
      { name: 'Tonik Bank', appleId: '1541576007', playId: 'com.tonik.mobile',        raSlug: null },
      { name: 'SeaBank PH', appleId: '1592249158', playId: 'ph.seabank.seabank',      raSlug: null },
    ]
  },
  id: {
    name: 'Indonesia',
    subreddit: 'indonesia',
    redditSearchTerms: ['kredivo masalah', 'gopay paylater keluhan', 'pinjaman online ojk', 'dana fintech'],
    apps: [
      { name: 'Kredivo',   appleId: '1255413338', playId: 'com.finaccel.android',    raSlug: null },
      { name: 'Akulaku',   appleId: '1125683586', playId: 'io.silvrr.installment',   raSlug: null },
      { name: 'GoPay',     appleId: '6446321594', playId: 'com.gojek.app',           raSlug: null },
      { name: 'OVO',       appleId: '1142114207', playId: 'ovo.id',                  raSlug: null },
      { name: 'Dana',      appleId: '1437123008', playId: 'id.dana',                 raSlug: null },
      { name: 'SPayLater', appleId: '6455990519', playId: 'com.shopee.id',           raSlug: null },
    ]
  }
};

// ── Apple App Store reviews via RSS ──────────────────────────────────────────
// Apple provides a public Atom/RSS feed for app reviews (no auth required)

async function fetchAppStoreReviews(app, countryCode) {
  // country code must be lowercase 2-letter: mx, br, ph, id
  const cc = countryCode.toLowerCase();
  const url = `https://itunes.apple.com/${cc}/rss/customerreviews/page=1/id=${app.appleId}/sortby=mostrecent/json`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const entries = json?.feed?.entry || [];
    // First entry is the app metadata, skip it
    return entries.slice(1, 21).map(e => ({
      title: e?.title?.label || '',
      body: e?.content?.label || '',
      rating: parseInt(e?.['im:rating']?.label || '3'),
      date: e?.updated?.label ? new Date(e.updated.label).toISOString().split('T')[0] : ''
    }));
  } catch (e) {
    console.warn(`    [AppStore] ${app.name} (${cc}): ${e.message}`);
    return [];
  }
}

// ── Google Play reviews via public web scrape ─────────────────────────────────
// Google Play's public app page embeds recent reviews in its initial HTML payload

async function fetchPlayStoreReviews(app) {
  const url = `https://play.google.com/store/apps/details?id=${app.playId}&hl=en&gl=US&showAllReviews=true`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,*/*'
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    const reviews = [];

    // Google Play embeds review text in AF_initDataCallback JSON blobs
    // Extract review body strings: look for patterns like ["review text",null,null,3
    const reviewMatches = html.matchAll(/\["([^"]{30,500})",null,null,(\d),/g);
    for (const m of reviewMatches) {
      const body = m[1].replace(/\\n/g, ' ').replace(/\\u[\dA-Fa-f]{4}/g, match =>
        String.fromCharCode(parseInt(match.slice(2), 16))
      ).trim();
      const rating = parseInt(m[2]);
      if (body && rating >= 1 && rating <= 5) {
        reviews.push({ title: '', body, rating, date: '' });
      }
    }

    return reviews.slice(0, 20);
  } catch (e) {
    console.warn(`    [PlayStore] ${app.name}: ${e.message}`);
    return [];
  }
}

// ── Reclame Aqui (Brazil) ─────────────────────────────────────────────────────
// Public complaint page — no login required for browsing

async function fetchReclameAqui(app) {
  if (!app.raSlug) return [];

  const url = `https://www.reclameaqui.com.br/empresa/${app.raSlug}/lista-reclamacoes/`;

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,*/*',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
      },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();

    const complaints = [];

    // Reclame Aqui embeds complaint titles and snippets in JSON-LD or page HTML
    // Extract complaint title text from <h4> or data attributes
    const titleMatches = html.matchAll(/<h4[^>]*class="[^"]*complaint[^"]*"[^>]*>([^<]{20,200})<\/h4>/gi);
    for (const m of titleMatches) {
      complaints.push({ title: m[1].trim(), body: '', rating: 2, date: '', source: 'reclame_aqui' });
    }

    // Also try structured data pattern: "title":"...", "description":"..."
    const jsonMatches = html.matchAll(/"title":"([^"]{20,200})","description":"([^"]{20,400})"/g);
    for (const m of jsonMatches) {
      complaints.push({
        title: m[1].replace(/\\n/g, ' ').trim(),
        body: m[2].replace(/\\n/g, ' ').trim(),
        rating: 2,
        date: '',
        source: 'reclame_aqui'
      });
    }

    return complaints.slice(0, 15);
  } catch (e) {
    console.warn(`    [ReclameAqui] ${app.name}: ${e.message}`);
    return [];
  }
}

// ── Keyword filter for embedded-feature apps (SParcelado, SCredito) ──────────
// When app.filterKeywords is set, keep only reviews that mention at least one keyword.
// This prevents generic Shopee shopping reviews from polluting the credit sentiment.

function filterByKeywords(reviews, keywords) {
  if (!keywords || !keywords.length) return reviews;
  const lower = keywords.map(k => k.toLowerCase());
  return reviews.filter(r => {
    const text = `${r.title} ${r.body}`.toLowerCase();
    return lower.some(k => text.includes(k));
  });
}

// ── Google News: user complaints / reviews coverage via RSS (CI-safe fallback) ─
// Used when direct App Store / Play Store scraping is blocked (common on CI IPs)

async function fetchReviewNewsFallback(app, marketName) {
  const langMap = {
    'Mexico':      'es-419&gl=MX&ceid=MX:es-419',
    'Brazil':      'pt-BR&gl=BR&ceid=BR:pt-BR',
    'Philippines': 'en-PH&gl=PH&ceid=PH:en',
    'Indonesia':   'id&gl=ID&ceid=ID:id'
  };
  const lang = langMap[marketName] || 'en-US&gl=US&ceid=US:en';
  const query = encodeURIComponent(`${app.name} review complaint reclamacao keluhan problema`);
  const url = `https://news.google.com/rss/search?q=${query}&hl=${lang}`;

  try {
    const parsed = await rss.parseURL(url);
    return (parsed.items || []).slice(0, 10).map(item => ({
      title: item.title || '',
      body: item.contentSnippet || item.title || '',
      rating: 3,
      date: item.pubDate ? new Date(item.pubDate).toISOString().split('T')[0] : '',
      source: 'google_news'
    }));
  } catch (e) {
    return [];
  }
}

// ── Reddit search via RSS ─────────────────────────────────────────────────────

async function fetchRedditSentiment(market) {
  const posts = [];

  for (const term of market.redditSearchTerms) {
    const query = encodeURIComponent(term);
    const url = `https://www.reddit.com/r/${market.subreddit}/search.json?q=${query}&sort=new&limit=10&restrict_sr=1`;

    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'competitor-intel-bot/1.0 (for research purposes)',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(12000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const children = json?.data?.children || [];
      for (const child of children) {
        const post = child?.data || {};
        if (post.selftext && post.selftext.length > 30) {
          posts.push({
            title: post.title || '',
            body: (post.selftext || '').slice(0, 500),
            score: post.score || 0,
            date: post.created_utc ? new Date(post.created_utc * 1000).toISOString().split('T')[0] : '',
            source: `reddit.com/r/${market.subreddit}`
          });
        }
      }
    } catch (e) {
      console.warn(`    [Reddit r/${market.subreddit}] "${term}": ${e.message}`);
    }

    await new Promise(r => setTimeout(r, 500));
  }

  return posts.slice(0, 20);
}

// ── Claude: sentiment analysis ────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a consumer insights analyst specializing in fintech apps in emerging markets.
Analyze user reviews and complaints to extract sentiment and recurring pain points.
Respond only with valid JSON.`;

function buildSentimentPrompt(app, marketName, reviews) {
  const reviewBlock = reviews.slice(0, 25).map((r, i) =>
    `[${i + 1}] Rating: ${r.rating}/5 | ${r.source || 'app_store'}\nTitle: ${r.title}\n${r.body}`
  ).join('\n\n---\n\n');

  const focusNote = app.promptFocus
    ? `\nFOCUS: This is for the "${app.name}" feature specifically. Only extract complaints and praises that mention or relate to: ${app.promptFocus}. Ignore reviews about unrelated app features.`
    : '';

  return `App: ${app.name}
Market: ${marketName}
Review count: ${reviews.length}${focusNote}

Analyze these user reviews and complaints:

${reviewBlock}

Extract:
1. Overall sentiment (weighted average across reviews)
2. Top 5 recurring complaints — in English, concise (max 12 words each)
3. Top 5 recurring praise points — in English, concise (max 12 words each)
4. Most common pain point category (credit_approval|repayment|app_ux|customer_service|fees|fraud|other)
5. NPS signal: are users recommending or warning others?
6. Pick the single most representative negative quote and single most representative positive quote.
   Translate both to English if they are in another language. Keep them short (max 30 words).

Return JSON:
{
  "overallSentiment": "positive|mixed|negative",
  "sentimentScore": 0.0,
  "topComplaints": ["string x5"],
  "topPraise": ["string x5"],
  "topPainCategory": "credit_approval|repayment|app_ux|customer_service|fees|fraud|other",
  "npsSignal": "recommending|neutral|warning",
  "reviewCount": ${reviews.length},
  "representativeBadReview": "English translation, max 30 words, or null if no negative reviews",
  "representativeGoodReview": "English translation, max 30 words, or null if no positive reviews"
}

IMPORTANT: sentimentScore must be a decimal between 0.0 and 1.0 (not 0–5).
Example: a moderately positive app = 0.65, a mostly negative app = 0.25.`;
}

// ── Process one app ────────────────────────────────────────────────────────────

async function processApp(marketSlug, marketName, countryCode, app, runId) {
  console.log(`    ${app.name}...`);

  const [appleReviews, playReviews, raComplaints] = await Promise.all([
    fetchAppStoreReviews(app, countryCode),
    fetchPlayStoreReviews(app),
    fetchReclameAqui(app)
  ]);

  let allReviews = [
    ...appleReviews.map(r => ({ ...r, source: 'apple_app_store' })),
    ...playReviews.map(r => ({ ...r, source: 'google_play' })),
    ...raComplaints
  ];

  console.log(`      Apple: ${appleReviews.length} | Play: ${playReviews.length} | ReclameAqui: ${raComplaints.length}`);

  // For embedded-feature apps (SParcelado, SCredito): filter to only reviews
  // that explicitly mention the feature name — drops generic Shopee shopping reviews
  allReviews = filterByKeywords(allReviews, app.filterKeywords);
  if (app.filterKeywords) {
    console.log(`      [keyword filter] kept ${allReviews.length} reviews mentioning ${app.name}`);
  }

  // CI fallback: if direct scraping blocked (or keyword filter left nothing), use Google News.
  // Google News is already searched by feature name so bypass keyword filter.
  if (!allReviews.length) {
    const newsReviews = await fetchReviewNewsFallback(app, marketName);
    console.log(`      [fallback] Google News reviews: ${newsReviews.length}`);
    allReviews = newsReviews; // no keyword filter — search already targets feature name
  }

  if (!allReviews.length) return null;

  let extracted;
  try {
    extracted = await extractStructured(SYSTEM_PROMPT, buildSentimentPrompt(app, marketName, allReviews));
  } catch (e) {
    console.warn(`      Claude failed for ${app.name}: ${e.message}`);
    return null;
  }

  // Normalize: Claude sometimes returns 0–5 instead of 0–1 despite the prompt
  let rawScore = parseFloat(extracted.sentimentScore) || 0;
  if (rawScore > 1.0) rawScore = rawScore / 5; // convert 0–5 → 0–1
  const scoreNum = Math.min(1.0, Math.max(0.0, rawScore));
  const scoreTier = scoreNum >= 0.6 ? 'good' : scoreNum >= 0.3 ? 'mixed' : 'poor';

  return {
    run_id: runId,
    market_slug: marketSlug,
    item_id: `${marketSlug}_${app.name.toLowerCase().replace(/\s+/g, '_')}_${runId.slice(0, 8)}`,
    company_slug: app.name.toLowerCase().replace(/\s+/g, '_'),
    score: `${(scoreNum * 5).toFixed(1)} / 5`,
    score_tier: scoreTier,
    sources: allReviews.some(r => r.source === 'google_news')
      ? ['Google News', 'Reddit']
      : ['Apple App Store', 'Google Play', ...(app.raSlug ? ['Reclame Aqui'] : [])],
    complaints: extracted.topComplaints || [],
    praises: extracted.topPraise || [],
    quotes: [
      ...(extracted.representativeBadReview ? [`"${extracted.representativeBadReview}"`] : []),
      ...(extracted.representativeGoodReview ? [`"${extracted.representativeGoodReview}"`] : [])
    ],
    raw_payload: extracted
  };
}

// ── Main per-market logic ─────────────────────────────────────────────────────

async function processMarket(marketSlug) {
  const market = MARKETS[marketSlug];
  const countryCode = marketSlug.toUpperCase();
  console.log(`\n=== Sentiment Feed: ${market.name} ===`);

  // Fetch Reddit posts for this market
  console.log(`  Fetching Reddit r/${market.subreddit}...`);
  const redditPosts = await fetchRedditSentiment(market);
  console.log(`  Reddit: ${redditPosts.length} posts`);

  const runId = await createRun(marketSlug, 'weekly_sentiment', {});
  const appRows = [];

  for (const app of market.apps) {
    const row = await processApp(marketSlug, market.name, countryCode, app, runId);
    if (row) appRows.push(row);
    await new Promise(r => setTimeout(r, 2000));
  }

  // Process Reddit as market-level sentiment signal
  if (redditPosts.length) {
    let redditExtracted;
    try {
      const redditPrompt = `Market: ${market.name}
These are Reddit posts from r/${market.subreddit} about fintech apps and consumer credit.

${redditPosts.map((p, i) => `[${i + 1}] Score: ${p.score} | ${p.date}\nTitle: ${p.title}\n${p.body}`).join('\n\n---\n\n')}

Extract overall consumer sentiment toward digital lending/credit in this market.
Identify the top 3 concerns or themes being discussed.

Return JSON:
{
  "overallSentiment": "positive|mixed|negative",
  "sentimentScore": 0.0,
  "topComplaints": ["theme1", "theme2", "theme3"],
  "topPraise": [],
  "topPainCategory": "credit_approval|repayment|app_ux|customer_service|fees|fraud|other",
  "npsSignal": "recommending|neutral|warning",
  "reviewCount": ${redditPosts.length},
  "representativeBadReview": "short quote",
  "representativeGoodReview": null
}`;

      redditExtracted = await extractStructured(SYSTEM_PROMPT, redditPrompt);
      if (redditExtracted) {
        const rScore = redditExtracted.sentimentScore || 0;
        const rTier = rScore >= 0.6 ? 'good' : rScore >= 0.3 ? 'mixed' : 'poor';
        appRows.push({
          run_id: runId,
          market_slug: marketSlug,
          item_id: `${marketSlug}_reddit_${market.subreddit}_${runId.slice(0, 8)}`,
          company_slug: `_reddit_${market.subreddit}`,
          score: `${(rScore * 5).toFixed(1)} / 5`,
          score_tier: rTier,
          sources: [`reddit.com/r/${market.subreddit}`],
          complaints: redditExtracted.topComplaints || [],
          praises: [],
          quotes: redditExtracted.representativeBadReview
            ? [`"${redditExtracted.representativeBadReview}"`]
            : [],
          raw_payload: redditExtracted
        });
      }
    } catch (e) {
      console.warn(`  Reddit Claude analysis failed: ${e.message}`);
    }
  }

  if (!appRows.length) {
    console.log(`  No sentiment data for ${market.name}`);
    await markSectionRefreshed(marketSlug, 'sentiment');
    return;
  }

  await batchInsert('intel_sentiment_items', appRows);
  console.log(`  Inserted ${appRows.length} sentiment rows`);

  await logChange(marketSlug, 'sentiment', 'modified', appRows.length,
    `Sentiment update: ${appRows.length} apps scored`, runId);
  await markSectionRefreshed(marketSlug, 'sentiment');
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
