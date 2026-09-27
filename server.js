// Pokemon Trader - server locale (solo moduli integrati di Node, nessuna installazione).
// Avvio:  node server.js   ->  http://localhost:8000
//
// Fonti dati:
//  - Prezzi: listino ufficiale Cardmarket (price guide), scaricato in automatico e rigenerato da Cardmarket ogni giorno.
//  - Anagrafica carte (nome, set, numero, immagine, idProduct Cardmarket): TCGdex (api.tcgdex.net).
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

// "node server.js --telefono" rende l'app raggiungibile dagli altri dispositivi della rete
// (lo scanner dal telefono). Di default resta visibile solo da questo PC: su una Wi-Fi
// pubblica chiunque potrebbe leggere e modificare watchlist e inventario.
const PHONE = process.argv.includes("--telefono");

const DATA_FILE = path.join(__dirname, "data.json");
const META_FILE = path.join(__dirname, "cache-cards.json");
const GUIDE_FILE = path.join(__dirname, "cache-priceguide.json");
const TCGDEX = "https://api.tcgdex.net/v2/en";
const GUIDE_URL = "https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_6.json";
const GUIDE_TTL = 6 * 3600 * 1000;       // ogni quanto si CHIEDE a Cardmarket se c'e' un listino nuovo
const HIST_DIR = path.join(__dirname, "storico-prezzi");   // un file al giorno, compresso
const HIST_DAYS = 120;
const MAX_DETAILS = 80;                  // carte per ricerca (una richiesta a TCGdex ciascuna, poi in cache)

const loadJson = (file, def) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return def; } };
const saveJson = (file, obj) => { fs.writeFileSync(file + ".tmp", JSON.stringify(obj)); fs.renameSync(file + ".tmp", file); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- HTTP con retry ----------
async function getJson(url, { retries = 5, timeout = 30000 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    if (i) await sleep(500 * i);
    try {
      const r = await fetch(url, { headers: { "User-Agent": "pokemon-trader/1.0" }, signal: AbortSignal.timeout(timeout) });
      if (r.status === 404) throw Object.assign(new Error("non trovato"), { fatal: true });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { lastErr = e; if (e.fatal) throw e; }
  }
  throw new Error(`${new URL(url).host} non risponde (${lastErr.message}) dopo ${retries} tentativi. Riprova tra qualche minuto.`);
}

// ---------- listino prezzi Cardmarket ----------
let guide = null; // { createdAt, fetchedAt, prices: Map<idProduct, {...}> }
let guideLoading = null;

// Il listino grezzo pesa 15 MB e ha 14 colonne: ne usiamo 6. Si salva solo quello che serve
// (circa 4 MB), nella stessa forma, cosi' scanner.js e build-catalog.js non cambiano.
const slimGuide = raw => ({
  createdAt: raw.createdAt, lastModified: raw.lastModified ?? null,
  priceGuides: raw.priceGuides.map(g => ({
    idProduct: g.idProduct, low: g.low, trend: g.trend, avg7: g.avg7, avg30: g.avg30,
    "trend-holo": g["trend-holo"], "avg30-holo": g["avg30-holo"],
  })),
});

// Storico: un file al giorno, compresso, con i soli prezzi di riferimento. Serve a misurare
// quanto si muovono i prezzi da un giorno all'altro (per ora non lo sappiamo: il listino
// veniva sovrascritto). ~1 MB al giorno, si tengono 120 giorni.
function saveHistory(slim) {
  try {
    const day = String(slim.createdAt).slice(0, 10);
    fs.mkdirSync(HIST_DIR, { recursive: true });
    const file = path.join(HIST_DIR, `prezzi-${day}.json.gz`);
    if (fs.existsSync(file)) return;
    // anche le carte con il solo prezzo reverse holo: esistono e vanno seguite
    const rows = slim.priceGuides.filter(g => g.trend > 0 || g.avg30 > 0 || g["trend-holo"] > 0 || g["avg30-holo"] > 0)
      .map(g => [g.idProduct, g.trend ?? 0, g.avg30 ?? 0, g["trend-holo"] ?? 0, g["avg30-holo"] ?? 0]);
    fs.writeFileSync(file + ".tmp", require("zlib").gzipSync(JSON.stringify({ createdAt: slim.createdAt, rows })));
    fs.renameSync(file + ".tmp", file);              // mai un file a meta': altrimenti resta corrotto per sempre
    const limit = Date.now() - HIST_DAYS * 86400000;
    for (const f of fs.readdirSync(HIST_DIR)) {
      const d = Date.parse(f.slice(7, 17));
      if (!isNaN(d) && d < limit) fs.unlinkSync(path.join(HIST_DIR, f));
    }
    console.log(`Storico prezzi: salvato ${day} (${rows.length} carte).`);
  } catch (e) { console.log("Storico prezzi non salvato:", e.message); }
}

function indexGuide(raw, fetchedAt) {
  const prices = new Map();
  for (const g of raw.priceGuides) prices.set(g.idProduct, {
    low: g.low, trend: g.trend, avg7: g.avg7, avg30: g.avg30,
    // le reverse holo stanno nello stesso prodotto, nelle colonne "-holo"
    trendHolo: g["trend-holo"], avg30Holo: g["avg30-holo"],
  });
  return { createdAt: raw.createdAt, lastModified: raw.lastModified ?? null, fetchedAt, prices };
}

async function ensureGuide() {
  if (guide && Date.now() - guide.fetchedAt < GUIDE_TTL) return guide;
  if (!guideLoading) {
    guideLoading = (async () => {
      try {
        // Cardmarket rigenera il listino una volta al giorno e risponde 304 se non e' cambiato:
        // si chiede con la data di quello che abbiamo e si scaricano i 15 MB solo se serve.
        const have = guide?.lastModified || loadJson(GUIDE_FILE, null)?.lastModified;
        const r = await fetch(GUIDE_URL, {
          headers: { "User-Agent": "pokemon-trader/1.0", ...(have ? { "If-Modified-Since": have } : {}) },
          signal: AbortSignal.timeout(180000),
        });
        if (r.status === 304) {                       // listino invariato: si tiene quello in cache
          const old = loadJson(GUIDE_FILE, null);
          // se la cache nel frattempo e' sparita o e' corrotta, si riscarica senza la condizione
          if (!old?.priceGuides?.length) throw Object.assign(new Error("cache mancante"), { retryFull: true });
          guide = indexGuide(old, Date.now());
          saveHistory(old);                           // recupera lo storico del giorno, se manca
        } else if (r.ok) {
          const slim = slimGuide({ ...await r.json(), lastModified: r.headers.get("last-modified") });
          fs.writeFileSync(GUIDE_FILE + ".tmp", JSON.stringify(slim));
          fs.renameSync(GUIDE_FILE + ".tmp", GUIDE_FILE);
          saveHistory(slim);
          guide = indexGuide(slim, Date.now());
        } else throw new Error("HTTP " + r.status);
      } catch (e) {
        if (e.retryFull) {                            // 304 ma senza cache valida: riscarico tutto
          const raw = await getJson(GUIDE_URL, { retries: 2, timeout: 180000 });
          const slim = slimGuide(raw);
          fs.writeFileSync(GUIDE_FILE + ".tmp", JSON.stringify(slim));
          fs.renameSync(GUIDE_FILE + ".tmp", GUIDE_FILE);
          saveHistory(slim);
          guide = indexGuide(slim, Date.now());
        }
        if (!guide) { // rete assente: riparte dall'ultimo listino salvato, se c'e'
          const old = loadJson(GUIDE_FILE, null);
          // si riprova tra 5 minuti, non a ogni richiesta: durante un blackout l'app resta usabile
          if (old) guide = indexGuide(old, Date.now() - GUIDE_TTL + 5 * 60 * 1000);
        }
        if (!guide) throw e;
      } finally { guideLoading = null; }
    })();
  }
  await guideLoading;
  return guide;
}

// ---------- anagrafica carte (TCGdex) ----------
const meta = loadJson(META_FILE, {}); // id TCGdex -> { ...campi stabili della carta }
let metaDirty = false;
setInterval(() => { if (metaDirty) { metaDirty = false; saveJson(META_FILE, meta); } }, 2000).unref();

async function cardMeta(id) {
  if (meta[id]?.category) return meta[id];         // le voci vecchie senza attacchi e categoria si riscaricano una volta
  const c = await getJson(`${TCGDEX}/cards/${encodeURIComponent(id)}`);
  const v = (c.variants_detailed || []).find(v => v.thirdParty?.cardmarket) || {};
  const idProduct = v.thirdParty?.cardmarket ?? null;
  const m = {
    id: c.id, name: c.name, number: c.localId, rarity: c.rarity,
    set: c.set?.name, image: c.image ? `${c.image}/low.webp` : null,
    idProduct,
    fallback: v.pricing?.cardmarket ? { ...v.pricing.cardmarket, date: v.pricing.cardmarket.updated } : null,
    // abilita' e attacchi: Cardmarket li scrive nel nome del prodotto ("Mewtwo LV.X [Psybarrier | Giga Burn]"),
    // e servono ad abbinare le carte quando i nomi delle due fonti non coincidono
    moves: [...(c.abilities || []), ...(c.attacks || [])].map(a => a.name).filter(Boolean),
    category: c.category || "?",                   // Pokemon / Trainer / Energy
  };
  meta[id] = m; metaDirty = true;
  return m;
}

function toCard(m, g) {
  const p = m.idProduct != null ? g.prices.get(m.idProduct) : null;
  const src = p || (m.fallback && { low: m.fallback.low, trend: m.fallback.trend, avg7: m.fallback.avg7, avg30: m.fallback.avg30 });
  return {
    id: m.id, name: m.name, number: m.number, rarity: m.rarity, set: m.set, image: m.image,
    cardmarketUrl: `https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(`${m.name} ${m.number}`)}`,
    idProduct: m.idProduct,
    updated: p ? g.createdAt.slice(0, 10).replace(/-/g, "/") : (m.fallback?.date || "").slice(0, 10).replace(/-/g, "/") || undefined,
    cm: src ? { trend: src.trend, low: src.low, avg7: src.avg7, avg30: src.avg30 } : { },
  };
}

async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } }
  }));
  return out;
}

