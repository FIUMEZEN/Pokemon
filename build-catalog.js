// Costruisce catalog.json: l'elenco locale di tutte le carte Pokemon con nome e
// prezzo, usato dalla tab "Perito" per riconoscere le carte scritte in un annuncio.
//
// Uso: node build-catalog.js
//
// Due fonti, la seconda facoltativa:
//  1. Cardmarket (listino + catalogo prodotti): nomi e prezzi. Pubblica, sempre
//     disponibile, nessun token. Da sola basta per far funzionare il perito.
//  2. CardTrader (blueprint): aggiunge numero di collezione ed espansione, che
//     servono a distinguere le versioni. Se e' bloccata da Cloudflare si salta:
//     il catalogo esce lo stesso, solo senza i numeri.
const fs = require("fs");
const path = require("path");

const DIR = __dirname;
const GUIDE = path.join(DIR, "cache-priceguide.json");
const PRODUCTS = path.join(DIR, "cache-products.json");
const BP_FILE = path.join(DIR, "cache-blueprints.json");
const OUT = path.join(DIR, "catalog.json");
const PRODUCTS_URL = "https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_6.json";
const API = "https://api.cardtrader.com/api/v2";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const loadJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
// "Charizard [Energy Burn | Fire Spin]" -> "Charizard"
const baseName = n => n.replace(/\s*[[(].*$/, "").trim();
// "124/191" -> "124"
const numberOf = v => (String(v || "").match(/([A-Z]{0,3}\d+)\s*\/\s*[A-Z]{0,3}\d+/i) || [])[1] || null;

async function cardTrader(p) {
  const token = (() => { try { return fs.readFileSync(path.join(DIR, "cardtrader-token.txt"), "utf8").trim(); } catch { return null; } })();
  if (!token) throw new Error("token assente");
  const r = await fetch(API + p, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(45000) });
  if (r.status === 403) throw new Error("bloccati da Cloudflare");
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

(async () => {
  // --- 1. prezzi ---
  const guide = loadJson(GUIDE, null);
  if (!guide) { console.error("Manca cache-priceguide.json: avvia prima il server (node server.js)."); process.exit(1); }
  const cm = new Map(guide.priceGuides.map(g => [g.idProduct, g]));
  console.log(`Listino Cardmarket del ${guide.createdAt.slice(0, 10)}: ${cm.size} prodotti.`);

  // --- 2. nomi ---
  let products = loadJson(PRODUCTS, null);
  if (!products) {
    console.log("Scarico il catalogo prodotti Cardmarket (~14 MB)...");
    const r = await fetch(PRODUCTS_URL, { signal: AbortSignal.timeout(180000) });
    if (!r.ok) { console.error("Download fallito: HTTP " + r.status); process.exit(1); }
    products = await r.json();
    fs.writeFileSync(PRODUCTS, JSON.stringify(products));
  }
  console.log(`Catalogo prodotti del ${products.createdAt.slice(0, 10)}: ${products.products.length} carte.`);

  // --- 3. numeri e nomi delle espansioni, se CardTrader risponde ---
  const extra = new Map();                        // idProduct Cardmarket -> { num, set }
  const bpCache = loadJson(BP_FILE, {});
  const addBlueprints = (list, setName) => {
    for (const b of list || []) {
      const id = b.card_market_ids?.[0];
      if (id == null || extra.has(id)) continue;
      extra.set(id, { num: numberOf(b.version), set: setName });
    }
  };
  try {
    const exps = (await cardTrader("/expansions")).filter(e => e.game_id === 5);
    console.log(`CardTrader raggiungibile: ${exps.length} espansioni, aggiungo numeri e set...`);
    let done = 0, dirty = false;
    for (const e of exps) {
      if (!bpCache[e.id]) {
        try {
          const raw = await cardTrader(`/blueprints/export?expansion_id=${e.id}`);
          // stessa forma di scanner.js, immagine compresa: la cache e' condivisa
          const img = b => { const u = b.image?.preview?.url || b.image?.url || b.image_url; return u ? (u.startsWith("/") ? "https://www.cardtrader.com" + u : u).replace("://cardtrader.com", "://www.cardtrader.com") : null; };
          bpCache[e.id] = (raw || []).map(b => ({ id: b.id, name: b.name, version: b.version, card_market_ids: b.card_market_ids, img: img(b) }));
          dirty = true;
          await sleep(250);                        // ritmo blando: Cloudflare blocca chi corre
        } catch (err) { console.log(`\n  interrotto: ${err.message}. Continuo con quello che ho.`); break; }
      }
      addBlueprints(bpCache[e.id], e.name);
      if (++done % 50 === 0) {
        if (dirty) { fs.writeFileSync(BP_FILE, JSON.stringify(bpCache)); dirty = false; }
        process.stdout.write(`\r  ${done}/${exps.length} espansioni · ${extra.size} carte con numero  `);
      }
    }
    if (dirty) fs.writeFileSync(BP_FILE, JSON.stringify(bpCache));
    console.log("");
  } catch (e) {
    console.log(`CardTrader non disponibile (${e.message}).`);
    for (const [id, v] of Object.entries(bpCache)) addBlueprints(v, null);   // usa la cache locale, se c'e'
    if (extra.size) console.log(`  Uso i ${extra.size} numeri gia' in cache.`);
    else console.log("  Il catalogo uscira' senza numeri di collezione: il perito dara' forbici piu' larghe.");
  }

  // --- 4. unione ---
  const cards = [];
  for (const p of products.products) {
    const g = cm.get(p.idProduct);
    if (!(g?.trend > 0 || g?.avg30 > 0)) continue;               // senza prezzo non serve
    const x = extra.get(p.idProduct);
    cards.push({
      n: baseName(p.name), full: p.name,
      num: x?.num ?? null, s: x?.set ?? null,
      t: g.trend ?? null, a: g.avg30 ?? null, l: g.low ?? null, th: g["trend-holo"] || null,
    });
  }
  cards.sort((a, b) => (b.t ?? 0) - (a.t ?? 0));
  fs.writeFileSync(OUT, JSON.stringify({
    builtAt: new Date().toISOString(), priceDate: guide.createdAt,
    withNumbers: cards.filter(c => c.num).length, cards,
  }));

  const names = new Set(cards.map(c => c.n));
  console.log(`\n${cards.length} carte con prezzo, ${names.size} nomi distinti, ${cards.filter(c => c.num).length} con numero di collezione.`);
  console.log(`Salvato in catalog.json (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB).`);
  console.log(`Carta piu' cara: ${cards[0].full} = ${cards[0].t} €`);
})().catch(e => { console.error("ERRORE:", e.message); process.exit(1); });
