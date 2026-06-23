// Business Stats Fetcher — Quarterly scraper for competitor KPIs
// Scrapes investor pages, press releases, and public disclosures via Google News
// then extracts structured metrics via Claude.
// Cadence: quarterly (GitHub Actions cron 0 7 1 1,4,7,10 *)

import fetch from 'node-fetch';
import Parser from 'rss-parser';
import { extractStructured } from '../lib/claude.js';
import { createRun, markSectionRefreshed, rebuildSnapshot, logChange, batchInsert } from '../lib/supabase.js';

const rss = new Parser({
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  }
});

// ── Competitor config per market ─────────────────────────────────────────────

const MARKETS = {
  mx: {
    name: 'Mexico',
    competitors: [
      { name: 'Nu Mexico',     searchQuery: 'Nu Mexico nubank usuarios clientes credito resultados',   ticker: null },
      { name: 'Mercado Pago',  searchQuery: 'Mercado Pago Mexico credito resultados financieros',       ticker: 'MELI' },
      { name: 'Kueski',        searchQuery: 'Kueski Mexico financiamiento inversión usuarios métricas',  ticker: null },
      { name: 'Plata',         searchQuery: 'Banco Plata Mexico clientes credito expansión',            ticker: null },
      { name: 'Klar',          searchQuery: 'Klar Mexico clientes tarjeta credito métricas',            ticker: null },
      { name: 'Stori',         searchQuery: 'Stori Mexico usuarios credito crecimiento financiamiento',  ticker: null },
    ]
  },
  br: {
    name: 'Brazil',
    competitors: [
      { name: 'Nubank',          searchQuery: 'Nubank resultados clientes receita lucro carteira credito',    ticker: 'NU' },
      { name: 'Mercado Crédito', searchQuery: 'Mercado Credito carteira credito inadimplencia resultado',     ticker: 'MELI' },
      { name: 'PicPay',          searchQuery: 'PicPay usuários receita crédito resultado trimestral',         ticker: null },
      { name: 'C6 Bank',         searchQuery: 'C6 Bank clientes carteira resultado financeiro',               ticker: null },
      { name: 'Creditas',        searchQuery: 'Creditas carteira credito funding resultado investimento',     ticker: null },
      { name: 'PagBank',         searchQuery: 'PagBank PagSeguro resultado receita lucro usuários',          ticker: 'PAGS' },
    ]
  },
  ph: {
    name: 'Philippines',
    competitors: [
      { name: 'GCash',       searchQuery: 'GCash users revenue loans credit metrics results Philippines', ticker: null },
      { name: 'Maya',        searchQuery: 'Maya bank Philippines users loans credit results quarterly',    ticker: null },
      { name: 'BillEase',    searchQuery: 'BillEase Philippines BNPL users portfolio results',            ticker: null },
      { name: 'Tonik Bank',  searchQuery: 'Tonik bank Philippines deposits loans customers results',      ticker: null },
      { name: 'SeaBank PH',  searchQuery: 'SeaBank Philippines users loans Sea Limited results',         ticker: 'SE' },
    ]
  },
  id: {
    name: 'Indonesia',
    competitors: [
      { name: 'Kredivo',   searchQuery: 'Kredivo Indonesia pengguna portofolio kredit hasil pendanaan',    ticker: null },
      { name: 'Akulaku',   searchQuery: 'Akulaku Indonesia pengguna pinjaman hasil keuangan',              ticker: null },
      { name: 'GoPay',     searchQuery: 'GoPay Gojek Indonesia pengguna transaksi kredit hasil',           ticker: 'GOTO' },
      { name: 'OVO',       searchQuery: 'OVO Indonesia pengguna transaksi fintech hasil',                  ticker: null },
      { name: 'Dana',      searchQuery: 'Dana dompet digital Indonesia pengguna hasil keuangan',           ticker: null },
      { name: 'Bank Jago', searchQuery: 'Bank Jago nasabah kredit Dana DPK hasil keuangan triwulan',      ticker: 'ARTO.JK' },
    ]
  }
};