async function search(q, setName) {
  if (!q && !setName) return { cards: [] };
  const g = await ensureGuide();
  const params = new URLSearchParams();
  if (q) params.set("name", q);
  if (setName) params.set("set.name", setName);
  const briefs = (await getJson(`${TCGDEX}/cards?${params}`)).filter(b => !/^[A-Z]\d/.test(b.id)); // esclude le carte digitali TCG Pocket
  const total = briefs.length;
  const metas = (await pool(briefs.slice(0, MAX_DETAILS), 10, b => cardMeta(b.id))).filter(m => m && m.idProduct != null);
  const cards = metas.map(m => toCard(m, g)).sort((a, b) => (b.cm.trend ?? 0) - (a.cm.trend ?? 0));
  return { cards, total, shown: Math.min(total, MAX_DETAILS), priceDate: g.createdAt };
}

async function getCard(id) {
  const g = await ensureGuide();
  return { card: toCard(await cardMeta(id), g) };
}

// ---------- prezzi vivi dell'inventario ----------
// Le carte comprate da Affari hanno solo il blueprint CardTrader. Il ponte verso il listino
// Cardmarket e' card_market_ids, gia' in cache-blueprints.json (lo scrive scanner.js):
// nessuna richiesta a CardTrader. Il file si rilegge solo se lo scanner l'ha cambiato.
const BP_FILE = path.join(__dirname, "cache-blueprints.json");
let bpIndex = null, bpMtime = 0;
function blueprintCm(id) {
  const mtime = fs.statSync(BP_FILE, { throwIfNoEntry: false })?.mtimeMs || 0;
  if (!bpIndex || mtime !== bpMtime) {
    bpIndex = new Map(); bpMtime = mtime;
    for (const list of Object.values(loadJson(BP_FILE, {})))
      for (const b of list || []) if (b.card_market_ids?.length) bpIndex.set(b.id, b.card_market_ids[0]);
  }
  return bpIndex.get(id) ?? null;
}

// items: [{ tcg: "sv3pt5-6" }] (da Cerca) oppure [{ bp: 117192, rev: false }] (da Affari).
// Per le carte da Affari il riferimento e' quello dello scanner: il piu' prudente tra trend e avg30
// (colonne -holo per le reverse).
async function livePrices(items) {
  const g = await ensureGuide();
  const out = await pool(items.slice(0, 500), 10, async it => {
    if (it.tcg) return { card: toCard(await cardMeta(String(it.tcg)), g) };
    const idProduct = blueprintCm(+it.bp);
    const p = idProduct != null ? g.prices.get(idProduct) : null;
    if (!p) return { idProduct, ref: null };
    const trend = it.rev ? p.trendHolo : p.trend, avg30 = it.rev ? p.avg30Holo : p.avg30;
    const refs = [trend, avg30].filter(x => x > 0);
    return { idProduct, trend: trend ?? null, avg30: avg30 ?? null, ref: refs.length ? Math.min(...refs) : null };
  });
  return { priceDate: g.createdAt, items: out };
}

// ---------- Scanner: cerca una carta e mostra i prezzi delle due piattaforme ----------
// Niente calcoli: si mostra quello che dicono Cardmarket (listino del giorno) e CardTrader
// (offerte vere, adesso). La ricerca e' locale sui blueprint gia' in cache: istantanea.
const CT_API = "https://api.cardtrader.com/api/v2";
const EXP_FILE = path.join(__dirname, "cache-expansions.json");
const ctToken = () => { try { return fs.readFileSync(path.join(__dirname, "cardtrader-token.txt"), "utf8").trim(); } catch { return ""; } };

let cards = null, cardsMtime = 0;
function cardIndex() {
  const mtime = fs.statSync(BP_FILE, { throwIfNoEntry: false })?.mtimeMs || 0;
  if (cards && mtime === cardsMtime) return cards;
  const exp = loadJson(EXP_FILE, {});
  const out = [];
  for (const [expId, list] of Object.entries(loadJson(BP_FILE, {}))) {
    for (const b of list || []) {
      out.push({ id: b.id, name: b.name, version: b.version || "", img: b.img || null,
        cm: b.card_market_ids?.[0] ?? null, exp: exp[expId] || "", cerca: norm(b.name + " " + (b.version || "") + " " + (exp[expId] || "")) });
    }
  }
  cards = out; cardsMtime = mtime;
  return cards;
}

// nomi delle espansioni: una sola richiesta, poi in cache (servono per distinguere le carte)
let expTry = 0;
async function ensureExpansions() {
  if (fs.existsSync(EXP_FILE) || Date.now() - expTry < 600000) return;
  expTry = Date.now();
  const t = ctToken();
  if (!t) return;
  const r = await fetch(`${CT_API}/expansions`, { headers: { Authorization: `Bearer ${t}` } });
  if (!r.ok) return;
  const names = {};
  for (const e of await r.json()) if (e.game_id === 5) names[e.id] = e.name;
  fs.writeFileSync(EXP_FILE, JSON.stringify(names));
  cards = null;
}

// Ricerca per nome e numero: "chariz 199" trova Charizard ex 199/165.
async function findCards(q) {
  const g = await ensureGuide();
  await ensureExpansions().catch(() => {});
  const parole = norm(q).split(" ").filter(Boolean);
  if (!parole.length) return { cards: [] };
  const out = [];
  for (const c of cardIndex()) {
    if (!parole.every(p => c.cerca.includes(p))) continue;
    const p = c.cm != null ? g.prices.get(c.cm) : null;
    out.push({ ...c, cerca: undefined,
      prezzi: p ? { trend: p.trend || null, avg30: p.avg30 || null, trendHolo: p.trendHolo || null, avg30Holo: p.avg30Holo || null } : null });
  }
  // prima le carte che valgono di piu': al mercatino sono quelle che contano
  out.sort((a, b) => (b.prezzi?.trend ?? b.prezzi?.avg30 ?? -1) - (a.prezzi?.trend ?? a.prezzi?.avg30 ?? -1));
  return { cards: out.slice(0, 24), totale: out.length, listino: g.createdAt };
}

// Offerte vere su CardTrader per una carta, adesso. Una richiesta, in coda, con memoria di
// 2 minuti: al mercatino si tocca una carta alla volta e Cloudflare non si arrabbia.
const offersCache = new Map();
const offersInFlight = new Map();                       // due tocchi sulla stessa carta = una richiesta
let ctQueue = Promise.resolve();                        // catena che NON si rompe: ogni anello cattura
async function ctOffers(bp) {
  const hit = offersCache.get(bp);
  if (hit && Date.now() - hit.at < 120000) return hit.data;
  if (offersInFlight.has(bp)) return offersInFlight.get(bp);
  const lavoro = ctQueue.catch(() => {}).then(async () => {
    const t = ctToken();
    if (!t) throw new Error("manca il token CardTrader");
    let r;
    for (let i = 0; i < 3; i++) {                       // sul 403 si aspetta, come fa lo scanner
      if (i) await sleep(4000 * i);
      r = await fetch(`${CT_API}/marketplace/products?blueprint_id=${bp}`,
        { headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(20000) });
      if (r.status !== 403 && r.status !== 429) break;
    }
    if (r.status === 403 || r.status === 429) throw new Error("CardTrader ci sta rallentando: riprova tra un minuto");
    if (!r.ok) throw new Error("CardTrader non risponde (HTTP " + r.status + ")");
    const lista = Object.values(await r.json())[0] || [];
    const gruppi = {};
    for (const p of lista) {
      const h = p.properties_hash || {};
      if (p.graded || p.on_vacation || p.price_currency !== "EUR" || h.altered || h.signed) continue;
      const k = `${h.pokemon_language || "?"}|${h.pokemon_reverse ? "reverse" : "normale"}|${h.condition || "?"}`;
      (gruppi[k] ??= []).push(p.price_cents / 100);
    }
    const offerte = Object.entries(gruppi).map(([k, v]) => {
      const [lang, tipo, cond] = k.split("|");
      return { lang, reverse: tipo === "reverse", cond, n: v.length, da: Math.min(...v) };
    }).sort((a, b) => a.da - b.da);   // la pagina poi raggruppa per lingua e condizione
    const data = { at: new Date().toISOString(), offerte, url: `https://www.cardtrader.com/cards/${bp}` };
    offersCache.set(bp, { at: Date.now(), data });
    await sleep(200);                                   // ritmo blando, come lo scanner
    return data;
  });
  ctQueue = lavoro.catch(() => {});                     // la coda prosegue anche dopo un errore
  offersInFlight.set(bp, lavoro);
  lavoro.catch(() => {}).then(() => offersInFlight.delete(bp));
  return lavoro;
}

