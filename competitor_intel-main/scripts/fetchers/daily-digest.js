// Daily Digest Fetcher
// Fetches RSS/news from public sources per market, extracts structured
// competitive intelligence via Claude, deduplicates, writes to Supabase.
// Cadence: daily (GitHub Actions cron 0 2 * * *)

import Parser from 'rss-parser';
import { extractStructured } from '../lib/claude.js';
import { supabase, createRun, markSectionRefreshed, rebuildSnapshot, logChange, batchInsert, getRecentHeadlines } from '../lib/supabase.js';
import { randomUUID, createHash } from 'crypto';

const rss = new Parser({ timeout: 15000 });

// ── Source configuration per market ─────────────────────────────────────────

const SOURCES = {
  mx: {
    name: 'Mexico',
    competitors: ['Nu', 'Plata', 'Kueski', 'Mercado Pago', 'Klar', 'Stori', 'DiDi', 'Baubap', 'Tala', 'Ualá', 'RappiCard'],
    feeds: [
      { url: 'https://news.google.com/rss/search?q=fintech+credito+mexico&hl=es-419&gl=MX&ceid=MX:es-419', label: 'Google News MX Fintech' },
      { url: 'https://news.google.com/rss/search?q=nubank+mexico+OR+kueski+OR+mercado+pago+mexico&hl=es-419&gl=MX&ceid=MX:es-419', label: 'Google News MX Competitors' },
      { url: 'https://www.cnbv.gob.mx/Paginas/rss.aspx', label: 'CNBV' },
    ]
  },
  br: {
    name: 'Brazil',
    competitors: ['Nubank', 'Mercado Crédito', 'PicPay', 'Creditas', 'C6 Bank', 'PagBank', 'Neon'],
    feeds: [
      { url: 'https://news.google.com/rss/search?q=nubank+OR+picpay+OR+creditas+fintech+brasil&hl=pt-BR&gl=BR&ceid=BR:pt-BR', label: 'Google News BR Fintech' },
      { url: 'https://www.bcb.gov.br/api/feed/pt-br/noticias/rss', label: 'Banco Central do Brasil' },
    ]
  },
  ph: {
    name: 'Philippines',
    competitors: ['GCash', 'Maya', 'BillEase', 'Tonik Bank', 'SeaBank', 'Tala', 'Cashalo'],
    feeds: [
      { url: 'https://news.google.com/rss/search?q=gcash+OR+maya+fintech+philippines&hl=en-PH&gl=PH&ceid=PH:en', label: 'Google News PH Fintech' },
      { url: 'https://www.bsp.gov.ph/feeds/pressreleases.xml', label: 'BSP Press Releases' },
    ]
  },
  id: {
    name: 'Indonesia',
    competitors: ['GoPay', 'OVO', 'Dana', 'Kredivo', 'Akulaku', 'SPayLater', 'JULO'],
    feeds: [
      { url: 'https://news.google.com/rss/search?q=gopay+OR+ovo+OR+kredivo+fintech+indonesia&hl=id&gl=ID&ceid=ID:id', label: 'Google News ID Fintech' },
      { url: 'https://www.ojk.go.id/id/berita-dan-kegiatan/siaran-pers/rss', label: 'OJK Press Releases' },
    ]
  }
};

// ── Claude prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a fintech competitive intelligence analyst specializing in consumer credit and digital payments.
Extract structured intelligence from news articles. Be precise, factual, and concise.
Only respond with valid JSON — no prose, no markdown outside the JSON block.`;

function buildUserPrompt(market, articles) {
  return `Today's date: ${new Date().toISOString().split('T')[0]}. Market: ${market.name}.

Extract competitive intelligence from these articles. Only include items relevant to fintech, consumer credit, digital payments, or financial regulation.
Focus on: product launches, pricing changes, regulatory actions, fundraising, partnerships, marketing campaigns, app updates.
Known competitors: ${market.competitors.join(', ')}.

For competitor field: use the closest match from the competitors list, or null if not competitor-specific.
For category: use one of: product, regulatory, funding, marketing, partnership, macro.

