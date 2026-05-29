param(
  [string]$IndexPath = ".\index.html",
  [string]$MarketSlug = "mexico",
  [string]$MarketName = "Mexico",
  [string]$CountryCode = "MX",
  [string]$CurrencyCode = "MXN",
  [string]$RunType = "baseline_import",
  [string]$SourceFile = "index.html",
  [string]$RunId = "",
  [string]$SupabaseUrl = $env:SUPABASE_URL,
  [string]$ServiceRoleKey = $env:SUPABASE_SERVICE_ROLE_KEY,
  [switch]$Apply,
  [switch]$WriteSnapshotJson,
  [string]$SnapshotPath = ".\supabase\baseline-dashboard-data.json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Read-EnvFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or ($line -notmatch "=")) { return }
    $name, $value = $line.Split("=", 2)
    $name = $name.Trim()
    $value = $value.Trim().Trim('"').Trim("'")
    if ($name -and -not [Environment]::GetEnvironmentVariable($name, "Process")) {
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
  }
}

Read-EnvFile ".\.env.local"
if (-not $SupabaseUrl) { $SupabaseUrl = $env:SUPABASE_URL }
if (-not $ServiceRoleKey) { $ServiceRoleKey = $env:SUPABASE_SERVICE_ROLE_KEY }
if (-not $RunId) { $RunId = ([guid]::NewGuid()).ToString() }