// ---------- perito: valuta un annuncio di Vinted / Subito / eBay ----------
// Due tipi di annuncio, due strategie:
//  - CARTA SINGOLA: chi vende scrive nome e numero ("Charizard ex 199/165").
//    Il denominatore (/165) e' il numero di carte ufficiali del set e identifica
//    l'espansione: "Charizard 4" corrisponde a 4 carte, "Charizard 4/102" a una sola.
//    Da li' il prezzo e' esatto e si calcola il guadagno netto della rivendita.
//  - LOTTO: niente nomi, solo foto. Si calcola il prezzo per carta e si mostrano
//    gli eventuali nomi citati, con la forbice di valore.
let catalog = null;
const norm = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s/]/g, " ").replace(/\s+/g, " ").trim();

function loadCatalog() {
  if (catalog) return catalog;
  const raw = loadJson(path.join(__dirname, "catalog.json"), null);
  if (!raw) return null;
  const byName = new Map();
  for (const c of raw.cards) {
    const k = norm(c.n);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(c);
  }
  catalog = { ...raw, byName, maxWords: Math.max(...[...byName.keys()].map(k => k.split(" ").length)) };
  return catalog;
}

// Forbice di valore per i nomi citati senza numero (lotti, o singole senza numero).
function nameRanges(text) {
  const cat = loadCatalog();
  if (!cat) return [];
  const t = norm(text);
  const words = t.split(" ");

  // scorre il testo cercando i nomi piu' lunghi per primi, senza sovrapposizioni
  const found = [];
  const used = new Array(words.length).fill(false);
  for (let len = Math.min(cat.maxWords, 5); len >= 1; len--) {
    for (let i = 0; i + len <= words.length; i++) {
      if (used.slice(i, i + len).some(Boolean)) continue;
      const key = words.slice(i, i + len).join(" ");
      if (len === 1 && STOP.has(key)) continue;
      let hits = cat.byName.get(key);
      // nome in un'altra lingua ("Dracaufeu", "Glurak"): lo si traduce in inglese tramite gli id TCGdex
      if (!hits && names?.byName.has(key)) {
        const en = new Set([...names.byName.get(key)].map(id => names.en.get(id)).filter(Boolean).map(norm));
        hits = [...en].flatMap(n => cat.byName.get(n) || []);
        if (!hits.length) hits = null;
      }
      if (!hits) continue;
      if (len === 1 && hits.every(h => (h.t ?? 0) < 1)) continue;  // nomi comuni senza valore: rumore
      for (let k = i; k < i + len; k++) used[k] = true;
      found.push({ key, hits });
    }
  }

  const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : null;

  return found.map(({ key, hits }) => {
    // come ovunque nell'app: il piu' prudente tra trend e media a 30 giorni
    const vals = hits.map(h => (h.t > 0 && h.a > 0) ? Math.min(h.t, h.a) : (h.t ?? h.a ?? 0)).filter(v => v > 0).sort((a, b) => a - b);
    const max = vals[vals.length - 1] ?? null;
    const rich = vals.filter(v => v >= 30).length / (vals.length || 1);
    return {
      name: hits[0]?.n ?? key, versions: hits.length,
      min: vals[0] ?? null, max,
      // In un lotto le carte sono quasi sempre le versioni comuni: la mediana di TUTTE
      // le stampe sovrastima parecchio. Il 25esimo percentile e' molto piu' vicino al vero.
      likely: pct(vals, 0.25),
      // "Pikachu" ha 434 versioni e ovviamente una vale 8000 €: segnalarlo non dice nulla.
      // Conta quanto il valore e' CONCENTRATO: se molte versioni di quel nome sono care,
      // la probabilita' di averne presa una buona e' reale. Se e' una su 400, no.
      richShare: +rich.toFixed(3),
      worthChecking: vals.length > 0 && rich >= 0.25 && max >= 50,
    };
  }).filter(c => c.max != null).sort((a, b) => (b.likely ?? 0) - (a.likely ?? 0));
}

// --- set TCGdex: non cambiano, si tengono in cache su disco ---
const SETS_FILE = path.join(__dirname, "cache-sets.json");
const setsCache = loadJson(SETS_FILE, { list: null, cards: {} });
let setsDirty = false;
setInterval(() => { if (setsDirty) { setsDirty = false; saveJson(SETS_FILE, setsCache); } }, 2000).unref();

async function tcgSets() {
  if (!setsCache.list) { setsCache.list = await getJson(`${TCGDEX}/sets`); setsDirty = true; }
  return setsCache.list;
}
async function tcgSetCards(id) {
  if (!setsCache.cards[id]) {
    const s = await getJson(`${TCGDEX}/sets/${encodeURIComponent(id)}`);
    setsCache.cards[id] = { name: s.name, cards: (s.cards || []).map(c => ({ id: c.id, localId: c.localId, name: c.name })) };
    setsDirty = true;
  }
  return setsCache.cards[id];
}

// "049" -> "49", "SV049" -> "SV49", "TG23" -> "TG23": stessa forma da entrambi i lati
const normNum = s => String(s).toUpperCase().replace(/^([A-Z]*)0+(?=\d)/, "$1");
const denomOf = s => parseInt(String(s).replace(/^[A-Z]+/i, ""), 10);

// Distanza di modifica: quante lettere cambiare per passare da una parola all'altra.
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

// Il nome compare nel testo? Esatto, oppure con un errore di battitura ("Moushold" per
// Maushold): tolleranza 1 lettera fino a 8 caratteri, 2 oltre, nessuna sui nomi cortissimi.
function nameMatch(text, name) {
  const t = norm(text), target = norm(name);
  if (!target) return null;
  if ((" " + t + " ").includes(" " + target + " ")) return { kind: "exact" };
  // Dalla foto il lettore attacca spesso lettere spurie al nome ("fsssdCharizard ex"):
  // senza spazi il nome c'e' ancora. Solo per nomi di almeno 6 lettere, altrimenti "Mew"
  // verrebbe trovato dentro "Mewtwo".
  const compact = target.replace(/ /g, "");
  if (compact.length >= 6 && t.replace(/ /g, "").includes(compact)) return { kind: "contained" };
  const tol = target.length <= 4 ? 0 : target.length <= 8 ? 1 : 2;
  if (!tol) return null;
  const words = t.split(" "), k = target.split(" ").length;
  for (let i = 0; i + k <= words.length; i++) {
    const w = words.slice(i, i + k).join(" ");
    if (Math.abs(w.length - target.length) <= tol && lev(w, target) <= tol) return { kind: "fuzzy", written: w };
  }
  return null;
}

// Attacchi e abilita' della carta presenti nel testo. Per non farsi ingannare da nomi di attacco
// generici ("Bite", "Pound") serve un attacco di almeno 6 lettere, oppure due attacchi.
// Dalla foto un attacco di due parole arriva spesso spezzato su righe diverse ("Giant" ... "Claw"):
// vale anche se tutte le sue parole di almeno 4 lettere compaiono nel testo.
function movesIn(text, moves) {
  const words = new Set(norm(text).split(" "));
  const split = m => { const ws = norm(m).split(" ").filter(w => w.length >= 4); return ws.length >= 2 && ws.every(w => words.has(w)); };
  const hits = moves.filter(m => nameMatch(text, m) || split(m));
  return hits.some(m => norm(m).length >= 6) || hits.length >= 2 ? hits : [];
}

