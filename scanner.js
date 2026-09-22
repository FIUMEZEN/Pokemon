// Scanner automatico: cerca su CardTrader annunci messi in vendita SOTTO il prezzo
// di mercato della stessa carta, e calcola il guadagno netto reale della rivendita.
//
// Uso:
//   node scanner.js            scansione completa (tutte le espansioni Pokemon)
//   node scanner.js ssp evs bs solo queste espansioni (codici)
//   node scanner.js --max 60   limite di spesa per carta, in euro
//
// Scrive opportunities.json, che l'app legge nella tab "Affari".
// NON compra niente: fa solo letture.
const fs = require("fs");
const path = require("path");

const API = "https://api.cardtrader.com/api/v2";
const GAME_POKEMON = 5;
const TOKEN = fs.readFileSync(path.join(__dirname, "cardtrader-token.txt"), "utf8").trim();
const OUT = path.join(__dirname, "opportunities.json");
const GUIDE_FILE = path.join(__dirname, "cache-priceguide.json");

// --- regole di selezione -------------------------------------------------
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : def; };
const CFG = {
  minBuy: opt("--min", 3),        // sotto questa cifra la spedizione si mangia tutto
  maxBuy: opt("--max", 80),       // tetto per singola carta
  minDepth: 5,                    // servono almeno 5 offerte NM: sotto non c'e' un mercato
  minGap: 0.25,                   // l'annuncio deve stare almeno il 25% sotto il mercato
  minProfit: 3,                   // guadagno netto minimo in euro
  minRoi: 0.20,                   // ROI netto minimo
  // costi (venditore UE iscritto dopo marzo 2026: 5,3% + IVA 22%)
  feePct: 5.3 * 1.22,
  shipIn: 1.5,                    // spedizione pagata comprando
  shipOut: 0,                     // vendendo la spedizione la paga il compratore
};
const codes = args.filter(a => !a.startsWith("--") && !/^\d+(\.\d+)?$/.test(a));

// --- utilita' ------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));

// CardTrader sta dietro Cloudflare: oltre ai limiti dichiarati (200 req/10s) c'e' una
// protezione anti-bot che risponde 403 "Just a moment..." se si va troppo veloci.
// Si tiene un ritmo blando e si aspetta a lungo quando arriva un 403.
async function get(p, tries = 5) {
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(i * 3000);
    try {
      const r = await fetch(API + p, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: AbortSignal.timeout(60000) });
      if (r.status === 429 || r.status === 403) {
        if (i === tries - 1) throw new Error(r.status === 403 ? "bloccati da Cloudflare: aspetta qualche minuto e riprova" : "troppe richieste");
        await sleep(10000);
        continue;
      }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) { if (i === tries - 1) throw e; }
  }
}

// I blueprint (nome, numero, set, id Cardmarket) non cambiano: si salvano una volta
// e non si riscaricano piu'. Dimezza le richieste e riduce il rischio di blocco.
const BP_FILE = path.join(__dirname, "cache-blueprints.json");
const loadJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const bpCache = loadJson(BP_FILE, {});
let bpDirty = false;
async function blueprints(expId) {
  if (bpCache[expId]?.every(b => "img" in b)) return bpCache[expId];     // voci vecchie senza immagine: si riscaricano
  const raw = await get(`/blueprints/export?expansion_id=${expId}`) || [];
  bpCache[expId] = raw.map(b => ({ id: b.id, name: b.name, version: b.version, card_market_ids: b.card_market_ids, img: cardImage(b) }));
  bpDirty = true;
  return bpCache[expId];
}
const saveBlueprints = () => { if (bpDirty) { fs.writeFileSync(BP_FILE, JSON.stringify(bpCache)); bpDirty = false; } };
// Immagine della carta. Gli indirizzi senza "www" rimandano a www.cardtrader.com: si salva
// direttamente quello finale.
function cardImage(b) {
  const u = b.image?.preview?.url || b.image?.url || b.image_url;
  if (!u) return null;
  return (u.startsWith("/") ? "https://www.cardtrader.com" + u : u).replace("://cardtrader.com", "://www.cardtrader.com");
}
let failed = 0;
async function pool(items, n, fn, onDone) {
  let i = 0, done = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) {
      const it = items[i++];
      try { await fn(it); } catch (e) { failed++; }     // un'espansione che fallisce non ferma la scansione
      onDone?.(++done, items.length);
    }
  }));
}

