param(
  [string]$IndexPath = ".\index.html",
  [string]$RunType = "baseline_import",
  [string]$SourceFile = "index.html",
  [string]$SupabaseUrl = $env:SUPABASE_URL,
  [string]$ServiceRoleKey = $env:SUPABASE_SERVICE_ROLE_KEY,
  [switch]$Apply,
  [switch]$WriteSnapshotJson,
  [string]$SnapshotDir = ".\supabase\snapshots"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Safe property read — avoids StrictMode exceptions on optional fields
function Get-Prop { param($Obj, [string]$Name); if ($null -ne $Obj -and $Obj.PSObject.Properties[$Name]) { $Obj.$Name } else { $null } }

# ── env loader ────────────────────────────────────────────────────────────────
function Read-EnvFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#") -or ($line -notmatch "=")) { return }
    $name, $value = $line.Split("=", 2)
    $name = $name.Trim(); $value = $value.Trim().Trim('"').Trim("'")
    if ($name -and -not [Environment]::GetEnvironmentVariable($name, "Process")) {
      [Environment]::SetEnvironmentVariable($name, $value, "Process")
    }
  }
}

Read-EnvFile ".\.env.local"
if (-not $SupabaseUrl)    { $SupabaseUrl    = $env:SUPABASE_URL }
if (-not $ServiceRoleKey) { $ServiceRoleKey = $env:SUPABASE_SERVICE_ROLE_KEY }