// Da numero e denominatore alla carta esatta.
// Il numero STAMPATO usa sempre le carte ufficiali come denominatore: una segreta di Dragons
// Exalted (124 ufficiali, 128 totali) e' stampata "125/124", mai "125/128". Il totale serve
// solo come ripiego. Tra piu' candidati vince chi ha il nome (anche scritto male) o
// l'espansione citati nel testo.
async function identify(text, num, den) {
  const N = await loadNames();
  const setsInText = new Set(scan(text, N.sets).map(k => N.sets.get(k)));
  const all = await tcgSets();
  const collect = async sets => {
    const out = [];
    for (const s of sets) {
      let sc; try { sc = await tcgSetCards(s.id); } catch { continue; }
      for (const c of sc.cards) {
        if (normNum(c.localId) !== normNum(num)) continue;
        // il nome puo' essere scritto in qualunque lingua (Chrysacier e' Metapod) e anche male
        let best = null;
        for (const x of N.namesOf.get(c.id) || [{ name: c.name, lang: "en" }]) {
          const m = nameMatch(text, x.name);
          if (m && (!best || (m.kind === "exact" && best.kind !== "exact"))) best = { ...m, lang: x.lang, name: x.name };
        }
        const setInText = setsInText.has(s.id);
        out.push({ ...c, setName: sc.name, match: best, setInText,
          score: (best?.kind === "exact" ? 4 : best ? 3 : 0) + (setInText ? 2 : 0) });
      }
    }
    return out;
  };
  let cands = await collect(all.filter(s => s.cardCount?.official === den));
  if (!cands.length) cands = await collect(all.filter(s => s.cardCount?.total === den));
  // Gli attacchi scritti nel testo: dalla foto il lettore li legge bene (grassetto, grandi) anche
  // quando perde il nome. "106/108" e' sia Groudon-EX (Dark Explorers) sia Lightning Energy
  // (Power Keepers): "Tromp" e "Giant Claw" nel testo dicono quale.
  // La riga debolezza/resistenza/ritirata ce l'hanno solo i Pokemon: se c'e' nel testo, una carta
  // Energia o Allenatore con lo stesso numero non e' quella giusta (106/108 = anche Lightning Energy).
  const pokemonText = /\b(weakness|resistance|retreat|debolezza|resistenza|ritirata|faiblesse|retraite)\b/i.test(text);
  if (cands.length <= 8) for (const c of cands) {
    const m = await cardMeta(c.id).catch(() => null);
    c.moves = movesIn(text, m?.moves || []);
    if (c.moves.length) c.score += 3 + c.moves.length;
    if (pokemonText && m?.category && m.category !== "Pokemon" && m.category !== "?") c.score -= 5;
  }
  cands.sort((a, b) => b.score - a.score);
  const best = cands[0] || null;
  // Un altro Pokemon nominato nel testo contraddice la carta trovata ("Garchomp 6/130" ma il
  // #6 e' Lucario): uno dei due e' sbagliato, e l'espansione citata non basta a confermare.
  const conflict = best && !best.match && !best.moves?.length ? scan(text, N.byName)[0] || null : null;
  return {
    best: best && { ...best, nameInText: !!best.match, nameLang: best.match?.lang ?? null, conflict,
      // confermata da nome, attacchi, o espansione senza nomi che la contraddicano
      confirmed: !!best.match || !!best.moves?.length || (best.setInText && !conflict) },
    alternatives: cands.length,
  };
}

// ---------- nomi di carte ed espansioni in tutte le lingue europee ----------
// Chi vende in Francia scrive "Chrysacier Évolutions", non "Metapod Evolutions". Gli id
// TCGdex sono gli stessi in ogni lingua (xy12-4 e' Chrysacier in fr, Metapod in en),
// quindi basta un indice nome -> id che copra tutte le lingue.
const NAME_LANGS = { en: "inglese", fr: "francese", de: "tedesco", it: "italiano", es: "spagnolo", pt: "portoghese" };
const NAMES_FILE = path.join(__dirname, "cache-names.json");
let names = null, namesLoading = null;
const setOf = id => id.slice(0, id.lastIndexOf("-"));

async function loadNames() {
  if (names) return names;
  namesLoading ??= (async () => {
    let raw = loadJson(NAMES_FILE, null);
    if (!raw) {
      raw = { cards: {}, sets: {} };
      for (const l of Object.keys(NAME_LANGS)) {
        raw.cards[l] = (await getJson(`https://api.tcgdex.net/v2/${l}/cards`)).map(c => [c.id, c.name]);
        raw.sets[l] = (await getJson(`https://api.tcgdex.net/v2/${l}/sets`)).map(s => [s.id, s.name]);
      }
      saveJson(NAMES_FILE, raw);
    }
    const byName = new Map(), namesOf = new Map(), en = new Map(), sets = new Map(), setNames = new Map();
    for (const [l, list] of Object.entries(raw.cards)) for (const [id, n] of list) {
      if (/^[A-Z]\d/.test(id)) continue;                        // TCG Pocket: carte digitali
      if (l === "en") en.set(id, n);
      const k = norm(n);
      if (!k) continue;
      if (!byName.has(k)) byName.set(k, new Set());
      byName.get(k).add(id);
      if (!namesOf.has(id)) namesOf.set(id, []);
      namesOf.get(id).push({ name: n, lang: l });
    }
    for (const [l, list] of Object.entries(raw.sets)) for (const [id, n] of list) {
      const k = norm(n);
      if (k.length >= 4 && k !== "pokemon") sets.set(k, id);  // nomi troppo corti o generici: rumore
      if (l === "en") setNames.set(id, n);
    }
    names = { byName, namesOf, en, sets, setNames };
    return names;
  })();
  try { return await namesLoading; } finally { namesLoading = null; }
}

// Espressioni del dizionario presenti nel testo, dalla piu' lunga alla piu' corta e senza
// sovrapposizioni: "Évolutions Prismatiques" batte "Évolutions", "Pikachu ex" batte "Pikachu".
// Parole che compaiono in quasi ogni annuncio ma sono anche nomi di carte in qualche lingua
// ("Carte" e' una carta allenatore francese): da sole non vanno mai prese come carte.
const STOP = new Set(["carte", "carta", "cartes", "cartas", "card", "cards", "karte", "karten", "pokemon",
  "lotto", "lot", "vendo", "collezione", "set", "rara", "rare", "holo", "reverse", "promo", "mint", "near",
  "energia", "energy", "energie", "base", "gioco", "jeu", "spiel", "juego"]);

function scan(text, dict, maxWords = 6) {
  const words = norm(text).split(" ");
  const used = new Array(words.length).fill(false);
  const found = [];
  for (let len = maxWords; len >= 1; len--)
    for (let i = 0; i + len <= words.length; i++) {
      if (used.slice(i, i + len).some(Boolean)) continue;
      const key = words.slice(i, i + len).join(" ");
      if (len === 1 && STOP.has(key)) continue;
      if (!dict.has(key)) continue;
      for (let k = i; k < i + len; k++) used[k] = true;
      found.push(key);
    }
  return found;
}

// ---------- ponte verso Cardmarket per le carte che TCGdex non collega ----------
// Interi set (es. XY Evolutions) non hanno l'id Cardmarket in TCGdex. Si ricostruisce
// confrontando l'elenco dei nomi del set con quello di ogni espansione Cardmarket: la piu'
// simile e' quella giusta (Evolutions: 0,87 contro 0,76 della seconda). Se le prime due
// si equivalgono, sono edizioni diverse dello stesso set (Base Set illimitato, shadowless,
// prima edizione): stessi nomi, prezzi molto diversi. Li' non si sceglie a caso.
const PRODUCTS_FILE = path.join(__dirname, "cache-products.json");
const PRODUCTS_URL = "https://downloads.s3.cardmarket.com/productCatalog/productList/products_singles_6.json";
// Chiave del nome, uguale per le due fonti. TCGdex e Cardmarket scrivono gli stessi nomi in
// modo diverso: "Groudon-EX" / "Groudon EX", "Charizard δ" / "Charizard δ Delta Species", e
// in tutta l'era Diamante & Perla / Platino Cardmarket aggiunge il livello ("Gliscor Lv.47",
// "Mewtwo LV.X") che TCGdex non scrive: senza toglierlo, per quei set il ponte non trovava
// quasi nessun nome in comune (somiglianza 0,14). Carte con lo stesso nome ma livello diverso
// si distinguono poi con gli attacchi.
const cardKey = n => norm(String(n).replace(/\s*[[(].*$/, "").replace(/δ|delta species/gi, " ").replace(/\s+LV\.?\s*(X|\d+)\b/gi, " "));
// Attacchi e abilita' in ordine alfabetico: identificano il testo della carta anche quando i
// nomi divergono del tutto (TCGdex "Mewtwo", Cardmarket "Mewtwo LV.X [Psybarrier | Giga Burn]").
const movesKey = list => list.map(norm).filter(Boolean).sort().join("|");
let products = null;
const expCache = {};

async function loadProducts() {
  if (products) return products;
  let raw = loadJson(PRODUCTS_FILE, null);
  if (!raw) { raw = await getJson(PRODUCTS_URL, { retries: 3, timeout: 180000 }); fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(raw)); }
  const byExp = new Map(), byExpName = new Map(), byExpMoves = new Map(), movesOf = new Map();
  const add = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };
  for (const p of raw.products) {
    const b = cardKey(p.name);
    if (!byExp.has(p.idExpansion)) byExp.set(p.idExpansion, new Set());
    byExp.get(p.idExpansion).add(b);
    add(byExpName, p.idExpansion + "|" + b, p.idProduct);
    const mk = movesKey(((p.name.match(/\[(.*)\]/) || [])[1] || "").split("|"));
    if (mk) { movesOf.set(p.idProduct, mk); add(byExpMoves, p.idExpansion + "|" + mk, p.idProduct); }
  }
  products = { byExp, byExpName, byExpMoves, movesOf };
  return products;
}

