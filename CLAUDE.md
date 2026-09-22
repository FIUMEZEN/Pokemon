# Pokemon Trader

App web locale (in italiano) per la compravendita di carte Pokémon: cerca una carta, mostra il prezzo Cardmarket e calcola il margine netto comprando e rivendendo. Utente: Fabio, budget 200-1000 €, carte singole raw.

## Avvio
- `node server.js` → http://localhost:8000. Nessuna dipendenza da installare.
- `node server.js --telefono` → raggiungibile anche dal telefono sulla stessa Wi-Fi (stampa l'indirizzo). Solo sulla rete di casa.
- **Non usare Python**: l'installazione sul PC è danneggiata (manca `html/entities.py`, quindi `http.server` non si importa). Per questo il server è in Node.
- Per riavviare: fermare il processo sulla porta 8000 (PowerShell: `Get-NetTCPConnection -LocalPort 8000 -State Listen | % { Stop-Process -Id $_.OwningProcess -Force }`), poi rilanciare.

## File
- `server.js`: server HTTP + accesso alle fonti dati.
- `index.html`: tutta l'interfaccia (HTML, CSS e JS in un file). Tab: Perito, Affari, Cerca, Watchlist, Inventario, Calcolatore.
- `data.json`: watchlist e inventario dell'utente (creato dall'app). **Non cancellarlo né riempirlo con dati di prova**: se si fanno test, rimetterlo a `{"watchlist":[],"inventory":[]}`.
- `cache-priceguide.json` (listino Cardmarket, ~15 MB) e `cache-cards.json` (anagrafica carte): cache su disco, rigenerabili.