// Il listino Cardmarket prezza le stampe europee. Le carte jp/kr/zh sono un altro
// mercato e il confronto non regge: si escludono.
const LANGS = new Set(["en", "it", "de", "fr", "es", "pt"]);
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// --- scansione di una espansione ----------------------------------------
function analyse(exp, blueprints, products, cm) {
  const bp = new Map(blueprints.map(b => [b.id, b]));
  const out = [];
  for (const [bid, list] of Object.entries(products)) {
    const b = bp.get(+bid);
    if (!b) continue;
    // solo carte singole non gradate, prezzo in euro, condizione perfetta
    const nm = list
      .filter(p => p.properties_hash?.condition === "Near Mint" && p.price_currency === "EUR"
        && !p.graded && !p.on_vacation && !p.properties_hash?.altered && !p.properties_hash?.signed
        && LANGS.has(p.properties_hash?.pokemon_language))
      .map(p => ({
        v: p.price_cents / 100, qty: p.quantity, seller: p.user?.username, country: p.user?.country_code,
        lang: p.properties_hash?.pokemon_language, rev: !!p.properties_hash?.pokemon_reverse, id: p.id,
        note: (p.description || "").trim().slice(0, 80) || null,   // spesso rivela "info in privato", difetti, ecc.
      }))
      .sort((a, b) => a.v - b.v);

    // normale e reverse sono due carte diverse: si valutano separatamente
    for (const rev of [false, true]) {
      const g = nm.filter(x => x.rev === rev);
      if (g.length < CFG.minDepth) continue;
      const best = g[0];
      if (best.v < CFG.minBuy || best.v > CFG.maxBuy) continue;

      // mediana delle altre offerte: regge anche se qualcuno mette prezzi assurdi come segnaposto
      const market = median(g.slice(1).map(x => x.v));
      const gap = (market - best.v) / market;
      if (gap < CFG.minGap) continue;

      // Il riferimento Cardmarket e' OBBLIGATORIO: e' la seconda fonte indipendente.
      // Senza, resterebbe solo CardTrader e un annuncio-spazzatura basterebbe a inventare un affare.
      const cmId = b.card_market_ids?.[0];
      const guide = cmId != null ? cm.get(cmId) : null;
      // trend e media a 30 giorni divergono spesso (es. Dark Gyarados: trend 218 ma avg30 114).
      // avg30 e' la media delle vendite REALI: si prende sempre la piu' prudente delle due.
      const refs = [rev ? guide?.["trend-holo"] : guide?.trend, rev ? guide?.["avg30-holo"] : guide?.avg30].filter(x => x > 0);
      if (!refs.length) continue;
      const cmRef = Math.min(...refs);
      // se le due fonti si contraddicono di oltre 3 volte, il dato non e' affidabile
      const ratio = market / cmRef;
      if (ratio < 1 / 3 || ratio > 3) continue;
      const sell = Math.min(market, cmRef);       // sempre la piu' prudente delle due

      const cost = best.v + CFG.shipIn;
      const net = p => p * (1 - CFG.feePct / 100) - CFG.shipOut - cost;
      const profit = net(sell);                   // scenario paziente: aspetti che le offerte sotto si esauriscano
      const roi = profit / cost;
      // scenario veloce: ti metti subito sotto la seconda offerta per vendere in giornata
      const sellFast = Math.min(g[1].v, cmRef);
      const profitFast = net(sellFast);
      // un affare deve reggere anche vendendo subito, altrimenti e' solo una scommessa sull'attesa
      if (profitFast <= 0) continue;
      if (profit < CFG.minProfit || roi < CFG.minRoi) continue;

      out.push({
        name: b.name, version: b.version || null, expansion: exp.name, code: exp.code,
        reverse: rev, lang: best.lang, buy: +best.v.toFixed(2), market: +market.toFixed(2),
        cmTrend: cmRef ?? null, sell: +sell.toFixed(2),
        sellFast: +sellFast.toFixed(2), profitFast: +profitFast.toFixed(2),
        profit: +profit.toFixed(2), roi: +roi.toFixed(3), depth: g.length, qty: best.qty,
        suspect: roi > 1.5,                        // guadagni cosi' alti sono quasi sempre dati sbagliati
        // annuncio isolato: sotto meta' del secondo prezzo. O e' un errore del venditore (ottimo)
        // o e' una carta non come descritta / una truffa. Va guardato con sospetto, non con entusiasmo.
        lonely: best.v < g[1].v * 0.5,
        note: best.note || null,
        seller: best.seller, country: best.country,
        url: `https://www.cardtrader.com/cards/${b.id}`,
        image: b.img || null,
      });
    }
  }
  return out;
}