async function cmExpansionFor(setId) {
  if (setId in expCache) return expCache[setId];
  const P = await loadProducts();
  const sc = await tcgSetCards(setId);
  const mine = new Set(sc.cards.map(c => cardKey(c.name)));
  const scored = [...P.byExp].map(([e, s]) => {
    let inter = 0;
    for (const n of mine) if (s.has(n)) inter++;
    return { e, j: inter / (mine.size + s.size - inter) };
  }).sort((a, b) => b.j - a.j);
  const [a, b] = scored;
  return expCache[setId] = a && a.j >= 0.5 ? { exp: a.e, twin: b && a.j - b.j < 0.02 ? b.e : null } : null;
}

// Prezzo di una carta TCGdex: id Cardmarket diretto se c'e', altrimenti il ponte.
async function priceCard(id, meta, reverse) {
  const g = await ensureGuide();
  const pick = ids => {
    const vals = ids.map(i => g.prices.get(i)).filter(Boolean).map(p => {
      const refs = [reverse ? p.trendHolo : p.trend, reverse ? p.avg30Holo : p.avg30].filter(v => v > 0);
      return { value: refs.length ? Math.min(...refs) : null, trend: reverse ? p.trendHolo : p.trend, avg30: reverse ? p.avg30Holo : p.avg30 };
    }).filter(x => x.value != null).sort((x, y) => x.value - y.value);
    return vals[0] || null;                           // piu' versioni: la piu' prudente
  };
  const ex = await cmExpansionFor(setOf(id)).catch(() => null);
  const P = await loadProducts();
  // edizione gemella (stessi nomi, altro prezzo): va segnalata anche quando l'id e' diretto
  const inExp = e => P.byExpName.get(e + "|" + cardKey(meta.name)) || [];
  // Edizioni: Cardmarket ha PIU' prodotti con questo nome di quante carte con questo nome
  // abbia il set in TCGdex. Nel 151 ci sono 3 "Charizard ex" da entrambe le parti: carte
  // diverse, nessuna ambiguita'. In Base Set TCGdex ha 1 Charizard e Cardmarket 3 prodotti
  // (1.009 €, 3.331 €, 709 €): i due in piu' sono edizioni diverse con lo stesso nome.
  // Si conta solo nell'espansione della carta: le edizioni vere (illimitata, shadowless) stanno
  // li' dentro. L'espansione "gemella" e' spesso la versione giapponese dello stesso set (il 151
  // ne ha una): altro mercato, gia' coperto dall'avviso sulla lingua.
  const editionsOf = async () => {
    if (!ex) return null;
    const own = meta.idProduct != null && ex.twin && inExp(ex.twin).includes(meta.idProduct) ? ex.twin : ex.exp;
    const cmIds = inExp(own);
    const sc = await tcgSetCards(setOf(id)).catch(() => null);
    const tcgCount = sc ? sc.cards.filter(c => cardKey(c.name) === cardKey(meta.name)).length : cmIds.length;
    if (cmIds.length <= tcgCount) return null;
    const vals = cmIds.map(i => pick([i])?.value).filter(v => v != null);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    return vals.length >= 2 && hi - lo > 0.01 ? { n: cmIds.length, lo, hi } : null;
  };
  if (meta.idProduct != null) {
    const p = pick([meta.idProduct]);
    if (p) return { ...p, via: "diretto", editions: await editionsOf() };
  }
  if (!ex) return null;
  let ids = inExp(ex.exp);
  const mk = movesKey(meta.moves || []);
  if (mk) {
    // stesso nome e stessi attacchi: la stessa carta. Nome diverso ma stessi attacchi:
    // la stessa carta chiamata diversamente (Mewtwo / Mewtwo LV.X).
    const same = ids.filter(i => P.movesOf.get(i) === mk);
    if (same.length) ids = same;
    else if (!ids.length) ids = P.byExpMoves.get(ex.exp + "|" + mk) || [];
  }
  if (ids.length > 1) {
    // Piu' prodotti con lo stesso nome. Se il set TCGdex ha altrettante carte con quel nome,
    // sono carte diverse (30th Celebration: Maushold #125 comune a 0,13 €, #146 rara a 10 €).
    // Cardmarket assegna gli id nell'ordine del set, quindi si abbinano per posizione.
    // Senza questo si prenderebbe sempre il piu' economico, sbagliando le rare.
    const sc = await tcgSetCards(setOf(id)).catch(() => null);
    const same = sc?.cards.filter(c => cardKey(c.name) === cardKey(meta.name))
      .sort((a, b) => a.localId.localeCompare(b.localId, undefined, { numeric: true }));
    const i = same && same.length === ids.length ? same.findIndex(c => c.id === id) : -1;
    if (i >= 0) ids = [[...ids].sort((a, b) => a - b)[i]];
  }
  const p = pick(ids);
  if (!p) return null;
  return { ...p, via: "ponte", editions: await editionsOf() };
}

// Senza numero: nome (in qualunque lingua) + espansione citata nel testo.
async function identifyByName(text) {
  const N = await loadNames();
  const setIds = new Set(scan(text, N.sets).map(k => N.sets.get(k)));
  if (!setIds.size) return null;                    // senza espansione il nome da solo e' troppo vago
  const hits = [];
  for (const key of scan(text, N.byName)) for (const id of N.byName.get(key))
    if (setIds.has(setOf(id))) hits.push({ id, lang: (N.namesOf.get(id) || []).find(x => norm(x.name) === key)?.lang });
  const uniq = [...new Map(hits.map(h => [h.id, h])).values()];
  return uniq.length ? { best: uniq[0], alternatives: uniq.length } : null;
}

// --- regole di lettura del testo ---
const RX = {
  numbers: /\b([A-Z]{0,3}\d{1,3})\s*\/\s*([A-Z]{0,3}\d{1,3})\b/gi,
  // vendute come tali da chi le produce: se c'e' la parola, non e' una carta originale
  fake: /\b(proxy|custom|replica|fake|fals[oaie]|ristampa|orica|fan ?made|non originale|gold metal|carta (in )?metallo)\b/i,
  graded: /\b(psa|bgs|beckett|cgc|gradata|graded|slab)\b/i,
  bad: /\b(played|segni|graffi|graffiata|rovinata|piegata|pieghe|usurata|damaged|poor|danneggiata)\b/i,
  good: /\b(near mint|nm|mint|perfett[ae]|come nuova|ottime condizioni|ottimo stato)\b/i,
  first: /\b(1st edition|first edition|prima edizione|1a edizione|1° edizione)\b/i,
  reverse: /\b(reverse|rev holo)\b/i,
  holo: /\bholo\b/i,
  lot: /\b(lotto|lot|bulk|stock|carte miste)\b/i,
  // carte promo: il numero stampato e' un codice senza barra ("DP28", "SWSH050", "SVP EN 085")
  promo: /\b(DP|HGSS|BW|XY|SM|SWSH|SVP)\s*-?\s*(?:EN\s*)?(\d{1,3})\b/gi,
  count: /\b(\d{2,4})\s*(carte|cards|card|cartes|karten|cartas|pz|pezzi|pcs)\b/i,
};
const LANGS = [
  ["giapponese", /\b(giappones[ei]|japanese|jap|jpn)\b/i, true],
  ["coreano", /\b(corean[oa]|korean)\b/i, true],
  ["cinese", /\b(cines[ei]|chinese)\b/i, true],
  ["italiano", /\b(italian[aeio]|italiane|ita)\b/i, false],
  ["inglese", /\b(ingles[ei]|inglesi|english|eng)\b/i, false],
  ["tedesco", /\b(tedesc(?:o|a|hi|he)|german|deutsch)\b/i, false],
  ["francese", /\b(frances[ei]|francesi|french)\b/i, false],
  ["spagnolo", /\b(spagnol[aeio]|spagnole|spanish)\b/i, false],
  ["portoghese", /\b(portoghes[ei]|portuguese)\b/i, false],
];
// QUANTO VALE UNA CARTA ITALIANA (misurato il 23/09/2026 sulle offerte Near Mint di CardTrader).
// Il listino Cardmarket e' unico per tutte le lingue europee, il mercato no.
//  - sulle stesse 413 carte presenti in entrambe le lingue: mediana offerte italiane / inglesi
//    = 0,56 (25o 0,43, 75o 0,78), stabile per fascia di prezzo (0,61 sotto 10 €, 0,53 sopra 30 €);
//  - rispetto al riferimento Cardmarket: l'offerta italiana piu' bassa ha mediana 0,76 e sta
//    sotto meta' riferimento nel 21% dei casi (l'inglese nell'1%).
// Quindi su una carta italiana su cinque il perito gridava "prezzo sotto meta' valore" e su una
// su venti "probabile falso" mentre il prezzo era quello normale delle italiane.
// SOLO l'italiano e' misurato: per tedesco, francese, spagnolo e portoghese non si applica
// nessun fattore (i dati sono troppo pochi e un numero inventato qui fa comprare male).
const IT_FACTOR = 0.75;
const priceIn = s => {
  const m = String(s || "").match(/€\s*(\d{1,5}(?:[.,]\d{1,2})?)|(\d{1,5}(?:[.,]\d{1,2})?)\s*(?:€|eur\b|euro\b)/i);
  return m ? parseFloat((m[1] || m[2]).replace(",", ".")) : null;
};

