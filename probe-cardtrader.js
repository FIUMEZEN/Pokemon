// Verifica delle ipotesi sull'API CardTrader + primo calcolo di margini REALI.
//
// Uso:
//   1. metti il token CardTrader in  cardtrader-token.txt  (una riga, niente altro)
//   2. node probe-cardtrader.js
//
// Non compra e non vende niente: fa solo letture.
const fs = require("fs");
const path = require("path");

const API = "https://api.cardtrader.com/api/v2";
const TOKEN_FILE = path.join(__dirname, "cardtrader-token.txt");
const GUIDE_FILE = path.join(__dirname, "cache-priceguide.json");

// costi di rivendita su Cardmarket (stessi valori dell'app)
const FEE_PCT = 5, FEE_FIX = 0, SHIP_OUT = 1.5, SHIP_IN = 1.5;

const eur = n => n == null ? "n/d" : n.toFixed(2) + " €";
const sleep = ms => new Promise(r => setTimeout(r, ms));

let token;
try {
  token = fs.readFileSync(TOKEN_FILE, "utf8").trim();
  if (!token) throw new Error("vuoto");
} catch {
  console.error(`\nManca il token. Crea il file:\n  ${TOKEN_FILE}\ne incollaci dentro il token preso da cardtrader.com (impostazioni profilo > API).\n`);
  process.exit(1);
}

async function get(p) {
  const r = await fetch(`${API}${p}`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": "pokemon-trader/1.0" },
    signal: AbortSignal.timeout(60000),
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} su ${p}: ${body.slice(0, 200)}`);
  return JSON.parse(body);
}

const step = (n, t) => console.log(`\n=== ${n}. ${t} ${"=".repeat(Math.max(0, 50 - t.length))}`);

(async () => {
  step(1, "Il token funziona?");
  const info = await get("/info");
  console.log("  OK, account:", info.username ?? JSON.stringify(info).slice(0, 120));

  step(2, "Qual e' il gioco Pokemon?");
  const games = (await get("/games")).array ?? (await get("/games"));
  const list = Array.isArray(games) ? games : games.array ?? [];
  const poke = list.find(g => /pok[eé]mon/i.test(g.name || g.display_name || ""));
  if (!poke) { console.log("  Giochi trovati:", JSON.stringify(list).slice(0, 300)); throw new Error("Pokemon non trovato"); }
  console.log(`  game_id = ${poke.id} (${poke.name})`);

  step(3, "Quante espansioni Pokemon?");
  const allExp = await get("/expansions");
  const exps = (Array.isArray(allExp) ? allExp : allExp.array ?? []).filter(e => e.game_id === poke.id);
  console.log(`  ${exps.length} espansioni. Esempi:`, exps.slice(-3).map(e => `${e.code}=${e.name}`).join(", "));

  // espansione di prova: una grossa e liquida, non una novita' asiatica senza offerte
  const test = exps.find(e => e.code === (process.argv[2] || "ssp")) || exps[exps.length - 1];
  step(4, `I blueprint hanno card_market_ids? (espansione ${test.name})`);
  const bps = await get(`/blueprints/export?expansion_id=${test.id}`);
  const bpArr = Array.isArray(bps) ? bps : bps.array ?? [];
  const withCm = bpArr.filter(b => (b.card_market_ids || []).length);
  console.log(`  ${bpArr.length} blueprint, di cui ${withCm.length} con card_market_ids (${Math.round(withCm.length / bpArr.length * 100)}%)`);
  console.log("  esempio:", JSON.stringify(bpArr[0]).slice(0, 300));

  step(5, "Le offerte reali hanno condizione e lingua?");
  const prods = await get(`/marketplace/products?expansion_id=${test.id}`);
  const flat = Object.values(prods).flat();
  console.log(`  ${flat.length} offerte su ${Object.keys(prods).length} carte`);
  if (!flat.length) throw new Error(`nessuna offerta nell'espansione ${test.code}: riprova con "node probe-cardtrader.js <codice>"`);
  console.log("  esempio offerta:", JSON.stringify(flat[0], null, 1).slice(0, 700));
  const props = {};
  for (const p of flat) for (const [k, v] of Object.entries(p.properties_hash || {})) (props[k] ??= new Set()).add(String(v));
  console.log("\n  valori distinti trovati nelle proprieta':");
  for (const [k, v] of Object.entries(props)) console.log(`    ${k}: ${[...v].slice(0, 8).join(" | ")}${v.size > 8 ? " ..." : ""}`);

  step(6, "Incrocio con il listino Cardmarket -> margini VERI");
  const guide = JSON.parse(fs.readFileSync(GUIDE_FILE, "utf8"));
  const cm = new Map(guide.priceGuides.map(g => [g.idProduct, g]));
  console.log(`  listino Cardmarket del ${guide.createdAt.slice(0, 10)}, ${cm.size} prodotti`);

  const bpById = new Map(bpArr.map(b => [b.id, b]));
  const deals = [];
  for (const p of flat) {
    const bp = bpById.get(p.blueprint_id);
    const cmId = bp?.card_market_ids?.[0];
    const g = cmId != null ? cm.get(cmId) : null;
    if (!g?.trend) continue;
    if (p.price?.currency !== "EUR") continue;
    const cond = p.properties_hash?.condition;
    if (cond && !/Near Mint|Mint/i.test(cond)) continue;   // solo NM o migliore
    const buy = p.price.cents / 100;
    const ricavo = g.trend * (1 - FEE_PCT / 100) - FEE_FIX - SHIP_OUT;
    const costo = buy + SHIP_IN;
    const profit = ricavo - costo;
    deals.push({ name: bp.name, cond, lang: p.properties_hash?.pokemon_language ?? p.properties_hash?.language,
      buy, trend: g.trend, avg7: g.avg7, avg30: g.avg30, profit, roi: profit / costo, seller: p.user?.username, qty: p.quantity });
  }
  deals.sort((a, b) => b.roi - a.roi);
  console.log(`\n  ${deals.length} offerte NM in EUR collegate a un prezzo Cardmarket`);
  const good = deals.filter(d => d.roi >= 0.2);
  console.log(`  di cui con ROI >= 20%: ${good.length}\n`);
  console.log("  I primi 15 candidati (SOLO questa espansione di prova):");
  for (const d of good.slice(0, 15)) {
    const trendDir = d.avg7 && d.avg30 ? (d.avg7 >= d.avg30 ? "in salita" : "in calo") : "?";
    console.log(`   ${(d.roi * 100).toFixed(0).padStart(4)}%  ${eur(d.profit).padStart(9)}  compri ${eur(d.buy).padStart(9)} -> trend ${eur(d.trend).padStart(9)}  [${trendDir}]  x${d.qty}  ${d.name?.slice(0, 40)} (${d.lang ?? "?"}, ${d.cond ?? "?"})`);
  }
  console.log("\nFatto. Nessun acquisto effettuato: solo letture.");
})().catch(e => { console.error("\nERRORE:", e.message); process.exit(1); });