// ── Fetch page text ───────────────────────────────────────────────────────────

async function fetchPageText(url, timeoutMs = 15000) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html,application/xhtml+xml,*/*'
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{3,}/g, '\n')
      .trim()
      .slice(0, 4000);
  } catch (e) {
    return '';
  }
}

// ── Fetch recent news articles about a competitor ────────────────────────────

async function fetchCompetitorArticles(competitor, marketName) {
  const articles = [];

  // Google News RSS search
  const query = encodeURIComponent(competitor.searchQuery);
  const lang = marketName === 'Brazil' ? 'pt-BR&gl=BR&ceid=BR:pt-BR' :
               marketName === 'Mexico' ? 'es-419&gl=MX&ceid=MX:es-419' :
               marketName === 'Philippines' ? 'en-PH&gl=PH&ceid=PH:en' :
               'id&gl=ID&ceid=ID:id';
  const newsUrl = `https://news.google.com/rss/search?q=${query}&hl=${lang}`;

  try {
    const parsed = await rss.parseURL(newsUrl);
    const items = (parsed.items || []).slice(0, 5);
    for (const item of items) {
      const url = item.link || item.guid || '';
      const text = url ? await fetchPageText(url) : '';
      articles.push({
        title: item.title || '',
        url,
        date: item.pubDate ? new Date(item.pubDate).toISOString().split('T')[0] : '',
        text: text.slice(0, 1500)
      });
    }
  } catch (e) {
    console.warn(`  [RSS] ${competitor.name}: ${e.message}`);
  }

  // If publicly traded, also try investor relations page via Google News
  if (competitor.ticker) {
    const irQuery = encodeURIComponent(`${competitor.ticker} earnings revenue customers quarterly results`);
    const irUrl = `https://news.google.com/rss/search?q=${irQuery}&hl=en-US&gl=US&ceid=US:en`;
    try {
      const parsed = await rss.parseURL(irUrl);
      const items = (parsed.items || []).slice(0, 3);
      for (const item of items) {
        const url = item.link || '';
        const text = url ? await fetchPageText(url) : '';
        articles.push({
          title: item.title || '',
          url,
          date: item.pubDate ? new Date(item.pubDate).toISOString().split('T')[0] : '',
          text: text.slice(0, 1500)
        });
      }
    } catch (e) {
      console.warn(`  [IR] ${competitor.name} (${competitor.ticker}): ${e.message}`);
    }
  }

  return articles;
}

// ── Claude extraction ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a fintech financial analyst. Extract publicly disclosed business metrics from press releases, earnings summaries, and news articles.
Only extract figures that are explicitly stated in the source text — do not estimate or infer.
Respond only with valid JSON.`;

function buildExtractionPrompt(competitor, marketName, articles) {
  const articleBlock = articles.map((a, i) =>
    `[${i + 1}] ${a.title} (${a.date})\nURL: ${a.url}\n${a.text}`
  ).join('\n\n---\n\n');

  return `Company: ${competitor.name}
Market: ${marketName}
Quarter context: Extract the most recently disclosed quarterly or annual figures from the articles below.

Extract whatever is available from these categories:
- customers / active users (number + period)
- credit portfolio / loan book size (currency + period)
- revenue (currency + period)
- net income / profit (currency + period)
- NPL ratio / default rate (% + period)
- funding raised (currency + round type + date)
- growth rate (MoM or YoY for any metric above)
- market share or ranking if explicitly stated

Return JSON:
{
  "stats": [
    {
      "metric": "metric name (e.g. Active Users, Credit Portfolio, Revenue, NPL Rate)",
      "value": "value with units (e.g. 5.2M, R$12B, 3.1%)",
      "period": "period (e.g. Q1 2025, FY2024, as of Mar 2025)",
      "source": "article title or URL",
      "confidence": "high|medium|low"
    }
  ],
  "keyHighlight": "one sentence summary of the most significant recent development"
}

If no reliable figures found, return { "stats": [], "keyHighlight": null }.

Articles:
${articleBlock}`;
}

// ── Process one competitor ────────────────────────────────────────────────────

async function processCompetitor(marketSlug, marketName, competitor, runId) {
  console.log(`  Processing ${competitor.name}...`);

  const articles = await fetchCompetitorArticles(competitor, marketName);
  if (!articles.length) {
    console.log(`    No articles found for ${competitor.name}`);
    return [];
  }

  let extracted;
  try {
    extracted = await extractStructured(SYSTEM_PROMPT, buildExtractionPrompt(competitor, marketName, articles));
  } catch (e) {
    console.warn(`    Claude failed for ${competitor.name}: ${e.message}`);
    return [];
  }

  const stats = extracted.stats || [];
  const keyHighlight = extracted.keyHighlight || null;

  // Filter to high/medium confidence only
  const reliable = stats.filter(s => s.confidence !== 'low');
  console.log(`    ${reliable.length} stats extracted (${stats.length - reliable.length} low-confidence dropped)`);

  if (!reliable.length) return [];

  // Map dynamic metric rows into the fixed intel_business_stats column shape
  const pick = (keywords) => {
    const m = reliable.find(s =>
      keywords.some(k => (s.metric || '').toLowerCase().includes(k))
    );
    return m ? `${m.value}${m.period ? ` (${m.period})` : ''}` : null;
  };

  const companySlug = competitor.name.toLowerCase().replace(/\s+/g, '_');

  return [{
    run_id: runId,
    market_slug: marketSlug,
    item_id: `${marketSlug}_${companySlug}_${runId.slice(0, 8)}`,
    company_slug: companySlug,
    users:            pick(['user', 'customer', 'active']),
    loan_os:          pick(['portfolio', 'loan book', 'loan os', 'carteira', 'portofolio']),
    revenue:          pick(['revenue', 'receita', 'pendapatan']),
    funding:          pick(['funding', 'raised', 'round', 'facility', 'investimento']),
    funding_advantage: keyHighlight,
    est_cac:          pick(['cac', 'acquisition cost']),
    est_promo_burn:   null,
    npl:              pick(['npl', 'default', 'inadimplencia', 'npp']),
    monetisation:     pick(['revenue', 'income', 'profit', 'lucro']),
    distribution:     null,
    ue_quality:       null,
    ue_confidence:    null,
    threat_level:     null,
    threat_why:       null,
    implication:      keyHighlight,
    raw_payload:      { metrics: reliable, keyHighlight, source: articles[0]?.url || null }
  }];
}

// ── Main per-market logic ────────────────────────────────────────────────────

async function processMarket(marketSlug) {
  const market = MARKETS[marketSlug];
  console.log(`\n=== Business Stats: ${market.name} ===`);

  const runId = await createRun(marketSlug, 'quarterly_business_stats', {});
  const allRows = [];

  for (const competitor of market.competitors) {
    const rows = await processCompetitor(marketSlug, market.name, competitor, runId);
    allRows.push(...rows);
    // Polite delay between competitors to avoid rate limits
    await new Promise(r => setTimeout(r, 2000));
  }

  if (!allRows.length) {
    console.log(`  No stats extracted for ${market.name}`);
    await markSectionRefreshed(marketSlug, 'businessStats');
    return;
  }

  await batchInsert('intel_business_stats', allRows);
  console.log(`  Inserted ${allRows.length} stat rows`);

  await logChange(marketSlug, 'businessStats', 'modified', allRows.length,
    `Quarterly business stats: ${allRows.length} metrics updated`, runId);
  await markSectionRefreshed(marketSlug, 'businessStats');
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
