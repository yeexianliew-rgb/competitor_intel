// Daily Digest Fetcher
// Fetches RSS/news from public sources per market, extracts structured
// competitive intelligence via Claude, deduplicates, writes to Supabase.
// Cadence: daily (GitHub Actions cron 0 2 * * *)

import Parser from 'rss-parser';
import { extractStructured } from '../lib/claude.js';
import { createRun, markSectionRefreshed, rebuildSnapshot, logChange, batchInsert, getRecentHeadlines } from '../lib/supabase.js';
import { createHash } from 'crypto';

const rss = new Parser({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Accept': 'application/rss+xml, application/xml, text/xml, */*'
  }
});

// ── Source configuration per market ─────────────────────────────────────────

const SOURCES = {
  mx: {
    name: 'Mexico',
    competitors: ['Nu', 'Plata', 'Kueski', 'Mercado Pago', 'Klar', 'Stori', 'DiDi', 'Baubap', 'Tala', 'Ualá', 'RappiCard', 'Spin by OXXO', 'Revolut', 'TikTok', 'Aplazo'],
    feeds: [
      // Local language (Spanish)
      { url: 'https://news.google.com/rss/search?q=fintech+credito+prestamo+mexico&hl=es-419&gl=MX&ceid=MX:es-419', label: 'MX Fintech (ES)' },
      { url: 'https://news.google.com/rss/search?q=nubank+mexico+OR+plata+banco+OR+kueski+OR+mercado+pago+mexico+OR+klar+OR+stori&hl=es-419&gl=MX&ceid=MX:es-419', label: 'MX Competitors (ES)' },
      { url: 'https://news.google.com/rss/search?q=CNBV+regulacion+fintech+OR+banxico+tasa+OR+open+finance+mexico&hl=es-419&gl=MX&ceid=MX:es-419', label: 'MX Regulation (ES)' },
      { url: 'https://news.google.com/rss/search?q=CNBV+site:cnbv.gob.mx&hl=es-419&gl=MX&ceid=MX:es-419', label: 'CNBV Official' },
      // English language (international + specialist)
      { url: 'https://news.google.com/rss/search?q=fintech+credit+lending+mexico&hl=en-US&gl=US&ceid=US:en', label: 'MX Fintech (EN)' },
      { url: 'https://news.google.com/rss/search?q=nubank+mexico+OR+kueski+OR+%22mercado+pago%22+mexico+credit&hl=en-US&gl=US&ceid=US:en', label: 'MX Competitors (EN)' },
      { url: 'https://news.google.com/rss/search?q=CNBV+OR+Banxico+regulation+OR+%22open+finance%22+mexico&hl=en-US&gl=US&ceid=US:en', label: 'MX Regulation (EN)' },
      // Global financial & fintech specialist press
      { url: 'https://news.google.com/rss/search?q=site:ft.com+mexico+fintech+OR+credit&hl=en-US&gl=US&ceid=US:en', label: 'FT Mexico' },
      { url: 'https://news.google.com/rss/search?q=site:reuters.com+mexico+fintech+OR+lending+OR+credit&hl=en-US&gl=US&ceid=US:en', label: 'Reuters Mexico' },
      { url: 'https://news.google.com/rss/search?q=site:techcrunch.com+mexico+fintech+OR+credit+OR+lending&hl=en-US&gl=US&ceid=US:en', label: 'TechCrunch Mexico' },
      { url: 'https://news.google.com/rss/search?q=site:finextra.com+mexico+OR+latam+fintech&hl=en-US&gl=US&ceid=US:en', label: 'Finextra Mexico' },
      { url: 'https://news.google.com/rss/search?q=site:fintechfutures.com+mexico+OR+latam&hl=en-US&gl=US&ceid=US:en', label: 'FintechFutures Mexico' },
    ],
    include: `
INCLUDE only events from the last 24 hours that meet at least one criterion:

Regulation & Enforcement:
- CNBV licence grants, revocations, suspensions, or approvals
- New fintech, consumer lending, or open finance regulations
- Regulatory investigations, fines, or enforcement actions against lenders or fintechs

Consumer Credit Competition:
- Credit card, BNPL, personal loan, or revolving credit product launches
- Pricing, fee, interest rate, credit limit, tenor, or underwriting changes
- Merchant financing or embedded credit launches
- Major partnerships expanding credit distribution

Funding & Corporate Activity:
- Fundraising, M&A, strategic investments
- Portfolio acquisitions or sales, debt facilities, securitization transactions

Payments & Ecosystem:
- Remittance corridor developments (US ↔ MX) affecting digital wallets or credit
- Open finance and interoperability updates

Repayment Risk Signals:
- Government subsidy or welfare changes affecting household cash flow
- Tax or income policy changes
- Consumer debt relief programs or debt restructuring initiatives
- Collection or bankruptcy regulation changes
- Major layoffs, unemployment developments, or economic shocks`,
    exclude: `
EXCLUDE:
- Generic marketing campaigns, sponsorships, executive interviews without announcements
- General Mexican politics unless it directly impacts financial regulation, lending, or repayments
- Crypto/DeFi unless linked to a licensed fintech
- US Federal Reserve news unless Banxico explicitly references it
- Real estate, auto loans, SME lending, or corporate credit news
- Minor app/UI updates, general fintech news without consumer credit implications`,
    takeaway: 'How does this affect Scredito\'s consumer credit positioning in Mexico?'
  },

  br: {
    name: 'Brazil',
    competitors: ['Nubank', 'Mercado Crédito', 'PicPay', 'Creditas', 'C6 Bank', 'PagBank', 'Neon', 'Serasa', 'Avante', 'Banco Inter', 'Itaú', 'Bradesco', 'TikTok', 'Pagaleve', 'Magie', 'Caixa'],
    feeds: [
      // Local language (Portuguese)
      { url: 'https://news.google.com/rss/search?q=nubank+OR+picpay+OR+creditas+OR+pagbank+fintech+credito+brasil&hl=pt-BR&gl=BR&ceid=BR:pt-BR', label: 'BR Competitors (PT)' },
      { url: 'https://news.google.com/rss/search?q=BACEN+OR+BCB+credito+consignado+OR+open+finance+brasil+regulacao&hl=pt-BR&gl=BR&ceid=BR:pt-BR', label: 'BR Regulation (PT)' },
      { url: 'https://news.google.com/rss/search?q=site:bcb.gov.br+credito+regulacao&hl=pt-BR&gl=BR&ceid=BR:pt-BR', label: 'BCB Official (PT)' },
      { url: 'https://news.google.com/rss/search?q=site:valor.globo.com+fintech+OR+credito+OR+nubank&hl=pt-BR&gl=BR&ceid=BR:pt-BR', label: 'Valor Econômico' },
      { url: 'https://news.google.com/rss/search?q=site:infomoney.com.br+fintech+OR+credito+OR+nubank&hl=pt-BR&gl=BR&ceid=BR:pt-BR', label: 'InfoMoney BR' },
      // English language (international coverage)
      { url: 'https://news.google.com/rss/search?q=nubank+OR+picpay+OR+creditas+brazil+fintech+credit&hl=en-US&gl=US&ceid=US:en', label: 'BR Competitors (EN)' },
      { url: 'https://news.google.com/rss/search?q=brazil+%22open+finance%22+OR+%22Selic+rate%22+OR+%22PIX+credit%22+OR+consignado&hl=en-US&gl=US&ceid=US:en', label: 'BR Regulation (EN)' },
      // Global financial & fintech specialist press
      { url: 'https://news.google.com/rss/search?q=site:ft.com+brazil+fintech+OR+credit+OR+nubank&hl=en-US&gl=US&ceid=US:en', label: 'FT Brazil' },
      { url: 'https://news.google.com/rss/search?q=site:reuters.com+brazil+fintech+OR+lending+OR+nubank&hl=en-US&gl=US&ceid=US:en', label: 'Reuters Brazil' },
      { url: 'https://news.google.com/rss/search?q=site:techcrunch.com+brazil+fintech+OR+nubank&hl=en-US&gl=US&ceid=US:en', label: 'TechCrunch Brazil' },
      { url: 'https://news.google.com/rss/search?q=site:finextra.com+brazil+OR+brasil+fintech&hl=en-US&gl=US&ceid=US:en', label: 'Finextra Brazil' },
    ],
    include: `
INCLUDE only events from the last 24 hours that meet at least one criterion:

Regulation & Enforcement:
- BCB/BACEN policy rate (Selic) decisions and forward guidance
- Open Finance regulation updates
- Consumer credit, collections, or lending regulation changes
- Enforcement actions against lenders, BNPL providers, or digital banks

Consumer Credit Competition:
- Nubank product, pricing, credit limit, or underwriting changes
- PIX Credit (Crédito via PIX) developments from any institution
- BNPL (parcelado) updates from Mercado Pago, PicPay, or major players
- Credit card, personal loan, payroll loan, or revolving credit launches
- Open Finance used to improve underwriting or credit distribution
- Major partnerships expanding credit distribution

Funding & Corporate Activity:
- Fundraising, IPOs, M&A, credit portfolio transactions
- Securitizations and funding facilities

Ecosystem Developments:
- Superapp credit expansion by Mercado Pago or PicPay
- Consignado, eConsignado, and Crédito do Trabalhador developments

Repayment Risk Signals:
- Employment and wage developments affecting repayment capacity
- Social benefit or welfare program changes
- Household debt relief programs
- Collection and insolvency regulation changes`,
    exclude: `
EXCLUDE:
- Generic marketing campaigns, sponsorships, executive interviews without announcements
- General Brazilian politics unless it directly impacts credit regulation or repayments
- Agribusiness, infrastructure, or B2B lending news
- Crypto unless from a regulated financial institution
- Capital markets or investment product news unrelated to consumer credit
- Minor app/UI updates, general fintech news without consumer credit implications`,
    takeaway: 'How does this shift the consumer credit or open finance landscape for a challenger in Brazil?'
  },

  ph: {
    name: 'Philippines',
    competitors: ['GCash', 'Maya', 'BillEase', 'Salmon', 'Tonik Bank', 'SeaBank', 'Tala', 'Atome', 'Cashalo', 'CIMB PH', 'UnionDigital', 'OLPs'],
    feeds: [
      // English (primary language for PH fintech coverage)
      { url: 'https://news.google.com/rss/search?q=gcash+OR+maya+OR+billease+OR+salmon+fintech+philippines&hl=en-PH&gl=PH&ceid=PH:en', label: 'PH Competitors (EN-PH)' },
      { url: 'https://news.google.com/rss/search?q=BSP+digital+bank+OR+lending+regulation+OR+online+lending+philippines&hl=en-PH&gl=PH&ceid=PH:en', label: 'PH Regulation (EN-PH)' },
      { url: 'https://news.google.com/rss/search?q=site:bsp.gov.ph&hl=en-PH&gl=PH&ceid=PH:en', label: 'BSP Official' },
      { url: 'https://news.google.com/rss/search?q=site:businessmirror.com.ph+fintech+OR+gcash+OR+maya+OR+credit&hl=en-PH&gl=PH&ceid=PH:en', label: 'Business Mirror PH' },
      { url: 'https://news.google.com/rss/search?q=site:businessworld.com.ph+fintech+OR+digital+bank+OR+credit&hl=en-PH&gl=PH&ceid=PH:en', label: 'BusinessWorld PH' },
      // International English (catches investor/analyst coverage not in PH media)
      { url: 'https://news.google.com/rss/search?q=gcash+OR+maya+OR+%22tonik+bank%22+philippines+fintech+credit&hl=en-US&gl=US&ceid=US:en', label: 'PH Competitors (EN-INT)' },
      { url: 'https://news.google.com/rss/search?q=philippines+%22digital+bank%22+OR+%22BSP%22+lending+fintech&hl=en-US&gl=US&ceid=US:en', label: 'PH Regulation (EN-INT)' },
      // Filipino language (catches local news not covered in English)
      { url: 'https://news.google.com/rss/search?q=gcash+maya+pautang+fintech+pilipinas&hl=fil&gl=PH&ceid=PH:fil', label: 'PH Fintech (FIL)' },
      // Global financial & fintech specialist press
      { url: 'https://news.google.com/rss/search?q=site:techcrunch.com+philippines+fintech+OR+gcash+OR+maya&hl=en-US&gl=US&ceid=US:en', label: 'TechCrunch PH' },
      { url: 'https://news.google.com/rss/search?q=site:finextra.com+philippines+fintech&hl=en-US&gl=US&ceid=US:en', label: 'Finextra PH' },
      { url: 'https://news.google.com/rss/search?q=site:reuters.com+philippines+fintech+OR+gcash+OR+credit&hl=en-US&gl=US&ceid=US:en', label: 'Reuters PH' },
    ],
    include: `
INCLUDE only events from the last 24 hours that meet at least one criterion:

Regulation & Enforcement:
- BSP digital bank licence grants, revocations, or new applications
- BSP policy rate decisions
- SEC or BSP actions against OLPs (Online Lending Platforms)
- Consumer lending regulations and enforcement actions

Consumer Credit Competition:
- GLoan, Maya Credit, BNPL, or personal loan product launches or changes
- Pricing, fees, credit limits, or underwriting changes
- Retailer, telco, or ecosystem partnerships expanding credit distribution

Funding & Corporate Activity:
- Fundraising, M&A, strategic investments
- Credit portfolio transactions

Payments & Ecosystem:
- e-Wallet interoperability developments
- QR Ph updates affecting credit adoption
- Remittance-linked credit products (OFW-focused)

Repayment Risk Signals:
- OFW income-related developments
- Government assistance or subsidy changes
- Employment developments affecting repayment capacity
- Debt restructuring initiatives or borrower protection regulation changes`,
    exclude: `
EXCLUDE:
- Generic marketing campaigns, sponsorships, executive interviews without announcements
- General Philippine politics unless directly linked to BSP or consumer credit policy
- Traditional bank (BDO, BPI, Metrobank) retail news unless digital credit related
- Real estate or auto lending news
- Crypto unless involving a BSP-regulated entity
- Minor app/UI updates, general fintech news without consumer credit implications`,
    takeaway: 'How does this affect credit access, repayment behavior, or digital lending growth in the Philippines?'
  },

  id: {
    name: 'Indonesia',
    competitors: ['Kredivo', 'Akulaku', 'GoPay', 'OVO', 'Dana', 'SPayLater', 'JULO', 'Honest', 'AdaKami', 'SeaBank', 'Bank Jago', 'Blu by BCA'],
    feeds: [
      // Local language (Indonesian)
      { url: 'https://news.google.com/rss/search?q=kredivo+OR+akulaku+OR+gopay+OR+ovo+fintech+kredit+indonesia&hl=id&gl=ID&ceid=ID:id', label: 'ID Competitors (ID)' },
      { url: 'https://news.google.com/rss/search?q=OJK+pinjaman+online+OR+bank+indonesia+QRIS+OR+fintech+lending+regulasi&hl=id&gl=ID&ceid=ID:id', label: 'ID Regulation (ID)' },
      { url: 'https://news.google.com/rss/search?q=site:ojk.go.id+siaran+pers&hl=id&gl=ID&ceid=ID:id', label: 'OJK Official (ID)' },
      { url: 'https://news.google.com/rss/search?q=site:kontan.co.id+fintech+OR+kredit+OR+pinjaman&hl=id&gl=ID&ceid=ID:id', label: 'Kontan ID' },
      { url: 'https://news.google.com/rss/search?q=site:bisnis.com+fintech+OR+kredit+OR+bnpl+indonesia&hl=id&gl=ID&ceid=ID:id', label: 'Bisnis.com ID' },
      // English language (international coverage)
      { url: 'https://news.google.com/rss/search?q=kredivo+OR+akulaku+OR+gopay+indonesia+fintech+credit+lending&hl=en-US&gl=US&ceid=US:en', label: 'ID Competitors (EN)' },
      { url: 'https://news.google.com/rss/search?q=indonesia+OJK+OR+%22Bank+Indonesia%22+fintech+lending+regulation&hl=en-US&gl=US&ceid=US:en', label: 'ID Regulation (EN)' },
      // Global financial & fintech specialist press
      { url: 'https://news.google.com/rss/search?q=site:techcrunch.com+indonesia+fintech+OR+kredivo+OR+gopay&hl=en-US&gl=US&ceid=US:en', label: 'TechCrunch ID' },
      { url: 'https://news.google.com/rss/search?q=site:reuters.com+indonesia+fintech+OR+ojk+OR+credit&hl=en-US&gl=US&ceid=US:en', label: 'Reuters ID' },
      { url: 'https://news.google.com/rss/search?q=site:finextra.com+indonesia+fintech&hl=en-US&gl=US&ceid=US:en', label: 'Finextra ID' },
      { url: 'https://news.google.com/rss/search?q=site:dealstreetasia.com+indonesia+fintech+OR+credit&hl=en-US&gl=US&ceid=US:en', label: 'DealStreetAsia ID' },
    ],
    include: `
INCLUDE only events from the last 24 hours that meet at least one criterion:

Regulation & Enforcement:
- OJK lending regulations, P2P lending rules, NPL limits, or supervisory actions
- Licence approvals, suspensions, or revocations for lending platforms
- Enforcement actions against lending platforms

Consumer Credit Competition:
- GoPay, OVO, Dana, or SPayLater credit feature launches or changes
- Kredivo or Akulaku pricing, credit limits, approval rates, or underwriting changes
- BNPL merchant partnerships with major e-commerce (Tokopedia, Shopee, Lazada)
- Digital bank (Bank Jago, SeaBank, Blu) credit product launches

Funding & Corporate Activity:
- Fundraising, M&A, strategic investments
- Portfolio sales or lending funding facilities

Payments & Ecosystem:
- BI rate decisions
- QRIS developments affecting credit adoption
- Payment ecosystem changes relevant to consumer credit

Repayment Risk Signals:
- Employment and income developments
- Debt relief or consumer protection initiatives
- Collection and restructuring regulations
- Events affecting repayment capacity or NPL trends`,
    exclude: `
EXCLUDE:
- Generic marketing campaigns, sponsorships, executive interviews without announcements
- Conventional bank (BRI, BNI, Mandiri) retail news unless digital credit related
- Crypto/DeFi
- General Indonesian politics unless directly tied to OJK or BI policy
- SME, corporate, or commodity-related lending news
- Minor app/UI updates, general fintech news without consumer credit implications`,
    takeaway: 'What does this mean for NPL risk, repayment behavior, credit growth, or competitive positioning in Indonesia?'
  }
};

// ── Claude prompts ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a consumer credit competitive intelligence analyst covering emerging markets fintech.
Your job is to extract only high-signal developments that materially affect consumer credit growth, repayments, risk, regulation, funding, or competitive positioning.
Prioritize signal over noise. Be precise, factual, and concise.
Only respond with valid JSON — no prose, no markdown outside the JSON block.`;

function buildUserPrompt(market, articles) {
  return `Today's date: ${new Date().toISOString().split('T')[0]}. Market: ${market.name}.

Objective: Generate a daily digest of developments from the last 24 hours that may materially impact consumer credit in ${market.name}.

Known competitors: ${market.competitors.join(', ')}.

${market.include}

${market.exclude}

For each qualifying item, extract:
- eventType: one of — regulatory | product | funding | partnership | valuation | repayment_risk | macro
- competitor: exact name from the competitor list above, or null if market-wide
- headline: factual, max 15 words, in English
- whatHappened: 1 sentence, factual summary of the event
- whyItMatters: 1 sentence, direct implication for consumer credit operators
- takeaway: 1 sentence — ${market.takeaway}
- date: YYYY-MM-DD (use article publish date)
- sourceUrl: original article URL

Category guide:
- regulatory: licence, rule change, enforcement, policy rate decision
- product: new product, feature launch, pricing/fee/rate/limit change
- funding: fundraising round, debt facility, securitization
- partnership: distribution deal, merchant or ecosystem tie-up
- valuation: analyst rating, earnings, IPO, M&A, valuation news
- repayment_risk: employment, income, welfare, debt relief, NPL, economic shock signals
- macro: broader economic indicator without a direct competitor or regulatory action

Return JSON (return empty newsItems array if nothing qualifies — do not force low-relevance items):
{
  "newsItems": [
    {
      "date": "YYYY-MM-DD",
      "category": "regulatory|product|funding|partnership|valuation|repayment_risk|macro",
      "competitor": "exact competitor name or null",
      "headline": "max 15 words",
      "whatHappened": "1 sentence factual summary",
      "whyItMatters": "1 sentence direct implication for consumer credit",
      "oneLineSummary": "${market.takeaway.replace(/'/g, "\\'")} (1 sentence)",
      "sourceUrl": "original article URL"
    }
  ]
}

IMPORTANT — Deduplication: Articles are sourced from both local-language and English feeds. Multiple articles may cover the same underlying event in different languages. Extract each real-world event only ONCE, using the most informative source. Prefer English-language sourceUrl when the same event is covered in both languages.

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
  if (existing.some(e => e.source_url && e.source_url === item.sourceUrl)) return true;
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

  // Deduplicate by exact URL first, then cap at 60 per market.
  // Cross-language story dedup (same event, different language) is handled by Claude
  // via the explicit deduplication instruction in the prompt.
  const seen = new Set();
  const uniqueArticles = allArticles.filter(a => {
    if (!a.url || seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  }).slice(0, 60);

  // 2. Send to Claude
  console.log(`  Sending ${uniqueArticles.length} articles to Claude...`);
  let extracted;
  try {
    extracted = await extractStructured(SYSTEM_PROMPT, buildUserPrompt(market, uniqueArticles));
  } catch (e) {
    console.error(`  Claude extraction failed: ${e.message}`);
    return;
  }

  const items = extracted.newsItems || [];
  console.log(`  Claude extracted ${items.length} items`);

  if (!items.length) {
    await markSectionRefreshed(marketSlug, 'digest');
    return;
  }

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
    category: item.category || item.eventType || 'macro',
    company_slug: item.competitor || null,
    headline: item.headline,
    what_happened: item.whatHappened || null,
    why_it_matters: item.whyItMatters || null,
    one_line_summary: item.oneLineSummary || item.whyItMatters || null,
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
