// Scanner automatico: cerca su CardTrader annunci messi in vendita SOTTO il prezzo
// di mercato della stessa carta, e calcola il guadagno netto reale della rivendita.
//
// Uso:
//   node scanner.js            scansione completa (tutte le espansioni Pokemon)
//   node scanner.js ssp evs bs solo queste espansioni (codici)
//   node scanner.js --max 60   limite di spesa per carta, in euro
//
// Scrive opportunities.json, che l'app legge nella tab "Affari", e deals-log.json (diario:
// quanto resta in vendita ogni occasione, per misurare se i segnali sono veri senza comprare).
// NON compra niente: fa solo letture.
const fs = require("fs");
const path = require("path");

const API = "https://api.cardtrader.com/api/v2";
const GAME_POKEMON = 5;
const TOKEN = fs.readFileSync(path.join(__dirname, "cardtrader-token.txt"), "utf8").trim();
const OUT = path.join(__dirname, "opportunities.json");
const LOG_FILE = path.join(__dirname, "deals-log.json");
const GUIDE_FILE = path.join(__dirname, "cache-priceguide.json");

// --- regole di selezione -------------------------------------------------
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : def; };
const CFG = {
  minBuy: opt("--min", 3),        // sotto questa cifra la spedizione si mangia tutto
  maxBuy: opt("--max", 1000),     // tetto per singola carta: il budget dell'utente arriva a 1000 € (era 80 fino al 22/09/2026)
  minDepth: 5,                    // servono almeno 5 offerte NM: sotto non c'e' un mercato
  minGap: 0.25,                   // l'annuncio deve stare almeno il 25% sotto il mercato
  minProfit: 3,                   // guadagno netto minimo in euro
  minRoi: 0.20,                   // ROI netto minimo
  // costi (venditore UE iscritto dopo marzo 2026: 5,3% + IVA 22%)
  feePct: 5.3 * 1.22,
  shipIn: 1.5,                    // spedizione provvisoria per la prima selezione: poi si usa quella vera del venditore
  shipUnknown: 7.9,               // venditore senza metodi esposti (spedisce via CT Zero): Raccomandata IT, prudente
  cardGrams: 20,                  // peso di una carta spedita (busta + protezione); +5 g per ogni carta in piu'
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

    // Normale e reverse sono due carte diverse. E lo sono anche le lingue: misurato il 22/09/2026,
    // l'offerta NM italiana piu' bassa vale il 41-54% di quella inglese della stessa carta (tedesco
    // 66-87%, spagnolo e francese ~100%). Con le lingue mescolate, il "prezzo di mercato" di una
    // carta italiana era quello delle inglesi: un'occasione inventata. Ogni gruppo
    // (carta, reverse, lingua) e' quindi un mercato a se', con le sue >= 5 offerte NM.
    for (const rev of [false, true]) for (const lang of LANGS) {
      const g = nm.filter(x => x.rev === rev && x.lang === lang);
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
      // Scenario veloce: ti metti subito sotto la seconda offerta per vendere in giornata. Ma se
      // l'annuncio ha piu' copie, comprandone una le altre restano in vendita a quel prezzo: la
      // concorrenza resta il prezzo d'acquisto, non la seconda offerta.
      const sellFast = Math.min(best.qty > 1 ? best.v : g[1].v, cmRef);
      const profitFast = net(sellFast);
      // un affare deve reggere anche vendendo subito, altrimenti e' solo una scommessa sull'attesa
      if (profitFast <= 0) continue;
      if (profit < CFG.minProfit || roi < CFG.minRoi) continue;

      out.push({
        name: b.name, version: b.version || null, expansion: exp.name, code: exp.code,
        reverse: rev, lang, buy: +best.v.toFixed(2), market: +market.toFixed(2),
        cmTrend: cmRef ?? null, sell: +sell.toFixed(2),
        sellFast: +sellFast.toFixed(2), profitFast: +profitFast.toFixed(2),
        profit: +profit.toFixed(2), roi: +roi.toFixed(3), depth: g.length, qty: best.qty,
        suspect: roi > 1.5,                        // guadagni cosi' alti sono quasi sempre dati sbagliati
        // annuncio isolato: sotto meta' del secondo prezzo. O e' un errore del venditore (ottimo)
        // o e' una carta non come descritta / una truffa. Va guardato con sospetto, non con entusiasmo.
        lonely: best.v < g[1].v * 0.5,
        note: best.note || null,
        seller: best.seller, country: best.country,
        productId: best.id,                        // id dell'annuncio: serve al diario per capire se e' sparito
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
  // Diario: si chiudono solo le voci di espansioni lette davvero in questo giro. Un'espansione
  // fallita farebbe sembrare "sparite" tutte le sue occasioni.
  const log = loadJson(LOG_FILE, { entries: {} });
  const openCodes = new Set(Object.values(log.entries).filter(e => !e.end).map(e => e.code));
  const okCodes = new Set();
  const listings = new Map();   // code -> { ids: Map(id annuncio -> {price, qty}), full: Map(blueprint -> prezzo della 25a offerta) }
  await pool(targets, 3, async exp => {
    const bps = await blueprints(exp.id);
    const prods = await get(`/marketplace/products?expansion_id=${exp.id}`);
    if (!prods || Array.isArray(prods)) return;
    found.push(...analyse(exp, bps || [], prods, cm));
    okCodes.add(exp.code);
    if (openCodes.has(exp.code)) {
      const ids = new Map(), full = new Map();
      for (const [bid, list] of Object.entries(prods)) {
        for (const p of list) ids.set(p.id, { price: p.price_cents / 100, qty: p.quantity });
        // l'API da' al massimo 25 offerte per carta: se la lista e' piena, un annuncio puo' uscirne
        // senza essere venduto (spinto fuori da offerte piu' economiche di altre condizioni)
        if (list.length >= 25) full.set(+bid, Math.max(...list.map(p => p.price_cents / 100)));
      }
      listings.set(exp.code, { ids, full });
    }
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
  // Spedizione vera: la selezione sopra usa 1,50 € provvisori (una spedizione piu' cara puo' solo
  // abbassare il guadagno; si perdono solo i rari casi con spedizione sotto 1,50 o gratuita sopra
  // una soglia: prudente di proposito). Ora ogni candidata si ricalcola con i metodi del suo venditore e
  // passa di nuovo gli stessi scarti. Misurato il 22/09/2026: in Italia sopra i 25 € di carrello
  // c'e' solo la Raccomandata (da 7,90 €), e la fascia 25-50 € perdeva quasi tutte le occasioni.
  const ships = await shippingFor([...new Set(found.map(f => f.seller))]);
  const kept = [];
  for (const f of found) {
    if (!EU.has(f.country)) continue;               // extra-UE: dazi e IVA all'import non calcolabili
    const sh = shipCost(ships.get(f.seller), f.buy, 1);
    const cost = f.buy + sh.cost;
    const net = p => p * (1 - CFG.feePct / 100) - CFG.shipOut - cost;
    const profit = net(f.sell), profitFast = net(f.sellFast), roi = profit / cost;
    if (profitFast <= 0) continue;
    if (profit < CFG.minProfit || roi < CFG.minRoi) continue;
    Object.assign(f, { profit: +profit.toFixed(2), profitFast: +profitFast.toFixed(2), roi: +roi.toFixed(3), suspect: roi > 1.5,
      ship: sh.cost, shipMethod: sh.name, shipTracked: sh.tracked, shipUnknown: sh.unknown });
    kept.push(f);
  }
  found.length = 0; found.push(...kept);

  // Da quando e' in vendita ogni occasione: stessa carta, stesso venditore, stesso prezzo = stessa
  // offerta, e tiene la data della prima volta che e' stata vista. Serve all'etichetta "NUOVA".
  const now = new Date().toISOString();
  const OLD = "2000-01-01T00:00:00.000Z";                // "gia' presente prima che si tenesse la data"
  const keyOf = o => `${o.url}|${o.seller}|${o.buy}|${o.reverse}|${o.lang}`;
  const seen = new Map((prev?.opportunities || []).map(o => [keyOf(o), o.firstSeen || prev.generatedAt]));
  for (const f of found) f.firstSeen = seen.get(keyOf(f)) || now;
  let fresh = found.filter(f => f.firstSeen === now).length;
  // Il primissimo giro con questa funzione non ha date precedenti: non si marca tutto come nuovo.
  // La data vera e' sconosciuta: si usa una data vecchia convenzionale, cosi' non risultano "nuove".
  if (prev && !prev.opportunities?.some(o => o.firstSeen)) { for (const f of found) f.firstSeen = OLD; fresh = 0; }

  updateLog(log, found, okCodes, listings, now, HOT ? "veloce" : partial ? "parziale" : "completo");

  // Giro parziale: le espansioni non controllate restano come erano.
  if (partial && prev?.opportunities) {
    const done = new Set(targets.map(e => e.code));
    found.push(...prev.opportunities.filter(o => !done.has(o.code)));
  }
  // prima le occasioni che reggono anche vendendo subito
  found.sort((a, b) => b.profitFast - a.profitFast);

  // Raggruppa per venditore: comprando piu' carte insieme la spedizione si paga una volta
  // sola. Solo occasioni solide, e guadagno calcolato vendendo subito.
  // La spedizione unica si ricalcola sul carrello intero: sopra la soglia del metodo economico
  // (in Italia 25 €) si passa alla Raccomandata, e il "risparmio" puo' diventare una perdita.
  // Le occasioni ricopiate da un giro parziale senza "ship" restano fuori dai gruppi.
  const bySeller = {};
  for (const f of found) if (!f.lonely && !f.suspect && f.ship != null) (bySeller[f.seller] ??= []).push(f);
  // nei giri parziali i venditori delle occasioni ricopiate non sono in "ships": si rileggono dalla
  // cache (nessuna richiesta, se l'ultimo giro completo li ha gia' letti)
  const bundleShips = await shippingFor(Object.keys(bySeller).filter(u => bySeller[u].length > 1));
  const bundles = Object.entries(bySeller).filter(([, v]) => v.length > 1)
    .map(([seller, v]) => {
      const sub = v.reduce((s, x) => s + x.buy, 0);
      const sh = shipCost(bundleShips.get(seller), sub, v.length);
      // somma dei guadagni singoli, restituendo le spedizioni singole e pagandone una sola
      const profit = v.reduce((s, x) => s + x.profitFast + x.ship, 0) - sh.cost;
      return { seller, country: v[0].country ?? null, n: v.length, cost: +sub.toFixed(2), ship: sh.cost, shipMethod: sh.name,
        profit: +profit.toFixed(2),
        cards: v.map(x => ({ name: x.name, image: x.image, buy: x.buy, url: x.url, lang: x.lang })) };
    })
    .filter(b => b.profit > 0)
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

// --- diario delle occasioni ----------------------------------------------
// Misura, senza comprare, se le occasioni sono vere: un annuncio sotto prezzo che sparisce in
// poche ore l'ha comprato qualcuno; uno che resta giorni non era un affare. Una voce per offerta
// (stessa chiave dell'etichetta NUOVA). Chiusure possibili:
//  - "sparita": l'annuncio non c'e' piu' (venduto o ritirato: dall'API non si distingue);
//  - "fuori dai 25": non c'e' piu', ma la lista di quella carta era piena e il suo prezzo stava
//    oltre l'ultima offerta mostrata: potrebbe essere ancora in vendita. Non conta come venduta;
//  - "prezzo cambiato": stesso annuncio, altro prezzo;
//  - "non piu' occasione": stesso annuncio e prezzo, ma i filtri non lo passano piu' (mercato o
//    listino Cardmarket cambiati: il giorno del nuovo listino ne chiude molte insieme).
// L'istante vero di chiusura sta tra end.lastSeen ed end.at: le espansioni calde si controllano
// ogni 5 minuti, le altre ogni ora. Le copie vendute di un annuncio con piu' copie vanno in qtyDrops.
function updateLog(log, found, okCodes, listings, now, mode) {
  const keyOf = o => `${o.url}|${o.seller}|${o.buy}|${o.reverse}|${o.lang}`;
  const E = log.entries;
  // migrazione una tantum: chiavi senza lingua (la lingua e' gia' nel campo lang della voce)
  for (const [k, e] of Object.entries(E)) {
    if (k.split("|").length >= 5 || !e.lang) continue;
    const k2 = `${k}|${e.lang}`;
    if (!E[k2]) { e.key = k2; E[k2] = e; }
    delete E[k];
  }
  const here = new Set();
  let opened = 0, closed = 0;
  for (const f of found) {
    const k = keyOf(f);
    here.add(k);
    const e = E[k];
    if (!e) {
      E[k] = {
        key: k, productId: f.productId ?? null, name: f.name, version: f.version, expansion: f.expansion, code: f.code,
        reverse: f.reverse, lang: f.lang, seller: f.seller, url: f.url,
        buy: f.buy, sellFast: f.sellFast, profitFast: f.profitFast, cmRef: f.cmTrend, depth: f.depth,
        lonely: f.lonely, suspect: f.suspect, qty: f.qty,
        firstSeen: f.firstSeen, lastSeen: now, mode, end: null, reopened: 0, qtyDrops: [],
      };
      opened++;
      continue;
    }
    if (e.end) { e.end = null; e.reopened++; }
    if (f.qty < e.qty) e.qtyDrops.push({ at: now, from: e.qty, to: f.qty });
    e.qty = f.qty; e.lastSeen = now;
    if (f.productId != null) e.productId = f.productId;       // rimesso in vendita con un id nuovo: si segue quello attuale
  }
  for (const e of Object.values(E)) {
    if (e.end || here.has(e.key) || !okCodes.has(e.code)) continue;
    const L = listings.get(e.code);
    if (!L) continue;
    const bid = +String(e.url).split("/").pop();
    const still = e.productId != null ? L.ids.get(e.productId) : null;
    let why;
    if (still) why = still.price !== e.buy ? "prezzo cambiato" : "non piu' occasione";
    else if (e.productId == null) why = "non piu' occasione";      // voce senza id: non si sa se e' sparita
    // prudente di proposito: nel dubbio non si conta come venduta (il diario sottostima, non gonfia)
    else if (L.full.has(bid) && L.full.get(bid) <= e.buy) why = "fuori dai 25";
    else why = "sparita";
    if (still && still.qty < e.qty) e.qtyDrops.push({ at: now, from: e.qty, to: still.qty });
    if (still) e.qty = still.qty;
    e.end = { at: now, lastSeen: e.lastSeen, why, ...(still && still.price !== e.buy ? { newPrice: still.price } : {}) };
    closed++;
  }
  // si tengono 60 giorni di voci chiuse
  const limit = Date.parse(now) - 60 * 86400000;
  for (const [k, e] of Object.entries(E)) if (e.end && Date.parse(e.end.at) < limit) delete E[k];
  log.updatedAt = now;
  fs.writeFileSync(LOG_FILE + ".tmp", JSON.stringify(log));
  fs.renameSync(LOG_FILE + ".tmp", LOG_FILE);
  console.log(`\nDiario: ${opened} occasioni nuove, ${closed} chiuse, ${Object.values(E).filter(e => !e.end).length} aperte.`);
}

// --- spedizione ------------------------------------------------------------
const EU = new Set(["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT",
  "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"]);
// Metodi di spedizione dei venditori: GET /shipping_methods?username=. Cache su disco 7 giorni,
// una richiesta alla volta e col ritmo blando dello sweep. Un errore non ferma il giro: quel
// venditore conta come "spedizione sconosciuta".
const SHIP_FILE = path.join(__dirname, "cache-shipping.json");
const SHIP_TTL = 7 * 86400000;
async function shippingFor(sellers) {
  const cache = loadJson(SHIP_FILE, {});
  const out = new Map();
  let fetched = 0, errors = 0;
  for (const u of sellers) {
    const c = cache[u];
    if (c && Date.now() - c.at < SHIP_TTL) { out.set(u, c.methods); continue; }
    try {
      const m = await get(`/shipping_methods?username=${encodeURIComponent(u)}`, 2);
      const methods = (Array.isArray(m) ? m : []).map(x => ({
        name: x.name, tracked: !!x.tracked,
        maxCart: x.max_cart_subtotal_price ? x.max_cart_subtotal_price.cents / 100 : null,
        freeOver: x.free_shipping_threshold_price ? x.free_shipping_threshold_price.cents / 100 : null,
        freeQty: x.free_shipping_threshold_quantity ?? null,
        costs: (x.shipping_method_costs || []).filter(k => k.price?.currency === "EUR")
          .map(k => ({ from: k.from_grams, to: k.to_grams, eur: k.price.cents / 100 })),
      }));
      cache[u] = { at: Date.now(), methods };
      out.set(u, methods);
      fetched++;
    } catch { errors++; }
    await sleep(200);
  }
  fs.writeFileSync(SHIP_FILE, JSON.stringify(cache));
  if (fetched || errors) console.log(`\nSpedizioni: ${fetched} venditori letti${errors ? `, ${errors} non letti (spedizione sconosciuta)` : ""}.`);
  return out;
}
// Metodo piu' economico per un carrello di "n" carte che vale "subtotal" euro.
function shipCost(methods, subtotal, n) {
  const grams = CFG.cardGrams + 5 * (n - 1);
  let best = null;
  for (const m of methods || []) {
    if (m.maxCart != null && subtotal > m.maxCart) continue;
    const free = (m.freeOver != null && subtotal >= m.freeOver) || (m.freeQty != null && n >= m.freeQty);
    const band = m.costs.find(k => grams >= k.from && grams <= k.to) || (grams < (m.costs[0]?.from ?? 0) ? m.costs[0] : null);
    if (!band && !free) continue;
    const eur = free ? 0 : band.eur;
    if (!best || eur < best.cost) best = { cost: eur, name: m.name, tracked: m.tracked, unknown: false };
  }
  return best || { cost: CFG.shipUnknown, name: null, tracked: null, unknown: true };
}
