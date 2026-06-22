// Shared Supabase client + helper utilities for all fetchers
import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

// Load .env.local if present (local dev only — CI uses GitHub Secrets)
const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, '../../.env.local');
if (existsSync(envPath)) {
  readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const [k, ...v] = line.trim().split('=');
    if (k && v.length && !process.env[k]) process.env[k] = v.join('=').replace(/^['"]|['"]$/g, '');
  });
}

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

// Create an ingestion run row and return its UUID
export async function createRun(marketSlug, runType, counts = {}) {
  const id = randomUUID();
  const { error } = await supabase.from('intel_ingestion_runs').insert({
    id,
    market_slug: marketSlug,
    run_type: runType,
    source_file: `scripts/fetchers/${runType}.js`,
    captured_at: new Date().toISOString(),
    status: 'completed',
    raw_counts: counts,
    metadata: { runner: process.env.GITHUB_RUN_ID || 'local' }
  });
  if (error) throw new Error(`createRun failed: ${error.message}`);
  return id;
}

// Mark a section's last_refreshed_at
export async function markSectionRefreshed(marketSlug, section) {
  await supabase.rpc('mark_section_refreshed', {
    p_market_slug: marketSlug,
    p_section: section
  });
}

// Rebuild the snapshot for a market (triggers Realtime → browser update)
export async function rebuildSnapshot(marketSlug) {
  const { error } = await supabase.rpc('rebuild_market_payload', {
    p_market_slug: marketSlug
  });
  if (error) throw new Error(`rebuildSnapshot(${marketSlug}) failed: ${error.message}`);
}

// Log a change entry
export async function logChange(marketSlug, section, changeType, delta, summary, runId) {
  await supabase.from('intel_change_log').insert({
    market_slug: marketSlug,
    section,
    change_type: changeType,
    record_count_delta: delta,
    summary,
    run_id: runId
  });
}

// Insert rows in batches of 250 (PostgREST limit)
export async function batchInsert(table, rows) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 250) {
    const batch = rows.slice(i, i + 250);
    const { error } = await supabase.from(table).insert(batch);
    if (error) throw new Error(`batchInsert(${table}) failed: ${error.message}`);
  }
}

// Fetch existing headlines/URLs for dedup (last N days)
export async function getRecentHeadlines(marketSlug, days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data } = await supabase
    .from('intel_news_items')
    .select('headline, source_url')
    .eq('market_slug', marketSlug)
    .gte('created_at', since);
  return data || [];
}