// --- programma principale ------------------------------------------------
(async () => {
  const guideRaw = JSON.parse(fs.readFileSync(GUIDE_FILE, "utf8"));
  const cm = new Map(guideRaw.priceGuides.map(g => [g.idProduct, g]));
  console.log(`Listino Cardmarket del ${guideRaw.createdAt.slice(0, 10)} (${cm.size} prodotti) come riferimento prudenziale.`);

  // Tre modi:
  //  - completo (nessun argomento): tutte le espansioni che possono dare occasioni;
  //  - veloce (--hot): solo le espansioni "calde", cioe' quelle che nell'ultimo giro completo
  //    hanno dato almeno un'occasione (~80 su 856). Pochi secondi, si puo' ripetere spesso;
  //  - a mano (codici): solo quelle indicate.
  // I giri parziali aggiornano solo le proprie espansioni e tengono le altre dal file precedente.
  const HOT = args.includes("--hot");
  const prev = loadJson(OUT, null);
  const all = (await get("/expansions")).filter(e => e.game_id === GAME_POKEMON);
  // Senza nessun collegamento a Cardmarket un'occasione non puo' uscire: si salta (70 espansioni,
  // quasi tutte asiatiche). Solo se i blueprint sono gia' in cache, altrimenti non lo sappiamo.
  const possible = e => !bpCache[e.id] || bpCache[e.id].some(b => (b.card_market_ids || []).length);
  const hotCodes = new Set(prev?.hot || (prev?.opportunities || []).map(o => o.code));
  const targets = codes.length ? all.filter(e => codes.includes(e.code))
    : HOT ? all.filter(e => hotCodes.has(e.code))
    : all.filter(possible);
  const partial = codes.length > 0 || HOT;
  if (!targets.length) { console.error(HOT ? "ERRORE: nessuna espansione calda: serve prima un giro completo." : "Nessuna espansione trovata per: " + codes.join(", ")); process.exit(1); }
  console.log(`${HOT ? "Giro veloce" : partial ? "Giro parziale" : "Giro completo"}: ${targets.length} espansioni. Spesa per carta ${CFG.minBuy}-${CFG.maxBuy} €.\n`);

  const found = [];
  const t0 = Date.now();
  await pool(targets, 3, async exp => {
    const bps = await blueprints(exp.id);
    const prods = await get(`/marketplace/products?expansion_id=${exp.id}`);
    if (!prods || Array.isArray(prods)) return;
    found.push(...analyse(exp, bps || [], prods, cm));
    await sleep(150);                              // ritmo blando: meglio lenti che bloccati
  }, (d, t) => {
    if (d % 50 === 0) saveBlueprints();
    if (d % 25 === 0 || d === t) {
      const el = (Date.now() - t0) / 1000;
      process.stdout.write(`\r  ${d}/${t} espansioni · ${found.length} occasioni · ${el.toFixed(0)}s (stima totale ${(el / d * t).toFixed(0)}s)   `);
    }
  });

  saveBlueprints();
  // Se CardTrader ci ha bloccati a meta' (403 di Cloudflare), il risultato e' parziale: meglio
  // tenere l'ultima scansione buona che sostituirla con una lista quasi vuota.
  if (failed > targets.length * 0.3) {
    console.error(`\n\nERRORE: ${failed} espansioni su ${targets.length} non lette (CardTrader ci sta bloccando?). Tengo la scansione precedente: riprova tra qualche minuto.`);
    process.exit(2);
  }
  // Da quando e' in vendita ogni occasione: stessa carta, stesso venditore, stesso prezzo = stessa
  // offerta, e tiene la data della prima volta che e' stata vista. Serve all'etichetta "NUOVA".
  const now = new Date().toISOString();
  const OLD = "2000-01-01T00:00:00.000Z";                // "gia' presente prima che si tenesse la data"
  const keyOf = o => `${o.url}|${o.seller}|${o.buy}|${o.reverse}`;
  const seen = new Map((prev?.opportunities || []).map(o => [keyOf(o), o.firstSeen || prev.generatedAt]));
  for (const f of found) f.firstSeen = seen.get(keyOf(f)) || now;
  let fresh = found.filter(f => f.firstSeen === now).length;
  // Il primissimo giro con questa funzione non ha date precedenti: non si marca tutto come nuovo.
  // La data vera e' sconosciuta: si usa una data vecchia convenzionale, cosi' non risultano "nuove".
  if (prev && !prev.opportunities?.some(o => o.firstSeen)) { for (const f of found) f.firstSeen = OLD; fresh = 0; }

  // Giro parziale: le espansioni non controllate restano come erano.
  if (partial && prev?.opportunities) {
    const done = new Set(targets.map(e => e.code));
    found.push(...prev.opportunities.filter(o => !done.has(o.code)));
  }
  // prima le occasioni che reggono anche vendendo subito
  found.sort((a, b) => b.profitFast - a.profitFast);

  // Raggruppa per venditore: comprando piu' carte insieme la spedizione si paga una volta
  // sola. Solo occasioni solide, e guadagno calcolato vendendo subito.
  const bySeller = {};
  for (const f of found) if (!f.lonely && !f.suspect) (bySeller[f.seller] ??= []).push(f);
  const bundles = Object.entries(bySeller).filter(([, v]) => v.length > 1)
    .map(([seller, v]) => ({
      seller, n: v.length, cost: +v.reduce((s, x) => s + x.buy, 0).toFixed(2),
      profit: +(v.reduce((s, x) => s + x.profitFast, 0) + (v.length - 1) * CFG.shipIn).toFixed(2),
      cards: v.map(x => ({ name: x.name, image: x.image, buy: x.buy, url: x.url })),
    }))
    .sort((a, b) => b.profit - a.profit);

  fs.writeFileSync(OUT, JSON.stringify({
    generatedAt: now,
    // ultimo giro completo: le espansioni calde si ricalcolano solo li'
    fullAt: partial ? prev?.fullAt || prev?.generatedAt || now : now,
    hot: partial ? [...hotCodes, ...found.map(f => f.code)].filter((c, i, a) => a.indexOf(c) === i) : [...new Set(found.map(f => f.code))],
    mode: HOT ? "veloce" : partial ? "parziale" : "completo",
    priceGuideDate: guideRaw.createdAt,
    config: CFG, expansionsScanned: partial ? prev?.expansionsScanned ?? targets.length : targets.length,
    opportunities: found, bundles,
  }, null, 1));

  console.log(`\n\nTrovate ${found.length} occasioni (${fresh} nuove). Salvate in opportunities.json\n`);
  console.log("Le migliori 20:");
  for (const f of found.slice(0, 20)) {
    console.log(`  compri ${f.buy.toFixed(2).padStart(7)} → +${f.profit.toFixed(2).padStart(6)} € con calma (${(f.roi * 100).toFixed(0)}%) / +${f.profitFast.toFixed(2).padStart(6)} € subito  ${(f.name + (f.reverse ? " [rev]" : "")).slice(0, 30).padEnd(30)} ${f.code.padEnd(7)} ${f.lang ?? "?"} x${f.qty}${f.suspect ? "  [DA VERIFICARE]" : ""}`);
  }
  if (bundles.length) {
    console.log("\nVenditori con piu' di un'occasione (una sola spedizione):");
    for (const b of bundles.slice(0, 5)) console.log(`  ${b.seller.padEnd(22)} ${String(b.n).padStart(2)} carte  +${b.profit.toFixed(2)} €`);
  }
  console.log("\nATTENZIONE: ogni occasione va verificata a mano prima di comprare (condizione reale, foto, affidabilita' del venditore, autenticita').");
})().catch(e => { console.error("\nERRORE:", e.message); process.exit(1); });
