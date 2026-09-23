// Test veloce della pagina (nessuna dipendenza): apre l'app in un Chrome headless separato,
// passa per tutte le tab, prova i flussi principali e segnala errori JavaScript.
// Uso:  node smoke-test.js        (con il server acceso; se e' spento lo avvia con --no-auto)
//
// Non tocca data.json: nella pagina save() viene disattivato e le PUT a /api/data bloccate.
// Alla fine controlla comunque che data.json sia identico a prima.
// Non lancia scansioni (POST /api/scan bloccata). Fa solo letture: listino, TCGdex, /api/live.
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const BASE = "http://localhost:8000";
const PORT = 9400 + Math.floor(Math.random() * 100);
const CHROME = ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe")].find(p => fs.existsSync(p));
const DATA = path.join(__dirname, "data.json");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = f => fs.existsSync(f) ? crypto.createHash("sha1").update(fs.readFileSync(f)).digest("hex") : "assente";

const results = [];
const check = (name, ok, info = "") => { results.push({ name, ok: !!ok, info }); console.log(`${ok ? "  ok " : "  NO "} ${name}${info ? "  — " + info : ""}`); };

(async () => {
  if (!CHROME) { console.error("Chrome non trovato."); process.exit(1); }
  const before = hash(DATA);
  let server = null;
  try { await fetch(BASE + "/api/scan"); } catch {
    console.log("Server spento: lo avvio con --no-auto.");
    server = spawn(process.execPath, [path.join(__dirname, "server.js"), "--no-auto"], { cwd: __dirname, stdio: "ignore" });
    for (let i = 0; i < 40; i++) { try { await fetch(BASE + "/api/scan"); break; } catch { await sleep(500); } }
  }
  const profile = path.join(require("os").tmpdir(), "pokemon-smoke-" + PORT);
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  let ws;
  const errors = [];
  try {
    let targets;
    for (let i = 0; i < 40; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); break; } catch { await sleep(250); } }
    ws = new WebSocket(targets.find(t => t.type === "page").webSocketDebuggerUrl);
    await new Promise(r => ws.onopen = r);
    let id = 0; const pending = {};
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; }
      if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    };
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pending[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async expr => {
      const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "errore");
      return r.result.result.value;
    };
    await send("Runtime.enable");
    // Prima che la pagina parta: niente scritture su data.json, niente scansioni, dialoghi finti.
    await send("Page.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", { source: `
      const _fetch = window.fetch;
      window.fetch = (u, o = {}) => {
        const m = (o.method || "GET").toUpperCase();
        if ((String(u).includes("/api/data") && m === "PUT") || (String(u).includes("/api/scan") && m === "POST"))
          return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
        return _fetch(u, o);
      };
      window.__ans = []; window.__prompts = [];
      // risposta "@def" = accettare il valore proposto, come premere Invio
      window.prompt = (msg, def) => { __prompts.push({ msg, def }); const a = __ans.length ? __ans.shift() : null; return a === "@def" ? String(def) : a; };
      window.confirm = () => (__ans.length ? __ans.shift() : true);
      window.alert = m => __prompts.push({ alert: m });
    ` });
    await send("Page.navigate", { url: BASE + "/" });
    await sleep(2500);
    await ev(`window.save = () => {}; data = { watchlist: [], inventory: [] }; 1`);   // parte vuota, mai salvata

    console.log("\nTab:");
    for (const t of ["perito", "deals", "search", "watch", "inv", "calc"]) {
      const n0 = errors.length;
      await ev(`go(${JSON.stringify(t)}); 1`); await sleep(t === "deals" ? 2500 : 400);
      const len = await ev(`document.querySelector("#view").innerText.length`);
      check(`tab ${t}`, len > 20 && errors.length === n0, `${len} caratteri`);
    }

    console.log("\nAffari:");
    await ev(`go("deals"); 1`); await sleep(2500);
    const deals = await ev(`document.querySelectorAll(".deal").length`);
    check("schede occasioni", deals > 0, `${deals} schede`);
    if (deals) {
      const d = await ev(`(() => { const b = document.querySelector(".deal button[data-key]"); const o = dealsData.opportunities.find(x => dealKey(x) === b.dataset.key);
        return { key: b.dataset.key, buy: o.buy, ship: shipOf(o), text: b.closest(".deal").innerText }; })()`);
      check("spedizione nella scheda", /sped\./.test(d.text), `${d.ship} €`);
      await ev(`__ans = [${JSON.stringify(String(d.buy).replace(".", ","))}, "@def"]; document.querySelector(".deal button[data-key]").click(); 1`);
      await sleep(200);
      const it = await ev(`data.inventory[0] || null`);
      check("«Segna come comprata» → inventario", it && it.src === "ct" && it.buy === d.buy && it.est && it.ct?.blueprintId, it ? `buy ${it.buy}, ship ${it.ship}` : "nessuna voce");
      const shipDef = await ev(`__prompts.filter(p => /Spedizione/.test(p.msg || "")).at(-1)?.def`);
      check("spedizione proposta = quella dello scanner", Number(shipDef) === d.ship, `${shipDef}`);
      check("etichetta IN INVENTARIO", await ev(`document.querySelector(".deal").innerText.includes("IN INVENTARIO")`));
    }

    console.log("\nCerca e Watchlist:");
    await ev(`go("search"); 1`); await sleep(200);
    await ev(`document.querySelector("#q").value = "Pikachu"; document.querySelector("#go").click(); 1`);
    for (let i = 0; i < 40 && !(await ev(`lastSearch.cards.length > 0 || /Errore|Nessun/.test(document.querySelector("#results").innerText)`)); i++) await sleep(500);
    const heads = await ev(`[...document.querySelectorAll("#results th")].map(t => t.innerText).join("|")`);
    check("colonna «Paga al massimo», niente margine su low", /Paga al massimo/.test(heads) && !/Margine/.test(heads), heads.replace(/\n/g, " "));
    const nCards = await ev(`lastSearch.cards.length`);
    check("risultati ricerca", nCards > 0, `${nCards} carte`);
    if (nCards) {
      const pct0 = await ev(`settings.pct`);
      const a = await ev(`document.querySelector("#results tbody tr").cells[5].innerText`);
      await ev(`settings.pct = 20; render(); 1`);
      const b = await ev(`document.querySelector("#results tbody tr").cells[5].innerText`);
      await ev(`settings.pct = ${pct0}; render(); 1`);
      check("«Paga al massimo» segue le commissioni", a !== b || /non rende|senza prezzo/.test(a), `${a} → ${b}`);
      await ev(`addWatch(lastSearch.cards[0].id); 1`); await sleep(200);
      check("watchlist", await ev(`data.watchlist.length === 1 && /Paga al massimo oggi/.test(document.querySelector("#view").innerText)`));
      await ev(`__ans = ["2,50"]; addInv(lastSearch.cards[0].id); 1`); await sleep(200);
      const cercaInv = await ev(`data.inventory.find(it => !it.src) || null`);
      check("«+ Compro» con virgola e senza valore precompilato", cercaInv?.buy === 2.5 && (await ev(`__prompts.filter(p => /Prezzo pagato/.test(p.msg || "")).at(-1)?.def`)) === "", cercaInv ? `buy ${cercaInv.buy}` : "");
    }

    console.log("\nInventario:");
    await ev(`invTry = 0; go("inv"); 1`);
    for (let i = 0; i < 30 && (await ev(`invLoading || data.inventory.some(it => !it.live)`)); i++) await sleep(500);
    const inv = await ev(`data.inventory.map(it => ({ src: it.src || "cerca", live: !!it.live, ref: invRef(it) }))`);
    check("prezzi vivi", inv.length > 0 && inv.every(x => x.live), JSON.stringify(inv));
    check("pagina inventario", await ev(`/Capitale in carte/.test(document.querySelector("#view").innerText)`));

    console.log("\nBanco di vendita:");
    if (await ev(`data.inventory.length > 0`)) {
      const costo = await ev(`data.inventory[0].buy + data.inventory[0].ship`);
      const floor = await ev(`floorPrice(data.inventory[0])`);
      check("prezzo minimo sopra il costo", floor > costo, `minimo ${floor.toFixed(2)} contro costo ${costo.toFixed(2)}`);
      await ev(`__ans = ["CardTrader", "@def"]; listCard(0); 1`); await sleep(200);
      const l = await ev(`data.inventory[0].listing`);
      check("messa in vendita", !!l && l.platform === "CardTrader" && l.price > 0, l ? `${l.platform} a ${l.price} €` : "nessun annuncio");
      check("annuncio visibile in pagina", await ev(`/In vendita su/.test(document.querySelector("#view").innerText)`));
      if (l) {
        await ev(`__ans = [${JSON.stringify((l.price * 0.9).toFixed(2).replace(".", ","))}]; dropPrice(0); 1`); await sleep(200);
        check("ribasso registrato", await ev(`data.inventory[0].listing.drops.length === 1 && data.inventory[0].listing.price < ${l.price}`));
      }
      await ev(`__ans = ["@def", "@def"]; sell(0); 1`); await sleep(200);
      const sold = await ev(`data.inventory[0].sold`);
      const senzaAnnuncio = await ev(`!data.inventory[0].listing`);
      check("vendita con incasso reale", !!sold && sold.net > 0 && !!sold.at && senzaAnnuncio, sold ? `incassati ${sold.net} €` : "non registrata");
      check("guadagno realizzato in pagina", await ev(`/Guadagno realizzato/.test(document.querySelector("#view").innerText)`));
      // il conto deve tornare al centesimo: incassato - imballaggio - (prezzo pagato + spedizione)
      const conti = await ev(`(() => { const it = data.inventory[0], r = soldProfit(it);
        return { profit: r.profit, atteso: it.sold.net - (it.sold.out || 0) - it.buy - it.ship, out: it.sold.out, plat: it.sold.platform }; })()`);
      check("guadagno calcolato al centesimo", Math.abs(conti.profit - conti.atteso) < 0.005, `${conti.profit.toFixed(2)} € su ${conti.plat}, imballaggio ${conti.out} €`);
      const floorCt = await ev(`floorPrice(data.inventory[0], "CardTrader") > floorPrice(data.inventory[0], "Vinted")`);
      check("il prezzo minimo cambia con la piattaforma", floorCt, "CardTrader (6,47%) più alto di Vinted (0%)");
    }

    console.log("\nCalcolatore:");
    await ev(`go("calc"); 1`);
    await ev(`const s = (i, v) => { const e = document.querySelector(i); e.value = v; e.oninput(); }; s("#cb", 20); s("#cs", 30); 1`);
    const out = await ev(`document.querySelector("#cout").innerText`);
    check("calcolo di esempio", /[0-9]/.test(out), out.replace(/\n/g, " "));

    check("nessun errore JavaScript", errors.length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    check("esecuzione del test", false, e.message);
  } finally {
    try { ws?.close(); } catch {}
    chrome.kill();
    server?.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
  check("data.json non modificato", hash(DATA) === before);
  const bad = results.filter(r => !r.ok);
  console.log(`\n${bad.length ? `FALLITI ${bad.length} controlli su ${results.length}` : `Tutti i ${results.length} controlli superati`}.`);
  process.exit(bad.length ? 1 : 0);
})();