## Fonti dei dati
- **Prezzi**: listino ufficiale Cardmarket `https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_6.json` (Pokémon = gioco 6). Pubblico, senza account, rigenerato da Cardmarket ogni giorno. Il server lo scarica all'avvio e lo riscarica quando ha più di 6 ore, al momento di una ricerca. Campi usati: `trend`, `low`, `avg`, `avg1`, `avg7`, `avg30`, tutti in €. Il file `.csv` corrispondente dà 403.
- **Anagrafica** (nome, set, numero, rarità, immagine, `idProduct` Cardmarket): TCGdex `https://api.tcgdex.net/v2/en`. Gratuita e veloce. Si prende `variants_detailed[].thirdParty.cardmarket` come `idProduct` e con quello si cerca il prezzo nel listino. Le carte digitali TCG Pocket (id tipo `A2b-022`) vengono escluse. Si mostrano al massimo 80 carte per ricerca.
- **Da non usare**: pokemontcg.io. Ha 500/502 intermittenti e i prezzi Cardmarket erano fermi da mesi (fino a 307 giorni), con errori grandi (es. Pikachu ex #247: 55 € contro 78 € reali).
- Cardmarket.com blocca l'accesso automatico (403): non si possono leggere le sue pagine con WebFetch o curl.
- Il «Suggested Price» non è nel listino pubblico. L'app usa il **prezzo trend** come prezzo di rivendita.

## Come si aggiornano i prezzi
- **Cerca**: prezzi freschi a ogni ricerca (colonna «Dati» = giorni dall'ultimo aggiornamento, ⚠ oltre 14).
- **Watchlist**: si aggiorna solo con il pulsante «Aggiorna prezzi».
- **Inventario**: prezzi vivi (22/09/2026). Aprendo la tab, se hanno più di un'ora, `refreshInv()` li chiede in un colpo solo a `POST /api/live`; c'è anche il pulsante «Aggiorna prezzi». Carte da Cerca: `it.card` si riscrive (trend Cardmarket). Carte da Affari: `it.live` = `blueprintId` → `card_market_ids[0]` in `cache-blueprints.json` → listino, **il più prudente tra `trend` e `avg30`** (colonne `-holo` per le reverse), come lo scanner; nessuna richiesta a CardTrader. Senza ponte Cardmarket si resta sulla stima `est.sellFast`. Le carte vendute non si aggiornano.
- **Inventario da Affari.** Le voci da CardTrader hanno `src: "ct"`, `ct` (dati dell'annuncio, `blueprintId`) e `est` (stima al momento dell'acquisto, da **non aggiornare mai**: è il dato per validare i segnali prima della Fase 3). `key` = stessa chiave di `keyOf` in `scanner.js` (`url|seller|buy|reverse`). Si registra **dopo** aver pagato, con il prezzo reale; «Apri su CardTrader» resta un link a parte. Le carte già in inventario si **marcano** (etichetta IN INVENTARIO), non si nascondono; una seconda copia chiede conferma. Le voci da Cerca non hanno `src` e restano come prima.
- **Tetto dello scanner.** `maxBuy` è 80 €, sotto la fascia di budget dell'utente (200-1000 €). Al 22/09/2026: 207 occasioni, nessuna sopra i 100 €, mediana `profitFast` 2,07 € sulle non sospette. Alzarlo cambia `opportunities.json` e i casi da controllare a mano: non farlo senza che lo chieda Fabio.

## Come si calcola il guadagno (funzione `net` in index.html)
```
costo    = prezzo acquisto + spedizione acquisto
ricavo   = prezzo vendita × (1 − commissione%) − quota fissa − spedizione vendita
guadagno = ricavo − costo        ROI = guadagno / costo
prezzo massimo d'acquisto per un ROI dato = ricavo / (1 + ROI) − spedizione acquisto
```
Esempio (Cardmarket: 5%, spedizioni 1,50 €): compro a 20, rivendo a 30 → costo 21,50, ricavo 27,00, guadagno 5,50 € (+25,6%).
In «Cerca»: acquisto = «Offerta min.» (`low`), vendita = «Trend». Preset piattaforme (commissione %, fissa €, spedizione €): Cardmarket 5/0/1,5; eBay 12,8/0,35/3; Vinted 0/0/2,5. Sono valori indicativi, salvati nel `localStorage` del browser.

## Limiti da tenere presenti
- **Il margine mostrato oggi in «Cerca» non è utilizzabile.** Misurato sul listino del 21/09/2026: nella fascia trend 5-60 € con vendite recenti (12.135 carte) lo spread `(trend-low)/trend` ha **mediana 52%**, 90° percentile 87%, e i massimi sono `low` di 0,02 € contro trend di 27 €. `low` include qualsiasi condizione e lingua, quindi non è un prezzo d'acquisto: è rumore. Va sostituito con offerte reali prima di costruirci sopra qualsiasi automazione.
- I prezzi sono giornalieri, non in tempo reale.
- Alcune carte vecchie possono avere `idProduct` sbagliato in TCGdex (es. Charizard Expedition #6, #39, #40 con lo stesso trend): da verificare su Cardmarket.
- Il link «CM» apre la ricerca su Cardmarket per nome e numero, non la pagina esatta del prodotto.

## Automazione: cosa si può e cosa no (verificato 21/09/2026)
Obiettivo dell'utente: automatizzare la compravendita. Scelta fatta: **Fase 1 (prezzi reali) + Fase 2 (scanner automatico), acquisto a mano**. Fase 3 (acquisto automatico) rimandata finché i segnali non si dimostrano validi. Focus strategia: **offerte sotto mercato**.

- **Cardmarket: acquisto NON automatizzabile.** L'API ufficiale è *chiusa a nuove domande* ("Currently, we are not accepting applications", help.cardmarket.com/en/cardmarket-api). È comunque un'API da venditore (stock, ordini ricevuti, spedizioni): nessun endpoint di acquisto. Il sito dà 403 agli accessi automatici e aggirarlo viola le ToS: **non farlo**. Migrazione API in corso verso `apiv2.cardmarket.com`.
- **CardTrader: sì.** `https://api.cardtrader.com/api/v2`, token **gratuito** dalle impostazioni profilo, header `Authorization: Bearer <token>`. Dà offerte reali (condizione, lingua, prezzo, venditore, quantità) e documenta l'acquisto (`POST /cart/add`, `POST /cart/purchase`). Rate limit 200 req/10s, marketplace 10 req/s. Senza token ogni endpoint dà 401.
- **Chiave di join CardTrader ↔ Cardmarket**: il blueprint ha `card_market_ids` (array) = `idProduct` del listino Cardmarket. Questo permette di comprare su CardTrader al prezzo reale e valutare la rivendita al trend Cardmarket.
- **Sweep completo fattibile**: `GET /marketplace/products?expansion_id=X` restituisce le 25 offerte più economiche per ogni blueprint dell'espansione. ~200 espansioni Pokémon → tutto il mercato in meno di un minuto entro i rate limit.
- Il token CardTrader **permette di spendere**: va in `cardtrader-token.txt` (mai nel codice, mai in chat).
- `probe-cardtrader.js`: script di sola lettura che verifica tutte le ipotesi sopra sui dati veri e stampa i primi margini reali. Da lanciare appena c'è il token, **prima** di scrivere l'integrazione definitiva.

## Economia reale del mestiere (misurata il 21/09/2026 — LEGGERE PRIMA DI CAMBIARE I CALCOLI)
Tre trappole misurate sui dati veri. Ognuna faceva sembrare redditizie operazioni in perdita.

1. **`low` Cardmarket vs `trend` non è un margine.** Mediana dello spread 52% su 12.135 carte liquide. `low` mescola tutte le condizioni e lingue. Numero inutilizzabile.
2. **CardTrader e Cardmarket costano uguale.** L'offerta minima NM su CardTrader è il **45% del trend Cardmarket** (mediana) ma il **117% del `low` Cardmarket**. Il "margine tra piattaforme" era solo il confronto tra il *minimo* di un mercato e la *media* dell'altro. Comprare su CardTrader per rivendere al trend Cardmarket **non è un'attività redditizia**.
3. **Nei set vecchi e illiquidi il divario tra offerte non è un errore di prezzo.** Esempio Base Set Nidoking: su CardTrader 1ª offerta 30,11 €, 3ª a 90,64 € (apparente −67%), ma trend Cardmarket 33,07 € → comprando e rivendendo si **perde** 0,68 €. Senza concorrenza gli annunci sono sparpagliati verso l'alto.

**Modello corretto, implementato in `scanner.js`:**
- prezzo d'acquisto = offerta NM più bassa reale su CardTrader;
- prezzo di rivendita = **`min(3ª offerta CardTrader, trend Cardmarket)`** — il guard sul trend è ciò che scarta le trappole del punto 3, **non rimuoverlo**;
- normale e reverse holo sono carte diverse: vanno valutate separatamente (`trend` vs `trend-holo`);
- servono ≥ 5 offerte NM, altrimenti non c'è un mercato di riferimento;
- commissioni CardTrader: **5,3% + IVA 22%** (venditore UE iscritto dopo marzo 2026), nessuna quota fissa. Vendendo la spedizione la paga il compratore.

**Dove sta il margine:** l'efficienza del mercato cresce con la liquidità. Nelle espansioni moderne (Surging Sparks 2024) su 35 carte con mercato gli annunci sotto prezzo sono **zero**: i prezzi coincidono al centesimo. Le occasioni, quando esistono, sono singoli annunci fuori prezzo, rari, da verificare a mano (condizione dichiarata, foto, affidabilità venditore, autenticità).

**Ottimizzazione utile:** `scanner.js` raggruppa le occasioni per venditore (`bundles`), perché comprando più carte dallo stesso venditore la spedizione si paga una volta sola. Sulle carte da pochi euro la spedizione è la voce che decide se c'è margine.

### Trappole nei dati CardTrader (trovate facendo girare lo scanner — NON rimuovere questi filtri)
La prima scansione completa produsse 343 "occasioni" guidate da fantasie tipo *compri a 3,91 € e vendi a 7.038 €*. Cause e rimedi:
1. **`card_market_ids` è `[]` per le espansioni giapponesi/asiatiche.** Il guard sul trend Cardmarket spariva in silenzio e restava il solo CardTrader. → Il riferimento Cardmarket è ora **obbligatorio**: senza, la carta si salta.
2. **Annunci-segnaposto a prezzi assurdi.** Es. Energy Link con offerte NM `3,91 · 3,99 · 7038 · 7038 · 7038`: la "3ª offerta" come prezzo di mercato ci cascava in pieno. → Prezzo di mercato = **mediana** delle offerte diverse dalla più bassa.
3. **Lingue asiatiche.** `jp`, `kr`, `zh-CN`, `zh-TW` sono un altro mercato, che il listino Cardmarket non prezza. → Ammesse solo `en, it, de, fr, es, pt`.
4. **Fonti in disaccordo.** Se mercato CardTrader e trend Cardmarket differiscono di oltre 3×, il dato è inaffidabile → si salta.
5. `roi > 1.5` resta possibile ma viene marcato `suspect: true` e mostrato come «da verificare».

6. **Condizione dichiarata: ci si fida dell'annuncio (decisione dell'utente, 22/09/2026).** Caso Palkia V Astral Radiance 167/189: «Near Mint» a 50,64 € mentre copie *Moderately Played* e *Played* stavano a 59-65 €. Era stato aggiunto un controllo (`condDoubt`: NM più economica di copie rovinate → «da verificare»), poi **tolto su richiesta dell'utente**: «fidiamoci di quello che dice l'annuncio, usiamo i dati disponibili». Non reintrodurre controlli che mettano in dubbio la condizione dichiarata senza che lo chieda. Nota tecnica: l'API non espone le foto dei singoli annunci.

**Due scenari di vendita, entrambi calcolati:** `profit` (paziente, si vende alla mediana, presuppone attesa che le offerte più basse si esauriscano) e `profitFast` (immediato, ci si mette sotto la 2ª offerta). Un'occasione viene scartata se `profitFast <= 0`: deve reggere anche vendendo subito.

## Sezione «Affari» (rifatta il 21/09/2026)
- **Schede con immagine** in griglia (`dealCard`), ordinate di default per **guadagno vendendo subito** (`profitFast`, il dato realistico). Filtri salvati nel `localStorage`: budget massimo per carta, guadagno minimo, ordinamento. Le occasioni sospette (`lonely`/`suspect`) stanno in una sezione a parte, chiusa di default. I gruppi «stesso venditore» mostrano le miniature.
- Immagini: dal blueprint CardTrader (`image.preview.url`), salvate come `img` in `cache-blueprints.json` e come `image` nelle occasioni. Gli indirizzi senza `www` rimandano a `www.cardtrader.com`: si salva direttamente quello. `scanner.js` e `build-catalog.js` salvano i blueprint nella stessa forma (cache condivisa); le voci vecchie senza `img` si riscaricano.
- **Scansioni automatiche (22/09/2026, richiesta dell'utente: «è lento vedere se escono nuove offerte»).** Finché il server è acceso: **giro veloce ogni 5 minuti** (`scanner.js --hot`, solo le espansioni «calde» = quelle con almeno un'occasione nell'ultimo giro completo, ~80, ~20 s) e **giro completo ogni ora** (tutte le espansioni con almeno un `card_market_ids`: se ne saltano ~70 che non possono dare occasioni). Media ~0,5 richieste/s. Dopo un errore i giri automatici si fermano 15 minuti. `node server.js --no-auto` li disattiva. Pulsante «Aggiorna ora» = giro veloce, se l'ultimo giro ha almeno 2 minuti. Stato in `GET /api/scan` (`next`, `fresh`, `mode`).
- **Giri parziali** (`--hot` o codici): aggiornano solo le proprie espansioni e ricopiano le altre dal file precedente. `opportunities.json` ha `fullAt` (ultimo giro completo), `hot` (codici caldi, ricalcolati solo dal giro completo), `mode`.
- **`firstSeen`**: ogni occasione tiene la data in cui è stata vista la prima volta (chiave: url + venditore + prezzo + reverse). Le occasioni già presenti prima che si tenesse la data hanno `firstSeen` convenzionale `2000-01-01` (data vera sconosciuta), altrimenti al primo giro risultavano tutte «nuove». Nella pagina: etichetta **NUOVA** se comparsa nell'ultima ora, ordinamento «Più recenti», contatore «Nuove nell'ultima ora». La pagina interroga lo stato ogni 20 s (ogni 3 s durante un giro) e ricarica da sola le occasioni quando arriva un giro nuovo, tenendo lo scorrimento.
- **Protezione**: se più del 30% delle espansioni fallisce (blocco di CardTrader), `scanner.js` esce con codice 2 **senza sovrascrivere** `opportunities.json`.
- Il riquadro commissioni in alto (`#settings`) è nascosto in Perito e Affari: lì i costi delle piattaforme sono già calcolati e il riquadro non conta nulla.
- Bug trovato: dopo l'aggiunta della cache blueprint, `scanner.js` usava `loadJson` senza definirlo e crashava all'avvio. Non era emerso perché lo scanner non era più stato eseguito. Dopo modifiche allo scanner, eseguirlo almeno su un'espansione: `node scanner.js ssp` (attenzione: sovrascrive `opportunities.json` e fa ripartire l'attesa di 20 minuti).

## CardTrader è dietro Cloudflare — non è il rate limit dichiarato a fermarti
Tre scansioni complete ravvicinate (856 espansioni × 2 richieste, concorrenza 6) hanno fatto scattare la protezione anti-bot: **403 con pagina "Just a moment..."** su *tutti* gli endpoint, token valido incluso. I 200 req/10s documentati non sono il vincolo reale.

- **Non aggirare il challenge** (niente browser headless, proxy o user-agent falsi): viola le ToS e fa bloccare l'account.
- Rimedio applicato: concorrenza 3, pausa 150-200 ms per richiesta, attesa 10 s e 5 tentativi sul 403.
- **`cache-blueprints.json`**: i blueprint (nome, numero, set, `card_market_ids`) non cambiano mai. Si scaricano una volta e si riusano — dimezza le richieste. Lo condividono `scanner.js` e `build-catalog.js`.
- Se arriva un 403, si aspetta qualche minuto: si sblocca da solo.

## Tab "Perito" — valutare un lotto di Vinted/Subito
Mercati generalisti = margini veri (chi vende non sa cosa ha), ma:
- **Vinted e Subito non hanno API pubbliche e lo scraping viola le loro ToS**: non si scarica il link. L'utente copia e incolla il testo.
- Ostacolo di fondo, che nessuna API risolverebbe: lì un annuncio è "Lotto carte Pokemon vintage" + foto, senza identità della carta né condizione. Il margine esiste *proprio perché* guardare le foto è lavoro umano.
- Consigliato all'utente: avvisi salvati sulle piattaforme stesse (gratis e leciti), e l'app come perito.

**Come si accede all'annuncio: bookmarklet, non scraping.** Nella tab Perito c'è un pulsante da trascinare nei preferiti. Gira nel browser dell'utente, sulla pagina che ha già aperto lui, e passa titolo/descrizione/foto all'app via `#perito=<base64>` (ancora: resta nel browser, non arriva mai al server). Nessuna richiesta automatica a Vinted, nessun aggiramento: è il copia-incolla in un clic. `readBookmarkletHash()` in index.html lo decodifica e lancia la valutazione.

**Catalogo (`build-catalog.js` → `catalog.json`, ~7 MB, 62.843 carte, 5.866 nomi):**
- Fonte base **Cardmarket**: `cache-products.json` (catalogo prodotti pubblico, ~14 MB) unito al listino prezzi per `idProduct`. Nessun token, sempre disponibile — il perito funziona anche con CardTrader bloccata.
- Arricchimento **CardTrader** (facoltativo): aggiunge numero di collezione e nome espansione, che permettono di fissare la versione esatta. Se dà 403 si salta e il catalogo esce lo stesso, con forbici più larghe.

### Due tipi di annuncio (osservazione dell'utente, 21/09/2026 — ha ridisegnato il perito)
- **Lotti**: non hanno mai i nomi delle carte, solo foto. Il perito calcola il **prezzo per carta** (≤ 0,08 €/carta = in linea col bulk; ≤ 0,30 = paghi la speranza di carte buone; oltre = caro) e mostra con la forbice gli eventuali nomi citati.
- **Carte singole**: titolo/descrizione riportano nome e **numero** (`Charizard ex 199/165`). Qui il perito dà il **prezzo esatto**.
- **Visione sulle foto: proposta e rifiutata dall'utente.** Non riproporla come soluzione ai lotti senza che la chieda lui.

**Identificazione esatta via TCGdex, senza CardTrader** (`identify()` in server.js): il **denominatore** del numero (`/165`) è il numero di carte ufficiali del set (`cardCount.official`, o `total`) e individua l'espansione; dentro quel set si cerca il `localId`. «Charizard 4» corrisponde a 4 carte, «Charizard 4/102» a una sola (Base Set). Se più set hanno lo stesso numero di carte vince quello il cui nome della carta compare nel testo; se il nome non compare si avvisa. Numeri normalizzati togliendo gli zeri iniziali (`049`→`49`, `SV049`→`SV49`). Set e liste carte in cache in `cache-sets.json` (non cambiano). Prezzo: `cardMeta()` → `idProduct` → listino, **il più prudente tra `trend` e `avg30`**; con «reverse» nel testo si usano `trendHolo`/`avg30Holo` (stesso prodotto Cardmarket, colonne `-holo`).

**Annunci in altre lingue (caso reale: «Pokemon evolutions chrysacier» → Metapod, XY Evolutions).** Chi vende in Francia o Germania scrive il nome nella sua lingua.
- `loadNames()` scarica da TCGdex nomi di carte ed espansioni in **en, fr, de, it, es, pt** (`cache-names.json`, ~14.800 nomi, 915 espansioni). Gli **id TCGdex sono identici in tutte le lingue** (`xy12-4` = Chrysacier fr = Metapod en): basta un indice nome→id.
- `scan()` cerca nel testo prima le espressioni più lunghe («Évolutions Prismatiques» batte «Évolutions»). **`STOP`**: parole da annuncio che sono anche nomi di carte in qualche lingua e da sole vanno ignorate — *«Carte» è una carta allenatore francese* e compariva in quasi ogni annuncio italiano.
- Senza numero, **nome + espansione citata** (`identifyByName`) spesso bastano a individuare una carta sola. Senza espansione il nome da solo è troppo vago: si dà la forbice.
- Nome straniero riconosciuto → avviso informativo sulla lingua. Il prezzo Cardmarket è unico per tutte le lingue europee (a differenza di quelle asiatiche).

**Ponte verso Cardmarket (`cmExpansionFor`, `priceCard`).** Interi set in TCGdex non hanno l'id Cardmarket (tutto **XY Evolutions**). Si ricostruisce l'espansione Cardmarket confrontando l'elenco dei nomi del set TCGdex con ogni espansione di `cache-products.json` (similarità di Jaccard; soglia minima 0,5): Evolutions 0,87 contro 0,76 della seconda, Surging Sparks 0,99 contro 0,55. Poi si prende il prodotto con lo stesso nome base; con più prodotti si usa il più prudente.

**Numero stampato: denominatore = carte UFFICIALI (caso reale: «Moushold holo 125/128 30c»).** `125/128` combaciava con Maushold (*30th Celebration*, 128 ufficiali) e con Serperior (*Dragons Exalted*, 124 ufficiali ma 128 totali). Nessun nome riconosciuto → l'app aveva scelto Serperior e acceso ⛔ «truffa» su una carta sbagliata. Regole introdotte in `identify()`:
- Si cercano prima i set con `official === den`; `total` solo come ripiego. Una segreta di Dragons Exalted è stampata `125/124`, mai `125/128`.
- **Nomi con errori di battitura** (`nameMatch` + distanza di Levenshtein): tolleranza 1 lettera fino a 8 caratteri, 2 oltre, 0 per nomi ≤ 4 caratteri (altrimenti «Mow» diventerebbe Mew). Viene mostrato un avviso «è Maushold scritto male».
- Anche l'espansione citata nel testo conferma la carta. Punteggio candidati: nome esatto 4, nome sbagliato 3, espansione nel testo +2.
- **Carta non confermata (né nome né espansione nel testo) → `uncertain`: niente ⛔ «troppo economica» e niente guadagno.** Un allarme calcolato sulla carta sbagliata è peggio di nessun allarme.
- «holo» su una comune o non comune = reverse holo (quelle carte non esistono in holo normale). Se Cardmarket non ha il prezzo reverse si usa quello normale.

**Ponte con più prodotti dello stesso nome.** In 30th Celebration Cardmarket ha due Maushold (0,13 € e 10,29 €) e TCGdex due carte (#125 comune, #146 illustration rare). Il ponte prendeva sempre il più economico: giusto per il #125 solo per caso, sbagliato per il #146. Ora, se i conteggi coincidono, si abbinano **per posizione**: carte TCGdex ordinate per numero, prodotti Cardmarket per `idProduct` (Cardmarket li assegna nell'ordine del set). Se i conteggi non coincidono si resta sul più prudente e scatta l'avviso edizioni.

**Edizioni con lo stesso nome — avviso (`editionsOf`).** Nella stessa espansione Cardmarket di Base Set ci sono **due Charizard con nome identico** (1.009 € e 3.331 € di trend): edizioni diverse. Regola: si avvisa se Cardmarket ha **più prodotti con quel nome, nell'espansione della carta, di quante carte con quel nome abbia il set in TCGdex**. Nel 151 ci sono 3 «Charizard ex» da entrambe le parti (normale, full art, SIR): carte diverse, nessun avviso.
- Due tentativi sbagliati da non ripetere: (1) confrontare con l'espansione "gemella" (Jaccard entro 0,02) dava falsi allarmi sul 151, perché la gemella è la versione giapponese dello stesso set; (2) richiedere che il nome sia unico nell'espansione spegneva proprio l'avviso di Base Set, dove le edizioni stanno *dentro* la stessa espansione.

### Scanner di carte (tab Perito, pulsante 📷)
Scelta dell'utente: **lettura gratuita (Tesseract.js da jsdelivr, nel browser)**, da telefono e da foto già fatta. Visione Claude proposta come alternativa (~1-2 cent/scansione) e non scelta: non riproporla senza che la chieda.
- Idea chiave: non serve riconoscere il disegno. Nome (in alto) e numero (in basso) bastano, e il perito già sa gestire i loro errori di lettura. `scanImage()` ritaglia zone della foto, le ingrandisce a 2000 px, le passa a Tesseract e manda il testo a `/api/appraise` (nome + numero nel `text`, lettura della carta intera nel `body`).
- Un solo `<input type=file accept=image/*>` **senza** `capture`: sul telefono offre fotocamera o galleria, sul computer la scelta del file. La fotocamera live (`getUserMedia`) non funzionerebbe comunque, perché dal telefono la pagina è in HTTP non-localhost.
- **Dal telefono**: `node server.js --telefono` ascolta su 0.0.0.0 e stampa gli indirizzi di rete. Di default resta su 127.0.0.1: su una Wi-Fi pubblica chiunque potrebbe modificare `data.json`.

**Misurato su 30 carte con immagini PERFETTE (scansioni TCGdex, 8 set dal 1999 al 2024): il numero viene letto in ~15 casi su 30.** Bene Scarlet & Violet e Sword & Shield, male XY, **0 su 4 Sun & Moon**. Sulle carte a illustrazione intera il numero sta sopra il disegno e non si legge. Il nome invece si legge quasi sempre (anche se storpiato: «Charizard 2X», «fsssdCharizard»). Con foto vere andrà peggio.
- Strategie provate, equivalenti tra loro: ritagli stretti psm 11 + fascia larga psm 3 = 15/30; fasce intere psm 6 = 12/30 (ma psm 6 legge sempre `4/102` di Base Set, 27 combinazioni su 27); le due insieme = 15/30. Non c'è un'impostazione magica: **non perdere tempo a ritoccare i parametri**.
- Quindi il flusso è: il lettore prende il nome; **se il numero non si legge, l'app chiede all'utente di scriverlo** (con la carta in mano: 5 secondi). Nome + numero bastano per la carta esatta.
- Aggiornamento: sulle foto vere dell'utente, con parole-guida, attacchi e riparazione del numero (sezione «Foto vere dell'utente» più sotto), **3 carte su 4 sono state riconosciute in automatico**. La misura 15/30 sulle scansioni pulite era fatta col metodo precedente (solo ritagli fissi).
- Aiuti per l'OCR: `fixSlash` (la barra letta come l, I, |), `fixEx` (il logo «ex» letto come @X, €X, ©X), `nameMatch` accetta il nome contenuto dentro lettere spurie (solo nomi di almeno 6 lettere, così «Mew» non si trova dentro «Mewtwo»), e tra più numeri candidati il server preferisce quello confermato dal nome.

### Foto vere dell'utente (21/09/2026): lezioni dal primo caso reale
Quattro foto «da scambio» (carta nella metà alta, sotto un foglio scritto a mano, attorno un controller DJ): Charizard δ Crystal Guardians 4/100, Groudon-EX full art Dark Explorers 106/108, Leafeon V Evolving Skies 166/203, Mewtwo LV.X promo DP28. **Risultato finale: 3 su 4 automatici, il Mewtwo chiede di scrivere `DP28`.** Le foto sono in `images/3.jpg`-`6.jpg` della scratchpad di sessione (non persistono). Cosa è servito, in ordine di impatto:

**1. Abbinamento Cardmarket per ATTACCHI (`movesKey`, `byExpMoves`).** I nomi divergono tra le fonti: TCGdex «Mewtwo» / Cardmarket «Mewtwo LV.X [Psybarrier | Giga Burn]»; «Groudon-EX» / «Groudon EX»; «Charizard δ» / «Charizard δ Delta Species». Cardmarket scrive abilità e attacchi tra parentesi nel nome del prodotto, TCGdex li ha nel dettaglio (`cardMeta().moves`). Stesso nome + stessi attacchi = stessa carta; nome diverso + stessi attacchi = stessa carta chiamata diversamente. Il primo tentativo per nome avrebbe preso il Groudon EX di **Primal Clash** (altri attacchi) invece di quello di Dark Explorers.
- `cardKey` toglie parentesi, punteggiatura, «δ / delta species» e **il livello** («Lv.47», «LV.X»). Senza togliere il livello, **tutta l'era Diamante & Perla / Platino** non trovava l'espansione Cardmarket (Jaccard 0,14 sulle promo DP).

**2. Codici promo senza barra** (`RX.promo`): DP28, HGSS01, BW99, XY174, SM60, SWSH050, SVP 085 → set `dpp`, `hgssp`, `bwp`, `xyp`, `smp`, `swshp`, `svp`. In TCGdex il `localId` è il codice stesso («DP28»), tranne le SV che sono solo cifre («085»).

**3. Trovare la carta nella foto con le parole-guida.** I ritagli fissi presuppongono una carta che riempie la foto: sulle foto vere leggevano «LOOP» dal controller. Ora `scanImage()` fa prima l'OCR dell'intera foto (psm 11, parole con posizione) e cerca **weakness / resistance / retreat** (anche it/fr/de/es), stampate poco sopra il numero su quasi ogni carta Pokémon. Poi ritaglia la fascia sotto quelle parole (da −1 a +12 altezze di riga, ±40 in larghezza), la ingrandisce a ~44 px di altezza del testo e la legge: fascia intera, metà destra, metà sinistra, psm 11 e 6, poi **a colori invertiti** (numero chiaro sul bordo nero delle full art). Trovate le parole-guida in 4 foto su 4. I ritagli fissi restano come ripiego.

**4. Riparare il numero letto male, SOLO con conferma** (`repaired` in `appraise`, solo con `scan: true`):
- barra letta come «1» o «7»: «41100» → 4/100;
- cifre spurie attaccate: «7106/1088», «W106/4108» → 106/108.
Si accettano solo denominatori che esistono come numero di carte di un set, e **un numero riparato vale solo se il nome o gli attacchi confermano la carta**: senza questa regola dal rumore «2720» uscì Dratini (Dragon Vault 2/20) al posto del Groudon.

**5. Conferme e scelte tra candidati in `identify()`:**
- **attacchi nel testo** (`movesIn`): dalla foto si leggono bene anche quando il nome si perde. Serve un attacco di ≥6 lettere o due attacchi; un attacco di due parole vale anche se arriva spezzato su righe diverse («Giant» … «Claw»);
- **categoria**: se il testo contiene la riga debolezza/resistenza/ritirata, le carte Energia e Allenatore con lo stesso numero perdono punti (106/108 è anche Lightning Energy di Power Keepers). `cardMeta().category` = Pokemon / Trainer / Energy;
- **nome in conflitto**: se nel testo c'è un altro Pokémon e né il nome né gli attacchi della carta trovata, non è confermata («Garchomp 6/130» → il #6 è Lucario → avviso).

**6. La richiesta «scrivi il numero» la decide il risultato del server** (nessuna carta, o carta incerta), non la presenza di cifre nel testo letto.

**Costi d'acquisto (verificati 21/09/2026):** su Vinted chi COMPRA paga la protezione acquisti **0,70 € + 5%** del prezzo, più la spedizione (stimata 3 €). Su una carta da 300 € sono 15,70 € di commissione: il margine su Cardmarket passa da ~65 € a 28 €. Le carte da pochi euro non si comprano mai singolarmente: la spedizione da sola supera il margine.

**Guadagno mostrato su tre piattaforme** (l'utente non ha ancora deciso dove rivendere): Cardmarket 5%, CardTrader 5,3% + IVA, Vinted 0% (la paga chi compra).

**Segnali d'allarme letti dal testo** (`RX` e `LANGS` in server.js): parole da riproduzione (*proxy, custom, replica, ristampa, orica, fan made, carta in metallo*…), lingue asiatiche, carta gradata, usura dichiarata, prima edizione.
- **Prezzo < 30% del valore = ⛔ falso o truffa** (< 50% = ⚠️). È il segnale di falso più forte calcolabile senza guardare le foto, ed è la risposta pratica all'obiezione dell'utente «non posso fare 10 controlli per carta».
- **Con un ⛔ o con lingua asiatica il guadagno NON si mostra** (`resaleBlocked`). Un «+761 €» verde accanto a «è una riproduzione» è un invito a cascarci. Per le asiatiche il prezzo di riferimento europeo non vale, e il controllo «troppo economica» è disattivato: costano legittimamente meno.
- Da non inserire tra le parole da falso: «metal», che è anche un tipo di energia Pokémon.

**Statistiche del perito — due scelte che sembrano dettagli ma non lo sono:**
1. **Stima realistica = 25° percentile**, non la mediana. La mediana sovrastima moltissimo: un lotto "per bambini" con Pikachu/Eevee/Snorlax dava 33 € con la mediana e ne dà 6 con il percentile, che è il valore vero. In un lotto qualunque le carte sono quasi sempre le comuni. Con il numero di collezione noto si usa la mediana delle sole versioni che corrispondono.
2. **Segnale 🔍 = concentrazione del valore (`richShare`)**, non il massimo. Segnalare "esiste una versione da 8.000 €" è inutile: vale per quasi ogni nome. Si mostra invece *quale frazione* delle versioni supera i 30 €: Eevee 14% e Snorlax 19% non si segnalano, Umbreon VMAX 59% e Charizard 63% sì.
- Bias noto: il catalogo tiene solo le carte con prezzo (`trend` o `avg30` > 0), quindi le comuni che nessuno vende singolarmente mancano e le percentuali risultano un po' gonfiate verso l'alto.

**Falsi — regola data all'utente.** Una carta falsa non è quasi mai dichiarata, e spesso il venditore stesso non sa di averla (collezione comprata in bancarella anni fa). Controllare ogni carta è insostenibile; la difesa pratica è **dove** si compra: i falsi seguono il valore e si concentrano sul vintage costoso e sulle chase famose. Sui mercati generalisti conviene comprare lotti e carte moderne, non il pezzo singolo vintage da 200 €.

## Come testare
Si è testato pilotando un Chrome headless separato via DevTools Protocol (Node 24 ha `WebSocket` e `fetch` integrati). Il salvataggio in `data.json` avviene con 200 ms di ritardo (debounce): nei test bisogna aspettare oltre 1 s prima di leggerlo.