// Costi verificati il 21/09/2026. Vinted: chi COMPRA paga la protezione acquisti.
const SHIP_IN = 3;                                   // spedizione tipica di una carta
const vintedBuyerFee = p => 0.70 + p * 0.05;
const RESALE = [
  { platform: "Cardmarket", fee: 0.05 },
  { platform: "CardTrader", fee: 0.053 * 1.22 },     // 5,3% + IVA
  { platform: "Vinted", fee: 0 },                    // la commissione la paga chi compra
];

async function appraise({ text, title, meta, body, url, ask, scan }) {
  // Titolo e descrizione sono affidabili; il resto della pagina contiene anche altri annunci.
  const head = [title, meta].filter(Boolean).join("\n") || text || "";
  const near = head + "\n" + String(body || "").slice(0, 1500);
  const isVinted = /vinted\./i.test(url || "");
  const flags = [];
  const flag = (level, msg) => flags.push({ level, msg });
  await loadNames();                                 // serve anche ai lotti, per i nomi stranieri

  // --- prezzo: quello scritto a mano vince, altrimenti si prova a leggerlo ---
  let price = ask > 0 ? ask : null, askAuto = false;
  if (price == null) { price = priceIn(head) ?? priceIn(body); askAuto = price != null; }

  // --- segnali scritti nel testo ---
  const fake = near.match(RX.fake);
  if (fake) flag("danger", `Il testo contiene «${fake[0]}»: è una riproduzione dichiarata, non una carta originale.`);
  const lang = LANGS.find(([, rx]) => rx.test(near));
  if (lang?.[2]) flag("warn", `Carta in ${lang[0]}: i prezzi Cardmarket sono quelli delle stampe europee. Questa ha un altro mercato e un altro valore.`);
  if (RX.graded.test(near)) flag("warn", "Carta gradata (PSA, BGS, CGC): il prezzo dipende dal voto sulla custodia, non è quello di una carta sfusa.");
  if (RX.bad.test(near)) flag("warn", "Il venditore parla di segni o usura: il prezzo Near Mint non vale. Può scendere anche della metà.");
  if (RX.first.test(near)) flag("info", "Dichiarata prima edizione: vale molto di più, ma è anche la versione più falsificata. Controlla il timbro «1st Edition» nella foto.");
  const reverse = RX.reverse.test(near);

  const out = {
    ask: price, askAuto, isVinted, lang: lang?.[0] ?? null, langDeclared: lang?.[0] ?? null,
    condition: RX.bad.test(near) ? "usurata" : RX.good.test(near) ? "buona" : null,
    flags, card: null, resale: null, names: [], lot: null,
  };

  // --- lotto: niente numeri da risolvere, si ragiona sul prezzo per carta ---
  const count = +(near.match(RX.count)?.[1] || 0);
  if (!scan && (RX.lot.test(head) || count >= 5)) {      // una scansione e' sempre una carta sola
    out.kind = "lot";
    out.lot = { count: count || null, perCard: price && count ? +(price / count).toFixed(3) : null };
    out.names = nameRanges(near);
    return finish(out);
  }

  // --- carta singola ---
  out.kind = "single";
  const N = await loadNames();

  // Scheda della carta a partire dall'id TCGdex, qualunque sia stato il modo di trovarla.
  const build = async (id, number, nameLang) => {
    const m = await cardMeta(id);
    // "holo" su una comune o non comune vuol dire reverse holo: quelle carte non esistono
    // in versione holo normale, e la reverse ha un altro prezzo.
    let rev = reverse || (RX.holo.test(near) && /^(common|uncommon)$/i.test(m.rarity || ""));
    let pr = await priceCard(id, m, rev);
    if (rev && pr?.value == null) { rev = false; pr = await priceCard(id, m, false); }  // nessun prezzo reverse: si usa il normale
    out.card = {
      name: m.name, set: N.setNames.get(setOf(id)) || m.set, number, rarity: m.rarity,
      image: m.image ? m.image.replace("/low.webp", "/high.webp") : null, reverse: rev,
      // sempre il piu' prudente tra trend e media delle vendite reali a 30 giorni
      value: pr?.value ?? null, trend: pr?.trend ?? null, avg30: pr?.avg30 ?? null,
      cardmarketUrl: `https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(m.name + (m.number ? " " + m.number : ""))}`,
    };
    // Il nome e' scritto in un'altra lingua: e' utile saperlo, e la carta quasi certamente e' in quella lingua.
    if (nameLang && nameLang !== "en") {
      const other = (N.namesOf.get(id) || []).find(x => x.lang === nameLang)?.name;
      out.lang ??= NAME_LANGS[nameLang];
      flag("info", `«${other}» è il nome ${NAME_LANGS[nameLang] === "italiano" ? "italiano" : "in " + NAME_LANGS[nameLang]} di ${m.name}: la carta è probabilmente in ${NAME_LANGS[nameLang]}. Il prezzo Cardmarket è unico per tutte le lingue europee.`);
    }
    if (pr?.editions) {
      const eu = n => n.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      flag("warn", `Su Cardmarket questa carta esiste in ${pr.editions.n} edizioni con lo stesso nome (es. illimitata, shadowless, prima edizione), da ${eu(pr.editions.lo)} € a ${eu(pr.editions.hi)} €. Il valore mostrato è quello di una sola: controlla dalle foto quale hai davanti.`);
    }
    if (out.card.value == null) flag("warn", "Carta riconosciuta, ma Cardmarket non ha un prezzo recente: si vende poco o per niente.");
  };

  // 1) numero con denominatore ("199/165"): il modo piu' preciso
  const pairs = [...new Set([...head.matchAll(RX.numbers), ...String(body || "").slice(0, 1500).matchAll(RX.numbers)]
    .map(m => `${m[1]}/${m[2]}`))];
  // Dalla foto la barra viene letta spesso come "1" o "7": "4/100" diventa "41100". Si prova a
  // rimetterla, ma solo dove a destra resta un denominatore che esiste davvero (100 = Crystal
  // Guardians). Sono tentativi di ripiego: valgono solo se il nome della carta li conferma.
  const repaired = new Set();
  if (scan) {
    const sizes = new Set((await tcgSets()).flatMap(s => [s.cardCount?.official, s.cardCount?.total]).filter(Boolean));
    const genuine = new Set(pairs);
    const push = (num, den) => {
      const p = `${num}/${den}`;
      if (genuine.has(p) || repaired.has(p)) return;
      if (den.length < 2 || den.length > 3 || den[0] === "0" || !sizes.has(+den) || !(+num >= 1 && +num <= +den + 80)) return;
      pairs.push(p);
      repaired.add(p);
    };
    // barra letta come "1" o "7": "41100" -> 4/100
    for (const m of head.matchAll(/\b(\d{3,7})\b/g))
      for (let i = 1; i < m[1].length - 2; i++)
        if (m[1][i] === "1" || m[1][i] === "7") push(m[1].slice(0, i), m[1].slice(i + 1));
    // cifre spurie attaccate davanti o dietro: "7106/1088" e "W106/4108" -> 106/108
    for (const m of head.matchAll(/(\d{1,5})\s*\/\s*(\d{2,5})/g))
      for (let a = 1; a <= Math.min(3, m[1].length); a++)
        for (const den of new Set([m[2].slice(0, 2), m[2].slice(0, 3), m[2].slice(-2), m[2].slice(-3)]))
          push(m[1].slice(-a), den);
  }
  // Con piu' numeri nel testo (tipico di una foto letta male) vince quello confermato dal
  // nome o dall'espansione; altrimenti il primo che corrisponde a una carta.
  let chosen = null;
  for (const p of pairs.slice(0, 24)) {
    const [num, d] = p.split("/");
    const den = denomOf(d);
    if (!(den > 0)) continue;
    const r = await identify(near, num, den);
    if (!r.best) continue;
    // un numero ricostruito dal rumore ("2720" -> 2/20) vale solo se il nome lo conferma:
    // altrimenti mostrerebbe una carta a caso (in prova: Dratini al posto di Groudon)
    if (repaired.has(p) && !r.best.confirmed) continue;
    if (!chosen || (r.best.confirmed && !chosen.r.best.confirmed)) chosen = { r, num, d };
    if (r.best.confirmed) break;
  }
  if (chosen) {
    const { r: { best, alternatives }, num, d } = chosen;
    await build(best.id, `${best.localId}/${d}`, best.nameLang);
    if (best.match?.kind === "fuzzy")
      flag("info", `Nell'annuncio c'è «${best.match.written}»: è ${out.card.name} scritto male. Il numero ${num}/${d} lo conferma.`);
    if (!best.match && best.moves?.length)
      flag("info", `Riconosciuta dagli attacchi scritti sulla carta (${best.moves.join(", ")}) insieme al numero ${num}/${d}.`);
    if (!best.confirmed) {
      // L'identita' poggia solo sul numero: niente allarmi "troppo economica" ne' guadagni,
      // perche' se la carta e' un'altra sarebbero entrambi falsi.
      out.card.uncertain = true;
      if (best.conflict) {
        const said = (N.namesOf.get([...N.byName.get(best.conflict)][0]) || []).find(x => norm(x.name) === best.conflict)?.name || best.conflict;
        flag("warn", `Nell'annuncio c'è «${said}», ma il numero ${num}/${d} corrisponde a ${out.card.name} (${out.card.set}): uno dei due è sbagliato. Controlla il numero nella foto.`);
      } else flag("warn", alternatives > 1
        ? `Il numero ${num}/${d} corrisponde a ${alternatives} carte diverse, e nell'annuncio non trovo né il nome né l'espansione. Ho scelto ${out.card.name} (${out.card.set}), ma potrebbe essere un'altra: controlla la foto.`
        : `Il numero ${num}/${d} corrisponde a ${out.card.name} (${out.card.set}), ma nell'annuncio non trovo né il nome né l'espansione: controlla nella foto che sia davvero questa carta.`);
    }
  }

  // 1b) carta promo: codice del set promo + numero. In TCGdex il numero della carta e' il
  // codice stesso ("DP28"), tranne le promo Scarlet & Violet che sono solo cifre ("085").
  if (!out.card) {
    const PROMO = { DP: "dpp", HGSS: "hgssp", BW: "bwp", XY: "xyp", SM: "smp", SWSH: "swshp", SVP: "svp" };
    for (const m of near.matchAll(RX.promo)) {
      const pre = m[1].toUpperCase(), n = m[2];
      const sc = await tcgSetCards(PROMO[pre]).catch(() => null);
      const c = sc?.cards.find(c => normNum(c.localId) === normNum(pre === "SVP" ? n : pre + n));
      if (!c) continue;
      const hit = (N.namesOf.get(c.id) || [{ name: c.name, lang: "en" }]).map(x => ({ ...nameMatch(near, x.name), lang: x.lang })).find(x => x.kind);
      await build(c.id, c.localId, hit?.lang);
      const byMoves = !hit && movesIn(near, (await cardMeta(c.id)).moves || []).length > 0;
      if (!hit && !byMoves) {
        out.card.uncertain = true;
        flag("warn", `Il codice ${pre}${n} corrisponde alla promo ${out.card.name} (${out.card.set}), ma il nome non compare: controlla nella foto che sia questa.`);
      }
      break;
    }
  }

  // 2) niente numero: nome (in qualunque lingua) + espansione citata
  if (!out.card) {
    const r = await identifyByName(head);
    if (r) {
      const m = await cardMeta(r.best.id);
      await build(r.best.id, m.number ? String(m.number) : null, r.best.lang);
      if (r.alternatives > 1 && out.card) out.card.uncertain = true;   // potrebbe essere un'altra carta: non si calcola nulla su di lei
      flag(r.alternatives > 1 ? "warn" : "info", r.alternatives > 1
        ? `Riconosciuta da nome ed espansione, ma nel set ci sono ${r.alternatives} carte con questo nome: senza il numero potrebbe essere un'altra. Chiedilo al venditore.`
        : "Riconosciuta da nome ed espansione, senza numero di collezione: controlla nella foto che sia proprio questa.");
    }
  }

  // 3) solo il nome: una forbice
  if (!out.card) {
    out.names = nameRanges(head);
    flag("info", pairs.length
      ? `Numero ${pairs[0]} non trovato in nessuna espansione: controlla di averlo letto bene.`
      : "Nessun numero di collezione nell'annuncio: la stima è una forbice. Chiedi al venditore il numero (es. 199/165), oppure scrivi l'espansione nel testo.");
  }
  return finish(out);
}

