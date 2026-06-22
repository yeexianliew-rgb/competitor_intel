-- Add what_happened and why_it_matters columns to intel_news_items
-- Run in Supabase SQL Editor

alter table public.intel_news_items
  add column if not exists what_happened text,
  add column if not exists why_it_matters text;
