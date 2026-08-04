// build.mjs — runs on the GitHub Actions runner (Node 20+, no dependencies).
//
// Cross-references two shared Google Sheets and writes ./public/data.json for the
// static dashboard. READ-ONLY: it only fetches the sheets via CSV/gviz export
// endpoints; it never writes to them.
//
// DATA MODEL (this account) --------------------------------------------------
//   1) Métricas dos Anúncios — aba "Meta Ads": Day / Campaign Name / Ad Set Name /
//      Ad Name / Amount Spent / Impressions / Link Clicks / Landing Page Views /
//      Checkouts Initiated. One row per day×campaign×conjunto×anúncio.
//   2) Lista de Compradores — DUAS abas somadas:
//        • "Vendas Geral"  → coluna espinha das VENDAS: Data|Hora, Nome (completo),
//          Produto, Bruto, Líquido. Tem o VALOR mas NÃO tem UTM.
//        • "BASE COMPLETA" → tem as UTMs (utm_source/medium/campaign/content) e o
//          PRIMEIRO nome do comprador, mas NÃO tem valor.
//      Cruzamos Vendas Geral ↔ BASE COMPLETA por PRIMEIRO NOME (+ data) para juntar
//      valor + atribuição, e então resolvemos o anúncio de origem.
//
// IMPOSTO: o gasto vai CRU (bruto) no data.json; o dashboard multiplica por meta.tax
// (×1,1385) antes de TODAS as métricas — assim nenhuma métrica escapa do imposto.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';

// --- Sources ----------------------------------------------------------------
const ADS_ID   = '1Q4KoC76d6aG7KG582jxYiLE3_bBeeNFyQ8gltg5BPq4';
const BUYERS_ID = '1-03Pwug1SlYVa8JoxYQYsi5Lj5xTb1UVrpY8qfpY3u4';

const SHEET_ADS   = `https://docs.google.com/spreadsheets/d/${ADS_ID}/export?format=csv&gid=0`;
const SHEET_BASE  = `https://docs.google.com/spreadsheets/d/${BUYERS_ID}/export?format=csv&gid=151354425`; // BASE COMPLETA
const SHEET_VENDAS = `https://docs.google.com/spreadsheets/d/${BUYERS_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('Vendas Geral')}`;

const ADS_URL   = `https://docs.google.com/spreadsheets/d/${ADS_ID}/edit`;
const BUYERS_URL = `https://docs.google.com/spreadsheets/d/${BUYERS_ID}/edit`;

// --- Tax on ad spend (applied in the dashboard, not here) -------------------
const TAX_RATE = 1.1385;

// --- utm_source values that mean "paid Meta traffic" ------------------------
const isPaidSource = (s) => /^(fb|facebook|facebook-ads|meta|meta-ads)$/i.test(String(s || '').trim());

// ---------------------------------------------------------------------------
// CSV parser (quoted fields, escaped quotes, embedded newlines)
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignore */ }
      else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Number in Brazilian or plain format: "1.234,56" / "46,9" / "197"