// Costo d'acquisto, guadagno netto sulle tre piattaforme e il controllo "troppo bello".
function finish(out) {
  const price = out.ask;
  if (price > 0) {
    const fee = out.isVinted ? +vintedBuyerFee(price).toFixed(2) : 0;
    out.buy = { price, fee, ship: SHIP_IN, total: +(price + fee + SHIP_IN).toFixed(2) };
  }
  // Il valore di listino vale per una carta inglese; l'italiana vale meno. Se la lingua non e'
  // dichiarata in un annuncio italiano si usa comunque il valore prudente: sopravvalutare fa
  // comprare male, sottovalutare fa solo perdere qualche affare.
  const declared = out.langDeclared || null;
  const inferred = out.lang && out.lang !== declared ? out.lang : null;     // dedotta dal nome della carta
  const asianLang = ["giapponese", "coreano", "cinese"].includes(declared || inferred);
  const italian = !asianLang && (declared || inferred || "italiano") === "italiano";
  // per le asiatiche il riferimento europeo non vale per niente: lo dice gia' il loro avviso
  const other = !asianLang && declared && declared !== "italiano" && declared !== "inglese";
  if (out.card?.value > 0) {
    out.card.valueFull = out.card.value;
    out.card.valueIt = +(out.card.value * IT_FACTOR).toFixed(2);
    out.card.lang = declared || inferred || null;
    out.card.langBasis = declared ? "dichiarata nell'annuncio" : inferred ? "dedotta dal nome della carta" : "non dichiarata";
    if (italian) out.card.value = out.card.valueIt;                         // il valore mostrato e' quello prudente
    out.card.valueNote = italian
      ? (declared ? "Carta italiana: vale circa tre quarti del prezzo di listino, che è quello delle inglesi."
        : "Lingua non dichiarata: si usa il valore di una carta italiana (tre quarti del listino). Se è inglese vale " + out.card.valueFull.toFixed(2).replace(".", ",") + " €.")
      : other ? "Il listino Cardmarket non distingue la lingua: una carta non inglese vale meno, ma quanto non è misurato."
      : null;
  }
  const v = out.card?.value;
  // Le stampe asiatiche hanno un altro mercato: il prezzo Cardmarket di riferimento non vale.
  const asian = ["giapponese", "coreano", "cinese"].includes(out.lang);
  const uncertain = !!out.card?.uncertain;
  if (v > 0 && out.buy) {
    // Il segnale di falso piu' forte che si puo' calcolare senza guardare le foto.
    // Non per le asiatiche (costano legittimamente meno) e non se la carta non e' confermata:
    // un "truffa!" calcolato sulla carta sbagliata e' peggio di nessun allarme.
    const ratio = price / v;
    const eu = n => n.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const check = !asian && !uncertain;
    if (check && ratio < 0.3) out.flags.unshift({ level: "danger", msg: `Chiedono ${eu(price)} € per una carta che vale ${eu(v)} € (il ${Math.round(ratio * 100)}%). Un prezzo così basso è il segnale più tipico di un falso o di una truffa.` });
    else if (check && ratio < 0.5) out.flags.unshift({ level: "warn", msg: `Prezzo a meno della metà del valore (${Math.round(ratio * 100)}%). Può essere un affare vero, ma controlla bene foto e venditore.` });
    // prezzo basso solo rispetto al listino (che e' il prezzo delle inglesi): dipende dalla lingua
    else if (check && out.card?.valueFull > v && price < out.card.valueFull * 0.5) {
      out.flags.unshift({ level: "info", msg: `Il prezzo è basso per una carta inglese, normale per una italiana. Chiedi al venditore in che lingua è: cambia il valore di circa un terzo.` });
    }

    // Con un allarme serio il guadagno "teorico" NON si mostra: un +1.000 € verde
    // accanto a "probabile falso" e' un invito a cascarci.
    if (uncertain) out.resaleBlocked = "Guadagno non calcolato: non è sicuro che la carta sia questa.";
    else if (asian) out.resaleBlocked = "Guadagno non calcolato: il prezzo di riferimento è quello delle stampe europee e per questa carta non vale.";
    else if (out.flags.some(f => f.level === "danger")) out.resaleBlocked = "Guadagno non calcolato: con questi segnali d'allarme il valore di mercato non è quello che otterresti.";
    else out.resale = RESALE.map(r => {
      const net = v * (1 - r.fee);
      const profit = net - out.buy.total;
      return { platform: r.platform, net: +net.toFixed(2), profit: +profit.toFixed(2), roi: +(profit / out.buy.total).toFixed(3) };
    });
  }
  if (out.kind === "lot" && out.lot?.perCard != null) {
    const pc = out.lot.perCard;
    out.lot.verdict = pc <= 0.08
      ? "In linea col valore delle carte comuni sfuse: rischi poco anche se non ci sono carte buone."
      : pc <= 0.3
        ? "Paghi più del valore delle comuni sfuse: conviene solo se nelle foto ci sono carte buone."
        : "Prezzo alto per un lotto: stai pagando la speranza di carte rare. Guarda bene le foto prima.";
  }
  return out;
}

// data.json contiene acquisti e vendite: se si corrompe sparisce la contabilita'. Prima di
// sovrascriverlo si tiene una copia del giorno (la prima scrittura di ogni giornata), 30 giorni.
const BACKUP_DIR = path.join(__dirname, "copie-data");
function backupData() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    // giorno locale, non UTC: altrimenti in Italia la copia "del giorno" cambia all'una di notte
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const file = path.join(BACKUP_DIR, `data-${day}.json`);
    if (!fs.existsSync(file)) fs.copyFileSync(DATA_FILE, file);
    const limit = Date.now() - 30 * 86400000;
    for (const f of fs.readdirSync(BACKUP_DIR)) {
      const d = Date.parse(f.slice(5, 15));
      if (!isNaN(d) && d < limit) fs.unlinkSync(path.join(BACKUP_DIR, f));
    }
  } catch (e) { console.log("Copia di data.json non riuscita:", e.message); }
}