Return this exact JSON structure:
{
  "newsItems": [
    {
      "date": "YYYY-MM-DD",
      "category": "product|regulatory|funding|marketing|partnership|macro",
      "competitor": "competitor name or null",
      "headline": "concise headline in English",
      "oneLineSummary": "one sentence explaining significance for a fintech competitor",
      "sourceUrl": "original article URL"
    }
  ]
}

Articles (title | url | published):
${articles.map((a, i) => `${i + 1}. ${a.title} | ${a.url} | ${a.date}`).join('\n')}`;
}

// ── Fetch RSS feeds ──────────────────────────────────────────────────────────

async function fetchFeed(feed) {
  try {
    const parsed = await rss.parseURL(feed.url);
    return (parsed.items || []).slice(0, 30).map(item => ({
      title: item.title || '',
      url: item.link || item.guid || '',
      date: item.pubDate ? new Date(item.pubDate).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]
    }));
  } catch (e) {
    console.warn(`  [warn] Feed fetch failed (${feed.label}): ${e.message}`);
    return [];
  }
}

// ── Deduplication ────────────────────────────────────────────────────────────

function itemId(marketSlug, headline, url) {
  const key = `${marketSlug}|${headline}|${url}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

function isDuplicate(item, existing) {
  // Exact URL match
  if (existing.some(e => e.source_url && e.source_url === item.sourceUrl)) return true;
  // Fuzzy headline match (>80% word overlap)
  const words = h => new Set((h || '').toLowerCase().split(/\W+/).filter(w => w.length > 4));
  const newWords = words(item.headline);
  return existing.some(e => {
    const exWords = words(e.headline);
    const intersection = [...newWords].filter(w => exWords.has(w)).length;
    return intersection / Math.max(newWords.size, 1) > 0.8;
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function processMarket(marketSlug) {
  const market = SOURCES[marketSlug];
  console.log(`\n=== Daily Digest: ${market.name} ===`);

  // 1. Fetch all RSS feeds
  const allArticles = [];
  for (const feed of market.feeds) {
    const items = await fetchFeed(feed);
    console.log(`  ${feed.label}: ${items.length} articles`);
    allArticles.push(...items);
  }

  if (!allArticles.length) {
    console.log('  No articles fetched, skipping.');
    return;
  }

  // Deduplicate articles by URL before sending to Claude
  const seen = new Set();
  const uniqueArticles = allArticles.filter(a => {
    if (!a.url || seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });

  // 2. Send to Claude
  console.log(`  Sending ${uniqueArticles.length} articles to Claude...`);
  let extracted;
  try {
    extracted = await extractStructured(
      SYSTEM_PROMPT,
      buildUserPrompt(market, uniqueArticles)
    );
  } catch (e) {
    console.error(`  Claude extraction failed: ${e.message}`);
    return;
  }

  const items = extracted.newsItems || [];
  console.log(`  Claude extracted ${items.length} items`);

  if (!items.length) return;

  // 3. Deduplicate against existing DB entries
  const existing = await getRecentHeadlines(marketSlug, 30);
  const newItems = items.filter(item => !isDuplicate(item, existing));
  console.log(`  ${newItems.length} new (${items.length - newItems.length} duplicates skipped)`);

  if (!newItems.length) {
    await markSectionRefreshed(marketSlug, 'digest');
    return;
  }

  // 4. Create ingestion run
  const runId = await createRun(marketSlug, 'daily_digest', { newsItems: newItems.length });

  // 5. Build rows
  const rows = newItems.map(item => ({
    run_id: runId,
    market_slug: marketSlug,
    item_id: itemId(marketSlug, item.headline, item.sourceUrl),
    item_date: item.date,
    category: item.category || 'macro',
    company_slug: item.competitor || null,
    headline: item.headline,
    one_line_summary: item.oneLineSummary,
    source_url: item.sourceUrl || null,
    raw_payload: item
  }));

  // 6. Insert
  await batchInsert('intel_news_items', rows);
  console.log(`  Inserted ${rows.length} news items`);

  // 7. Log change
  await logChange(marketSlug, 'digest', 'added', rows.length,
    `Daily digest: ${rows.length} new items`, runId);

  // 8. Mark section refreshed + rebuild snapshot
  await markSectionRefreshed(marketSlug, 'digest');
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