function Get-JsObjectLiteral {
  param(
    [string]$Text,
    [string]$Marker
  )
  $markerIndex = $Text.IndexOf($Marker)
  if ($markerIndex -lt 0) { throw "Marker not found: $Marker" }
  $start = $Text.IndexOf("{", $markerIndex)
  if ($start -lt 0) { throw "Opening brace not found after marker: $Marker" }

  $depth = 0
  $inString = $false
  $stringQuote = [char]0
  $inLineComment = $false
  $inBlockComment = $false

  for ($i = $start; $i -lt $Text.Length; $i++) {
    $ch = $Text[$i]
    $next = if ($i + 1 -lt $Text.Length) { $Text[$i + 1] } else { [char]0 }

    if ($inLineComment) {
      if ($ch -eq "`n") { $inLineComment = $false }
      continue
    }
    if ($inBlockComment) {
      if ($ch -eq "*" -and $next -eq "/") { $inBlockComment = $false; $i++ }
      continue
    }
    if ($inString) {
      if ($ch -eq "\") { $i++; continue }
      if ($ch -eq $stringQuote) { $inString = $false }
      continue
    }

    if ($ch -eq "/" -and $next -eq "/") { $inLineComment = $true; $i++; continue }
    if ($ch -eq "/" -and $next -eq "*") { $inBlockComment = $true; $i++; continue }
    if ($ch -eq "'" -or $ch -eq '"' -or $ch -eq [char]96) { $inString = $true; $stringQuote = $ch; continue }
    if ($ch -eq "{") { $depth++ }
    if ($ch -eq "}") {
      $depth--
      if ($depth -eq 0) {
        return $Text.Substring($start, $i - $start + 1)
      }
    }
  }
  throw "No matching closing brace found for marker: $Marker"
}

function Remove-JsComments {
  param([string]$Text)
  $sb = [System.Text.StringBuilder]::new()
  $inString = $false
  $stringQuote = [char]0
  $inLineComment = $false
  $inBlockComment = $false

  for ($i = 0; $i -lt $Text.Length; $i++) {
    $ch = $Text[$i]
    $next = if ($i + 1 -lt $Text.Length) { $Text[$i + 1] } else { [char]0 }

    if ($inLineComment) {
      if ($ch -eq "`n") { $inLineComment = $false; [void]$sb.Append($ch) }
      continue
    }
    if ($inBlockComment) {
      if ($ch -eq "*" -and $next -eq "/") { $inBlockComment = $false; $i++ }
      continue
    }
    if ($inString) {
      [void]$sb.Append($ch)
      if ($ch -eq "\") {
        if ($i + 1 -lt $Text.Length) { $i++; [void]$sb.Append($Text[$i]) }
        continue
      }
      if ($ch -eq $stringQuote) { $inString = $false }
      continue
    }

    if ($ch -eq "/" -and $next -eq "/") { $inLineComment = $true; $i++; continue }
    if ($ch -eq "/" -and $next -eq "*") { $inBlockComment = $true; $i++; continue }
    if ($ch -eq "'" -or $ch -eq '"') { $inString = $true; $stringQuote = $ch; [void]$sb.Append($ch); continue }
    if ($ch -eq [char]96) { throw "Template literals are not supported in extracted data blocks." }
    [void]$sb.Append($ch)
  }
  $sb.ToString()
}

function ConvertTo-JsonStringLiteral {
  param([string]$Value)
  $sb = [System.Text.StringBuilder]::new()
  [void]$sb.Append('"')
  foreach ($ch in $Value.ToCharArray()) {
    $code = [int][char]$ch
    switch ($ch) {
      '"' { [void]$sb.Append('\"') }
      '\' { [void]$sb.Append('\\') }
      "`b" { [void]$sb.Append('\b') }
      "`f" { [void]$sb.Append('\f') }
      "`n" { [void]$sb.Append('\n') }
      "`r" { [void]$sb.Append('\r') }
      "`t" { [void]$sb.Append('\t') }
      default {
        if ($code -lt 32) {
          [void]$sb.Append('\u')
          [void]$sb.Append($code.ToString('x4'))
        } else {
          [void]$sb.Append($ch)
        }
      }
    }
  }
  [void]$sb.Append('"')
  $sb.ToString()
}

function Convert-JsStringsToJson {
  param([string]$Text)
  $out = [System.Text.StringBuilder]::new()

  for ($i = 0; $i -lt $Text.Length; $i++) {
    $ch = $Text[$i]
    if ($ch -ne "'" -and $ch -ne '"') {
      [void]$out.Append($ch)
      continue
    }

    $quote = $ch
    $value = [System.Text.StringBuilder]::new()
    $i++
    while ($i -lt $Text.Length) {
      $c = $Text[$i]
      if ($c -eq "\") {
        if ($i + 1 -ge $Text.Length) { break }
        $i++
        $esc = $Text[$i]
        switch ($esc) {
          "n" { [void]$value.Append("`n") }
          "r" { [void]$value.Append("`r") }
          "t" { [void]$value.Append("`t") }
          "b" { [void]$value.Append([char]8) }
          "f" { [void]$value.Append([char]12) }
          "u" {
            if ($i + 4 -lt $Text.Length) {
              $hex = $Text.Substring($i + 1, 4)
              [void]$value.Append([char][Convert]::ToInt32($hex, 16))
              $i += 4
            }
          }
          default { [void]$value.Append($esc) }
        }
      } elseif ($c -eq $quote) {
        break
      } else {
        [void]$value.Append($c)
      }
      $i++
    }
    [void]$out.Append((ConvertTo-JsonStringLiteral $value.ToString()))
  }
  $out.ToString()
}

function Convert-JsObjectLiteralToObject {
  param([string]$Literal)
  $json = Remove-JsComments $Literal
  $json = Convert-JsStringsToJson $json
  $json = [regex]::Replace($json, "([{,]\s*)([A-Za-z_$][A-Za-z0-9_$]*)\s*:", '$1"$2":')
  do {
    $before = $json
    $json = [regex]::Replace($json, ",\s*([}\]])", '$1')
  } while ($json -ne $before)
  $json | ConvertFrom-Json
}

function ConvertTo-Slug {
  param([string]$Name)
  if (-not $Name) { return $null }
  $key = $Name.Trim().ToLowerInvariant()
  $map = @{
    "nu" = "nu"; "plata" = "plata"; "kueski" = "kueski"; "mercado pago" = "mp"; "mp" = "mp";
    "klar" = "klar"; "stori" = "stori"; "didi" = "didi"; "revolut" = "revolut"; "baubap" = "baubap";
    "tala" = "tala"; "rappicard" = "rappicard"; "ualá" = "uala"; "uala" = "uala";
    "regulatory" = "regulatory"; "macro" = "macro"; "others" = "others"
  }
  if ($map.ContainsKey($key)) { return $map[$key] }
  $normalized = $key.Normalize([Text.NormalizationForm]::FormD)
  $chars = $normalized.ToCharArray() | Where-Object { [Globalization.CharUnicodeInfo]::GetUnicodeCategory($_) -ne [Globalization.UnicodeCategory]::NonSpacingMark }
  (-join $chars) -replace "[^a-z0-9]+", "-" -replace "^-|-$", ""
}

function Get-CompanyName {
  param([string]$Slug)
  $map = @{
    "nu" = "Nu"; "plata" = "Plata"; "kueski" = "Kueski"; "mp" = "Mercado Pago"; "klar" = "Klar";
    "stori" = "Stori"; "didi" = "DiDi"; "revolut" = "Revolut"; "baubap" = "Baubap"; "tala" = "Tala";
    "rappicard" = "RappiCard"; "uala" = "Uala"; "regulatory" = "Regulatory"; "macro" = "Macro"; "others" = "Others"
  }
  if ($map.ContainsKey($Slug)) { return $map[$Slug] }
  return $Slug
}

function New-HashKey {
  param([string]$Value)
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
  (($sha.ComputeHash($bytes) | ForEach-Object { $_.ToString("x2") }) -join "").Substring(0, 32)
}

function Convert-RowsToJson {
  param([object[]]$Rows)
  if (-not $Rows -or $Rows.Count -eq 0) { return "[]" }
  $parts = foreach ($row in $Rows) { $row | ConvertTo-Json -Depth 100 -Compress }
  "[" + ($parts -join ",") + "]"
}

function Add-Row {
  param(
    [hashtable]$Bag,
    [string]$Table,
    [hashtable]$Row
  )
  if (-not $Bag.ContainsKey($Table)) { $Bag[$Table] = [System.Collections.Generic.List[object]]::new() }
  $Bag[$Table].Add([pscustomobject]$Row)
}

function Add-SourceLink {
  param(
    [hashtable]$Bag,
    [string]$Url,
    [string]$Context,
    [string]$SourceTable,
    [object]$RawPayload
  )
  if (-not $Url) { return }
  Add-Row $Bag "intel_source_links" @{
    run_id = $RunId; market_slug = $MarketSlug; link_key = New-HashKey "$RunId|$Url|$Context|$SourceTable";
    url = $Url; context = $Context; source_table = $SourceTable; raw_payload = $RawPayload
  }
}

function Invoke-SupabaseInsert {
  param(
    [string]$Table,
    [object[]]$Rows,
    [string]$OnConflict = ""
  )
  if (-not $Rows -or $Rows.Count -eq 0) { return }
  if (-not $Apply) {
    Write-Host ("DRY RUN {0}: {1} rows" -f $Table, $Rows.Count)
    return
  }
  if (-not $SupabaseUrl -or -not $ServiceRoleKey) {
    throw "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required when -Apply is used."
  }
  if ($ServiceRoleKey -like "sb_secret_*") {
    throw "SUPABASE_SERVICE_ROLE_KEY must be the legacy service_role JWT key, not the newer sb_secret_* API key. In Supabase Project Settings -> API, use the service_role key that starts with eyJ..."
  }

  $uri = $SupabaseUrl.TrimEnd("/") + "/rest/v1/" + $Table
  if ($OnConflict) { $uri += "?on_conflict=$OnConflict" }
  $headers = @{
    "apikey" = $ServiceRoleKey
    "Authorization" = "Bearer $ServiceRoleKey"
    "Content-Type" = "application/json"
    "Prefer" = "resolution=merge-duplicates,return=minimal"
  }
  $batchSize = 250
  for ($i = 0; $i -lt $Rows.Count; $i += $batchSize) {
    $end = [Math]::Min($i + $batchSize - 1, $Rows.Count - 1)
    $batch = @($Rows[$i..$end])
    $body = Convert-RowsToJson $batch
    Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $body | Out-Null
  }
  Write-Host ("INSERTED {0}: {1} rows" -f $Table, $Rows.Count)
}

$html = Get-Content -Raw -LiteralPath $IndexPath
$data = Convert-JsObjectLiteralToObject (Get-JsObjectLiteral $html "const DATA =")
$mktAds = Convert-JsObjectLiteralToObject (Get-JsObjectLiteral $html "const mktAds =")
$data | Add-Member -NotePropertyName "mktAds" -NotePropertyValue $mktAds -Force

$capturedAt = (Get-Date).ToUniversalTime().ToString("o")
$rows = @{}
$companySlugs = [System.Collections.Generic.HashSet[string]]::new()

Add-Row $rows "intel_markets" @{ slug = $MarketSlug; name = $MarketName; country_code = $CountryCode; currency_code = $CurrencyCode }

$counts = [ordered]@{
  newsItems = @($data.newsItems).Count
  upcomingEvents = @($data.upcomingEvents).Count
  marketingItemsOld = @($data.marketingItems_old).Count
  mktFunnels = @($data.mktFunnels.PSObject.Properties).Count
  productItems = @($data.productItems.PSObject.Properties | ForEach-Object { @($_.Value).Count } | Measure-Object -Sum).Sum
  sentimentItems = @($data.sentimentItems).Count
  businessStats = @($data.businessStats).Count
  mktAds = @($mktAds.PSObject.Properties | ForEach-Object { @($_.Value).Count } | Measure-Object -Sum).Sum
}

Add-Row $rows "intel_ingestion_runs" @{
  id = $RunId; market_slug = $MarketSlug; run_type = $RunType; source_file = $SourceFile;
  captured_at = $capturedAt; status = "completed"; raw_counts = $counts; metadata = @{ importer = "scripts/import-index-to-supabase.ps1" }
}
Add-Row $rows "intel_dashboard_snapshots" @{ run_id = $RunId; market_slug = $MarketSlug; payload = $data }

foreach ($item in @($data.newsItems)) {
  $slug = ConvertTo-Slug $item.competitor
  if ($slug) { [void]$companySlugs.Add($slug) }
  Add-Row $rows "intel_news_items" @{
    run_id = $RunId; market_slug = $MarketSlug; item_id = $item.id; item_date = $item.date; category = $item.category;
    company_slug = $slug; headline = $item.headline; one_line_summary = $item.oneLineSummary; source_url = $item.sourceUrl; raw_payload = $item
  }
  Add-SourceLink $rows $item.sourceUrl $item.headline "intel_news_items" $item
}

foreach ($event in @($data.upcomingEvents)) {
  $key = New-HashKey "$($event.sortDate)|$($event.title)"
  Add-Row $rows "intel_upcoming_events" @{
    run_id = $RunId; market_slug = $MarketSlug; event_key = $key; event_date = $event.date; sort_date = $event.sortDate;
    title = $event.title; summary = $event.summary; importance = $event.importance; event_type = $event.type; raw_payload = $event
  }
}

foreach ($item in @($data.marketingItems_old)) {
  $slug = ConvertTo-Slug $item.competitor
  if ($slug) { [void]$companySlugs.Add($slug) }
  Add-Row $rows "intel_marketing_items_archive" @{
    run_id = $RunId; market_slug = $MarketSlug; item_id = $item.id; company_slug = $slug; date_captured = $item.dateCaptured;
    channel = $item.channel; ad_status = $item.adStatus; source_url = $item.sourceUrl; landing_page_url = $item.landingPageUrl;
    creative_url = $item.creativeUrl; screenshot_url = $item.screenshotUrl; headline = $item.headline; ad_copy_summary = $item.adCopySummary;
    hook = $item.hook; promo_mechanics = $item.promoMechanics; target_segment = $item.targetSegment; cta = $item.cta; notes = $item.notes; raw_payload = $item
  }
  Add-SourceLink $rows $item.sourceUrl $item.headline "intel_marketing_items_archive" $item
  Add-SourceLink $rows $item.landingPageUrl $item.headline "intel_marketing_items_archive" $item
}

foreach ($prop in $data.mktFunnels.PSObject.Properties) {
  $company = ConvertTo-Slug $prop.Name
  [void]$companySlugs.Add($company)
  $funnel = $prop.Value
  Add-Row $rows "intel_marketing_funnels" @{
    run_id = $RunId; market_slug = $MarketSlug; company_slug = $company; funnel_summary = $funnel.funnelSummary;
    channel_implication = $funnel.channelImplication; prm_counter_move = $funnel.prmCounterMove; raw_payload = $funnel
  }
  $i = 0
  foreach ($channel in @($funnel.channels)) {
    Add-Row $rows "intel_marketing_channels" @{
      run_id = $RunId; market_slug = $MarketSlug; company_slug = $company; ordinal = $i; name = $channel.name;
      channel_type = $channel.type; traffic_est = $channel.trafficEst; engagement = $channel.engagement; ux_flow = $channel.uxFlow;
      spend_level = $channel.spendLevel; raw_payload = $channel
    }
    $i++
  }
  $i = 0
  foreach ($pillar in @($funnel.messaging.evergreen)) {
    Add-Row $rows "intel_marketing_message_pillars" @{
      run_id = $RunId; market_slug = $MarketSlug; company_slug = $company; ordinal = $i; pillar = $pillar.pillar;
      channels = @($pillar.channels); copy = $pillar.copy; raw_payload = $pillar
    }
    $i++
  }
  $i = 0
  foreach ($campaign in @($funnel.messaging.campaigns)) {
    Add-Row $rows "intel_marketing_campaigns" @{
      run_id = $RunId; market_slug = $MarketSlug; company_slug = $company; ordinal = $i; name = $campaign.name;
      period = $campaign.period; channel = $campaign.channel; hook = $campaign.hook; copy = $campaign.copy; notes = $campaign.notes; raw_payload = $campaign
    }
    $i++
  }
  $i = 0
  foreach ($promotion in @($funnel.prm)) {
    Add-Row $rows "intel_marketing_promotions" @{
      run_id = $RunId; market_slug = $MarketSlug; company_slug = $company; ordinal = $i; promotion_type = $promotion.type;
      mechanic = $promotion.mechanic; segment = $promotion.segment; status = $promotion.status; period = $promotion.period; raw_payload = $promotion
    }
    $i++
  }
}

foreach ($prop in $mktAds.PSObject.Properties) {
  if ($prop.Name -notmatch "^(.*)_(channels|campaigns|prm)_([0-9]+)$") { throw "Unexpected mktAds key: $($prop.Name)" }
  $company = ConvertTo-Slug $Matches[1]
  $section = $Matches[2]
  $sourceIndex = [int]$Matches[3]
  [void]$companySlugs.Add($company)
  foreach ($ad in @($prop.Value)) {
    Add-Row $rows "intel_marketing_ad_examples" @{
      run_id = $RunId; market_slug = $MarketSlug; ad_key = $ad.id; company_slug = $company; section = $section; source_index = $sourceIndex;
      ad_id = $ad.id; format = $ad.format; preview_url = $ad.previewUrl; headline_es = $ad.headlineEs; ad_copy_es = $ad.adCopyEs;
      ad_copy_en = $ad.adCopyEn; cta_es = $ad.ctaEs; source_url = $ad.sourceUrl; date_seen = $ad.dateSeen; raw_payload = $ad
    }
    Add-SourceLink $rows $ad.sourceUrl $ad.headlineEs "intel_marketing_ad_examples" $ad
  }
}

foreach ($prop in $data.productItems.PSObject.Properties) {
  $company = ConvertTo-Slug $prop.Name
  [void]$companySlugs.Add($company)
  foreach ($product in @($prop.Value)) {
    Add-Row $rows "intel_product_specs" @{
      run_id = $RunId; market_slug = $MarketSlug; product_id = $product.id; company_slug = $company; product_name = $product.productName;
      product_type = $product.productType; apr_cat = $product.aprCat; credit_limit = $product.creditLimit; tenure = $product.tenure;
      approval_speed = $product.approvalSpeed; kyc_requirements = $product.kycRequirements; repayment_options = $product.repaymentOptions;
      fees = $product.fees; rewards = $product.rewards; distribution = $product.distribution; promise = $product.promise; notes = $product.notes; raw_payload = $product
    }
  }
}

foreach ($item in @($data.sentimentItems)) {
  $slug = ConvertTo-Slug $item.competitor
  if ($slug) { [void]$companySlugs.Add($slug) }
  Add-Row $rows "intel_sentiment_items" @{
    run_id = $RunId; market_slug = $MarketSlug; item_id = $item.id; company_slug = $slug; score = $item.score; score_tier = $item.scoreTier;
    sources = @($item.sources); complaints = @($item.complaints); praises = @($item.praises); quotes = @($item.quotes); raw_payload = $item
  }
}

foreach ($item in @($data.businessStats)) {
  $slug = ConvertTo-Slug $item.competitor
  if ($slug) { [void]$companySlugs.Add($slug) }
  Add-Row $rows "intel_business_stats" @{
    run_id = $RunId; market_slug = $MarketSlug; item_id = $item.id; company_slug = $slug; users = $item.users; loan_os = $item.loanOS;
    revenue = $item.revenue; funding = $item.funding; funding_advantage = $item.fundingAdvantage; est_cac = $item.estCAC;
    est_promo_burn = $item.estPromoBurn; npl = $item.npl; monetisation = $item.monetisation; distribution = $item.distribution;
    ue_quality = $item.ueQuality; ue_confidence = $item.ueConfidence; threat_level = $item.threatLevel; threat_why = $item.threatWhy;
    implication = $item.implication; raw_payload = $item
  }
}

Add-Row $rows "intel_macro_snapshots" @{ run_id = $RunId; market_slug = $MarketSlug; raw_payload = $data.macroData }
$i = 0
foreach ($indicator in @($data.macroData.indicators)) {
  Add-Row $rows "intel_macro_indicators" @{
    run_id = $RunId; market_slug = $MarketSlug; ordinal = $i; label = $indicator.label; value = $indicator.value;
    note = $indicator.note; color = $indicator.color; raw_payload = $indicator
  }
  $i++
}
foreach ($prop in $data.macroData.ratesData.PSObject.Properties) {
  Add-Row $rows "intel_macro_series" @{ run_id = $RunId; market_slug = $MarketSlug; series_group = "ratesData"; series_name = $prop.Name; values_json = @($prop.Value) }
}
foreach ($prop in $data.macroData.nplData.PSObject.Properties) {
  Add-Row $rows "intel_macro_series" @{ run_id = $RunId; market_slug = $MarketSlug; series_group = "nplData"; series_name = $prop.Name; values_json = @($prop.Value) }
}
$i = 0
foreach ($event in @($data.macroData.regulatory)) {
  Add-Row $rows "intel_macro_events" @{ run_id = $RunId; market_slug = $MarketSlug; event_group = "regulatory"; ordinal = $i; event_date = $event.date; event = $event.event; impact = $event.impact; note = $event.note; raw_payload = $event }
  $i++
}
$i = 0
foreach ($event in @($data.macroData.seasonal)) {
  Add-Row $rows "intel_macro_events" @{ run_id = $RunId; market_slug = $MarketSlug; event_group = "seasonal"; ordinal = $i; period = $event.period; event = $event.event; note = $event.note; raw_payload = $event }
  $i++
}

foreach ($slug in $companySlugs) {
  Add-Row $rows "intel_companies" @{ market_slug = $MarketSlug; slug = $slug; name = (Get-CompanyName $slug); aliases = @() }
}

if ($WriteSnapshotJson) {
  $dir = Split-Path -Parent $SnapshotPath
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
  $data | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $SnapshotPath -Encoding UTF8
  Write-Host "Wrote snapshot JSON to $SnapshotPath"
}

Write-Host "RunId: $RunId"
Write-Host "Apply: $Apply"
Write-Host "Extracted counts:"
$counts.GetEnumerator() | ForEach-Object { Write-Host ("  {0}: {1}" -f $_.Key, $_.Value) }

$order = @(
  "intel_markets",
  "intel_companies",
  "intel_ingestion_runs",
  "intel_dashboard_snapshots",
  "intel_source_links",
  "intel_news_items",
  "intel_upcoming_events",
  "intel_marketing_items_archive",
  "intel_marketing_funnels",
  "intel_marketing_channels",
  "intel_marketing_message_pillars",
  "intel_marketing_campaigns",
  "intel_marketing_promotions",
  "intel_marketing_ad_examples",
  "intel_product_specs",
  "intel_sentiment_items",
  "intel_business_stats",
  "intel_macro_snapshots",
  "intel_macro_indicators",
  "intel_macro_series",
  "intel_macro_events"
)

foreach ($table in $order) {
  $tableRows = if ($rows.ContainsKey($table)) { @($rows[$table]) } else { @() }
  Invoke-SupabaseInsert $table $tableRows
}