// ---------- scansioni "Affari": automatiche finche' il server e' acceso ----------
// Due giri, entrambi in un processo a parte (scanner.js):
//  - VELOCE ogni 5 minuti, solo sulle ~80 espansioni "calde" (~20 secondi, ~80 richieste);
//  - COMPLETO ogni ora, su tutte (~800 richieste), che ricalcola quali sono le calde.
// In media ~0,5 richieste al secondo. Il blocco Cloudflare del 21/09 era nato da ~5.000
// richieste in pochi minuti. Se una scansione fallisce, i giri automatici si fermano 15 minuti.
// "node server.js --no-auto" li disattiva: resta solo il pulsante.
const { spawn } = require("child_process");
const OPP_FILE = path.join(__dirname, "opportunities.json");
const FAST_EVERY = 5 * 60 * 1000, FULL_EVERY = 60 * 60 * 1000, BUTTON_GAP = 2 * 60 * 1000, BACKOFF = 15 * 60 * 1000;
const AUTO = !process.argv.includes("--no-auto");
const scanJob = { running: false, mode: null, done: 0, total: 0, found: 0, fresh: 0, error: null, errorAt: 0 };
const oppTimes = () => {
  const o = loadJson(OPP_FILE, null);
  const last = Date.parse(o?.generatedAt || 0) || 0;
  return { last, full: Date.parse(o?.fullAt || o?.generatedAt || 0) || 0, hasHot: !!(o?.hot?.length || o?.opportunities?.length) };
};
function nextAuto() {
  const t = oppTimes();
  if (!t.last || !t.hasHot || Date.now() - t.full >= FULL_EVERY) return { mode: "completo", at: Math.max(t.full + FULL_EVERY, scanJob.errorAt + BACKOFF) };
  return { mode: "veloce", at: Math.max(Math.min(t.last + FAST_EVERY, t.full + FULL_EVERY), scanJob.errorAt + BACKOFF) };
}

function scanStatus() {
  const t = oppTimes(), n = nextAuto();
  return { ...scanJob, auto: AUTO, lastScanAt: t.last || null, fullAt: t.full || null,
    next: AUTO ? { mode: n.mode, inMinutes: Math.max(0, Math.ceil((n.at - Date.now()) / 60000)) } : null,
    waitMinutes: Math.max(0, Math.ceil((t.last + BUTTON_GAP - Date.now()) / 60000)) };
}
// Pulsante: giro veloce, se l'ultimo giro ha almeno 2 minuti (senza espansioni calde: completo).
function startScan(mode) {
  if (scanJob.running) return { ok: false, error: "Una scansione è già in corso." };
  const t = oppTimes();
  if (!mode) {
    const wait = Math.ceil((t.last + BUTTON_GAP - Date.now()) / 60000);
    if (wait > 0) return { ok: false, error: `Aggiornate meno di 2 minuti fa: riprova tra ${wait} ${wait === 1 ? "minuto" : "minuti"}.` };
    mode = t.hasHot ? "veloce" : "completo";
  }
  Object.assign(scanJob, { running: true, mode, done: 0, total: 0, found: 0, fresh: 0, error: null });
  const p = spawn(process.execPath, [path.join(__dirname, "scanner.js"), ...(mode === "veloce" ? ["--hot"] : [])], { cwd: __dirname });
  let out = "";
  p.stdout.on("data", d => { out += d; if (out.length > 1e5) out = out.slice(-2e4); });
  let err = "";
  p.stdout.on("data", d => {
    const m = [...String(d).matchAll(/(\d+)\/(\d+) espansioni · (\d+) occasioni/g)].pop();
    if (m) Object.assign(scanJob, { done: +m[1], total: +m[2], found: +m[3] });
  });
  p.stderr.on("data", d => { err += d; });
  p.on("close", code => {
    scanJob.running = false;
    scanJob.fresh = +((out.match(/\((\d+) nuove\)/) || [])[1] || 0);
    scanJob.error = code === 0 ? null
      : ((err.match(/ERRORE:?\s*(.+)/) || err.match(/\w*Error:\s*(.+)/) || [])[1] || `la scansione si è fermata (codice ${code})`).trim();
    if (scanJob.error) scanJob.errorAt = Date.now();
    console.log(`[${new Date().toLocaleTimeString("it-IT")}] giro ${mode}: ${scanJob.error ? "ERRORE " + scanJob.error : `${scanJob.fresh} occasioni nuove`}`);
  });
  return { ok: true };
}
if (AUTO) setInterval(() => {
  if (scanJob.running) return;
  const n = nextAuto();
  if (Date.now() >= n.at) startScan(n.mode);
}, 30 * 1000).unref();

// ---------- server ----------
const send = (res, code, body, type = "application/json; charset=utf-8") => {
  res.writeHead(code, { "Content-Type": type });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = req => new Promise((resolve, reject) => {
  let b = "";
  req.on("data", d => { b += d; if (b.length > 5e6) reject(new Error("troppo grande")); });
  req.on("end", () => resolve(b));
});

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET") {
      if (u.pathname === "/") return send(res, 200, fs.readFileSync(path.join(__dirname, "index.html")), "text/html; charset=utf-8");
      if (u.pathname === "/api/search") return send(res, 200, await search((u.searchParams.get("q") || "").trim(), (u.searchParams.get("set") || "").trim()));
      if (u.pathname === "/api/card") return send(res, 200, await getCard(u.searchParams.get("id")));
      if (u.pathname === "/api/data") return send(res, 200, loadJson(DATA_FILE, { watchlist: [], inventory: [] }));
      if (u.pathname === "/api/opportunities") return send(res, 200, loadJson(OPP_FILE, null) ?? { missing: true });
      // fotografia del mercato delle carte in magazzino: la scrive scanner.js nel giro completo
      if (u.pathname === "/api/market") return send(res, 200, loadJson(path.join(__dirname, "cache-market.json"), null) ?? { missing: true });
      // Scanner: ricerca locale e offerte CardTrader vive
      if (u.pathname === "/api/find") return send(res, 200, await findCards((u.searchParams.get("q") || "").trim()));
      if (u.pathname === "/api/offers") return send(res, 200, await ctOffers(+u.searchParams.get("bp")));
      if (u.pathname === "/api/scan") return send(res, 200, scanStatus());
    } else if (req.method === "POST" && u.pathname === "/api/scan") {
      return send(res, 200, startScan());
    } else if (req.method === "POST" && u.pathname === "/api/live") {
      const b = JSON.parse(await readBody(req));
      if (!Array.isArray(b.items)) return send(res, 400, { error: "formato non valido" });
      return send(res, 200, await livePrices(b.items));
    } else if (req.method === "POST" && u.pathname === "/api/appraise") {
      const b = JSON.parse(await readBody(req));
      const s = v => typeof v === "string" ? v.slice(0, 8000) : "";
      const input = { text: s(b.text), title: s(b.title), meta: s(b.meta), body: s(b.body), url: s(b.url), ask: parseFloat(b.ask) || null, scan: !!b.scan };
      if (!input.text.trim() && !input.title.trim()) return send(res, 400, { error: "testo mancante" });
      return send(res, 200, await appraise(input));
    } else if (req.method === "PUT" && u.pathname === "/api/data") {
      const body = JSON.parse(await readBody(req));
      if (!Array.isArray(body.watchlist) || !Array.isArray(body.inventory)) return send(res, 400, { error: "formato non valido" });
      backupData();                                  // prima di sovrascrivere: una copia al giorno
      fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify({ watchlist: body.watchlist, inventory: body.inventory }, null, 2));
      fs.renameSync(DATA_FILE + ".tmp", DATA_FILE);
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 502, { error: e.message });
  }
}).listen(8000, PHONE ? "0.0.0.0" : "127.0.0.1", () => {
  console.log("Pokemon Trader su http://localhost:8000  (Ctrl+C per uscire)");
  if (PHONE) {
    const ips = Object.values(os.networkInterfaces()).flat().filter(a => a && a.family === "IPv4" && !a.internal).map(a => a.address);
    console.log(`\nDal telefono, collegato alla stessa Wi-Fi, apri:${ips.map(ip => `\n   http://${ip}:8000`).join("")}`);
    console.log("Attenzione: l'app ora è visibile a tutti i dispositivi di questa rete. Usa --telefono solo sulla Wi-Fi di casa.");
    console.log("Se Windows chiede di consentire l'accesso a Node.js, scegli solo «Reti private».\n");
  }
  ensureGuide().then(g => console.log(`Listino Cardmarket del ${g.createdAt}: ${g.prices.size} prodotti`)).catch(e => console.log("Listino non disponibile:", e.message));
  loadNames().then(n => console.log(`Nomi delle carte in ${Object.keys(NAME_LANGS).length} lingue: ${n.byName.size} nomi, ${n.sets.size} espansioni`)).catch(e => console.log("Nomi non disponibili:", e.message));
  loadProducts().catch(e => console.log("Catalogo Cardmarket non disponibile:", e.message));
});