# ── JS → JSON parser helpers ──────────────────────────────────────────────────
function Get-JsObjectLiteral {
  param([string]$Text, [string]$Marker)
  $markerIndex = $Text.IndexOf($Marker)
  if ($markerIndex -lt 0) { throw "Marker not found: $Marker" }
  $start = $Text.IndexOf("{", $markerIndex)
  if ($start -lt 0) { throw "Opening brace not found after marker: $Marker" }

  $depth = 0; $inString = $false; $stringQuote = [char]0
  $inLineComment = $false; $inBlockComment = $false

  for ($i = $start; $i -lt $Text.Length; $i++) {
    $ch = $Text[$i]
    $next = if ($i + 1 -lt $Text.Length) { $Text[$i + 1] } else { [char]0 }

    if ($inLineComment)  { if ($ch -eq "`n") { $inLineComment = $false }; continue }
    if ($inBlockComment) { if ($ch -eq "*" -and $next -eq "/") { $inBlockComment = $false; $i++ }; continue }
    if ($inString) {
      if ($ch -eq "\") { $i++; continue }
      if ($ch -eq $stringQuote) { $inString = $false }
      continue
    }
    if ($ch -eq "/" -and $next -eq "/") { $inLineComment = $true; $i++; continue }
    if ($ch -eq "/" -and $next -eq "*") { $inBlockComment = $true; $i++; continue }
    if ($ch -eq "'" -or $ch -eq '"' -or $ch -eq [char]96) { $inString = $true; $stringQuote = $ch; continue }
    if ($ch -eq "{") { $depth++ }
    if ($ch -eq "}") { $depth--; if ($depth -eq 0) { return $Text.Substring($start, $i - $start + 1) } }
  }
  throw "No matching closing brace found for marker: $Marker"
}

function Remove-JsComments {
  param([string]$Text)
  $sb = [System.Text.StringBuilder]::new()
  $inString = $false; $stringQuote = [char]0
  $inLineComment = $false; $inBlockComment = $false

  for ($i = 0; $i -lt $Text.Length; $i++) {
    $ch = $Text[$i]
    $next = if ($i + 1 -lt $Text.Length) { $Text[$i + 1] } else { [char]0 }

    if ($inLineComment) { if ($ch -eq "`n") { $inLineComment = $false; [void]$sb.Append($ch) }; continue }
    if ($inBlockComment) { if ($ch -eq "*" -and $next -eq "/") { $inBlockComment = $false; $i++ }; continue }
    if ($inString) {
      [void]$sb.Append($ch)
      if ($ch -eq "\") { if ($i + 1 -lt $Text.Length) { $i++; [void]$sb.Append($Text[$i]) }; continue }
      if ($ch -eq $stringQuote) { $inString = $false }
      continue
    }
    if ($ch -eq "/" -and $next -eq "/") { $inLineComment = $true; $i++; continue }
    if ($ch -eq "/" -and $next -eq "*") { $inBlockComment = $true; $i++; continue }
    if ($ch -eq "'" -or $ch -eq '"') { $inString = $true; $stringQuote = $ch; [void]$sb.Append($ch); continue }
    if ($ch -eq [char]96) { [void]$sb.Append('"'); continue }  # treat template literals as plain string start
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
      '"'   { [void]$sb.Append('\"') }
      '\'   { [void]$sb.Append('\\') }
      "`b"  { [void]$sb.Append('\b') }
      "`f"  { [void]$sb.Append('\f') }
      "`n"  { [void]$sb.Append('\n') }
      "`r"  { [void]$sb.Append('\r') }
      "`t"  { [void]$sb.Append('\t') }
      default {
        if ($code -lt 32) { [void]$sb.Append('\u'); [void]$sb.Append($code.ToString('x4')) }
        else { [void]$sb.Append($ch) }
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
    if ($ch -ne "'" -and $ch -ne '"') { [void]$out.Append($ch); continue }
    $quote = $ch
    $value = [System.Text.StringBuilder]::new()
    $i++
    while ($i -lt $Text.Length) {
      $c = $Text[$i]
      if ($c -eq "\") {
        if ($i + 1 -ge $Text.Length) { break }
        $i++; $esc = $Text[$i]
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
      } elseif ($c -eq $quote) { break }
      else { [void]$value.Append($c) }
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
  do { $before = $json; $json = [regex]::Replace($json, ",\s*([}\]])", '$1') } while ($json -ne $before)
  $json | ConvertFrom-Json
}

# ── slug helpers ──────────────────────────────────────────────────────────────
function ConvertTo-Slug {
  param([string]$Name)
  if (-not $Name) { return $null }
  $key = $Name.Trim().ToLowerInvariant()
  $map = @{
    "nu" = "nu"; "plata" = "plata"; "kueski" = "kueski"; "mercado pago" = "mp"; "mp" = "mp";
    "klar" = "klar"; "stori" = "stori"; "didi" = "didi"; "revolut" = "revolut"; "baubap" = "baubap";
    "tala" = "tala"; "rappicard" = "rappicard"; "ualá" = "uala"; "uala" = "uala";
    "nubank" = "nubank"; "inter" = "inter"; "picpay" = "picpay"; "neon" = "neon"; "c6" = "c6";
    "gcash" = "gcash"; "maya" = "maya"; "tonik" = "tonik"; "seabank" = "seabank"; "cimb" = "cimb";
    "gopay" = "gopay"; "ovo" = "ovo"; "dana" = "dana"; "kredivo" = "kredivo"; "akulaku" = "akulaku";
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
    "rappicard" = "RappiCard"; "uala" = "Uala"; "nubank" = "Nubank"; "inter" = "Inter";
    "picpay" = "PicPay"; "neon" = "Neon"; "c6" = "C6 Bank"; "gcash" = "GCash"; "maya" = "Maya";
    "tonik" = "Tonik"; "seabank" = "SeaBank"; "cimb" = "CIMB"; "gopay" = "GoPay"; "ovo" = "OVO";
    "dana" = "DANA"; "kredivo" = "Kredivo"; "akulaku" = "Akulaku";
    "regulatory" = "Regulatory"; "macro" = "Macro"; "others" = "Others"
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

# ── row bag helpers ───────────────────────────────────────────────────────────
function Add-Row {
  param([hashtable]$Bag, [string]$Table, [hashtable]$Row)
  if (-not $Bag.ContainsKey($Table)) { $Bag[$Table] = [System.Collections.Generic.List[object]]::new() }
  $Bag[$Table].Add([pscustomobject]$Row)
}

function Add-SourceLink {
  param([hashtable]$Bag, [string]$Url, [string]$Context, [string]$SourceTable, [object]$RawPayload, [string]$RunId, [string]$MarketSlug)
  if (-not $Url) { return }
  Add-Row $Bag "intel_source_links" @{
    run_id = $RunId; market_slug = $MarketSlug; link_key = New-HashKey "$RunId|$Url|$Context|$SourceTable";
    url = $Url; context = $Context; source_table = $SourceTable; raw_payload = $RawPayload
  }
}

# ── Supabase uploader ─────────────────────────────────────────────────────────
function Convert-RowsToJson {
  param([object[]]$Rows)
  if (-not $Rows -or $Rows.Count -eq 0) { return "[]" }
  $parts = foreach ($row in $Rows) { $row | ConvertTo-Json -Depth 50 -Compress }
  "[" + ($parts -join ",") + "]"
}

function Get-SupabaseHeaders {
  return @{
    "apikey"        = $ServiceRoleKey
    "Authorization" = "Bearer $ServiceRoleKey"
    "Content-Type"  = "application/json"
    "Prefer"        = "resolution=merge-duplicates,return=minimal"
  }
}

function Invoke-SupabaseInsert {
  param([string]$Table, [object[]]$Rows)
  if (-not $Rows -or $Rows.Count -eq 0) { return }
  if (-not $Apply) { Write-Host ("  DRY RUN {0}: {1} rows" -f $Table, $Rows.Count); return }
  if (-not $SupabaseUrl -or -not $ServiceRoleKey) { throw "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required with -Apply." }
  if ($ServiceRoleKey -like "sb_secret_*") { throw "Use the service_role JWT key (starts with eyJ...), not sb_secret_*." }

  $uri     = $SupabaseUrl.TrimEnd("/") + "/rest/v1/" + $Table
  $headers = Get-SupabaseHeaders
  $batchSize = 250
  for ($i = 0; $i -lt $Rows.Count; $i += $batchSize) {
    $end   = [Math]::Min($i + $batchSize - 1, $Rows.Count - 1)
    $batch = @($Rows[$i..$end])
    $body  = Convert-RowsToJson $batch
    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
    try {
      Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $bodyBytes | Out-Null
    } catch {
      $resp = $_.Exception.Response
      if ($resp) {
        $stream = $resp.GetResponseStream()
        $reader = [System.IO.StreamReader]::new($stream)
        $detail = $reader.ReadToEnd()
        $status = [int]$resp.StatusCode
        throw "Supabase HTTP $status on $Table`: $detail"
      }
      throw "Supabase connection error on $Table`: $($_.Exception.Message)"
    }
  }
  Write-Host ("  INSERTED {0}: {1} rows" -f $Table, $Rows.Count)
}

function Invoke-SupabaseInsertSnapshot {
  # Uploads one intel_dashboard_snapshots row.
  # Serializes the payload via ConvertTo-Json (handles PSCustomObject correctly),
  # then injects the resulting JSON string as a raw value in the POST body.
  param([string]$RunId, [string]$MarketSlug, [object]$Payload, [int]$SchemaVersion = 1)
  if (-not $Apply) { Write-Host "  DRY RUN intel_dashboard_snapshots: 1 rows"; return }

  # ConvertTo-Json handles PSCustomObject; depth 50 is sufficient for the dashboard shape
  $payloadJson = $Payload | ConvertTo-Json -Depth 50 -Compress

  # Strip BOM if ConvertTo-Json somehow adds one (it doesn't, but be safe)
  if ($payloadJson.Length -gt 0 -and [int][char]$payloadJson[0] -eq 65279) {
    $payloadJson = $payloadJson.Substring(1)
  }

  $runIdEsc  = $RunId.Replace('"','\"')
  $marketEsc = $MarketSlug.Replace('"','\"')
  $body = "[{""run_id"":""$runIdEsc"",""market_slug"":""$marketEsc"",""schema_version"":$SchemaVersion,""payload"":$payloadJson}]"

  $uri       = $SupabaseUrl.TrimEnd("/") + "/rest/v1/intel_dashboard_snapshots"
  $headers   = Get-SupabaseHeaders
  $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($body)
  try {
    Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $bodyBytes | Out-Null
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $stream = $resp.GetResponseStream()
      $reader = [System.IO.StreamReader]::new($stream)
      throw "Supabase snapshot error: $($reader.ReadToEnd())"
    }
    throw
  }
  Write-Host "  INSERTED intel_dashboard_snapshots: 1 rows"
}

function Invoke-SupabaseRpc {
  param([string]$FnName, [hashtable]$Params)
  if (-not $Apply) { return }
  $uri  = $SupabaseUrl.TrimEnd("/") + "/rest/v1/rpc/$FnName"
  $headers = @{
    "apikey"        = $ServiceRoleKey
    "Authorization" = "Bearer $ServiceRoleKey"
    "Content-Type"  = "application/json"
  }
  $body = $Params | ConvertTo-Json -Compress
  try { Invoke-RestMethod -Method Post -Uri $uri -Headers $headers -Body $body | Out-Null }
  catch { Write-Host ("  RPC $FnName warning: " + $_.Exception.Message) }
}

# ── market metadata ───────────────────────────────────────────────────────────
$marketMeta = @{
  mx = @{ name = "Mexico";      countryCode = "MX"; currencyCode = "MXN" }
  br = @{ name = "Brazil";      countryCode = "BR"; currencyCode = "BRL" }
  ph = @{ name = "Philippines"; countryCode = "PH"; currencyCode = "PHP" }
  id = @{ name = "Indonesia";   countryCode = "ID"; currencyCode = "IDR" }
}

# ── per-section row builders ──────────────────────────────────────────────────
function Build-NewsRows {
  param([hashtable]$Bag, [object]$Data, [string]$RunId, [string]$MarketSlug)
  foreach ($item in @(Get-Prop $Data 'newsItems')) {
    if (-not $item -or -not (Get-Prop $item 'headline')) { continue }
    $slug = ConvertTo-Slug (Get-Prop $item 'competitor')
    $iid  = if (Get-Prop $item 'id') { $item.id } else { New-HashKey "$RunId|$($item.headline)" }
    Add-Row $Bag "intel_news_items" @{
      run_id = $RunId; market_slug = $MarketSlug; item_id = $iid
      item_date = (Get-Prop $item 'date'); category = (Get-Prop $item 'category'); company_slug = $slug
      headline = $item.headline; one_line_summary = (Get-Prop $item 'oneLineSummary')
      source_url = (Get-Prop $item 'sourceUrl'); raw_payload = $item
    }
    Add-SourceLink $Bag (Get-Prop $item 'sourceUrl') $item.headline "intel_news_items" $item $RunId $MarketSlug
  }
}

function Build-EventRows {
  param([hashtable]$Bag, [object]$Data, [string]$RunId, [string]$MarketSlug)
  foreach ($evItem in @(Get-Prop $Data 'upcomingEvents')) {
    if (-not $evItem -or -not (Get-Prop $evItem 'title')) { continue }
    $key = New-HashKey "$($evItem.sortDate)|$($evItem.title)"
    Add-Row $Bag "intel_upcoming_events" @{
      run_id = $RunId; market_slug = $MarketSlug; event_key = $key
      event_date = (Get-Prop $evItem 'date'); sort_date = (Get-Prop $evItem 'sortDate')
      title = $evItem.title; summary = (Get-Prop $evItem 'summary')
      importance = (Get-Prop $evItem 'importance'); event_type = (Get-Prop $evItem 'type')
      raw_payload = $evItem
    }
  }
}

function Build-MarketingRows {
  param([hashtable]$Bag, [object]$Data, [string]$RunId, [string]$MarketSlug, [hashtable]$CompanySlugs)
  foreach ($item in @(Get-Prop $Data 'marketingItems_old')) {
    if (-not $item) { continue }
    $slug = ConvertTo-Slug (Get-Prop $item 'competitor')
    if ($slug) { $CompanySlugs[$slug] = $true }
    $iid = if (Get-Prop $item 'id') { $item.id } else { New-HashKey "$RunId|$(Get-Prop $item 'headline')" }
    Add-Row $Bag "intel_marketing_items_archive" @{
      run_id = $RunId; market_slug = $MarketSlug; item_id = $iid; company_slug = $slug
      date_captured = (Get-Prop $item 'dateCaptured'); channel = (Get-Prop $item 'channel')
      ad_status = (Get-Prop $item 'adStatus'); source_url = (Get-Prop $item 'sourceUrl')
      landing_page_url = (Get-Prop $item 'landingPageUrl'); creative_url = (Get-Prop $item 'creativeUrl')
      screenshot_url = (Get-Prop $item 'screenshotUrl'); headline = (Get-Prop $item 'headline')
      ad_copy_summary = (Get-Prop $item 'adCopySummary'); hook = (Get-Prop $item 'hook')
      promo_mechanics = (Get-Prop $item 'promoMechanics'); target_segment = (Get-Prop $item 'targetSegment')
      cta = (Get-Prop $item 'cta'); notes = (Get-Prop $item 'notes'); raw_payload = $item
    }
    Add-SourceLink $Bag (Get-Prop $item 'sourceUrl') (Get-Prop $item 'headline') "intel_marketing_items_archive" $item $RunId $MarketSlug
    Add-SourceLink $Bag (Get-Prop $item 'landingPageUrl') (Get-Prop $item 'headline') "intel_marketing_items_archive" $item $RunId $MarketSlug
  }

  $funnels = Get-Prop $Data 'mktFunnels'
  if ($funnels) {
    foreach ($prop in $funnels.PSObject.Properties) {
      $company = ConvertTo-Slug $prop.Name
      $CompanySlugs[$company] = $true
      $funnel = $prop.Value
      Add-Row $Bag "intel_marketing_funnels" @{
        run_id = $RunId; market_slug = $MarketSlug; company_slug = $company
        funnel_summary = (Get-Prop $funnel 'funnelSummary'); channel_implication = (Get-Prop $funnel 'channelImplication')
        prm_counter_move = (Get-Prop $funnel 'prmCounterMove'); raw_payload = $funnel
      }
      $ord = 0
      foreach ($ch in @(Get-Prop $funnel 'channels')) {
        if (-not $ch) { continue }
        Add-Row $Bag "intel_marketing_channels" @{
          run_id = $RunId; market_slug = $MarketSlug; company_slug = $company; ordinal = $ord
          name = (Get-Prop $ch 'name'); channel_type = (Get-Prop $ch 'type'); traffic_est = (Get-Prop $ch 'trafficEst')
          engagement = (Get-Prop $ch 'engagement'); ux_flow = (Get-Prop $ch 'uxFlow'); spend_level = (Get-Prop $ch 'spendLevel'); raw_payload = $ch
        }; $ord++
      }
      $messaging = Get-Prop $funnel 'messaging'
      $ord = 0
      foreach ($pillar in @(Get-Prop $messaging 'evergreen')) {
        if (-not $pillar) { continue }
        Add-Row $Bag "intel_marketing_message_pillars" @{
          run_id = $RunId; market_slug = $MarketSlug; company_slug = $company; ordinal = $ord
          pillar = (Get-Prop $pillar 'pillar'); channels = @(Get-Prop $pillar 'channels'); copy = (Get-Prop $pillar 'copy'); raw_payload = $pillar
        }; $ord++
      }
      $ord = 0
      foreach ($campaign in @(Get-Prop $messaging 'campaigns')) {
        if (-not $campaign) { continue }
        Add-Row $Bag "intel_marketing_campaigns" @{
          run_id = $RunId; market_slug = $MarketSlug; company_slug = $company; ordinal = $ord
          name = (Get-Prop $campaign 'name'); period = (Get-Prop $campaign 'period'); channel = (Get-Prop $campaign 'channel')
          hook = (Get-Prop $campaign 'hook'); copy = (Get-Prop $campaign 'copy'); notes = (Get-Prop $campaign 'notes'); raw_payload = $campaign
        }; $ord++
      }
      $ord = 0
      foreach ($promo in @(Get-Prop $funnel 'prm')) {
        if (-not $promo) { continue }
        Add-Row $Bag "intel_marketing_promotions" @{
          run_id = $RunId; market_slug = $MarketSlug; company_slug = $company; ordinal = $ord
          promotion_type = (Get-Prop $promo 'type'); mechanic = (Get-Prop $promo 'mechanic'); segment = (Get-Prop $promo 'segment')
          status = (Get-Prop $promo 'status'); period = (Get-Prop $promo 'period'); raw_payload = $promo
        }; $ord++
      }
    }
  }
}

function Build-AdRows {
  param([hashtable]$Bag, [object]$MktAds, [string]$RunId, [string]$MarketSlug, [hashtable]$CompanySlugs)
  if (-not $MktAds) { return }
  foreach ($prop in $MktAds.PSObject.Properties) {
    if ($prop.Name -notmatch "^(.*)_(channels|campaigns|prm)_([0-9]+)$") {
      Write-Host ("  Skipping unexpected mktAds key: " + $prop.Name); continue
    }
    $company = ConvertTo-Slug $Matches[1]
    $section = $Matches[2]; $sourceIndex = [int]$Matches[3]
    $CompanySlugs[$company] = $true
    foreach ($ad in @($prop.Value)) {
      if (-not $ad) { continue }
      $adKey = if (Get-Prop $ad 'id') { $ad.id } else { New-HashKey "$RunId|$($prop.Name)|$(Get-Prop $ad 'headlineEs')" }
      Add-Row $Bag "intel_marketing_ad_examples" @{
        run_id = $RunId; market_slug = $MarketSlug; ad_key = $adKey; company_slug = $company
        section = $section; source_index = $sourceIndex; ad_id = (Get-Prop $ad 'id'); format = (Get-Prop $ad 'format')
        preview_url = (Get-Prop $ad 'previewUrl'); headline_es = (Get-Prop $ad 'headlineEs'); ad_copy_es = (Get-Prop $ad 'adCopyEs')
        ad_copy_en = (Get-Prop $ad 'adCopyEn'); cta_es = (Get-Prop $ad 'ctaEs'); source_url = (Get-Prop $ad 'sourceUrl')
        date_seen = (Get-Prop $ad 'dateSeen'); raw_payload = $ad
      }
      Add-SourceLink $Bag (Get-Prop $ad 'sourceUrl') (Get-Prop $ad 'headlineEs') "intel_marketing_ad_examples" $ad $RunId $MarketSlug
    }
  }
}

function Build-ProductRows {
  param([hashtable]$Bag, [object]$Data, [string]$RunId, [string]$MarketSlug, [hashtable]$CompanySlugs)
  $productItems = Get-Prop $Data 'productItems'
  if (-not $productItems) { return }
  foreach ($prop in $productItems.PSObject.Properties) {
    $company = ConvertTo-Slug $prop.Name
    $CompanySlugs[$company] = $true
    foreach ($product in @($prop.Value)) {
      if (-not $product) { continue }
      $productId = if (Get-Prop $product 'id') { $product.id } else { New-HashKey "$RunId|$company|$(Get-Prop $product 'productName')" }
      Add-Row $Bag "intel_product_specs" @{
        run_id = $RunId; market_slug = $MarketSlug; product_id = $productId; company_slug = $company
        product_name = (Get-Prop $product 'productName'); product_type = (Get-Prop $product 'productType'); apr_cat = (Get-Prop $product 'aprCat')
        credit_limit = (Get-Prop $product 'creditLimit'); tenure = (Get-Prop $product 'tenure'); approval_speed = (Get-Prop $product 'approvalSpeed')
        kyc_requirements = (Get-Prop $product 'kycRequirements'); repayment_options = (Get-Prop $product 'repaymentOptions')
        fees = (Get-Prop $product 'fees'); rewards = (Get-Prop $product 'rewards'); distribution = (Get-Prop $product 'distribution')
        promise = (Get-Prop $product 'promise'); notes = (Get-Prop $product 'notes'); raw_payload = $product
      }
    }
  }
}

function Build-SentimentRows {
  param([hashtable]$Bag, [object]$Data, [string]$RunId, [string]$MarketSlug, [hashtable]$CompanySlugs)
  foreach ($item in @(Get-Prop $Data 'sentimentItems')) {
    if (-not $item) { continue }
    $slug = ConvertTo-Slug (Get-Prop $item 'competitor')
    if ($slug) { $CompanySlugs[$slug] = $true }
    $iid = if (Get-Prop $item 'id') { $item.id } else { New-HashKey "$RunId|$slug|sentiment" }
    Add-Row $Bag "intel_sentiment_items" @{
      run_id = $RunId; market_slug = $MarketSlug; item_id = $iid; company_slug = $slug
      score = "$(Get-Prop $item 'score')"; score_tier = (Get-Prop $item 'scoreTier')
      sources = @(Get-Prop $item 'sources'); complaints = @(Get-Prop $item 'complaints')
      praises = @(Get-Prop $item 'praises'); quotes = @(Get-Prop $item 'quotes'); raw_payload = $item
    }
  }
}

function Build-BusinessStatRows {
  param([hashtable]$Bag, [object]$Data, [string]$RunId, [string]$MarketSlug, [hashtable]$CompanySlugs)
  foreach ($item in @(Get-Prop $Data 'businessStats')) {
    if (-not $item) { continue }
    $slug = ConvertTo-Slug (Get-Prop $item 'competitor')
    if ($slug) { $CompanySlugs[$slug] = $true }
    $iid = if (Get-Prop $item 'id') { $item.id } else { New-HashKey "$RunId|$slug|bizstat" }
    Add-Row $Bag "intel_business_stats" @{
      run_id = $RunId; market_slug = $MarketSlug; item_id = $iid; company_slug = $slug
      users = (Get-Prop $item 'users'); loan_os = (Get-Prop $item 'loanOS'); revenue = (Get-Prop $item 'revenue')
      funding = (Get-Prop $item 'funding'); funding_advantage = (Get-Prop $item 'fundingAdvantage')
      est_cac = (Get-Prop $item 'estCAC'); est_promo_burn = (Get-Prop $item 'estPromoBurn')
      npl = (Get-Prop $item 'npl'); monetisation = (Get-Prop $item 'monetisation'); distribution = (Get-Prop $item 'distribution')
      ue_quality = (Get-Prop $item 'ueQuality'); ue_confidence = (Get-Prop $item 'ueConfidence')
      threat_level = (Get-Prop $item 'threatLevel'); threat_why = (Get-Prop $item 'threatWhy')
      implication = (Get-Prop $item 'implication'); raw_payload = $item
    }
  }
}

function Build-MacroRows {
  param([hashtable]$Bag, [object]$Data, [string]$RunId, [string]$MarketSlug)
  $macro = Get-Prop $Data 'macroData'
  if (-not $macro) { return }
  Add-Row $Bag "intel_macro_snapshots" @{ run_id = $RunId; market_slug = $MarketSlug; raw_payload = $macro }
  $ord = 0
  foreach ($indicator in @(Get-Prop $macro 'indicators')) {
    if (-not $indicator) { continue }
    Add-Row $Bag "intel_macro_indicators" @{
      run_id = $RunId; market_slug = $MarketSlug; ordinal = $ord
      label = (Get-Prop $indicator 'label'); value = (Get-Prop $indicator 'value')
      note = (Get-Prop $indicator 'note'); color = (Get-Prop $indicator 'color'); raw_payload = $indicator
    }; $ord++
  }
  $ratesData = Get-Prop $macro 'ratesData'
  if ($ratesData) {
    foreach ($prop in $ratesData.PSObject.Properties) {
      Add-Row $Bag "intel_macro_series" @{ run_id = $RunId; market_slug = $MarketSlug; series_group = "ratesData"; series_name = $prop.Name; values_json = @($prop.Value) }
    }
  }
  $nplData = Get-Prop $macro 'nplData'
  if ($nplData) {
    foreach ($prop in $nplData.PSObject.Properties) {
      Add-Row $Bag "intel_macro_series" @{ run_id = $RunId; market_slug = $MarketSlug; series_group = "nplData"; series_name = $prop.Name; values_json = @($prop.Value) }
    }
  }
  # All rows must share identical keys (PostgREST requirement) — use null for missing fields
  $ord = 0
  foreach ($regItem in @(Get-Prop $macro 'regulatory')) {
    if (-not $regItem) { continue }
    Add-Row $Bag "intel_macro_events" @{
      run_id = $RunId; market_slug = $MarketSlug; event_group = "regulatory"; ordinal = $ord
      event_date = (Get-Prop $regItem 'date'); period = $null
      event = (Get-Prop $regItem 'event'); impact = (Get-Prop $regItem 'impact')
      note = (Get-Prop $regItem 'note'); raw_payload = $regItem
    }; $ord++
  }
  $ord = 0
  foreach ($seasItem in @(Get-Prop $macro 'seasonal')) {
    if (-not $seasItem) { continue }
    Add-Row $Bag "intel_macro_events" @{
      run_id = $RunId; market_slug = $MarketSlug; event_group = "seasonal"; ordinal = $ord
      event_date = $null; period = (Get-Prop $seasItem 'period')
      event = (Get-Prop $seasItem 'event'); impact = $null
      note = (Get-Prop $seasItem 'note'); raw_payload = $seasItem
    }; $ord++
  }
}

# ── insert order (respects FK constraints) ────────────────────────────────────
$insertOrder = @(
  "intel_markets", "intel_companies", "intel_ingestion_runs",
  "intel_source_links", "intel_news_items", "intel_upcoming_events",
  "intel_marketing_items_archive", "intel_marketing_funnels", "intel_marketing_channels",
  "intel_marketing_message_pillars", "intel_marketing_campaigns", "intel_marketing_promotions",
  "intel_marketing_ad_examples", "intel_product_specs", "intel_sentiment_items",
  "intel_business_stats", "intel_macro_snapshots", "intel_macro_indicators",
  "intel_macro_series", "intel_macro_events"
)

# ── main: parse HTML ──────────────────────────────────────────────────────────
Write-Host "Reading $IndexPath ..."
$html = Get-Content -Raw -LiteralPath $IndexPath

Write-Host "Parsing const DATA (Mexico) ..."
$mxData = Convert-JsObjectLiteralToObject (Get-JsObjectLiteral $html "const DATA =")

Write-Host "Parsing const mktAds ..."
$mktAds = Convert-JsObjectLiteralToObject (Get-JsObjectLiteral $html "const mktAds =")

Write-Host "Parsing per-market data from MARKET_DATA ..."
# MARKET_DATA.mx is a JS reference to DATA (not an inline object), so we extract
# each non-MX market by finding its key inside the MARKET_DATA block directly.
function Get-MarketDataLiteral {
  param([string]$Html, [string]$MarketKey)
  # Find "  br: {" (or ph/id) inside MARKET_DATA block
  $marker = "  ${MarketKey}: {"
  $markerIdx = $Html.IndexOf($marker)
  if ($markerIdx -lt 0) { return $null }
  # Back up to the opening brace
  $start = $Html.IndexOf("{", $markerIdx)
  if ($start -lt 0) { return $null }
  $depth = 0; $inString = $false; $stringQuote = [char]0
  $inLineComment = $false; $inBlockComment = $false
  for ($i = $start; $i -lt $Html.Length; $i++) {
    $ch = $Html[$i]; $next = if ($i + 1 -lt $Html.Length) { $Html[$i+1] } else { [char]0 }
    if ($inLineComment)  { if ($ch -eq "`n") { $inLineComment = $false }; continue }
    if ($inBlockComment) { if ($ch -eq "*" -and $next -eq "/") { $inBlockComment = $false; $i++ }; continue }
    if ($inString) {
      if ($ch -eq "\") { $i++; continue }
      if ($ch -eq $stringQuote) { $inString = $false }
      continue
    }
    if ($ch -eq "/" -and $next -eq "/") { $inLineComment = $true; $i++; continue }
    if ($ch -eq "/" -and $next -eq "*") { $inBlockComment = $true; $i++; continue }
    if ($ch -eq "'" -or $ch -eq '"' -or $ch -eq [char]96) { $inString = $true; $stringQuote = $ch; continue }
    if ($ch -eq "{") { $depth++ }
    if ($ch -eq "}") { $depth--; if ($depth -eq 0) { return $Html.Substring($start, $i - $start + 1) } }
  }
  return $null
}

$nonMxData = @{}
foreach ($slug in @("br", "ph", "id")) {
  Write-Host "  Parsing $slug ..."
  $literal = Get-MarketDataLiteral $html $slug
  if ($literal) {
    try { $nonMxData[$slug] = Convert-JsObjectLiteralToObject $literal }
    catch { Write-Host "  WARNING: failed to parse $slug - $($_.Exception.Message)" }
  } else {
    Write-Host "  WARNING: could not find data block for $slug"
  }
}

# Stitch mxData + mktAds into the mx slot (MARKET_DATA.mx just points to DATA)
$mxData | Add-Member -NotePropertyName "mktAds" -NotePropertyValue $mktAds -Force
$capturedAt = (Get-Date).ToUniversalTime().ToString("o")

# ── process each market ───────────────────────────────────────────────────────
foreach ($marketSlug in @("mx", "br", "ph", "id")) {
  $meta = $marketMeta[$marketSlug]
  $runId = ([guid]::NewGuid()).ToString()

  Write-Host ""
  Write-Host "=== Market: $marketSlug ($($meta.name)) | RunId: $runId ==="

  # Pick the right data object
  $data = if ($marketSlug -eq "mx") { $mxData } else { $nonMxData[$marketSlug] }
  if (-not $data) { Write-Host "  No data found for $marketSlug, skipping."; continue }

  $companySlugs = @{}
  $rows = @{}

  # Market row (schema already has it seeded, but upsert is harmless)
  Add-Row $rows "intel_markets" @{
    slug = $marketSlug; name = $meta.name; country_code = $meta.countryCode; currency_code = $meta.currencyCode
  }

  # Counts for ingestion run
  $newsCount    = @(Get-Prop $data 'newsItems').Count
  $eventCount   = @(Get-Prop $data 'upcomingEvents').Count
  $mktOldVal    = Get-Prop $data 'marketingItems_old'
  $mktOldCount  = if ($mktOldVal) { @($mktOldVal).Count } else { 0 }
  $funnelsVal   = Get-Prop $data 'mktFunnels'
  $funnelCount  = if ($funnelsVal) { @($funnelsVal.PSObject.Properties).Count } else { 0 }
  $prodVal      = Get-Prop $data 'productItems'
  $prodCount    = if ($prodVal) { (@($prodVal.PSObject.Properties | ForEach-Object { @($_.Value).Count }) | Measure-Object -Sum).Sum } else { 0 }
  $sentCount    = @(Get-Prop $data 'sentimentItems').Count
  $bizCount     = @(Get-Prop $data 'businessStats').Count
  $adsCount     = if ($marketSlug -eq "mx" -and $mktAds) { (@($mktAds.PSObject.Properties | ForEach-Object { @($_.Value).Count }) | Measure-Object -Sum).Sum } else { 0 }

  $counts = [ordered]@{
    newsItems = $newsCount; upcomingEvents = $eventCount; marketingItemsOld = $mktOldCount;
    mktFunnels = $funnelCount; productItems = $prodCount; sentimentItems = $sentCount;
    businessStats = $bizCount; mktAds = $adsCount
  }

  Add-Row $rows "intel_ingestion_runs" @{
    id = $runId; market_slug = $marketSlug; run_type = $RunType; source_file = $SourceFile;
    captured_at = $capturedAt; status = "completed"; raw_counts = $counts;
    metadata = @{ importer = "scripts/import-index-to-supabase.ps1" }
  }
  # Snapshot is uploaded separately via Invoke-SupabaseInsertSnapshot (bypasses ConvertTo-Json depth limits)

  Build-NewsRows        $rows $data $runId $marketSlug
  Build-EventRows       $rows $data $runId $marketSlug
  Build-MarketingRows   $rows $data $runId $marketSlug $companySlugs
  if ($marketSlug -eq "mx") { Build-AdRows $rows $mktAds $runId $marketSlug $companySlugs }
  Build-ProductRows     $rows $data $runId $marketSlug $companySlugs
  Build-SentimentRows   $rows $data $runId $marketSlug $companySlugs
  Build-BusinessStatRows $rows $data $runId $marketSlug $companySlugs
  Build-MacroRows       $rows $data $runId $marketSlug

  foreach ($slug in $companySlugs.Keys) {
    Add-Row $rows "intel_companies" @{ market_slug = $marketSlug; slug = $slug; name = (Get-CompanyName $slug); aliases = @() }
  }

  # Print counts
  Write-Host "  Counts:"
  $counts.GetEnumerator() | ForEach-Object { Write-Host ("    {0}: {1}" -f $_.Key, $_.Value) }

  # Snapshot JSON
  if ($WriteSnapshotJson) {
    if (-not (Test-Path -LiteralPath $SnapshotDir)) { New-Item -ItemType Directory -Path $SnapshotDir | Out-Null }
    $snapPath = Join-Path $SnapshotDir "$marketSlug-snapshot.json"
    $data | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $snapPath -Encoding UTF8
    Write-Host "  Wrote snapshot: $snapPath"
  }

  # Deduplicate source_links by link_key (same URL can appear on multiple items)
  if ($rows.ContainsKey("intel_source_links")) {
    $seen = @{}
    $rows["intel_source_links"] = [System.Collections.Generic.List[object]]@(
      $rows["intel_source_links"] | Where-Object { $k = $_.link_key; if (-not $seen[$k]) { $seen[$k] = $true; $true } else { $false } }
    )
  }

  # Upload this market
  Write-Host "  Uploading tables ..."
  foreach ($table in $insertOrder) {
    $tableRows = if ($rows.ContainsKey($table)) { @($rows[$table]) } else { @() }
    Invoke-SupabaseInsert $table $tableRows
  }
  # Snapshot uploaded separately to avoid ConvertTo-Json depth limits on large payload
  Invoke-SupabaseInsertSnapshot $runId $marketSlug $data 1

  # Mark all sections refreshed
  foreach ($section in @("digest", "marketing", "products", "sentiment", "macro")) {
    Invoke-SupabaseRpc "mark_section_refreshed" @{ p_market_slug = $marketSlug; p_section = $section }
  }
}

Write-Host ""
Write-Host "Done. Apply=$Apply"
