// Prova veloce dell'app da banco (nessuna dipendenza): apre la pagina in un Chrome headless
// grande come un telefono, cerca una carta, apre i prezzi, registra un acquisto finto e
// controlla il conto della giornata.
// Uso:  node smoke-test.js        (con il server acceso; se e' spento lo avvia)
//
// Non tocca data.json (lo confronta prima e dopo) e non lancia scansioni.
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
const check = (name, ok, info = "") => { results.push({ ok: !!ok }); console.log(`${ok ? "  ok " : "  NO "} ${name}${info ? "  — " + info : ""}`); };

(async () => {
  if (!CHROME) { console.error("Chrome non trovato."); process.exit(1); }
  const before = hash(DATA);
  let server = null;
  try { await fetch(BASE + "/api/scan"); } catch {
    console.log("Server spento: lo avvio.");
    server = spawn(process.execPath, [path.join(__dirname, "server.js")], { cwd: __dirname, stdio: "ignore" });
    for (let i = 0; i < 60; i++) { try { await fetch(BASE + "/api/scan"); break; } catch { await sleep(500); } }
  }
  const profile = path.join(require("os").tmpdir(), "pokemon-smoke-" + PORT);
  // finestra da telefono: e' li' che l'app va usata
  const chrome = spawn(CHROME, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    "--window-size=390,844", "about:blank"], { stdio: "ignore" });
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
    await send("Page.enable");
    // dialoghi finti e memoria del telefono pulita a ogni prova
    await send("Page.addScriptToEvaluateOnNewDocument", { source: `
      try { localStorage.clear(); } catch {}
      window.__ans = [];
      window.prompt = (msg, def) => { const a = __ans.shift(); return a === "@def" ? String(def) : a ?? null; };
      window.confirm = () => (__ans.length ? __ans.shift() : true);
      window.alert = () => {};
    ` });
    await send("Page.navigate", { url: BASE + "/" });
    await sleep(2500);

    console.log("\nSchermate:");
    check("si apre sulla Carta", await ev(`tab === "carta"`));
    check("due sole schede", await ev(`Object.keys(TABS).join(",")`) === "carta,giornata", await ev(`Object.keys(TABS).join(", ")`));

    console.log("\nCerca una carta:");
    const t0 = Date.now();
    await ev(`cerca("charizard ex 199"); 1`);
    for (let i = 0; i < 40 && !(await ev(`!!risultati`)); i++) await sleep(150);
    const n = await ev(`risultati ? risultati.cards.length : 0`);
    check("ricerca istantanea", n > 0, `${n} carte in ${Date.now() - t0} ms`);
    check("espansione e numero nella lista", await ev(`/199/.test(document.querySelector("#lista").innerText)`));

    console.log("\nPrezzi della carta:");
    await ev(`apri(risultati.cards[0].id); 1`);
    for (let i = 0; i < 60 && (await ev(`attesa`)); i++) await sleep(200);
    const testo = await ev(`document.querySelector("#view").innerText`);
    check("offerte CardTrader per lingua", /Italiano|Inglese|Giapponese/.test(testo), (await ev(`(offerte?.offerte || []).length`)) + " gruppi");
    check("prezzi Cardmarket", /Trend/.test(testo));
    check("prezzo grande in cima", await ev(`!!document.querySelector(".big")`));
    check("nessun calcolo di rivendita", !/ROI|Paga al massimo|guadagn/i.test(testo), "niente aritmetica");

    console.log("\nSegnare un acquisto:");
    await ev(`__ans = ["12,50"]; presa(); 1`);
    await sleep(200);
    const acq = await ev(`acquisti[0] || null`);
    check("acquisto registrato", acq && acq.prezzo === 12.5 && acq.nome, acq ? `${acq.nome} a ${acq.prezzo} €` : "niente");
    check("si passa alla Giornata", await ev(`tab === "giornata"`));
    check("totale speso in pagina", await ev(`/12,50/.test(document.querySelector("#view").innerText)`));
    await ev(`localStorage.getItem("acquisti") ? 1 : 0`);
    check("resta nel telefono", await ev(`JSON.parse(localStorage.getItem("acquisti")).length === 1`));

    console.log("\nScatolone:");
    await ev(`lottoCalc("carte", "500"); lottoCalc("prezzo", "30"); 1`);
    const lot = await ev(`document.querySelector("#lottoout").innerText`);
    check("prezzo per carta", /0,06/.test(lot), lot.replace(/\n/g, " ").slice(0, 60));
    await ev(`lottoCalc("prezzo", "250"); 1`);
    check("giudizio sul lotto caro", /Caro/.test(await ev(`document.querySelector("#lottoout").innerText`)));

    check("nessun errore JavaScript", errors.length === 0, errors.slice(0, 2).join(" | "));
  } catch (e) {
    check("esecuzione del test", false, e.message);
  } finally {
    try { ws?.close(); } catch {}
    chrome.kill();
    server?.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
  check("data.json non modificato", hash(DATA) === before);
  const bad = results.filter(r => !r.ok).length;
  console.log(`\n${bad ? `FALLITI ${bad} controlli su ${results.length}` : `Tutti i ${results.length} controlli superati`}.`);
  process.exit(bad ? 1 : 0);
})();