function num(s) {
  if (s == null) return 0;
  s = String(s).trim();
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

// Collapse whitespace + trim (join keys sometimes differ only by double spaces).
const normKey = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// Lowercase + strip accents (for name matching).
const fold = (s) => normKey(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const firstName = (s) => fold(s).split(' ')[0] || '';

// Decode a URL-encoded UTM then normalize.
function decodeUtm(s) {
  let v = String(s == null ? '' : s);
  if (v.includes('%')) { try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch { /* keep */ } }
  return normKey(v);
}
const isUtm = (s) => {
  const v = String(s == null ? '' : s).trim().toLowerCase();
  return v !== '' && v !== 'undefined' && !v.includes('{{');
};

// Meta appends "|<numeric id>" to UTM values. Strip a trailing "|<6+ digits>".
const stripId = (s) => decodeUtm(s).replace(/\s*\|\s*\d{6,}\s*$/, '').trim();
// utm_content = "<AdName>|<id>::<fbclid junk>::" → take the ad name before first "|".
const adFromContent = (s) => {
  let v = decodeUtm(s).split('::')[0];      // drop ::...:: tracking tail
  v = v.split('|')[0];                        // drop |<id>
  return normKey(v);
};

const pad = (n) => String(n).padStart(2, '0');

// Extract YYYY-MM-DD from "26/7/2026", "28/07/2026", "29/07/2026 | 09:20:55", ISO…
function isoDate(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);            // ISO
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);           // D/M/YYYY (Brazil)
  if (m) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`;
  return null;
}

async function fetchText(url, label) {
  const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'funnel-dashboard-build' } });
  if (!r.ok) throw new Error(`Fetch failed ${r.status} for ${label}`);
  const body = await r.text();
  if (/^\s*<!DOCTYPE html/i.test(body)) {
    throw new Error(`Got an HTML page instead of CSV for ${label} — the sheet is probably NOT shared publicly (set "Anyone with the link → Viewer").`);
  }
  return body;
}
const headerIndex = (h, name) => h.findIndex((x) => x.trim().toLowerCase() === name.toLowerCase());

(async () => {
  const [csvAds, csvBase, csvVendas] = await Promise.all([
    fetchText(SHEET_ADS, 'ads sheet'),
    fetchText(SHEET_BASE, 'BASE COMPLETA'),
    fetchText(SHEET_VENDAS, 'Vendas Geral'),
  ]);

  // ---------------- Sheet 1: Meta Ads metrics ----------------
  const a = parseCSV(csvAds);
  const h1 = a[0] || [];
  const I = {
    day:   headerIndex(h1, 'Day'),
    camp:  headerIndex(h1, 'Campaign Name'),
    set:   headerIndex(h1, 'Ad Set Name'),
    ad:    headerIndex(h1, 'Ad Name'),
    spend: headerIndex(h1, 'Amount Spent'),
    imp:   headerIndex(h1, 'Impressions'),
    clk:   headerIndex(h1, 'Link Clicks'),
    lpv:   headerIndex(h1, 'Landing Page Views'),
    chk:   headerIndex(h1, 'Checkouts Initiated'),
  };
  const ads = [];
  for (let i = 1; i < a.length; i++) {
    const r = a[i];
    if (!r || r.length < 2) continue;
    const day = String(r[I.day] || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    ads.push({
      d: day,
      c: normKey(r[I.camp]),
      s: normKey(r[I.set]),
      a: normKey(r[I.ad]),
      spend: num(r[I.spend]),                       // GROSS — tax applied in dashboard
      imp: Math.round(num(r[I.imp])),
      clk: Math.round(num(r[I.clk])),
      lpv: I.lpv >= 0 ? Math.round(num(r[I.lpv])) : 0,
      ic:  I.chk >= 0 ? Math.round(num(r[I.chk])) : 0,
    });
  }

  // Ad-name → {campaign, adset} it spent most under (authoritative attribution).
  const spendByCombo = new Map(); // adKey -> Map("c||s" -> spend)
  const adOriginal   = new Map(); // adKey(folded) -> original ad name
  for (const r of ads) {
    if (!r.a) continue;
    const ak = fold(r.a);
    adOriginal.set(ak, r.a);
    const m = spendByCombo.get(ak) || new Map();
    const k = r.c + '||' + r.s;
    m.set(k, (m.get(k) || 0) + r.spend);
    spendByCombo.set(ak, m);
  }
  const adToCombo = new Map(); // adKey -> {c, s, a}
  for (const [ak, m] of spendByCombo) {
    let best = null, bestSpend = -Infinity;
    for (const [k, sp] of m) if (sp > bestSpend) { bestSpend = sp; best = k; }
    const [c, s] = (best || '||').split('||');
    adToCombo.set(ak, { c, s, a: adOriginal.get(ak) });
  }
  // Canonical name lookups (folded → original ads-sheet spelling) so a sale's
  // campaign/conjunto/anúncio join EXACTLY to the ad rows in the grouping tables.
  const canonCamp = new Map(), canonSet = new Map(), canonAd = new Map();
  for (const r of ads) {
    if (r.c) canonCamp.set(fold(r.c), r.c);
    if (r.s) canonSet.set(fold(r.s), r.s);
    if (r.a) canonAd.set(fold(r.a), r.a);
  }
  // Resolve an ad-name candidate: exact fold match, else longest common-prefix
  // (≥6 chars) against known ad names. Returns the canonical ad name or ''.
  function resolveAdName(cand) {
    const c = fold(cand);
    if (!c) return '';
    if (canonAd.has(c)) return canonAd.get(c);
    let best = '', bestLen = 0;
    for (const [ak, orig] of canonAd) {
      let n = 0; const L = Math.min(ak.length, c.length);
      while (n < L && ak[n] === c[n]) n++;
      if (n >= 6 && n > bestLen) { bestLen = n; best = orig; }
    }
    return best;
  }

  // ---------------- Sheet 2a: BASE COMPLETA (UTMs by first name) ----------------
  const b = parseCSV(csvBase);
  const h2 = b[0] || [];
  const B = {
    date:  headerIndex(h2, 'DATA'),
    name:  headerIndex(h2, 'NOME'),
    src:   headerIndex(h2, 'utm_source'),
    med:   headerIndex(h2, 'utm_medium'),
    camp:  headerIndex(h2, 'utm_campaign'),
    cont:  headerIndex(h2, 'utm_content'),
  };
  const leadByND = new Map(); // "first|date" -> lead
  const leadByN  = new Map(); // "first" -> lead (first occurrence)
  for (let i = 1; i < b.length; i++) {
    const r = b[i];
    if (!r || r.length < 2) continue;
    const fn = firstName(r[B.name]);
    if (!fn) continue;
    const d = isoDate(r[B.date]);
    const lead = {
      src: String(r[B.src] || '').trim(),
      camp: r[B.camp], med: r[B.med], cont: r[B.cont],
    };
    if (d) leadByND.set(fn + '|' + d, lead);
    if (!leadByN.has(fn)) leadByN.set(fn, lead);
  }

  // ---------------- Sheet 2b: Vendas Geral (sales spine + value) ----------------
  const v = parseCSV(csvVendas);
  const h3 = v[0] || [];
  const V = {
    date: headerIndex(h3, 'Data | Hora') >= 0 ? headerIndex(h3, 'Data | Hora') : 0,
    name: headerIndex(h3, 'Nome'),
    prod: headerIndex(h3, 'Produto'),
    val:  headerIndex(h3, 'Bruto'),
  };
  const sales = [];
  const attribution = { ad: 0, adset: 0, campaign: 0, none: 0 };
  let salesRows = 0, trafficSales = 0, unmatchedName = 0;

  for (let i = 1; i < v.length; i++) {
    const r = v[i];
    if (!r || r.length < 2) continue;
    const d = isoDate(r[V.date]);
    if (!d) continue;
    const value = num(r[V.val]);
    if (!(value > 0)) continue;                    // skip empty/zero rows
    salesRows++;

    const fn = firstName(r[V.name]);
    const lead = leadByND.get(fn + '|' + d) || leadByN.get(fn) || null;
    if (!lead) unmatchedName++;

    const paid = lead ? isPaidSource(lead.src) : false;
    let src = 'organico', m = '', c = '', s = '', ad = '';

    if (paid) {
      src = 'meta-ads';
      // This account's UTMs = "<name>|<meta id>" (utm_content also has a ::tracking:: tail).
      // Strip the id → cleaned values match the ads sheet EXACTLY; map to canonical spelling.
      ad = resolveAdName(adFromContent(lead.cont));
      const uCamp = stripId(lead.camp), uSet = stripId(lead.med);
      const adCombo = ad ? adToCombo.get(fold(ad)) : null;
      c = canonCamp.get(fold(uCamp)) || (adCombo ? adCombo.c : '') || (isUtm(uCamp) ? uCamp : '');
      s = canonSet.get(fold(uSet))  || (adCombo ? adCombo.s : '') || (isUtm(uSet)  ? uSet  : '');
      m = ad ? 'ad' : (c ? 'campaign' : 'none');
      trafficSales++;
      attribution[m]++;
    }
    sales.push({ d, v: Math.round(value * 100) / 100, src, m, c, s, a: ad });
  }

  // ---------------- Output (reference data.json contract) ----------------
  const allDates = [...ads.map((x) => x.d), ...sales.map((x) => x.d)].sort();
  const nowBR = new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).replace(',', '');

  const warnings = [];
  if (unmatchedName > 0) warnings.push(`${unmatchedName} venda(s) sem correspondência de nome na aba BASE COMPLETA — contadas como orgânico/não atribuído.`);
  if (attribution.none > 0) warnings.push(`${attribution.none} venda(s) de tráfego pago sem anúncio resolvido (UTM incompleta).`);

  const out = {
    meta: {
      title: 'CPGD-AGO26 — Meta Ads',
      platform: 'Meta Ads',
      traffic_source: 'meta-ads',
      tax: TAX_RATE,
      currency: 'BRL',
      generated_at_br: nowBR,
      date_min: allDates[0] || null,
      date_max: allDates[allDates.length - 1] || null,
      ads_url: ADS_URL,
      sales_url: BUYERS_URL,
      sales_tab: 'Vendas Geral + BASE COMPLETA',
      counts: {
        ads_rows: ads.length,
        sales_rows: salesRows,
        traffic_sales: trafficSales,
        attribution,
      },
      warnings,
    },
    ads,
    sales,
  };

  mkdirSync('public', { recursive: true });
  writeFileSync('public/data.json', JSON.stringify(out));

  // Cache-bust: stamp the current build id into index.html.
  try {
    const buildId = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    let html = readFileSync('public/index.html', 'utf8');
    html = html.replace(/const BUILD_ID = "[^"]*";/, `const BUILD_ID = "${buildId}";`);
    writeFileSync('public/index.html', html);
  } catch (e) { console.warn('BUILD_ID stamp skipped:', e.message); }

  console.log('Wrote public/data.json', out.meta.counts, out.meta.date_min, '→', out.meta.date_max);
  if (ads.length === 0) throw new Error('No ad rows parsed — aborting so the previous deploy is kept.');
})().catch((err) => { console.error(err); process.exit(1); });
