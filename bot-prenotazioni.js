// ============================================================================
//  Bot prenotazioni — il pezzo di iStudio che ASCOLTA invece di parlare soltanto
// ============================================================================
//
//  Sta in un file suo e non dentro server.js perché è un sottosistema intero
//  (tabelle, macchina a stati, orari, avvisi al personale): infilarlo nel file
//  unico l'avrebbe portato oltre le 4000 righe, e la parte che tocca WhatsApp
//  ha bisogno di essere leggibile per forza.
//
//  ⚠️ REGOLA CHE VALE PER TUTTO IL FILE: **il bot non indovina mai.**
//  Se non è sicuro di aver capito, passa la parola a una persona. Un bot che
//  tira a indovinare prenota otto persone quando erano quattro, e quella sera
//  il locale ha un tavolo sbagliato e un cliente arrabbiato. Ogni volta che
//  sotto trovi un `return null`, è questa regola.
//
//  Il file è diviso in due metà nette:
//   - la PRIMA metà non sa cosa sia WhatsApp: prende testo, guarda il database,
//     restituisce testo. È quella che si può provare davvero (`prova-bot.js`);
//   - la SECONDA metà collega quella logica al client di whatsapp-web.js.
//  Se un giorno si passasse alla Cloud API ufficiale, si riscrive solo la
//  seconda metà.
// ============================================================================

'use strict';

// ---------------------------------------------------------------------------
//  Tabelle
// ---------------------------------------------------------------------------

function preparaDatabase(db) {
  db.exec(`
    -- Le prenotazioni. 'tavolo' è scritto A MANO dalla sala e il bot non lo
    -- legge né lo conta: è lo spazio degli umani. Il bot ragiona sui coperti.
    CREATE TABLE IF NOT EXISTS prenotazioni (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telefono TEXT NOT NULL,
      nome TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL,                     -- aaaa-mm-gg, ora LOCALE
      ora TEXT NOT NULL,                      -- hh:mm
      persone INTEGER NOT NULL,
      zona TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      tavolo TEXT NOT NULL DEFAULT '',
      stato TEXT NOT NULL DEFAULT 'confermata', -- confermata|presentata|annullata
      -- (in pagina: Confermata | Conclusa | Cancellata)
      origine TEXT NOT NULL DEFAULT 'bot',      -- bot|manuale
      contact_id INTEGER,
      creata_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      annullata_at TEXT,
      promemoria_at TEXT,
      recensione_at TEXT
    );

    -- A che punto è ogni conversazione. Una riga per numero: il bot non tiene
    -- niente in memoria, così un riavvio non perde nessuno a metà prenotazione.
    CREATE TABLE IF NOT EXISTS bot_conversazioni (
      telefono TEXT PRIMARY KEY,
      passo TEXT NOT NULL DEFAULT 'inizio',
      dati TEXT NOT NULL DEFAULT '{}',
      aggiornata_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      richiamata_at TEXT,
      muto_fino TEXT,                          -- presa in carico o parola OPERATORE
      risposte_oggi INTEGER NOT NULL DEFAULT 0,
      giorno_risposte TEXT
    );

    -- Parole chiave → risposta, scritte dal ristoratore.
    -- Chi ha chiesto il menu, e quando: è l'unica cosa che si può contare
    -- (i clic sul collegamento no: il computer del locale non è in rete, e
    -- WhatsApp apre i link da sé per l'anteprima). Serve al report.
    CREATE TABLE IF NOT EXISTS bot_menu_richieste (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telefono TEXT NOT NULL,
      passo TEXT NOT NULL DEFAULT '',
      quando TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE IF NOT EXISTS bot_faq (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parole TEXT NOT NULL,
      risposta TEXT NOT NULL,
      usi INTEGER NOT NULL DEFAULT 0
    );

    -- Le frasi che il bot non ha riconosciuto, con quante volte sono tornate.
    -- È il meccanismo con cui il bot migliora senza programmatore: le domande
    -- le portano i clienti veri, in ordine di frequenza.
    CREATE TABLE IF NOT EXISTS bot_non_capite (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      testo TEXT NOT NULL,
      normalizzato TEXT NOT NULL,
      volte INTEGER NOT NULL DEFAULT 1,
      ultima_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      risolta INTEGER NOT NULL DEFAULT 0
    );

    -- Chi riceve gli avvisi. Questi numeri sono SEMPRE esclusi dal percorso di
    -- prenotazione: se il responsabile scrive al locale, il bot non deve
    -- chiedergli per quante persone vuole un tavolo.
    CREATE TABLE IF NOT EXISTS bot_personale (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      telefono TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      canale TEXT NOT NULL DEFAULT 'whatsapp',   -- whatsapp|email|entrambi
      riceve TEXT NOT NULL DEFAULT 'riepilogo',  -- immediato|riepilogo|annullamenti|niente
      appello INTEGER NOT NULL DEFAULT 1
    );

    -- Chi scrive al numero del locale PER LAVORO e a cui il bot non deve mai
    -- rispondere (Chi avvisare → «Il bot non risponde a», 23 ottobre 2026):
    -- camerieri, cuochi, chi consegna. chat_id si impara la prima volta che
    -- scrive col numero, come per il personale: con gli indirizzi @lid il
    -- numero può non arrivare.
    CREATE TABLE IF NOT EXISTS bot_esclusi (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL DEFAULT '',
      telefono TEXT NOT NULL,
      chat_id TEXT NOT NULL DEFAULT '',
      creato_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- Le conversazioni passate a una persona, con il codice per rispondere.
    CREATE TABLE IF NOT EXISTS bot_richieste (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codice TEXT NOT NULL,
      telefono TEXT NOT NULL,
      nome TEXT NOT NULL DEFAULT '',
      testo TEXT NOT NULL,
      stato TEXT NOT NULL DEFAULT 'in_attesa',   -- in_attesa|risposta|scaduta
      creata_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      avvisata_at TEXT,
      sollecitata_at TEXT,
      risposta TEXT,
      risposta_at TEXT,
      risposta_da TEXT,
      -- Chi se ne sta occupando adesso, e da quando. Finché è agganciata, quella
      -- persona scrive al cliente NORMALMENTE, senza rimettere il codice davanti.
      presa_da TEXT,
      presa_at TEXT
    );

    -- Giorni in cui il bot non prende prenotazioni. Due motivi diversi che
    -- finiscono allo stesso posto, ma che al cliente vanno detti in due modi:
    -- «chiuso» (ferie, evento privato) e «pieno» (sold out) non sono la stessa
    -- notizia. Sul primo cambia giorno rassegnato, sul secondo prova a
    -- chiamare — ed è giusto così.
    CREATE TABLE IF NOT EXISTS bot_chiusure (
      data TEXT PRIMARY KEY,
      motivo TEXT NOT NULL DEFAULT ''
    );

    -- I numeri imparati da chi scrive. Serve alla Chat: «Aggiungi in rubrica»
    -- prova a leggere il numero dal pannello di WhatsApp, ma sugli account
    -- Business quel pannello il numero non lo mostra proprio — era il limite
    -- «non risolvibile» delle note tecniche. Qui invece il numero arriva
    -- insieme al messaggio, che è la fonte più affidabile che ci sia.
    CREATE TABLE IF NOT EXISTS numeri_visti (
      nome TEXT PRIMARY KEY,
      telefono TEXT NOT NULL,
      visto_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- Messaggi già visti: un riavvio non deve far rispondere due volte.
    CREATE TABLE IF NOT EXISTS bot_visti (
      id TEXT PRIMARY KEY,
      visto_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- Chi ha chiesto di NON ricevere più messaggi. Sta qui e non solo in
    -- rubrica perché la maggior parte di chi prenota su WhatsApp in rubrica
    -- NON C'È: ci finisce solo se il locale ce lo mette a mano. Fidandosi del
    -- solo segno in rubrica, a chi ha scritto STOP si continuava a scrivere —
    -- dopo avergli risposto «non ti scriveremo più».
    CREATE TABLE IF NOT EXISTS bot_stop (
      chiave TEXT PRIMARY KEY,                 -- l'indirizzo della chat
      numero TEXT NOT NULL DEFAULT '',         -- il numero, se lo conosciamo
      quando TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    -- La lista d'attesa. Chi trova pieno lascia il nome invece di andarsene;
    -- quando un posto si libera il bot glielo propone — a UNO alla volta per
    -- giornata, in ordine di arrivo, con un tempo per rispondere. Chi non
    -- risponde torna in coda, non sparisce.
    -- 'ora' vuota vuol dire «qualunque turno di quel giorno».
    CREATE TABLE IF NOT EXISTS bot_attese (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telefono TEXT NOT NULL,                  -- la chiave della chat, come in bot_conversazioni
      nome TEXT NOT NULL DEFAULT '',
      cognome TEXT NOT NULL DEFAULT '',
      persone INTEGER NOT NULL,
      data TEXT NOT NULL,
      ora TEXT NOT NULL DEFAULT '',
      stato TEXT NOT NULL DEFAULT 'in_attesa', -- in_attesa|avvisata|prenotata|rinunciata|scaduta|tolta
      creata_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      avvisata_at TEXT,
      avvisata_ora TEXT NOT NULL DEFAULT '',   -- il turno proposto, quando lo è stato
      scade_at TEXT,                           -- entro quando deve rispondere alla proposta
      prenotazione_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_attese_data ON bot_attese(data, stato);

    -- ⚠️ Un contatore che sale a ogni tocco alle prenotazioni, chiunque sia
    -- stato: il bot da WhatsApp, la piattaforma, il tablet della sala, un
    -- altro tablet. Serve alla pagina della sala per accorgersi che qualcosa è
    -- cambiato senza doversi riscaricare tutto ogni pochi secondi: chiede solo
    -- questo numero, che è una riga sola, e ricarica davvero solo se è salito.
    --
    -- Sta come TRIGGER e non come riga di codice perché le prenotazioni si
    -- scrivono da una decina di punti diversi: metterlo in ognuno vuol dire
    -- dimenticarlo in uno, e quello sarebbe proprio il cambiamento che la sala
    -- non vede.
    CREATE TRIGGER IF NOT EXISTS prenotazioni_versione_ins AFTER INSERT ON prenotazioni
    BEGIN
      INSERT INTO settings (key, value) VALUES ('prenotazioni_versione', '1')
        ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT);
    END;
    CREATE TRIGGER IF NOT EXISTS prenotazioni_versione_upd AFTER UPDATE ON prenotazioni
    BEGIN
      INSERT INTO settings (key, value) VALUES ('prenotazioni_versione', '1')
        ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT);
    END;
    CREATE TRIGGER IF NOT EXISTS prenotazioni_versione_del AFTER DELETE ON prenotazioni
    BEGIN
      INSERT INTO settings (key, value) VALUES ('prenotazioni_versione', '1')
        ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT);
    END;

    CREATE INDEX IF NOT EXISTS idx_pren_data ON prenotazioni(data, stato);
    CREATE INDEX IF NOT EXISTS idx_pren_tel ON prenotazioni(telefono, stato);
  `);

  // Migrazioni, con lo stesso schema del resto del progetto: l'indirizzo della
  // conversazione WhatsApp. Serve perché il numero non basta più — le chat in
  // formato `@lid` non lo contengono affatto, e per rispondere occorre
  // l'indirizzo così com'è arrivato.
  // Quando gli è stato chiesto «sei ancora lì?». Una volta sola per
  // conversazione: si azzera quando la conversazione riparte da capo.
  try { db.exec('ALTER TABLE bot_conversazioni ADD COLUMN richiamata_at TEXT'); } catch {}
  // Quando al cliente è stato detto che gli risponde una PERSONA. Serve a dirlo
  // una volta sola per presa in carico: chi risponde dal telefono del locale
  // scrive dieci righe, e l'annuncio va davanti alla prima, non a tutte.
  try { db.exec('ALTER TABLE bot_conversazioni ADD COLUMN persona_at TEXT'); } catch {}
  try { db.exec('ALTER TABLE bot_richieste ADD COLUMN presa_da TEXT'); } catch {}
  try { db.exec('ALTER TABLE bot_richieste ADD COLUMN presa_at TEXT'); } catch {}
  try { db.exec("ALTER TABLE prenotazioni ADD COLUMN chat_id TEXT NOT NULL DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE bot_richieste ADD COLUMN chat_id TEXT NOT NULL DEFAULT ''"); } catch {}
  // L'indirizzo della chat del personale, imparato la prima volta che scrive:
  // da lì in poi si riconosce anche quando WhatsApp non passa il numero.
  try { db.exec("ALTER TABLE bot_personale ADD COLUMN chat_id TEXT NOT NULL DEFAULT ''"); } catch {}
  // Due ruoli distinti, perché sono due mestieri diversi: chi risponde ai
  // clienti quando il bot si arrende, e chi vuole solo sapere le prenotazioni.
  try { db.exec('ALTER TABLE bot_personale ADD COLUMN gestisce INTEGER NOT NULL DEFAULT 1'); } catch {}
  // Il codice per collegare il telefono di una persona del personale. Serve
  // perché il numero, da solo, non basta: con gli indirizzi `@lid` WhatsApp
  // può non passarlo mai, e allora il responsabile resterebbe per sempre un
  // cliente qualunque. Con un codice da scrivere in chat il collegamento
  // riesce comunque, qualunque cosa faccia WhatsApp.
  try { db.exec("ALTER TABLE bot_personale ADD COLUMN codice_collegamento TEXT NOT NULL DEFAULT ''"); } catch {}
  try { db.exec('ALTER TABLE bot_personale ADD COLUMN collegato_at TEXT'); } catch {}
  // Il numero a cui richiamare, che può essere diverso da quello che scrive:
  // capita spessissimo che uno prenoti per la moglie, per il capo o per il
  // gruppo, e il locale finisca con l'unico numero che non serve a niente.
  try { db.exec("ALTER TABLE prenotazioni ADD COLUMN telefono_contatto TEXT NOT NULL DEFAULT ''"); } catch {}
  // Il tavolo. Sta nella tabella dal primo giorno, ma per un anno nessuno lo
  // ha scritto: lo assegna la sala, a prenotazione fatta. Un archivio nato da
  // una copia in cui la colonna mancasse non deve rompere la pagina della sala.
  try { db.exec("ALTER TABLE prenotazioni ADD COLUMN tavolo TEXT NOT NULL DEFAULT ''"); } catch {}
  // Il cognome sta in una colonna sua e non attaccato al nome: serve per
  // cercare una prenotazione, per riconoscere chi è già stato qui, e perché la
  // rubrica di iStudio tiene nome e cognome separati da sempre.
  try { db.exec("ALTER TABLE prenotazioni ADD COLUMN cognome TEXT NOT NULL DEFAULT ''"); } catch {}
  // «Per un altro»: la prenotazione è nata correggendo il nome al riepilogo
  // («non sono io», «è per mia madre»). Il numero da cui è arrivata resta di
  // chi ha scritto, non di chi cena: questa riga non fa mai diventare «Anna»
  // il nome del telefono di Marco, e nella scheda dei clienti Anna sta da sola.
  try { db.exec('ALTER TABLE prenotazioni ADD COLUMN per_altri INTEGER NOT NULL DEFAULT 0'); } catch {}
  // L'email del cliente, chiesta come ultimo passo della prenotazione. Sta
  // sulla RIGA e non in rubrica: è l'indirizzo che quella persona ha dato per
  // quella sera, e chi legge la prenotazione lo deve trovare lì.
  try { db.exec("ALTER TABLE prenotazioni ADD COLUMN email TEXT NOT NULL DEFAULT ''"); } catch {}
  // Il pagamento. L'importo sta in CENTESIMI e come numero intero: con gli euro
  // a virgola mobile, 0,1 + 0,2 non fa 0,3, e su una somma di soldi un centesimo
  // che balla è una discussione col cliente.
  try { db.exec('ALTER TABLE prenotazioni ADD COLUMN importo_dovuto INTEGER NOT NULL DEFAULT 0'); } catch {}
  try { db.exec('ALTER TABLE prenotazioni ADD COLUMN importo_totale INTEGER NOT NULL DEFAULT 0'); } catch {}
  // Quando scade il tempo per pagare. Finché non è passato, il posto è tenuto.
  try { db.exec('ALTER TABLE prenotazioni ADD COLUMN pagamento_scade_at TEXT'); } catch {}
  try { db.exec('ALTER TABLE prenotazioni ADD COLUMN pagato_at TEXT'); } catch {}
  // Come è stata confermata: da sola (Stripe) o da una persona. Serve a
  // rispondere alla domanda «chi ha detto che questa ha pagato?», che è la
  // prima che si fa quando i conti non tornano.
  try { db.exec("ALTER TABLE prenotazioni ADD COLUMN pagata_da TEXT NOT NULL DEFAULT ''"); } catch {}
  // L'identificativo del pagamento su Stripe. È quello che lega la riga alla
  // sessione: senza, l'elenco dei pagamenti sarebbe un mucchio di incassi senza
  // sapere di chi sono.
  try { db.exec("ALTER TABLE prenotazioni ADD COLUMN pagamento_id TEXT NOT NULL DEFAULT ''"); } catch {}
  // ⚠️ Il promemoria via email ha la SUA colonna. Con una sola, un invio
  // WhatsApp riuscito avrebbe chiuso la partita anche per l'email (e
  // viceversa): i due canali cadono per ragioni diverse — la linea di WhatsApp
  // e la casella di posta — e uno non deve coprire il buco dell'altro.
  try { db.exec('ALTER TABLE prenotazioni ADD COLUMN promemoria_email_at TEXT'); } catch {}
  // L'esperienza scelta («Business lunch», «Menu degustazione»): è il nome,
  // com'era scritto nella scheda quando il cliente ha prenotato. Alla cucina
  // serve sapere che il tavolo 12 è un degustazione.
  try { db.exec("ALTER TABLE prenotazioni ADD COLUMN esperienza TEXT NOT NULL DEFAULT ''"); } catch {}
  // Il locale scelto alla prima domanda («RO bistrot», «REAR Restaurant»), e
  // se quella prenotazione sta FUORI dalla sala di sempre: i suoi coperti non
  // contano sui tavoli del locale principale (vedi «I locali»).
  try { db.exec("ALTER TABLE prenotazioni ADD COLUMN locale_scelto TEXT NOT NULL DEFAULT ''"); } catch {}
  try { db.exec('ALTER TABLE prenotazioni ADD COLUMN fuori_sala INTEGER NOT NULL DEFAULT 0'); } catch {}
  // Perché è stata cancellata, quando la cancella una persona dalla sala o
  // dalla piattaforma (dal titolare, 24 ottobre 2026): «Non si è presentato»,
  // «Ha disdetto», o scritto a mano. Facoltativo. E da dove: 'sala' o
  // 'piattaforma'; vuoto se l'ha cancellata il bot (lì non cambia niente).
  try { db.exec("ALTER TABLE prenotazioni ADD COLUMN motivo_annullamento TEXT NOT NULL DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE prenotazioni ADD COLUMN annullata_da TEXT NOT NULL DEFAULT ''"); } catch {}
  // «chiusura» o «pieno». Le righe già scritte sono chiusure: è quello che
  // voleva dire questa tabella prima che il sold out esistesse.
  try { db.exec("ALTER TABLE bot_chiusure ADD COLUMN tipo TEXT NOT NULL DEFAULT 'chiusura'"); } catch {}

  // ⚠️ Gli altri due agganci della persona: l'indirizzo della chat e il numero
  // lasciato come contatto. Senza indice, `dovePersona` — `chat_id IN (…) OR
  // telefono IN (…)` — non poteva usare `idx_pren_tel` per colpa dell'OR e
  // faceva una SCANSIONE DELL'ARCHIVIO INTERO. Non su una pagina che si apre
  // ogni tanto: su OGNI MESSAGGIO, perché da quando il bot riconosce chi torna
  // `ultimoNomeDi` gira sempre. Misurato con la prova di carico, su un archivio
  // da 50.000 righe (cinque anni di un locale che lavora): 14,20 ms contro
  // 0,14 ms, cioè cento volte tanto, e un messaggio intero da 18,5 a 3,9 ms.
  // Con i due indici SQLite fa `MULTI-INDEX OR` e li usa tutti e due — senza
  // bisogno di ANALYZE, che sul computer di un ristorante non lo lancia nessuno.
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_pren_chat ON prenotazioni(chat_id)'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_pren_contatto ON prenotazioni(telefono_contatto)'); } catch {}

  // I tavoli del locale. Vuota di partenza, e vuota vuol dire «si conta a
  // coperti come prima»: vedi `postoPer`.
  //
  // ⚠️ Il nome è unico senza badare alle maiuscole: è quello che la sala
  // scrive nella riga della prenotazione, e con due «T4» non si saprebbe a
  // quale dei due si è seduto qualcuno.
  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_tavoli (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      posti INTEGER NOT NULL,
      posti_min INTEGER NOT NULL DEFAULT 1,   -- sotto, il tavolo è troppo grande
      solo_sala INTEGER NOT NULL DEFAULT 0,   -- 1 = il bot non lo dà mai
      ordine INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tavoli_nome ON bot_tavoli(nome COLLATE NOCASE);
  `);
  // Quale menu è partito (menu, degustazione, tutti): colonna arrivata dopo.
  try { db.exec("ALTER TABLE bot_menu_richieste ADD COLUMN quale TEXT NOT NULL DEFAULT 'menu'"); } catch {}
  // Il minimo è arrivato dopo: i tavoli già fatti partono da 1, cioè come prima.
  try { db.exec('ALTER TABLE bot_tavoli ADD COLUMN posti_min INTEGER NOT NULL DEFAULT 1'); } catch {}

  // ⚠️ Gli stati sono passati da quattro a tre: «non presentato» non si può più
  // assegnare. Le righe che ce l'hanno ancora resterebbero in uno stato che
  // nessuna pagina sa disegnare — una prenotazione che non si può né leggere né
  // correggere. Rientrano fra le cancellate, che è il posto più vicino.
  db.prepare("UPDATE prenotazioni SET stato = 'annullata' WHERE stato = 'non_presentato'").run();

  // «Salva le frasi» salva TUTTE le frasi, anche quelle mai toccate: chi ha
  // premuto quel tasto una volta si porta dietro una copia del testo di allora,
  // e da lì in poi le frasi migliorate non gli arrivano più. Se quello che c'è
  // scritto è ancora, parola per parola, un vecchio predefinito, allora nessuno
  // l'ha scelto: si toglie e torna a valere quello nuovo. Un testo cambiato
  // anche di una virgola non si tocca — è una scelta del locale.
  for (const [chiave, vecchi] of Object.entries(TESTI_SUPERATI)) {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(chiave);
    if (r && vecchi.includes(r.value)) db.prepare('DELETE FROM settings WHERE key = ?').run(chiave);
  }

  // I menu che c'erano già, collegati alle esperienze (16 ottobre 2026): fino
  // a ieri un'esperienza senza menu scelto riceveva comunque quello generale,
  // e chi aveva caricato la carta e il degustazione se li aspetta su «Alla
  // carta» e «Menu degustazione». UNA volta sola (il segno resta), e solo
  // dove il menu non era scelto: una scelta del titolare non si tocca, e se
  // dopo toglie il collegamento non torna da solo.
  if (leggi(db, 'bot_menu_esperienze_collegati') !== 'true') {
    const lista = esperienzeValide(leggi(db, 'bot_esperienze'));
    const attivi = menuAttivi({
      bot_menu_link: leggi(db, 'bot_menu_link'), bot_menu_file: leggi(db, 'bot_menu_file'),
      bot_menu_degustazione_link: leggi(db, 'bot_menu_degustazione_link'),
      bot_menu_degustazione_file: leggi(db, 'bot_menu_degustazione_file'),
    });
    let cambiate = false;
    for (const e of lista || []) {
      if (e.menu) continue;
      const parole = paroleDellEsperienza(e).join(' ');
      if (attivi.degustazione && /degustazion/.test(parole)) { e.menu = 'degustazione'; cambiate = true; } else if (attivi.menu && /\bcarta\b/.test(parole)) { e.menu = 'menu'; cambiate = true; }
    }
    if (cambiate) scrivi(db, 'bot_esperienze', JSON.stringify(lista));
    scrivi(db, 'bot_menu_esperienze_collegati', 'true');
  }

  // I titoli scritti prima del 23 ottobre 2026 (vedi «nomeConTitolo»): nome
  // «Don.» e cognome «Franco» diventano «Don Franco», nome «Ing.» e cognome
  // «Muto» diventano «Ing. Muto». Messi insieme dicono la stessa cosa di
  // prima: cambia solo che il saluto non è più «Don.!». Si guarda a ogni
  // avvio, e dalla seconda volta non trova più niente. La rubrica no: è del
  // locale, la si corregge dalla scheda del cliente.
  {
    const chiavi = Object.keys(TITOLI);
    const dove = `lower(replace(replace(trim(nome), '.', ''), ' ', '')) IN (${chiavi.map(() => '?').join(',')}) `
      + "AND trim(COALESCE(cognome, '')) <> ''";
    for (const tabella of ['prenotazioni', 'bot_attese']) {
      const righe = db.prepare(`SELECT id, nome, cognome FROM ${tabella} WHERE ${dove}`).all(...chiavi);
      if (!righe.length) continue;
      const scrivi = db.prepare(`UPDATE ${tabella} SET nome = ?, cognome = ? WHERE id = ?`);
      db.transaction(() => {
        for (const r of righe) { const g = nomeConTitolo(r.nome, r.cognome); scrivi.run(g.nome, g.cognome, r.id); }
      })();
    }
  }

  // Le prenotazioni prese PRIMA che il numero si salvasse da solo hanno il
  // recapito vuoto anche quando la chat lo conteneva. Si riempie qui, una
  // volta, così la sala trova il telefono anche sui tavoli di ieri — sennò la
  // funzione varrebbe solo per chi prenota da domani, e non è quello che serve
  // a chi deve richiamare stasera.
  //
  // ⚠️ SOLO dove manca. Un numero che il cliente ha dettato non si tocca mai:
  // chi prenota per un amico scrive dal proprio WhatsApp e detta il numero
  // dell'amico, e sovrascriverlo con l'indirizzo della chat metterebbe sulla
  // riga il recapito della persona sbagliata.
  //
  // Gli `@lid` restano fuori già dalla query, e quelli che passano vengono
  // comunque ripassati da `numeroDallaChat`: le cifre di un identificativo
  // interno non sono un telefono.
  const senzaRecapito = db.prepare(
    "SELECT id, telefono FROM prenotazioni "
    + "WHERE telefono_contatto = '' AND telefono <> '' AND telefono NOT LIKE '%@lid%'"
  ).all();
  if (senzaRecapito.length) {
    const scrivi = db.prepare('UPDATE prenotazioni SET telefono_contatto = ? WHERE id = ?');
    db.transaction((righe) => {
      for (const r of righe) {
        const n = numeroDallaChat(r.telefono);
        if (n) scrivi.run(n, r.id);
      }
    })(senzaRecapito);
  }
}

// I vecchi testi predefiniti, quelli sostituiti da una versione migliore.
// Serve solo a riconoscerli: non vengono mai riproposti. L'elenco si ricava
// dalla storia del progetto — ogni frase che è stata riscritta lascia qui
// dietro quella di prima.
const TESTI_SUPERATI = {
  bot_t_locali: [
    'Vuoi prenotare per {nomi}?\n\n{scelte}',  ],
  // «Scrivimi il nome o il numero» → «Scrivi il numero: 1, 2 o 3» (19 ottobre 2026).
  bot_t_esperienze: [
    'Ecco cosa puoi prenotare da noi:\n\n{esperienze}\n\nA quale sei interessato? Scrivimi il nome o il numero.',  ],
  bot_t_esperienze_giorno: [
    '{data}{servizio} puoi scegliere:\n\n{esperienze}\n\nQuale preferisci? Scrivimi il nome o il numero.',  ],
  bot_t_esperienza_no: [
    'Non ho capito quale preferisci: scrivimi il nome o il numero.\n\n{esperienze}',  ],
  // Col segnaposto 📍 al posto di 🍝 (19 ottobre 2026, chiesto dal titolare).
  bot_t_gia_altro_locale: [
    '{saluto} {nome}! \nHai già una prenotazione confermata:\n\n📍 {scelto}\n📅 {data}\n🕘 {ora}\n👥 {persone} persone\n\nCosa vuoi fare?\n\n• Per annullarla, scrivi CANCELLA.\n• Per fare un\'altra prenotazione, scrivi NUOVA.',  ],
  bot_t_annulla_altro_locale: [
    'Sei sicuro di voler cancellare la prenotazione?\n\n📍 {scelto}\n📅 {data}\n🕘 {ora}\n👥 {persone} persone\n\nScrivi SÌ per confermare',  ],
  bot_t_turno_unico: [
    'Per {data} a {servizio} c’è un solo turno disponibile, {fascia}. ✨\n\nTi va bene? Scrivi SÌ per continuare.',  ],
  bot_t_menu_invito: [
    '📖 Se vuoi dare prima un’occhiata, scrivi {scelte}.',  ],
  bot_t_menu: [
    'Ecco il nostro menu 🍽️\n👉 {link}\n\nSe vuoi prenotare, dimmi pure per quante persone.',  ],
  bot_t_nota_domanda: [
    // ⚠️ Partiva dal presupposto di aver riconosciuto una DOMANDA, e prometteva
    // una risposta. Su «allergia alle noci» sarebbe stata una risposta attesa e
    // mai arrivata; e «ho bisogno di una torta» non veniva riconosciuto affatto.
    'Me la sono segnata 📝\n\nQuesta però non posso confermartela io: la giro a {locale} e ti rispondono appena possibile.',
  ],
  bot_t_pagamento: [
    'Perfetto {nome}, ci siamo quasi ✨\nTi collego al pagamento per confermare il tavolo.\n\n📅 {data}  🕘 {ora}  👥 {persone}\n💳 Da pagare adesso: {importo}\n\n👉 Paga qui: {link}\n{resto}\n⚠️ Il tavolo NON è ancora prenotato: lo diventa appena ricevo il pagamento.\nHo tenuto il tuo posto fino alle {scadenza}.',  ],
  bot_t_benvenuto: [
    'Buonasera! Sono l\'assistente di {locale} 🍽️\nPer quante persone devo prenotare?\n(rispondi con un numero, es. 4)',
    '{saluto}! Sono l\'assistente di {locale} 🍽️\nPer quante persone devo prenotare?\n(rispondi con un numero, es. 4)',

    '{saluto}! Sono {assistente} l\'assistente virtuale di {locale} 🍽️\nPer quante persone devo prenotare?\n(rispondi con un numero, es. 4)',  ],
  bot_t_giorno_no: [
    'Non ho capito il giorno. Puoi scrivere «oggi», «domani», il giorno della settimana oppure la data (es. 22/08).',

    'Non ho capito il giorno. Puoi indicarmi la data:',  ],
  bot_t_ora_no: [
    'Non ho capito l\'orario. Rispondi col numero della riga oppure con l\'ora (es. 21:30).',

    'Non ho capito l\'orario. Puoi indicarmi l\'ora:',  ],
  bot_t_nome: [
    'A che nome metto la prenotazione?',

    'A che nome metto la prenotazione?\n(nome e cognome)',  ],
  bot_t_riepilogo: [
    'Ricapitolando:\n📅 {data}  🕘 {ora}  👥 {persone}  👤 {nome}\n\nConfermi? Scrivi SÌ per confermare o NO per annullare.',

    'Perfetto! ✨\nEcco il riepilogo della tua prenotazione:\n\n📅 Data: {data}\n🕘 Orario: {ora}\n👥 Persone: {persone}\n👤 Nome: {nome}\n📞 {telefono}\n\nConfermi la prenotazione?\n\nScrivi SÌ per confermare\noppure NO per annullare.',

    // ⚠️ Senza la riga «Note»: il cliente scriveva «siamo con un bimbo» e poi
    // non se la vedeva scritta da nessuna parte. L'unico modo che ha di
    // accorgersi se è stato capito male è rileggerla.
    'Perfetto! ✨ \nEcco il riepilogo della tua prenotazione:\n\n📅 Data: {data}\n🕘 Orario: {ora}\n👥 Persone: {persone}\n👤 Nome: {nome}\n\nConfermi la prenotazione?\n\nScrivi SÌ per confermare',
    // Senza la riga dell'esperienza.
    'Perfetto! ✨ \nEcco il riepilogo della tua prenotazione:\n\n📅 Data: {data}\n🕘 Orario: {ora}\n👥 Persone: {persone}\n👤 Nome: {nome}\n📝 Note: {note}\n\nConfermi la prenotazione?\n\nScrivi SÌ per confermare',  ],
  bot_t_benvenuto_esperienze: [
    // La riga degli orari in un pezzo solo (fino al 20 ottobre 2026), poi a
    // righe (fino al 22): ora gli orari vengono dopo la scelta dell'esperienza.
    '{saluto} ✨ \n\nSono {assistente} l\'assistente virtuale di {locale}\nSarà un piacere aiutarti con la tua prenotazione.\n\n🕒 Siamo aperti {orari}.\n',
    '{saluto} ✨ \n\nSono {assistente} l\'assistente virtuale di {locale}\nSarà un piacere aiutarti con la tua prenotazione.\n\nSiamo aperti:\n{orari}\n',  ],
  bot_t_bentornato_esperienze: [
    'Che bello rivederti, {nome}! ✨\n\n🕒 Siamo aperti {orari}.\n',
    'Che bello rivederti, {nome}! ✨\n\nSiamo aperti:\n{orari}\n',  ],
  bot_t_orari: [
    '🕒 Siamo aperti {orari}.',
  ],
  bot_t_esperienza_menu: [
    'Vuoi dare un\'occhiata al menu? Scrivi SÌ e te lo mando, oppure NO per andare avanti.',  ],
  bot_t_email: [
    'Perfetto! ✨\nEcco il riepilogo della tua prenotazione:\n\n📅 Data: {data}\n🕘 Orario: {ora}\n👥 Persone: {persone}\n👤 Nome: {nome}\n\nPer confermare, scrivimi la tua email: la useremo per mandarti la conferma.\n\n(se hai cambiato idea, scrivi NO)',
    // Senza la riga dell'esperienza (business lunch, degustazione…).
    'Perfetto! ✨\nEcco il riepilogo della tua prenotazione:\n\n📅 Data: {data}\n🕘 Orario: {ora}\n👥 Persone: {persone}\n👤 Nome: {nome}\n📝 Note: {note}\n\nPer confermare, scrivimi la tua email: la useremo per mandarti la conferma.\n\n(se hai cambiato idea, scrivi NO)',  ],
  bot_email_testo: [
    'Ciao {nome},\n\necco il riepilogo della tua prenotazione:\n\n📅 Giorno: {data}\n🕘 Orario: {ora}\n👥 Persone: {persone}\n👤 A nome di: {nome} {cognome}\n{note}\n{pagamento}\nA presto!\n{locale}',  ],
  bot_t_nonho_chiuso: [
    'Su questa non riesco a risponderti io. Ho passato il messaggio al locale: ti rispondono appena aperto.',

    'Su questa non riesco a risponderti io.\nHo passato il messaggio a una persona del locale: ti risponderà appena il ristorante apre, dalle {apertura}.',  ],
  bot_t_recensione: [
    'Ciao {nome}, grazie per essere stato da {locale}!\nSe ti va, lasciarci una recensione ci aiuta molto: {link}\nSe invece qualcosa non è andato, rispondi pure qui: ci teniamo a saperlo.',

    'Ciao {nome}, grazie per essere stato da {locale}!\nSe ti va, lasciarci una recensione ci aiuta molto: {link}\nSe invece qualcosa non è andato, rispondi pure qui: ci teniamo a saperlo.\n\nSe non vuoi più ricevere messaggi, scrivi STOP.',  ],
  bot_t_gia_prenotato: [
    '{saluto} {nome}! Hai già una prenotazione da noi:\n📅 {data}  🕘 {ora}  👥 {persone}\n\nSe vuoi disdirla scrivi ANNULLA. Se invece vuoi prenotare un altro tavolo, dimmi per quante persone.',
    '{saluto} {nome}! Hai già una prenotazione da noi:\n📅 {data}  🕘 {ora}  👥 {persone}\n\nVuoi SPOSTARLA a un altro giorno o ANNULLARLA?\nSe invece vuoi prenotare un altro tavolo, dimmi per quante persone.',

    '{saluto} {nome}! Hai già una prenotazione da noi:\n📅 {data}  🕘 {ora}  👥 {persone}\n\nScrivi CAMBIA per spostarla a un altro giorno, oppure CANCELLA per annullarla.\nSe invece vuoi prenotare un altro tavolo, dimmi per quante persone.',

    '{saluto} {nome}! \nHai già una prenotazione confermata:\n\n📅 {data}\n🕘 {ora}\n👥 {persone} persone\n\nVuoi modificare la tua prenotazione?\n\n• Per spostarla a un altro giorno, scrivi CAMBIA.\n• Per annullarla, scrivi CANCELLA.\n\nPer effettuare una NUOVA PRENOTAZIONE, dimmi semplicemente per quante persone.\n\n',  ],
  bot_t_conferma: [
    '✅ Prenotazione confermata! Ti aspettiamo.\nSe hai un imprevisto scrivi ANNULLA e ci pensiamo noi.',

    '✅ Prenotazione confermata! Ti aspettiamo.\nSe hai un imprevisto scrivi CANCELLA e ci pensiamo noi.',  ],
  bot_t_manuale: [
    'Ciao {nome}! Ti confermiamo la prenotazione da {locale}:\n📅 {data}  🕘 {ora}  👥 {persone}\n\nSe hai un imprevisto scrivi ANNULLA.',

    'Ciao {nome}! Ti confermiamo la prenotazione da {locale}:\n📅 {data}  🕘 {ora}  👥 {persone}\n\nSe hai un imprevisto scrivi CANCELLA.',  ],
  bot_t_spostata: [
    '✅ Spostata! Ti aspettiamo {data} alle {ora}.\nSe hai un imprevisto scrivi ANNULLA.',

    '✅ Spostata! Ti aspettiamo {data} alle {ora}.\nSe hai un imprevisto scrivi CANCELLA.',  ],
  bot_t_persone_no: [
    'Non ho capito il numero di persone. Scrivimi solo la cifra, per esempio 4.',
  ],
  bot_t_giorno: [
    'Per che giorno?',
  ],
  bot_t_chiuso: [
    'Quel giorno siamo chiusi. Scegli un altro giorno.',
  ],
  bot_t_ora: [
    'Per {data} abbiamo:',
  ],
  bot_t_ora_piena: [
    'Mi dispiace, alle {ora} siamo già al completo.\nEcco gli orari ancora liberi:',
  ],
  bot_t_ora_tardi: [
    'Per le {ora} non facciamo più in tempo.\nEcco gli orari ancora liberi:',
  ],
  bot_t_completo: [
    'Mi dispiace, per {data} siamo al completo.\nVuoi provare un altro giorno?',
  ],
  bot_t_note: [
    'Ci sono allergie o richieste particolari? Se no, scrivi NO.',
    // ⚠️ «scrivi NO» invitava a cominciare la frase con un no, che è esattamente
    // la forma che veniva buttata via: «no, ma abbiamo un passeggino».
    'Prima di completare la prenotazione, c’è qualche allergia, intolleranza o esigenza particolare che dovremmo conoscere?\n\nSe non hai nulla da segnalare, scrivi semplicemente NO.',
  ],
  bot_t_telefono: [
    'A quale numero possiamo richiamarti se serve?\nScrivi OK per usare questo, oppure scrivimi il numero giusto.',
  ],
  bot_t_telefono_no: [
    'Non ho capito il numero. Scrivilo tutto (es. 333 1234567), oppure OK per usare questo.',
  ],
  bot_t_rinuncia: [
    'Va bene, non ho prenotato niente. Se cambi idea scrivimi pure!',
  ],
  bot_t_ricominciamo: [
    '🙂 Se preferisci, scrivi RICOMINCIA per ripartire da capo con la prenotazione, oppure OPERATORE per parlare con una persona.',
  ],
  bot_t_ricominciato: [
    'Va bene, ricominciamo da capo!\n\nPer quante persone devo prenotare?\n',
    'Va bene, ricominciamo da capo!\nPer quante persone devo prenotare?',
  ],
  bot_t_annulla_quale: [
    'Vuoi annullare la prenotazione di {data} alle {ora} per {persone} persone?\nScrivi SÌ per confermare.',
  ],
  bot_t_modificata: [
    'Ciao {nome}, abbiamo aggiornato la tua prenotazione:\n📅 {data}  🕘 {ora}  👥 {persone}\n\nSe qualcosa non va scrivici pure.',
  ],
  bot_t_annullata: [
    'Prenotazione annullata. Grazie per averci avvisato — ci fa davvero comodo. A presto!',
  ],
  bot_t_annullata_locale: [
    'Ciao {nome}, ti avvisiamo che la tua prenotazione da {locale} di {data} alle {ora} è stata annullata. Se pensi ci sia un errore, scrivici pure.',
    // Senza il locale: chi aveva il bistrot non sapeva quale gli avevano tolto (20 ottobre 2026).
    'Ciao {nome}, \nti avvisiamo che la tua prenotazione di {data} alle {ora} è stata cancellata.\n\n{locale}',
  ],
  bot_t_annulla_niente: [
    'Non trovo prenotazioni future a tuo nome.',
  ],
  bot_t_sposta_quale: [
    'La tua prenotazione è {data} alle {ora} per {persone}.\nPer che giorno vuoi spostarla?',
  ],
  bot_t_sposta_conferma: [
    'Sposto la tua prenotazione a {data} alle {ora} per {persone}?\nScrivi SÌ per confermare o NO per lasciarla dov\'è.',
  ],
  bot_t_sposta_pieno: [
    'Mi dispiace, per {data} alle {ora} non c\'è più posto.\n⚠️ La tua prenotazione di {vecchiaData} alle {vecchiaOra} resta com\'era: non ho toccato niente.',
  ],
  bot_t_gia_prenotate: [
    '{saluto} {nome}! Da noi hai {quante} prenotazioni:\n{elenco}\n\nScrivi CAMBIA o CANCELLA e ti chiedo quale.\nSe invece vuoi prenotare un altro tavolo, dimmi per quante persone.',

    '{saluto} {nome}!\nHai {quante} prenotazioni confermate:\n\n{elenco}\n\nVuoi modificare la tua prenotazione?\n\n• Per spostarla a un altro giorno, scrivi CAMBIA.\n• Per annullarla, scrivi CANCELLA.',
  ],
  bot_t_quale_annulla: [
    'Quale vuoi cancellare?\n{elenco}\n\nRispondi con il numero.',
  ],
  bot_t_quale_sposta: [
    'Quale vuoi cambiare?\n{elenco}\n\nRispondi con il numero.',
  ],
  bot_t_promemoria: [
    'Ciao {nome}! ✨\n\nTi ricordiamo la tua prenotazione di domani alle {ora}, per {persone} persone.\n\nTi aspettiamo!\n{locale}',
    'Ciao {nome}, ti ricordiamo il tavolo di domani alle {ora} per {persone} persone. A presto!',
  ],
  bot_t_nonho_aperto: [
    'Su questa non riesco a risponderti io. Ho avvisato il locale: ti risponde una persona a breve.',
  ],
  bot_t_operatore: [
    'Va bene, ti risponde una persona del locale appena possibile.',
    // ⚠️ Prometteva fretta proprio quando non ce n'è: alle 20:30 di sabato
    // nessuno può guardare il telefono.
    'Certamente! 😊\n\nHo passato la tua richiesta a un operatore.\nTi risponderà appena possibile.\n\nA presto! ✨',
  ],
  bot_t_operatore_chiuso: [
    // Senza il giorno: «dalle 09:00» la domenica sera di un locale chiuso il
    // lunedì si legge come «domani», e sarebbe falso di un giorno.
    'Certamente! 😊\n\nIn questo momento il locale è chiuso, ma ho già passato la tua richiesta a un operatore: ti risponderà alla riapertura, dalle {apertura}.\n\nA presto! ✨',
  ],
  bot_t_umano_finito: [
    // ⚠️ «ti saluta» si legge come «ti manda un saluto»: il contrario.
    '👋 {nome} ti saluta, grazie per aver scritto!\n\nDa qui in avanti ti risponde di nuovo l’assistente virtuale: posso aiutarti con le prenotazioni.\nSe ti serve ancora una persona, scrivi OPERATORE.',
  ],
  bot_t_prefisso_umano: [
    '',
  ],
  bot_t_troppe: [
    'Per oggi ti ho già risposto parecchie volte. Ti faccio richiamare da una persona del locale.',
  ],
  // «Eravamo rimasti a quale esperienza preferisci», «a per che giorno», «a
  // l'orario»: non era italiano (20 ottobre 2026).
  bot_t_richiamo: [
    'Sei ancora lì? 🙂\n\nEravamo rimasti a {cosa}: rispondi pure qui e finiamo in un attimo.\n\nSe preferisci ripartire da capo scrivi RICOMINCIA.',
  ],
};

// ---------------------------------------------------------------------------
//  Impostazioni
// ---------------------------------------------------------------------------
//  Stanno nella tabella `settings` che c'è già, col prefisso `bot_`: una
//  tabella in meno da mantenere, e le funzioni getSetting/setSetting del
//  server funzionano già così.
//
//  Ogni campo ha un valore predefinito sensato, e non è un dettaglio: la
//  prima accensione chiede CINQUE cose, tutto il resto deve funzionare da
//  solo. Una pagina con quaranta campi da riempire non la compila nessuno, e
//  un bot mai acceso non serve a niente.

const PREDEFINITI = {
  bot_attivo: 'false',
  bot_locale: '',
  bot_assistente: '',      // il nome dell'assistente virtuale, es. «Aurora»

  // Orari — 0 è domenica, come getDay() di JavaScript
  //
  // ⚠️ `bot_fasce` è il modo nuovo: per ogni giorno della settimana il pranzo
  // e la cena, a turni — ogni turno con un inizio e una fine. Finché è vuota
  // valgono ancora i tre campi di prima — giorni, pranzo, cena — letti
  // ESATTAMENTE come prima: un locale che si aggiorna non deve trovarsi orari
  // diversi da quelli che aveva. Vedi `fasceDi`.
  bot_fasce: '',
  // Gli orari da prenotare, scelti giorno per giorno e servizio per servizio
  // (vedi `slotDelGiorno`): {"1":{"cena":["20:00","20:30"]}}. Vuoto di
  // fabbrica: senza, ogni servizio resta a turni.
  bot_slot: '',
  // Le esperienze («business lunch», «alla carta», «menu degustazione»): una
  // lista JSON, vuota di fabbrica. Con meno di due il bot non chiede niente
  // e lavora come sempre. Vedi `esperienzeValide`.
  bot_esperienze: '',
  bot_locali: '',            // la prima domanda: «RO bistrot o REAR?» (vedi «I locali»)
  bot_giorni: '1,2,3,4,5,6,0',
  bot_turni_pranzo: '',
  bot_turni_cena: '19:30,20:00,21:30',
  bot_durata_tavolo: '120',
  bot_preavviso_ore: '2',
  bot_max_giorni: '60',

  // Capienza — a coperti, finché il locale non elenca i suoi tavoli. Con i
  // tavoli impostati (tabella `bot_tavoli`) questi due numeri non decidono più
  // niente: vedi `postoPer`.
  bot_coperti_turno: '40',
  bot_coperti_liberi: '0',
  bot_max_persone: '8',
  bot_min_persone: '1',

  // Quali domande fare
  bot_chiedi_nome: 'true',
  // ⚠️ Riconoscere chi torna dal suo numero: lo saluta per nome e non gli
  // richiede come si chiama. Si può spegnere — un locale che prende molte
  // prenotazioni «per conto di» dallo stesso telefono può preferire di no.
  bot_riconosci: 'true',
  bot_chiedi_note: 'false',
  bot_chiedi_telefono: 'false',

  // La lista d'attesa. Accesa di partenza: quando è pieno, il bot propone di
  // avvisare se si libera un posto invece di chiudere con «siamo al completo».
  // Chi non la vuole la spegne, e il bot torna a dire solo che è pieno.
  bot_lista_attesa: 'true',
  // Quanto tempo ha chi riceve «si è liberato un posto» per dire SÌ, prima che
  // il posto passi al successivo in lista. Troppo poco e nessuno fa in tempo a
  // leggere; troppo e un posto libero resta fermo per uno che non risponde.
  bot_attesa_minuti: '30',
  // Il pagamento della prenotazione. Spento di partenza: acceso per sbaglio
  // vorrebbe dire chiedere soldi a tutti senza che il locale se ne accorga.
  bot_pagamento_attivo: 'false',
  bot_pagamento_prezzo: '0',            // in euro, come lo scrive il locale
  bot_pagamento_modo: 'persona',        // persona | prenotazione
  bot_pagamento_percentuale: '100',     // quanto si paga adesso
  bot_pagamento_minuti: '30',           // il minimo che Stripe consente
  // ⚠️ Il pagamento BLOCCA la prenotazione, oppure no.
  //
  //   obbligatorio (com'è di partenza): il tavolo NON è prenotato finché non si
  //     paga. Scade, e il posto torna libero.
  //   facoltativo: il tavolo è prenotato SUBITO, e la caparra è un invito. Non
  //     scade niente e non si libera niente.
  //
  // Di partenza resta «obbligatorio» perché è quello che faceva prima: chi
  // aveva già acceso il pagamento non deve ritrovarsi, dopo un aggiornamento,
  // dei tavoli tenuti da gente che non ha pagato.
  bot_pagamento_obbligatorio: 'true',
  // ⚠️ La chiave di Stripe è una credenziale che MUOVE DENARO. Vive qui dentro,
  // in `data.db`, che non esce da questa macchina e non è mai andato su GitHub —
  // lo stesso trattamento della password della posta. Nella pagina se ne vedono
  // solo le ultime quattro cifre.
  bot_pagamento_chiave: '',
  // Dove torna il cliente dopo aver pagato. Non serve a noi — la conferma gli
  // arriva in chat — ma Stripe vuole un indirizzo, e mandarlo su una pagina che
  // non esiste è l'ultima cosa che vede di questa prenotazione.
  bot_pagamento_ritorno: '',
  // L'email di riepilogo. Spenta di partenza: chi non ha configurato la posta
  // non deve trovarsi errori di invio che non ha chiesto.
  bot_email_attiva: 'false',
  bot_email_oggetto: 'La tua prenotazione da {locale} — {data}',
  // Il logo del locale, come «data:image/…;base64,…», e un modello HTML
  // facoltativo. Vuoti di partenza: senza logo l'email ha solo il nome del
  // locale in testa; senza modello vale quello incorporato nel server, che
  // per quasi tutti è già la versione «da template».
  bot_email_logo: '',
  bot_email_html: '',
  bot_email_testo: 'Ciao {nome},\n\necco il riepilogo della tua prenotazione:\n\n📅 Giorno: {data}\n🕘 Orario: {ora}\n👥 Persone: {persone}\n{esperienza}👤 A nome di: {nome} {cognome}\n{note}\n{pagamento}\nA presto!\n{locale}',
  // L'email si chiede di suo: è l'ultimo passo, quello che conferma la
  // prenotazione. Chi non la vuole la spegne da qui, e si torna al «SÌ».
  bot_chiedi_email: 'true',

  // Limiti e sicurezza
  bot_max_risposte: '20',
  bot_parola_operatore: 'OPERATORE',
  bot_silenzio_ore: '6',

  // Avvisi al personale
  bot_avvisi_da: '09:00',
  bot_avvisi_a: '23:30',
  bot_raggruppa_min: '10',
  bot_sollecito_min: '15',
  bot_riepilogo_ora: '17:00',
  bot_appello_ora: '23:30',
  bot_appello_senza_risposta: 'presentati',   // presentati|niente

  // ⚠️ Dopo quanti minuti ricordare al responsabile una richiesta rimasta
  // senza risposta. L'avviso partiva UNA volta sola: chi alle 20:30 di sabato
  // aveva le mani occupate non se lo vedeva più ricordare, e quel cliente —
  // a cui il bot aveva promesso una risposta — poteva non riceverla mai.
  // La colonna «sollecitata_at» esisteva in archivio dal primo giorno e non la
  // usava nessuno: era prevista per questo. 0 per spegnerlo.
  bot_sollecito_minuti: '20',

  // ---- Le parole del passo «allergie e richieste» ----
  // ⚠️ Stanno qui e non nel codice perché cambiano da locale a locale, e fin
  // qui per aggiungerne una serviva pubblicare una versione nuova.
  //
  // Queste fanno scattare l'avviso al locale (codice R): sono le cose che un
  // cliente CHIEDE, e a cui qualcuno deve rispondere sì o no. Si possono
  // togliere: restano comunque il punto interrogativo e le aperture da
  // richiesta («ho bisogno di», «mi serve», «vorrei»…), che sono grammatica e
  // non cambiano da locale a locale.
  bot_parole_richiesta: 'torta, torte, dolce, dolci, candeline, regalo, sorpresa, fiori, '
    + 'seggiolone, seggioloni, passeggino, carrozzina, preventivo, menu fisso, '
    + 'menu degustazione, conto separato, conti separati, parcheggio, taxi',
  // Queste invece si AGGIUNGONO a «no / nessuna / niente / nulla / tutto ok»,
  // che restano sempre. Servono per i modi di dire di zona: «apposto», «ok
  // così», «tutto liscio».
  bot_parole_nessuna: '',
  // Altri modi di dire «questa prenotazione non è per me». Si aggiungono a
  // quelli incorporati, non li sostituiscono.
  bot_parole_altro_nome: '',

  // ---- La conversazione lasciata a metà ----
  // Due meccanismi diversi, e il primo è quello che conta.
  //
  // ⚠️ Perché NON si azzera a tempo dopo pochi minuti: chi sta prenotando si
  // distrae — guida, è al lavoro, chiede alla moglie quanti sono. Cinque minuti
  // di silenzio in mezzo a una prenotazione sono la normalità. Azzerare al
  // sesto vuol dire che scrive «4» e si sente rispondere «Ciao! Come posso
  // aiutarti?», con giorno e ora già scelti buttati via. Quel cliente non
  // ricomincia: se ne va. Una conversazione aperta non costa niente a nessuno,
  // un tavolo perso costa una serata.
  //
  // Dopo quanti minuti di silenzio un SALUTO vale come «ricominciamo» invece
  // che come risposta alla domanda in sospeso. È il cliente a decidere, con la
  // sua parola: nessun timer butta via niente.
  bot_riapre_minuti: '10',
  // Quante risposte non capite DI FILA, sulla stessa domanda, prima di passare
  // la conversazione a una persona. Erano due fisse; il titolare ha chiesto
  // più pazienza (13 ottobre 2026): dalla seconda il bot chiede di riscrivere
  // con un esempio (`bot_t_riscrivi`), alla terza passa. Fra 2 e 5.
  bot_tentativi: '3',
  // Il richiamo: dopo quanti minuti il bot chiede «sei ancora lì?». Una volta
  // sola per conversazione, e solo dentro gli orari degli avvisi.
  bot_richiamo_attivo: 'true',
  bot_richiamo_minuti: '15',

  // Promemoria
  bot_promemoria_attivo: 'true',
  bot_promemoria_ora: '12:00',
  // E non dopo: vedi «promemoriaDaMandare» nel server (24 ottobre 2026).
  bot_promemoria_fino: '21:00',
  // Quanti giorni prima. 1 = il giorno prima, 0 = lo stesso giorno.
  bot_promemoria_giorni: '1',

  // La pagina della sala, su una porta sua. Spenta di fabbrica: una porta in
  // più aperta su una rete che spesso è quella dei clienti va accesa da chi sa
  // cosa sta facendo, non trovata già aperta.
  bot_sala_attiva: 'false',
  bot_sala_password: '',
  // Come si vede il tablet: 'chiaro', 'scuro' oppure 'auto' — che vuol dire
  // scura dalle 19:00 alle 6:00, a orologio. La sera uno schermo bianco acceso
  // sul bancone dà fastidio a chi sta in sala e si vede dal tavolo accanto.
  // ⚠️ È la scelta di PARTENZA: in sala c'è un tasto che la cambia per quel
  // tablet, e da lì in poi vince quello.
  bot_sala_tema: 'chiaro',

  // Recensioni
  bot_recensione_attiva: 'false',
  bot_recensione_link: '',
  // Il collegamento al menu (un PDF in rete, una pagina): va a chi lo chiede
  // («mi mandi il menu?»), al posto di {link} in `bot_t_menu`. Vuoto = il
  // bot non ne parla. Sta anche in {menu}, per chi lo vuole nel benvenuto.
  bot_menu_link: '',
  bot_menu_degustazione_link: '',
  // Oppure un FILE caricato (PDF o immagine), che il bot allega: il nome del
  // file dentro `allegati-menu/`, scritto dal server. Se c'è, vince sul link.
  bot_menu_file: '',
  bot_menu_degustazione_file: '',
  // Il nome com'era sul computer di chi l'ha caricato, per riconoscerlo in pagina.
  bot_menu_file_nome: '',
  bot_menu_degustazione_file_nome: '',
  bot_recensione_giorni: '2',
  bot_recensione_ora: '11:00',
  bot_recensione_max: '20',

  // I testi. Vengono scritti già pronti: un ristoratore che deve inventarsi
  // tredici messaggi da zero non accende mai il bot.
  bot_t_benvenuto: '{saluto} ✨ \n\nSono {assistente} l\'assistente virtuale di {locale}\nSarà un piacere aiutarti con la tua prenotazione.\n\nPer quante persone desideri prenotare? (esempio: 2)\n',
  // ⚠️ La domanda secca, per chi la conversazione l'ha già aperta. Il
  // benvenuto si presenta — «sono l'assistente di…» — e a chi ha appena letto
  // un nostro messaggio quella presentazione dice una cosa sola: che non ci
  // ricordiamo di lui. Chi scrive NUOVA sta rispondendo a noi.
  bot_t_quante: 'Per quante persone desideri prenotare? (esempio: 2)',
  // Con le esperienze (scheda «Esperienze», almeno due) la prima domanda non
  // è «per quante persone» ma «cosa vuoi mangiare»: il benvenuto si ferma
  // prima della domanda, e sotto arriva l'elenco. Deciso dal titolare.
  // Senza gli orari: con le esperienze arrivano dopo la scelta (22 ottobre 2026).
  bot_t_benvenuto_esperienze: '{saluto} ✨ \n\nSono {assistente} l\'assistente virtuale di {locale}\nSarà un piacere aiutarti con la tua prenotazione.\n',
  bot_t_bentornato_esperienze: 'Che bello rivederti, {nome}! ✨\n',
  // {numeri} è «1, 2 o 3»: si sceglie col numero (chiesto dal titolare, 19
  // ottobre 2026). Il nome lo capisce lo stesso, ma «business lunch» può
  // valere per due — vedi `bot_t_esperienza_quale`.
  bot_t_esperienze: 'Ecco cosa puoi prenotare da noi:\n\n{esperienze}\n\nA quale sei interessato? Scrivi il numero: {numeri}.',
  // ---- I locali: la prima domanda, prima di tutto (vedi «I locali») ----
  // {nomi} è «RO bistrot o per REAR Restaurant», {scelte} è «Scrivi *bistrot*
  // per RO bistrot e *ristorante* per REAR Restaurant.»; {scelto} è il locale
  // scelto ({locale} resta il nome di tutto, «RO WORLD»).
  bot_t_benvenuto_locali: '{saluto} ✨\n\nSono {assistente} l\'assistente virtuale di {locale}\nSeguirò la tua prenotazione.\n',
  bot_t_bentornato_locali: 'Che bello rivederti, {nome}! ✨\n',
  // Senza «Scrivi *bistrot* per…»: deciso dal titolare (19 ottobre 2026), è
  // scontato — il bot capisce i nomi, le parole e anche «bistot». Le scelte
  // restano in `bot_t_locale_no`, per chi risponde altro.
  bot_t_locali: 'Vuoi prenotare per {nomi}?',
  bot_t_locale_no: 'Non ho capito dove vuoi prenotare.\n\n{scelte}',
  bot_t_locale_preso: 'Perfetto, {scelto} 👍',
  bot_t_altro_locale_pieno: 'Mi dispiace: {scelto} per {data} è al completo. 😔',
  bot_t_altro_locale_restano: 'Mi dispiace, per {scelto} restano solo {posti}: per quante persone vuoi prenotare?',
  bot_t_altro_locale_sposta: 'La prenotazione per {scelto} è per {data}, e quel giorno non si può spostare.\n\nSe non potete venire scrivi ANNULLA, oppure OPERATORE per parlare con una persona.',
  // Chi ha già un posto all'altro locale e riscrive: il promemoria dice DOVE
  // (chi ha prenotato anche il REAR deve capire quale delle due sta leggendo),
  // e non offre CAMBIA — quel giorno non si sposta, e promettergli una cosa
  // per dirgli di no al messaggio dopo è peggio che non dirla. Lo stesso nella
  // domanda prima di cancellare (deciso dal titolare, 19 ottobre 2026).
  // 🍝 e non 📍: l'icona del bistrot, la stessa delle pagine (chiesto dal
  // titolare). Il 📍 resta al locale di sempre, nelle etichette delle pagine.
  bot_t_gia_altro_locale: '{saluto} {nome}! \nHai già una prenotazione confermata:\n\n🍝 {scelto}\n📅 {data}\n🕘 {ora}\n👥 {persone} persone\n\nCosa vuoi fare?\n\n• Per annullarla, scrivi CANCELLA.\n• Per fare un\'altra prenotazione, scrivi NUOVA.',
  bot_t_annulla_altro_locale: 'Sei sicuro di voler cancellare la prenotazione?\n\n🍝 {scelto}\n📅 {data}\n🕘 {ora}\n👥 {persone} persone\n\nScrivi SÌ per confermare',
  // Il giorno l'ha già detto: solo le esperienze che valgono quel giorno.
  bot_t_esperienze_giorno: '{data}{servizio} puoi scegliere:\n\n{esperienze}\n\nQuale preferisci? Scrivi il numero: {numeri}.',
  bot_t_esperienza_no: 'Non ho capito quale preferisci 🙏 Scrivi il numero: {numeri}.\n\n{esperienze}',
  // Alla seconda risposta che non si capisce, al menu: si va avanti e il
  // menu si sceglie al tavolo (24 ottobre 2026). Sotto, la domanda dopo.
  bot_t_esperienza_al_tavolo: 'Nessun problema, il menu lo scegli direttamente al tavolo 😊',
  // Il nome scritto va bene per più d'una («business lunch»: da €35 o da
  // €45?). L'elenco è solo di quelle, coi numeri di prima.
  bot_t_esperienza_quale: 'Ne abbiamo più di uno 🙂\n\n{esperienze}\n\nQuale preferisci? Scrivi il numero: {numeri}.',
  // «No» subito dopo «Perfetto, business lunch 👍»: si sceglie di nuovo.
  bot_t_esperienza_altra: 'Nessun problema 🙂 Ecco di nuovo cosa puoi prenotare:\n\n{esperienze}\n\nQuale preferisci? Scrivi il numero: {numeri}.',
  bot_t_esperienza_presa: 'Perfetto, {esperienza} 👍',
  // Niente domanda «vuoi vedere il menu?»: una riga, e chi lo vuole scrive
  // MENU — e riceve quello dell'esperienza scelta, senza «quale?».
  bot_t_esperienza_menu: '📖 Se vuoi vederlo, scrivi MENU.',
  // Il menu SUO di un'esperienza (file o collegamento caricato nella sua scheda).
  bot_t_menu_esperienza: '📖 {esperienza}: ecco il menu ✨\n👉 {link}',
  // MENU dopo aver scelto un'esperienza che un menu non ce l'ha: si dice, non
  // se ne manda un altro (era il guasto: il business lunch riceveva la carta).
  bot_t_esperienza_senza_menu: 'Per «{esperienza}» non ho un menu da mandarti: te lo raccontano in sala. 🙂',
  // MENU prima di scegliere, con più esperienze che hanno un menu: quale?
  bot_t_menu_quale_esperienze: 'Quale menu vuoi vedere? ✨\n\n{menu}\n\nScrivimi il nome o il numero.',
  // Gli orari d'apertura, una riga per servizio dalle fasce di «Orari e
  // tavoli»: nel benvenuto ({orari} vale in ogni frase) e a chi scrive ORARI.
  bot_t_orari: 'Siamo aperti:\n{orari}',
  // Un giorno in cui il locale c'è ma quell'esperienza no: non è «chiuso».
  bot_t_esperienza_chiusa: '{esperienza}: per {data} non è disponibile ({quando}).\n\nTi va di scegliere un altro giorno?',
  // ⚠️ Quando il cliente ha fatto una DOMANDA chiara — «è possibile
  // parcheggiare», «accettate la carta?» — la frase qui sopra è mezza
  // sbagliata: gli propone di prenotare, che non è quello che ha chiesto.
  // Qui la prenotazione passa in fondo, fra parentesi, e davanti c'è la sola
  // cosa che gli serve: come si ottiene una risposta vera.
  // ⚠️ Nel messaggio del pagamento la parola «confermata» non deve comparire:
  // chi legge «richiesta ricevuta» e poi «confermata» due righe sotto capisce
  // di avere un tavolo, e sabato sera si presenta. È il rischio numero uno di
  // tutta questa funzione, e sta in una parola.
  bot_t_pagamento: 'Perfetto {nome}, ci siamo quasi ✨\nTi collego al pagamento per confermare il tavolo.\n\n📅 {data}  🕘 {ora}  👥 {persone}\n💳 Da pagare adesso: {importo}\n\n👉 Paga qui: {link}\n{resto}\n⚠️ Il tavolo NON è ancora prenotato: lo diventa appena ricevo il pagamento.\nHo tenuto il tuo posto fino alle {scadenza}.\n\nDopo aver pagato torna pure qui: appena ricevo il pagamento ti scrivo io la conferma.',
  bot_t_pagata: '✅ Prenotazione CONFERMATA, {nome}!\n\n📅 {data}  🕘 {ora}  👥 {persone}\n💳 Ricevuti {importo}\n\nTi aspettiamo! Se hai un imprevisto scrivi CANCELLA.',
  // «Non ti è stato addebitato niente» sembra ovvia a noi, non a chi ha
  // cliccato un link di pagamento e poi si sente dire «scaduto». Senza quella
  // riga, qualcuno telefona al locale preoccupato.
  // Quando Stripe non risponde: il posto resta tenuto, ed è il collegamento che
  // manca. Dirgli «riprova» sarebbe una bugia — non c'è niente da riprovare.
  bot_t_pagamento_lento: 'Ho preso la tua richiesta, {nome} ✨\n\n📅 {data}  🕘 {ora}  👥 {persone}\n\nSto preparando il collegamento per il pagamento: te lo mando qui appena è pronto.\nHo tenuto il tuo posto.',
  // Il pagamento facoltativo: il tavolo è GIÀ prenotato, e questo va detto per
  // primo. Un messaggio che comincia parlando di soldi si legge come una
  // richiesta, e il cliente che non paga resta col dubbio di non avere il tavolo.
  bot_t_caparra: '✅ Prenotazione confermata, {nome}!\n\n📅 {data}  🕘 {ora}  👥 {persone}\n\nIl tavolo è tuo: non devi fare altro.\n\nSe vuoi, puoi lasciare fin d\'ora un acconto di {importo}:\n👉 {link}\n{resto}\nSe hai un imprevisto scrivi CANCELLA.',
  bot_t_caparra_ricevuta: '💳 Ricevuto il tuo acconto di {importo}, {nome}. Grazie!\n\n📅 {data}  🕘 {ora}  👥 {persone}\n{resto}\nTi aspettiamo!',
  bot_t_pagamento_scaduto: '⏰ Il tempo per pagare è scaduto e ho liberato il tavolo.\n\nNon ti è stato addebitato niente.\nSe vuoi ancora venire scrivi NUOVA e ricominciamo.',
  bot_t_persone_no: 'Non sono riuscita a capire il numero di persone!\n\nPuoi indicarmi solo il numero?\n(esempio: 2)',
  bot_t_giorno: 'Quale giorno desideri prenotare?\n',
  bot_t_giorno_no: 'Non sono riuscita a capire la data! \n\nPuoi indicarmi il giorno della prenotazione:\n',
  bot_t_troppo_lontano: 'Per {data} siamo troppo in l\u00e0 nel tempo: ti faccio rispondere da una persona del locale.',
  bot_t_chiuso: 'Purtroppo quel giorno {locale} è chiuso. \n\nTi va di scegliere un altro giorno?',
  bot_t_ora: 'Per {data} abbiamo disponibilità nei seguenti orari:\n',
  // A chi chiede il menu, se il collegamento è impostato. Esce come una
  // risposta pronta: a inizio conversazione e alla domanda sulle persone,
  // dove una domanda su altro non è un numero sbagliato.
  bot_t_menu: 'Ecco il nostro menu 🍽️\n👉 {link}',
  bot_t_menu_degustazione: 'E questo è il menu degustazione ✨\n👉 {link}',
  // Nessun collegamento impostato, e qualcuno lo chiede lo stesso.
  bot_t_menu_nessuno: 'Al momento non riesco a inviarti i menu: chiedi pure in sala, saranno felici di raccontarteli. 🙂',
  // L'ha già ricevuto oggi: non si rimanda da soli, si chiede.
  bot_t_menu_rimando: 'Te l’ho mandato poco fa 🙂 Vuoi che te lo rimandi? Scrivi SÌ o NO.',
  // Sotto il menu: come si va avanti. A chi non ha ancora cominciato si
  // propone di prenotare; a chi era a metà si ridice la domanda a cui era
  // rimasto ({cosa}: «per che giorno», «a che ora», «se confermi la prenotazione»).
  bot_t_menu_prenota: 'Se vuoi prenotare, dimmi pure per quante persone.',
  bot_t_menu_riprendi: 'Riprendiamo da dove eravamo: {cosa}?',
  // La riga sotto il benvenuto, solo se il collegamento c'è. Vuota = nessuna riga.
  // Una riga sola, uguale con uno o due menu (deciso dal titolare): a chi
  // scrive MENU con due menu attivi si chiede poi quale.
  bot_t_menu_invito: '📖 Se vuoi dare prima un’occhiata al menu, scrivi MENU.',
  bot_t_menu_quale: 'Abbiamo due menu: quale vuoi vedere? ✨\nScrivi MENU per il menu oppure DEGUSTAZIONE per il menu degustazione.',
  // Pranzo o cena, prima degli orari (deciso dal titolare). Si chiede solo
  // quando quel giorno sono aperti e liberi tutti e due i servizi, e il
  // cliente non l'ha già detto.
  bot_t_servizio: 'Per {data} preferisci pranzo o cena? 🍽️',
  bot_t_servizio_no: 'Non ho capito: per {data} preferisci pranzo o cena?',
  // Il messaggio dei TURNI, intero: chiesto dal titolare, che nella pagina
  // dei testi vedeva solo la riga sopra e quella sotto, e non l'elenco. Il
  // bot mette l'elenco al posto di {turni}, un turno per riga. Senza turni
  // (orari di prima) vale ancora `bot_t_ora`, con gli orari sotto.
  bot_t_ora_turno: 'Per {data} c’è disponibilità nei seguenti orari:\n\n{turni}\n\nScrivimi il turno che preferisci (per esempio «il primo») oppure l’orario.',
  // Con gli orari scelti dal locale (vedi `slotDelGiorno`), al posto dei turni.
  bot_t_ora_orari: 'Per {data}{servizio} ho questi orari:\n\n{orari}\n\nScrivimi l’orario che preferisci.',
  // Un servizio con un turno solo: invece di un elenco di una riga, si chiede
  // se va bene. {arrivo} è «alle 12:30, e il tavolo è tuo fino alle 15:30»
  // (o «alle 12:30» se la fine non è scritta); {fascia} è «dalle 12:30 alle
  // 15:30». Senza la parola «turno»: deciso dal titolare (19 ottobre 2026).
  bot_t_turno_unico: 'Per {data} a {servizio} ti aspettiamo {arrivo}. ✨\n\nTi va bene? Scrivi SÌ per continuare.',
  // Il servizio chiesto è chiuso (o pieno) e dell'altro resta un turno solo:
  // sotto quel turno, la domanda.
  bot_t_unico_va_bene: 'Ti va bene? Scrivi SÌ per continuare.',
  // «No» all'unico turno del servizio scelto: altri giorni per quel servizio.
  bot_t_unico_no: 'Va bene 👍 Ecco altri giorni in cui c’è posto a {servizio}:\n',
  // …e in fondo, se quel giorno l'altro servizio ha posto, come chiederlo.
  bot_t_unico_no_altro: 'Se invece {data} ti va bene a {altro}, scrivimi «{altro}».',
  // Il cliente ha chiesto un servizio — «a pranzo» — che quel giorno non c'è,
  // o è pieno. Non è un «non ho capito»: si dice com'è, e si propone l'altro.
  bot_t_servizio_chiuso: 'Per {data} a {servizio} siamo chiusi, ma abbiamo disponibilità in questi orari:\n',
  bot_t_servizio_pieno: 'Per {data} a {servizio} non abbiamo più disponibilità, ma ci sono ancora questi orari:\n',
  // Il servizio chiesto c'è, ma l'esperienza scelta lì non vale.
  bot_t_servizio_esperienza: '{esperienza}: per {data} a {servizio} non è disponibile ({quando}), ma ci sono questi orari:\n',
  // L'orario scritto a metà («21», «alle 8»). Deciso dal titolare: se il bot
  // ne sceglie uno vicino lo DICE, sulla stessa risposta, invece di
  // aggiustare in silenzio; se non c'è, lo dice invece di «non ho capito».
  bot_t_ora_vicina: 'ℹ️ Alle {scritto} non abbiamo un turno: ho segnato le {ora}. Se preferisci un altro orario, scrivimelo.',
  bot_t_ora_niente: 'Alle {scritto} non abbiamo un turno. Questi sono quelli disponibili:\n',
  bot_t_ora_quale: 'Alle {scritto} abbiamo più di un turno: scrivimi l’orario preciso.\n',
  bot_t_ora_cambiata: '👍 Ho segnato le {ora}.',
  // Alla domanda dell'orario, un altro giorno con un orario che quel giorno c'è.
  bot_t_giorno_cambiato: '👍 Ho segnato {data} alle {ora}.',
  bot_t_ora_no: 'Non sono riuscita a capire quale orario preferisci!\n\nPuoi indicarmi direttamente l’orario (esempio: 21:30)\n',
  // Un orario che il locale fa davvero, ma pieno (o troppo vicino), non è una
  // risposta incomprensibile: è un no, e va detto per quello che è.
  bot_t_ora_piena: 'Mi dispiace, alle {ora} siamo già al completo.\n\nEcco gli orari ancora liberi:\n',
  bot_t_ora_tardi: 'Per le {ora} non è possibile.\n\nEcco gli orari ancora liberi:\n',
  bot_t_completo: 'Mi dispiace, per {data} non abbiamo più disponibilità.\n\nVuoi scegliere un altro giorno?\n\n',
  // La lista d'attesa, in quattro momenti: la proposta in coda a un «pieno»,
  // la conferma di essere in lista, l'avviso che un posto si è liberato, e le
  // due uscite (rinuncia, o posto ripreso da altri nel frattempo).
  // {quando} è «per sabato 12 settembre alle 20:00», o senza l'ora se la
  // richiesta era per tutta la giornata.
  bot_t_attesa_proposta: 'Se vuoi, ti scrivo io appena si libera un posto {quando}: rispondi SÌ e ti metto in lista d\'attesa.',
  bot_t_attesa_segnata: 'Perfetto, sei in lista d\'attesa {quando} per {persone} persone. 📝\n\nSe si libera un posto ti scrivo qui, e avrai {minuti} minuti per confermare.\n\nSe cambi idea scrivi CANCELLA.',
  bot_t_attesa_gia: 'Sei già in lista d\'attesa {quando}: appena si libera un posto ti scrivo io.',
  bot_t_attesa_libero: '🎉 Si è liberato un posto {quando} per {persone} persone!\n\nLo vuoi? Rispondi SÌ entro {minuti} minuti, altrimenti lo propongo a chi è in lista dopo di te.',
  bot_t_attesa_rinuncia: 'Va bene, ti ho tolto dalla lista d\'attesa. Se vuoi prenotare un altro giorno, dimmi per quante persone.',
  bot_t_attesa_ripieno: 'Mi dispiace, nel frattempo quel posto è stato preso. 😔\nResti in lista: ti riscrivo se si libera di nuovo.',
  bot_t_attesa_scaduta: 'Non ho ricevuto la tua risposta in tempo, così il posto {quando} è tornato libero per gli altri in lista. 😔\n\nResti in lista: se se ne libera un altro ti riscrivo qui.',
  bot_t_attesa_rimossa: 'Ti ho tolto dalla lista d\'attesa {quando}: non ti scriverò più se si libera un posto.\n\nSe ti serve un tavolo, scrivimi pure quando vuoi.',
  bot_t_attesa_tolta: 'Ti ho tolto dalla lista d\'attesa. Se vuoi prenotare, dimmi per quante persone.',
  bot_t_nome: 'A che nome e cognome segno la prenotazione?\n',
  bot_t_note: 'Prima di completare la prenotazione, c’è qualche allergia, intolleranza o esigenza particolare che dovremmo conoscere?\n\nSe non c’è nulla, scrivi NESSUNA.',
  bot_t_telefono: 'A quale numero possiamo richiamarti se serve?\n\nScrivi OK per usare questo, oppure scrivimi il numero giusto.',
  bot_t_telefono_no: 'Non ho capito il numero. \nScrivilo intero (esempio 3331234567)',
  bot_t_email: 'Perfetto! ✨\nEcco il riepilogo della tua prenotazione:\n\n📅 Data: {data}\n🕘 Orario: {ora}\n👥 Persone: {persone}\n🍽️ {esperienza}\n👤 Nome: {nome}\n📝 Note: {note}\n\nPer confermare, scrivimi la tua email: la useremo per mandarti la conferma.\n\n(se hai cambiato idea, scrivi NO)',
  bot_t_daccordo: 'Va bene! 😊\n\nResto qui: se ti serve altro, scrivimi pure.',
  bot_t_email_no: 'Mi serve la tua email per confermare la prenotazione.\nScrivimela per intero, per esempio: nome@esempio.it\n\n(se hai cambiato idea, scrivi NO)',
  bot_t_riepilogo: 'Perfetto! ✨ \nEcco il riepilogo della tua prenotazione:\n\n📅 Data: {data}\n🕘 Orario: {ora}\n👥 Persone: {persone}\n🍽️ {esperienza}\n👤 Nome: {nome}\n📝 Note: {note}\n\nConfermi la prenotazione?\n\nScrivi SÌ per confermare',
  // Esce SOLO quando il nome l'abbiamo messo noi, riconoscendo il numero. A
  // chi il nome l'ha appena scritto questa riga non serve, ed è solo rumore.
  bot_t_bentornato: 'Che bello rivederti, {nome}! ✨\n\nPer quante persone desideri prenotare? (esempio: 2)\n',
  bot_t_nome_altro: 'Per {nome}, come l\'altra volta?\n\nScrivi SÌ, oppure scrivimi il nome giusto.',
  bot_t_telefono_altro: 'A quale numero possiamo contattare {nome}, se serve?\n\nScrivi NO se preferisci che chiamiamo te.',
  bot_t_nome_nostro: '\n\n(Ho usato il nome dell\'ultima volta. Se prenoti per un\'altra persona, scrivimi il nome giusto.)',
  // ⚠️ Il bot NON dice di sì al posto del ristorante. «Si può avere una torta?»
  // seguito da «OK, grazie» è una promessa che il locale non ha fatto, e quel
  // cliente si presenta aspettandosi la torta.
  // ⚠️ Il nome della chiave è storico: vale per QUALUNQUE nota, non solo per le
  // domande. Non si rinomina perché chi l'ha già riscritta perderebbe il testo.
  bot_t_nota_domanda: 'Me la sono segnata 📝\n\nLa trovano scritta sulla prenotazione. Se c’è qualcosa da confermare te lo dicono loro: io non posso farlo al posto del ristorante.',
  bot_t_conferma: '✅ Prenotazione confermata!\n\nGrazie, {nome}. ✨\nTi aspettiamo da {locale} per una nuova esperienza.\n\nSe dovessi avere un imprevisto, contattami in questa chat.\n\nA presto!',
  bot_t_rinuncia: 'OK! Non ho prenotato niente.\n\nSperiamo di poterti accogliere presto da {locale}. ✨',
  bot_t_lasciato: 'Va bene, non ho toccato niente: la tua prenotazione resta com\'era. ✨',
  bot_t_ricominciamo: 'Se preferisci, scrivi RICOMINCIA per ripartire da capo con la prenotazione, oppure OPERATORE per parlare con una persona.',
  // Dal secondo «non ho capito» di fila: non la stessa domanda una terza
  // volta, ma «riscrivilo», con un esempio adatto alla domanda ({esempio}).
  bot_t_riscrivi: 'Scusami, non ho capito bene 🙏 Me lo riscrivi in un altro modo?\n{esempio}',
  bot_t_richiamo: 'Sei ancora lì? 🙂\n\nTi stavo chiedendo {cosa}: rispondi pure qui e finiamo in un attimo.\n\nSe preferisci ripartire da capo scrivi RICOMINCIA.',
  // In cima alla presentazione: la domanda la fa il primo messaggio (20 ottobre 2026).
  bot_t_ricominciato: 'Va bene, ricominciamo da capo! 🙂',
  // «Torna indietro»: in cima alla domanda di prima, riscritta com'era.
  bot_t_indietro: 'Va bene, torniamo indietro 🙂',
  bot_t_indietro_inizio: 'Siamo già alla prima domanda 🙂',
  bot_t_annulla_quale: 'Sei sicuro di voler cancellare la prenotazione?\n\n📅 {data}\n🕘 {ora}\n👥 {persone} persone\n\nScrivi SÌ per confermare',
  bot_t_modificata: 'Ciao {nome}, abbiamo aggiornato la tua prenotazione:\n\n📅 {data} \n🕘 {ora} \n👥 {persone}\n\nA presto!\n',
  bot_t_manuale: 'Ciao {nome}! \nTi confermiamo la prenotazione da {locale}:\n\n📅 {data} \n🕘 {ora}  \n👥 {persone}\n\nSe hai un imprevisto scrivi in questa chat.',
  bot_t_annullata: '✅ Prenotazione cancellata.\n\nGrazie per averci avvisato.\nSperiamo di poterti accogliere presto da {locale}. ✨',
  // {scelto}: il locale della prenotazione («RO bistrot»); {locale} firma.
  bot_t_annullata_locale: 'Ciao {nome}, \nti avvisiamo che la tua prenotazione da {scelto} di {data} alle {ora} è stata cancellata.\n\n{locale}',
  bot_t_annulla_niente: '⚠️ Non trovo alcuna prenotazione associata al tuo nome.\n\nSe pensi che ci sia un errore o hai bisogno di supporto, scrivi OPERATORE e ti metterò in contatto con una persona del nostro team.',
  bot_t_sposta_quale: 'La tua prenotazione è:\n\n📅 {data}\n🕘 {ora}\n👥 {persone}\n\nChe giorno vuoi spostarla?\n',
  bot_t_sposta_conferma: 'Sposto la tua prenotazione a:\n\n📅 {data}\n🕘 {ora}\n👥 {persone}\n\nScrivi SÌ per confermare',
  bot_t_spostata: '✅ Spostata! \nTi aspettiamo {data} alle {ora}.\n\nSe hai un imprevisto scrivi in questa chat.',
  bot_t_sposta_pieno: 'Mi dispiace, per {data} alle {ora} non c\'è più posto.\n\n⚠️ La tua prenotazione di {vecchiaData} alle {vecchiaOra} resta com\'era: non ho toccato niente.',
  bot_t_gia_prenotate: '{saluto} {nome}!\nHai {quante} prenotazioni confermate:\n\n{elenco}\n\nCosa vuoi fare?\n\n• Per spostarne una a un altro giorno, scrivi CAMBIA.\n• Per annullarne una, scrivi CANCELLA.\n• Per prenotare un altro tavolo, scrivi NUOVA.',
  bot_t_quale_annulla: 'Quale prenotazione vuoi cancellare?\n\n{elenco}\n\nRispondi con il numero indicato.\n',
  bot_t_quale_sposta: 'Quale prenotazione vuoi cambiare?\n\n{elenco}\n\nRispondi con il numero indicato.\n',
  bot_t_gia_prenotato: '{saluto} {nome}! \nHai già una prenotazione confermata:\n\n📅 {data}\n🕘 {ora}\n👥 {persone} persone\n\nCosa vuoi fare?\n\n• Per spostarla a un altro giorno, scrivi CAMBIA.\n• Per annullarla, scrivi CANCELLA.\n• Per prenotare un altro tavolo, scrivi NUOVA.',
  bot_t_promemoria: 'Ciao {nome}! ✨\n\nTi ricordiamo la tua prenotazione: {data} alle {ora}, per {persone} persone.\n\nTi aspettiamo!\n{locale}',
  // L'oggetto dell'email di promemoria. Il TESTO è lo stesso di WhatsApp qui
  // sopra: è la stessa cosa da dire, e tenerla in due posti vorrebbe dire
  // cambiarne uno e dimenticare l'altro.
  bot_t_promemoria_oggetto: 'Promemoria: la tua prenotazione da {locale} — {data}',
  bot_t_recensione: 'Ciao {nome}! ✨\n\nGrazie per aver scelto {locale} e per aver condiviso con noi la tua esperienza.\n\nSe ti sei trovato bene, ci farebbe davvero piacere ricevere una recensione: il tuo parere è prezioso per noi. ❤️\n\n{link}\n\nSe non vuoi più ricevere messaggi come questo, scrivi STOP.\n\nSe invece c’è qualcosa che non è andato come avresti desiderato, scrivici direttamente qui. Saremo felici di ascoltarti.',
  bot_t_nonho_aperto: 'Non sono sicura di aver capito la tua richiesta. 😊\n\nTi metto subito in contatto con un operatore, che potrà aiutarti.',
  bot_t_nonho_chiuso: 'Non ho capito la tua richiesta. 😊\n\nHo passato il messaggio a un operatore, che ti risponderà alla riapertura del ristorante.\n\nA presto! ✨',
  // ⚠️ «Ti risponderà appena possibile» alle 20:30 di sabato è il momento in
  // cui è MENO vero: è esattamente quando nessuno può guardare il telefono.
  // Meglio dire come stanno le cose che promettere una fretta che non c'è.
  bot_t_operatore: 'Certamente! 😊\n\nHo passato la tua richiesta a una persona del locale.\nTi risponde appena si libera — in orario di servizio può volerci qualche minuto.\n\nA presto! ✨',
  // ⚠️ La stessa cosa, ma quando nessuno sta leggendo il telefono. «Ti
  // risponderà appena possibile» scritto alle tre di notte è una promessa che
  // il locale non può mantenere: chi la legge resta col telefono in mano ad
  // aspettare. Dire che il locale è chiuso e da che ora si risponde costa una
  // riga e toglie l'attesa a vuoto. Le due frasi per «non ho capito» erano già
  // sdoppiate così (bot_t_nonho_aperto / _chiuso): questa era rimasta indietro.
  // ⚠️ Un'ora batte un aggettivo: «{quando} dalle {apertura}» è verificabile,
  // «ci vorrà più tempo» no — e toglie certezza invece di darne. {quando} è
  // «oggi», «domani» o il nome del giorno: l'ora senza il giorno, la domenica
  // sera di un locale chiuso il lunedì, si legge come «domani» e sarebbe falso.
  bot_t_operatore_chiuso: 'Certamente! 😊\n\nIn questo momento il locale è chiuso, ma ho già passato la tua richiesta a una persona: ti risponde {quando}, dalle {apertura}.\n\nA presto! ✨',
  // ⚠️ E quando la persona ha finito. Prima il cliente non riceveva NIENTE:
  // stava parlando con Giulia e al messaggio dopo gli rispondeva di nuovo il
  // bot, senza che nessuno gli avesse detto che Giulia era andata via. Non
  // «ha abbandonato la conversazione», che suona come se l'avessero piantato
  // lì: la persona ha finito, e al cliente serve sapere come richiamarla.
  // ⚠️ NON «{nome} ti saluta»: in italiano si legge benissimo come «ti manda un
  // saluto», che è il contrario di quello che vuol dire. Qui serve una cosa
  // sola, detta senza equivoci: quella persona ha finito.
  bot_t_umano_finito: '✅ La conversazione con {nome} è conclusa — grazie di averci scritto!\n\nDa qui in avanti ti risponde di nuovo l’assistente virtuale: posso aiutarti con le prenotazioni.\nSe ti serve di nuovo una persona, scrivi OPERATORE.',
  bot_t_prefisso_umano: '👋 Sei in contatto con {nome} del team {locale}.',
  // Chi risponde dal telefono del locale (o dalla scheda Chat) non ha un
  // codice e non si presenta: lo fa il bot per lui, subito DOPO la sua prima
  // risposta. Senza nome, perché da quel telefono non si sa chi scrive.
  bot_t_ingresso_locale: '👋 Da qui ti risponde una persona di {locale}.',
  // Quando il bot viene riattivato dalla piattaforma («Riattiva il bot»,
  // «Sblocca»): la persona ha finito, e va detto — come su LIBERA.
  bot_t_uscita_locale: '✅ La persona ha finito — grazie di averci scritto!\n\nDa qui in avanti ti risponde di nuovo l\'assistente virtuale: posso aiutarti con le prenotazioni.\nSe ti serve di nuovo una persona, scrivi OPERATORE.',
  bot_t_troppe: 'Per aiutarti al meglio, ti passo a un operatore.\n\nTi risponderà appena possibile. ✨\n',
};

function leggi(db, chiave) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(chiave);
  if (r && r.value !== null && r.value !== undefined && r.value !== '') return r.value;
  // La stringa vuota salvata di proposito (es. un testo svuotato) resta vuota
  if (r && r.value === '') return '';
  return PREDEFINITI[chiave] !== undefined ? PREDEFINITI[chiave] : '';
}

function scrivi(db, chiave, valore) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(chiave, String(valore));
}

function config(db) {
  const c = {};
  for (const k of Object.keys(PREDEFINITI)) c[k] = leggi(db, k);
  return c;
}

const num = (v, sePerso) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : sePerso;
};
const boolDi = (v) => String(v) === 'true' || v === true;

// ---------------------------------------------------------------------------
//  Capire il testo del cliente
// ---------------------------------------------------------------------------
//  Qui si riconoscono PAROLE, non significati. È il progetto, non un limite da
//  correggere: quando non si riconosce niente si passa a una persona, e va
//  benissimo così.

function normalizza(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // via gli accenti, come normalizzaNome() nel server
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// «una» NON sta in questo elenco, e non è una dimenticanza: «una comitiva»,
// «una tavolata», «siamo una famiglia» diventerebbero tutti «1 persona», cioè
// esattamente l'errore peggiore — il bot che indovina il numero sbagliato. Chi
// è davvero solo scrive «uno» oppure «una persona», gestita qui sotto a parte.
const NUMERI_A_PAROLE = {
  uno: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sei: 6,
  sette: 7, otto: 8, nove: 9, dieci: 10, undici: 11, dodici: 12,
};

// Quante persone. Accetta «4», «siamo 4», «quattro», «4 persone».
// NON accetta «io, mia moglie e i suoceri»: lì restituisce null e passa a una
// persona, che è meglio di prenotare per il numero sbagliato.
function interpretaPersone(testo) {
  // ⚠️ «No, business lunch da 45 euro» diventava «per 45 persone preferisco
  // farti parlare con il locale» (19 ottobre 2026). Un prezzo non è un
  // numero di persone: «45 euro», «45€», «€45», «45,50 €» si tolgono prima.
  const t = normalizza(testo).replace(/€\s*\d+(?:[.,]\d+)?|\d+(?:[.,]\d+)?\s*(?:€|euro\b|eur\b)/g, ' ')
    // ⚠️ Nemmeno un orario (23 ottobre 2026, da una chat vera): «20.30»,
    // scritto da chi aveva un tavolo subito dopo il promemoria, erano venti
    // persone e una prenotazione nuova. Via «20.30», «20:30», «alle 20».
    .replace(/\b\d{1,2}\s*[:.]\s*\d{2}\b/g, ' ')
    .replace(new RegExp(`\\b${PAROLE_DELL_ORA}\\s*\\d{1,2}\\b`, 'g'), ' ')
    .trim();
  if (!t) return null;
  const cifre = t.match(/\b(\d{1,2})\b/);
  if (cifre) {
    const n = parseInt(cifre[1], 10);
    return n >= 1 && n <= 50 ? n : null;
  }
  if (/\buna\s+person[ae]\b/.test(t)) return 1;
  for (const [parola, valore] of Object.entries(NUMERI_A_PAROLE)) {
    if (parola === 'sei' && !seiComeNumero(t)) continue;
    if (new RegExp(`(^|\\W)${parola}(\\W|$)`).test(t)) return valore;
  }
  return null;
}

// ⚠️ «Sei» è anche il verbo. «Ci sei?», «sei ancora lì?» erano sei persone
// (visto il 23 ottobre 2026, nella raffica di `prova-carico.js`): al passo
// delle persone il bot passava a «Quale giorno desideri prenotare?» per sei, e
// come primo messaggio cominciava una prenotazione. Vale come numero solo da
// solo, o detto come persone: «sei persone», «siamo in sei», «per sei», «sei
// o sette».
function seiComeNumero(t) {
  const x = t.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return x === 'sei'
    || /\bsei\s+(?:persone|persona|pers|pax|coperti|adulti|ospiti|posti|o|oppure)\b/.test(x)
    || /\b(?:siamo|saremo|in|per|tavolo da|tavolo per)\s+sei\b/.test(x);
}

const GIORNI_SETTIMANA = {
  domenica: 0, lunedi: 1, martedi: 2, mercoledi: 3,
  giovedi: 4, venerdi: 5, sabato: 6,
};
const NOMI_GIORNI = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
const NOMI_MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
  'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

// Data locale in aaaa-mm-gg, lo stesso formato usato ovunque nel progetto.
// Con l'ora UTC il giorno cambierebbe all'una o alle due di notte.
function comeData(d) {
  return d.toLocaleDateString('sv-SE');
}

function piuGiorni(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}

// La data in forma corta, per gli elenchi che il responsabile legge sul
// telefono: «mer 26 agosto» invece di «mercoledì 26 agosto». Tre lettere in
// meno per riga sembrano poco, ma su WhatsApp sono la differenza fra una riga
// e due — e un elenco che va a capo ogni riga non si scorre più.
function dataBreve(iso) {
  const [a, m, g] = String(iso).split('-').map(Number);
  const d = new Date(a, m - 1, g);
  return `${NOMI_GIORNI[d.getDay()].slice(0, 3)} ${g} ${NOMI_MESI[m - 1]}`;
}

function dataItaliana(iso) {
  const [a, m, g] = String(iso).split('-').map(Number);
  const d = new Date(a, m - 1, g);
  return `${NOMI_GIORNI[d.getDay()]} ${g} ${NOMI_MESI[m - 1]}`;
}

// ⚠️ LE DATE SCRITTE STORTE: «15 ottore», «3 nomembre», «sabto», «domai».
// Chiesto dal titolare (13 ottobre 2026): prima erano due «non ho capito» e la
// conversazione passava a una persona per una lettera. Si raddrizza una parola
// a UN errore (una lettera sbagliata, mancante, in più, o due invertite: vedi
// `distanzaParole`), di almeno cinque lettere, e solo se la parola giusta è
// una sola. Leggere male costa poco: la risposta dopo dice la data intera, e
// il riepilogo chiede conferma.
//
// Due regole diverse, e il perché:
// - il MESE si raddrizza solo dopo un numero («15 ottore»), e allora ovunque:
//   un numero seguito da una parola a un errore da un mese è quel mese. MA
//   non «marzo»: «per 2 mario rossi» e «per 2 marco» sarebbero il 2 marzo, a
//   una lettera di distanza. Fuori anche i cognomi a un errore dai mesi lunghi
//   («Maggi», «Giugni», «Agosti»);
// - il GIORNO della settimana e «domani» solo quando il bot ha chiesto il
//   giorno (`storti`). Nel testo libero «Domenico» è un nome e «Romani» un
//   cognome: a un errore da «domenica» e da «domani».
const PAROLE_DEI_GIORNI = ['lunedi', 'martedi', 'mercoledi', 'giovedi', 'venerdi', 'sabato', 'domenica',
  'domani', 'dopodomani', 'stasera'];
const NON_SONO_GIORNI = new Set(['domenico', 'romani']);
const MESI_DA_RADDRIZZARE = NOMI_MESI.filter((m) => m !== 'marzo');
const NON_SONO_MESI = new Set(['maggi', 'giugni', 'agosti', 'aprire']);
function parolaVicina(parola, elenco) {
  if (elenco.includes(parola)) return parola;
  if (parola.length < 5) return null;
  const vicine = elenco.filter((p) => distanzaParole(parola, p, 1) <= 1);
  return vicine.length === 1 ? vicine[0] : null;
}
function dateRaddrizzate(t, storti = false) {
  let s = String(t || '').replace(/\b(\d{1,2})\s+([a-z]+)\b/g, (intero, g, parola) => {
    const mese = NON_SONO_MESI.has(parola) ? null : parolaVicina(parola, MESI_DA_RADDRIZZARE);
    return mese ? `${g} ${mese}` : intero;
  });
  if (storti) {
    s = s.replace(/[a-z]+/g, (parola) => (NON_SONO_GIORNI.has(parola) ? parola
      : parolaVicina(parola, PAROLE_DEI_GIORNI) || parola));
  }
  return s;
}

// Interpreta un giorno. Accetta: oggi/stasera, domani, dopodomani, il nome del
// giorno della settimana (prossima occorrenza), 22, 22/8, 22/08/2026, 22 agosto.
// Con `storti` anche il giorno della settimana scritto male (vedi sopra).
function interpretaData(testo, adesso, { storti = false } = {}) {
  const t = dateRaddrizzate(normalizza(testo), storti);
  if (!t) return null;

  // «Questa sera», «sta sera» come «stasera» (24 ottobre 2026: «Per questa
  // sera a cena» al passo del menu non si capiva).
  if (/\b(oggi|stasera|stanotte|stamattina|(?:questa|sta) (?:sera|mattina|notte))\b/.test(t)) return comeData(adesso);
  if (/\bdopodomani\b/.test(t)) return comeData(piuGiorni(adesso, 2));
  if (/\bdomani\b/.test(t)) return comeData(piuGiorni(adesso, 1));

  // 22/08/2026 · 22-08 · 22.8
  const conMese = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\b/);
  if (conMese) {
    const g = +conMese[1], m = +conMese[2];
    let a = conMese[3] ? +conMese[3] : adesso.getFullYear();
    if (a < 100) a += 2000;
    const d = new Date(a, m - 1, g);
    if (d.getDate() !== g || d.getMonth() !== m - 1) return null;   // 31/02 non esiste
    // Data già passata senza anno indicato: è l'anno prossimo
    if (!conMese[3] && comeData(d) < comeData(adesso)) d.setFullYear(a + 1);
    return comeData(d);
  }

  // Un numero secco è il giorno del mese: «1» davanti a un elenco che dice
  // «martedì 1 settembre» vuol dire QUEL giorno. Prima non veniva letto affatto,
  // e finiva nella scorciatoia che sceglieva la riga numero 1 — un altro giorno,
  // senza dirlo a nessuno.
  const soloGiorno = t.match(/^(\d{1,2})$/);
  if (soloGiorno) {
    const g = +soloGiorno[1];
    if (g < 1 || g > 31) return null;
    const d = new Date(adesso.getFullYear(), adesso.getMonth(), g);
    if (d.getDate() !== g) return null;                    // «31» a febbraio non esiste
    if (comeData(d) < comeData(adesso)) {                  // già passato: è il mese prossimo
      d.setMonth(d.getMonth() + 1);
      if (d.getDate() !== g) return null;
    }
    return comeData(d);
  }

  // 22 agosto
  const conNomeMese = t.match(/\b(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\b/);
  if (conNomeMese) {
    const g = +conNomeMese[1];
    const m = NOMI_MESI.indexOf(conNomeMese[2]);
    const d = new Date(adesso.getFullYear(), m, g);
    if (d.getDate() !== g) return null;
    if (comeData(d) < comeData(adesso)) d.setFullYear(adesso.getFullYear() + 1);
    return comeData(d);
  }

  // ⚠️ Il nome del giorno va cercato PER ULTIMO, dopo tutte le forme che
  // contengono una data vera. Stando in cima si prendeva il «giovedì» di
  // «giovedì 3 settembre» e si prenotava il giovedì prossimo — il 27 agosto —
  // buttando via il resto della frase: il cliente scriveva una data precisa e
  // se ne vedeva confermare un'altra. Chi scrive un giorno del mese sta
  // dicendo qualcosa di più preciso di chi nomina il giorno della settimana,
  // e in caso di disaccordo è la data che vale.
  for (const [nome, indice] of Object.entries(GIORNI_SETTIMANA)) {
    if (new RegExp(`(^|\\W)${nome}(\\W|$)`).test(t)) {
      // «sabato» detto di sabato vuol dire quasi sempre sabato PROSSIMO, non oggi:
      // chi vuole oggi scrive «stasera». Meglio 7 giorni avanti che una
      // prenotazione per fra due ore che il cliente non si aspetta.
      let delta = (indice - adesso.getDay() + 7) % 7;
      if (delta === 0) delta = 7;
      return comeData(piuGiorni(adesso, delta));
    }
  }

  return null;
}

// Più giorni in una frase sola: «oggi, domani, sabato 3 settembre», oppure
// «2 3 4 settembre».
//
// ⚠️ Il caso difficile è l'ultimo: «2 3 4 settembre» sono TRE giorni che si
// spartiscono un mese nominato una volta sola in fondo. Letto pezzo per pezzo,
// «2» e «3» diventerebbero il 2 e il 3 del mese corrente — cioè due giorni
// sbagliati, segnati pieni senza che nessuno se ne accorga fino a quando un
// cliente non si sente dire di no per niente. Quindi: se in fondo c'è il nome
// di un mese, quel mese vale per tutti i numeri sciolti della frase.
//
// Si restituisce un elenco ORDINATO e senza doppioni: «sabato, sabato» è una
// distrazione, non due giorni.
function interpretaGiorni(testo, adesso) {
  const grezzo = String(testo || '').trim();
  if (!grezzo) return [];

  // Il mese scritto una volta sola in fondo, che vale per tutti i numeri.
  const mese = normalizza(grezzo).match(
    new RegExp(`\\b(${NOMI_MESI.join('|')})\\b\\s*$`));

  // Si spezza su virgole, «e» e punti e virgola.
  //
  // ⚠️ NON sulla barra: «1/9» è il primo settembre, e spezzandolo diventava
  // «1» e «9» — due giorni sbagliati segnati pieni senza che nessuno lo
  // chiedesse. Nemmeno sugli spazi, qui: «sabato 3 settembre» è un pezzo solo.
  const pezzi = grezzo.split(/\s*(?:,|;|\be\b)\s*/i).map((p) => p.trim()).filter(Boolean);

  const date = new Set();
  for (const pezzo of pezzi) {
    // Dentro a un pezzo possono esserci più numeri sciolti: «2 3 4 settembre».
    // Si guarda se il pezzo è FATTO solo di numeri (più l'eventuale mese): in
    // quel caso ogni numero è un giorno per conto suo.
    const soloNumeri = pezzo.match(/^\s*(\d{1,2}(?:\s+\d{1,2})+)\s*(?:[a-zà-ù]+)?\s*$/i);
    if (soloNumeri) {
      for (const g of soloNumeri[1].split(/\s+/)) {
        const iso = interpretaData(mese ? `${g} ${mese[1]}` : g, adesso);
        if (iso) date.add(iso);
      }
      continue;
    }
    // Più giorni separati dal solo spazio: «oggi domani», «sabato domenica».
    // Si accetta la divisione SOLO se ogni pezzo, da solo, è un giorno vero:
    // così «sabato 3 settembre» — dove «settembre» da solo non è un giorno —
    // resta tutto intero e non diventa «sabato» più chissà cosa.
    const parole = pezzo.split(/\s+/);
    if (parole.length > 1) {
      const tutte = parole.map((p) => interpretaData(p, adesso));
      if (tutte.every(Boolean)) { for (const d of tutte) date.add(d); continue; }
    }
    const iso = interpretaData(pezzo, adesso);
    if (iso) { date.add(iso); continue; }
    // Un numero secco in un pezzo che il lettore delle date non ha capito, ma
    // con un mese nominato altrove nella frase: «sabato 3 settembre, 4».
    const secco = pezzo.match(/^\d{1,2}$/);
    if (secco && mese) {
      const conMese = interpretaData(`${pezzo} ${mese[1]}`, adesso);
      if (conMese) date.add(conMese);
    }
  }
  return [...date].sort();
}

// ⚠️ L'ORARIO IN UNA FRASE CON ALTRI NUMERI. Visto in una chat vera (23
// ottobre 2026): alla domanda dell'orario il cliente scrive «22 ottobre ore
// 20:30», e il bot prendeva il PRIMO numero — il 22, il giorno — e segnava le
// 22:30 («Alle 22 non abbiamo un turno: ho segnato le 22:30»). Due volte di
// fila, perché il cliente riscriveva la stessa frase. Prima di cercare l'ora
// si tolgono le date («22 ottobre», «22/10», «il 10», «giovedì 10») e le
// persone («4 persone», «siamo in 3»); fra i numeri che restano vale quello
// dopo «ore»/«alle», poi quello coi minuti, poi il primo.
const PAROLE_DELL_ORA = '(?:ore|alle|h|per le|verso le|dopo le|prima delle|dalle)';
function senzaDateNePersone(t) {
  return dateRaddrizzate(t)
    .replace(new RegExp(`\\b\\d{1,2}\\s+(?:di\\s+)?(?:${NOMI_MESI.join('|')})\\b`, 'g'), ' ')
    .replace(/\b\d{1,2}\s*\/\s*\d{1,2}(?:\s*\/\s*\d{2,4})?\b/g, ' ')
    // «giovedì 10», «il 10»: il giorno resta, il numero no. Non «il 2° turno».
    .replace(/\b(lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica|il|giorno|del)\s+\d{1,2}\b(?!\s*(?:[:.,]\s*\d|[°º]|turno))/g, '$1 ')
    .replace(/\b\d{1,2}\s*(?:persone|persona|pers|pax|coperti|adulti|bambini|ospiti|posti)\b/g, ' ')
    .replace(/\b(?:siamo|saremo)\s+(?:in\s+)?\d{1,2}\b(?!\s*[:.,]\s*\d)/g, ' ')
    .replace(/\bin\s+\d{1,2}\b(?!\s*[:.,]\s*\d)/g, ' ');
}
// { ore, minuti, conMinuti } dell'orario scritto nel testo, o null.
function oraNelTesto(testo) {
  const t = senzaDateNePersone(normalizza(testo));
  // La virgola vale solo attaccata («20,30»): in «per 2, 20:30» il «2, 20»
  // sarebbero le 2:20.
  const m = t.match(new RegExp(`\\b${PAROLE_DELL_ORA}\\s*(\\d{1,2})(?:(?:\\s*[:.]\\s*|,|\\s*)(\\d{2}))?\\b`))
    || t.match(/\b(\d{1,2})(?:\s*[:.]\s*|,)(\d{2})\b/)
    || t.match(/\b(\d{1,2})(?:\s*[:.]\s*|,|\s*)(\d{2})?\b/);
  if (!m) return null;
  const ore = +m[1];
  const minuti = m[2] ? +m[2] : 0;
  if (ore > 23 || minuti > 59) return null;
  return { ore, minuti, conMinuti: !!m[2] };
}

// Un orario: 21:30 · 21.30 · 2130 · 21
// L'orario come l'ha SCRITTO il cliente: «21» → { scritto: '21', ore: 21 },
// «21.15» → { scritto: '21:15', ore: 21, minuti: 15 }. null se non c'è un orario.
function oraScritta(testo) {
  const o = oraNelTesto(testo);
  if (!o) return null;
  return { ...o,
           scritto: o.conMinuti ? `${String(o.ore).padStart(2, '0')}:${String(o.minuti).padStart(2, '0')}` : String(o.ore) };
}

// Un messaggio che dice un orario e basta: «20.30», «alle 20:30», «facciamo
// alle 21?», «possiamo arrivare alle 20.30». Serve un orario vero — coi
// minuti o dopo «alle»/«ore»: «20» da solo può essere anche venti persone —
// e, tolte l'ora e le parole di contorno, non deve restare niente. Un giorno
// («domani alle 20.30») resta, e allora non è solo un orario.
const CONTORNO_DELL_ORA = /\b(?:ok|okay|va bene|grazie|si|allora|facciamo|meglio|magari|possiamo|posso|si puo|puo|fare|arrivare|venire|arriviamo|arrivo|arriveremo|veniamo|verremo|anticipare|anticipiamo|posticipare|posticipiamo|invece|piuttosto|anzi|no|perfetto|ma|se|ci|e|possibile|ciao|buongiorno|buonasera|scusa|scusate|scusi|per favore|per cortesia|verso|circa)\b/g;
function soloUnOrario(testo) {
  const t = normalizza(testo);
  const conMinuti = /\b\d{1,2}\s*[:.]\s*\d{2}\b/;
  const dopoParola = new RegExp(`\\b${PAROLE_DELL_ORA}\\s*\\d{1,2}(?:(?:\\s*[:.]\\s*|,)\\d{2})?\\b`, 'g');
  if (!conMinuti.test(t) && !dopoParola.test(t)) return false;
  const resto = t.replace(dopoParola, ' ').replace(/\b\d{1,2}\s*[:.]\s*\d{2}\b/g, ' ')
    .replace(/[^a-z\s]/g, ' ').replace(CONTORNO_DELL_ORA, ' ').replace(/\s+/g, ' ').trim();
  return !resto;
}

function interpretaOra(testo, turni) {
  const t = normalizza(testo);
  if (!t) return null;

  // Anche qui niente scorciatoia sul numero di riga: gli orari non sono piu'
  // numerati, e leggere «2» come «la seconda riga» significava confermare un
  // turno che il cliente non aveva chiesto, in silenzio. Meglio richiedere.
  // Le date e le persone della frase non sono l'ora (vedi «oraNelTesto»).
  const o = oraNelTesto(t);
  if (!o) return null;
  const { ore, minuti: min } = o;
  const scritto = `${String(ore).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  if (turni.includes(scritto)) return scritto;
  // Ha scritto un orario che non è un turno: se ce n'è UNO solo che comincia con
  // quell'ora lo si usa, altrimenti non si indovina.
  const vicini = turni.filter((x) => x.startsWith(String(ore).padStart(2, '0') + ':'));
  if (vicini.length === 1) return vicini[0];
  // «alle 8» vuol dire le 20:00: in italiano l'ora di cena si dice quasi sempre
  // così. Vale solo se UN turno solo corrisponde, come sopra: mai indovinare.
  if (ore >= 1 && ore <= 11 && !o.conMinuti) {
    const pomeriggio = turni.filter((x) => x.startsWith(String(ore + 12).padStart(2, '0') + ':'));
    if (pomeriggio.length === 1) return pomeriggio[0];
  }
  return null;
}

// I saluti. Sono la prima cosa che scrive chiunque, e mandarli a una persona
// vuol dire disturbare il responsabile di sala per un «ciao»: il bot diventa
// subito un fastidio invece di un aiuto. Vanno riconosciuti di serie, senza
// che il ristoratore debba impostare niente.
const SALUTI = [
  'ciao', 'ciao ciao', 'salve', 'buongiorno', 'buon giorno', 'buondi', 'buondì',
  'buonasera', 'buona sera', 'buon pomeriggio', 'buonanotte', 'buona notte',
  'hey', 'ehi', 'hola', 'ehilà', 'ehila', 'salvex',
];
// Parole di cortesia che spesso accompagnano il saluto e non cambiano il senso
const CORTESIA = /\b(grazie|per favore|per cortesia|scusi|scusa|scusate|gentilmente|senta|senti|buon|a tutti|ragazzi)\b/g;

// Un cenno del capo: «ok», «va bene», «perfetto», «grazie». Non è una
// richiesta e non è un equivoco — è quello che si scrive quando si è letto e
// non serve altro.
//
// ⚠️ Serve perché il ricordino («hai già una prenotazione, scrivi CAMBIA,
// CANCELLA o NUOVA») è una frase a cui viene naturale rispondere «ok». Senza
// questo, quell'«ok» faceva ripetere il ricordino identico, e un secondo cenno
// girava la conversazione a una persona: il cliente si ritrovava un operatore
// addosso per aver detto che andava bene.
const DACCORDO = [
  'ok', 'okay', 'oki', 'okey', 'va bene', 'vabene', 'vabbe', 'vabbè', 'va benissimo',
  'perfetto', 'certo', 'certamente', 'daccordo', 'd accordo', 'capito', 'ho capito',
  'bene', 'ottimo', 'chiaro', 'si', 'sì', 'tutto ok', 'nulla', 'niente altro',
];

function eSoloDaccordo(testo) {
  let t = normalizza(testo).replace(/[!?.,;:😊😀🙂👋🙏❤️👍✅]/gu, ' ');
  if (!t) return false;
  // Le parole più lunghe per prime: togliendo «bene» da «va bene» resterebbe
  // un «va» orfano, e la frase non risulterebbe più un cenno.
  for (const p of [...DACCORDO].sort((a, b) => b.length - a.length)) {
    t = t.replace(new RegExp(`(^|\\s)${p}(?=\\s|$)`, 'g'), ' ');
  }
  t = t.replace(CORTESIA, ' ').replace(/\s+/g, ' ').trim();
  return t === '' && normalizza(testo) !== '';
}

// Vero solo se il messaggio è UN SALUTO E BASTA. «Ciao, avete il parcheggio?»
// non è un saluto: è una domanda, e va trattata come tale.
function eSaluto(testo) {
  let t = normalizza(testo).replace(/[!?.,;:😊😀🙂👋🙏❤️]/gu, ' ');
  if (!t) return false;
  // Il controllo di fine parola è una PREVISIONE e non un consumo: con
  // `(\s|$)` lo spazio veniva mangiato dalla prima corrispondenza e la seconda
  // non scattava più — «ciao ciao» restava mezzo pieno e non risultava un saluto.
  for (const s of SALUTI) t = t.replace(new RegExp(`(^|\\s)${s}(?=\\s|$)`, 'g'), ' ');
  t = t.replace(CORTESIA, ' ').replace(/\s+/g, ' ').trim();
  return t === '' && normalizza(testo) !== '';
}

// Quanto dista una parola da un'altra, contando anche le lettere INVERTITE
// come un solo errore. Non è un dettaglio da manuale: «cioa» e «slave» sono
// esattamente questo — due dita che arrivano nell'ordine sbagliato su una
// tastiera del telefono — e sono i due sbagli visti per primi in prova.
// Contandoli come due errori (come fa il conto classico) resterebbero fuori
// proprio i casi più comuni.
function distanzaParole(a, b, massimo = 1) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > massimo) return massimo + 1;
  const righe = [];
  for (let i = 0; i <= a.length; i++) righe.push(new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) righe[i][0] = i;
  for (let j = 0; j <= b.length; j++) righe[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const costo = a[i - 1] === b[j - 1] ? 0 : 1;
      righe[i][j] = Math.min(righe[i - 1][j] + 1, righe[i][j - 1] + 1, righe[i - 1][j - 1] + costo);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        righe[i][j] = Math.min(righe[i][j], righe[i - 2][j - 2] + 1);   // due lettere invertite
      }
    }
  }
  return righe[a.length][b.length];
}

// Un saluto scritto storto. Vale SOLO per il primo messaggio, e il motivo è
// tutto qui: lì l'unico danno di uno sbaglio è che il bot saluta e chiede per
// quante persone. Alla domanda sul nome no — «Salvi» e «Salvo» sono cognomi
// veri, e scambiarli per un «salve» vorrebbe dire buttare via il nome di chi
// sta prenotando. Per questo è una funzione a parte e non un `eSaluto` più
// largo: la stessa tolleranza che qui aiuta, là farebbe danni.
function eSalutoStorto(testo) {
  if (eSaluto(testo)) return true;
  const pulito = normalizza(testo)
    .replace(/[!?.,;:😊😀🙂👋🙏❤️]/gu, ' ')
    .replace(/(.)\1{2,}/g, '$1')       // «ciaooo» → «ciao»: l'entusiasmo non è uno sbaglio
    .replace(/\s+/g, ' ')
    .trim();
  if (!pulito) return false;
  const parole = pulito.split(' ');
  if (parole.length > 3) return false;   // una frase lunga non è un saluto storto: è una frase
  return parole.every((parola) => {
    CORTESIA.lastIndex = 0;
    if (CORTESIA.test(parola)) { CORTESIA.lastIndex = 0; return true; }
    CORTESIA.lastIndex = 0;
    if (SALUTI.includes(parola)) return true;
    // Sotto le quattro lettere una lettera sbagliata cambia troppe cose:
    // «hey» diventerebbe «lei», «bel», «hai». Lì si preferisce non capire.
    if (parola.length < 4) return false;
    return SALUTI.some((s) => s.length >= 4 && distanzaParole(parola, s) <= 1);
  });
}

// Buongiorno o buonasera secondo l'ora vera: un bot che dice «buonasera» alle
// dieci del mattino si riconosce subito per quello che è.
// ⚠️ Il nome entra nel SALUTO, non in un segnaposto nuovo: così «Buonasera»
// diventa «Buonasera Marco» in tutte le frasi che già usano {saluto}, comprese
// quelle che un ristorante si è riscritto a modo suo. Un segnaposto nuovo
// avrebbe funzionato solo per chi non ha mai toccato niente.
function salutoOra(adesso = new Date()) {
  return adesso.getHours() < 14 ? 'Buongiorno' : 'Buonasera';
}

// Divide quello che il cliente scrive in nome e cognome.
//
// Con una parola sola NON si indovina quale sia: al ristorante «a nome Rossi»
// è la cosa più normale del mondo, e infilare «Rossi» nella casella del nome
// di battesimo produrrebbe rubriche piene di cognomi spacciati per nomi.
// Una parola sola resta il nome della prenotazione, e basta.
// Quasi nessuno risponde «Mario Rossi» e basta: si risponde «Certo, Mario
// Rossi», «sì sono Mario Rossi», «mi chiamo Mario Rossi». Prendendo la prima
// parola, in tabella finiva un signor «Certo» — e il cliente si sentiva
// chiamare così all'arrivo.
//
// Si tolgono solo formule di cortesia e presentazioni: nessuna di queste è un
// nome italiano, e quello che resta viene lasciato intatto.
//
// ⚠️ Il confine di parola «\b» qui NON si può usare: in JavaScript vale solo
// per le lettere inglesi, e dopo una vocale accentata («sì», «è») non scatta.
// «Sì Mario Rossi» restava con il «Sì» attaccato. Si guarda invece che dopo
// venga uno spazio, un segno di punteggiatura o la fine della frase — che
// protegge anche i nomi veri: «Perla» non comincia con «per» seguito da spazio.
const FINE_PAROLA = '(?=$|[\\s,.:;!?-])';
const CORTESIE_NOME = new RegExp('^(?:si|sì|certo|certamente|ok|okay|va bene|'
  + 'perfetto|allora|dunque|ecco(?:lo|la)?|grazie|prego|volentieri|come no|'
  + "senz'altro|buonasera|buongiorno|salve|ciao|beh|be)" + FINE_PAROLA + '[\\s,.:;!?-]*', 'i');
// Le stesse cortesie, ma alla FINE: «Cristoforo Colombo certo!».
//
// ⚠️ Qui si va molto più cauti che all'inizio, perché diverse di queste parole
// sono COGNOMI VERI: Prego, Ok, Bene, Certo. Toglierne uno a chi si chiama così
// vuol dire storpiargli il nome per sempre, in rubrica e in sala.
// Quindi si tolgono solo:
//   • le cortesie di più parole, che cognomi non sono («per favore», «va bene»);
//   • le parole singole SOLO se chiuse da punteggiatura — «Colombo Certo!» è
//     una cortesia, «Salvatore Prego» è un signor Prego.
const CORTESIE_IN_FONDO = new RegExp(
  '[\\s,]*\\b(?:'
  + '(?:per favore|per cortesia|va bene|come no|senz\'altro|grazie mille|grazie)[\\s,.:;!?]*'
  + '|(?:si|sì|certo|certamente|ok|okay|perfetto|prego|volentieri|esatto|giusto)[,.:;!?]+[\\s]*'
  + ')$', 'i');

const PRESENTAZIONI_NOME = new RegExp('^(?:(?:io )?sono|mi chiamo|il mio nome (?:è|e)|'
  + 'il nome (?:è|e)|a nome(?: di)?|per|met(?:ti|tila|tilo) a nome(?: di)?|'
  + 'segna(?:la)?(?: a nome)?(?: di)?)' + FINE_PAROLA + '[\\s,.:;-]*', 'i');

function ripulisciNome(testo) {
  let t = String(testo || '').replace(/\s+/g, ' ').trim();
  // Si tolgono a giro finché ce n'è: «certo, sono Mario Rossi» ne ha due.
  for (let giro = 0; giro < 4; giro++) {
    const prima = t;
    t = t.replace(CORTESIE_NOME, '').replace(PRESENTAZIONI_NOME, '').trim();
    if (t === prima) break;
  }
  // ⚠️ Le stesse cortesie stanno anche IN FONDO: «Cristoforo Colombo certo!»
  // finiva in rubrica e negli elenchi della sala con quel «Certo!» attaccato al
  // cognome. Si tolgono solo se resta qualcosa: «certo» da solo è già stato
  // tolto sopra, e in quel caso il nome si richiede.
  for (let giro = 0; giro < 3; giro++) {
    const senzaCoda = t.replace(CORTESIE_IN_FONDO, '').trim();
    if (!senzaCoda || senzaCoda === t) break;
    t = senzaCoda;
  }
  t = t.replace(/^[\s,.:;-]+|[\s,.:;!?]+$/g, '').trim();
  // Se togliendo le cortesie non resta niente, la risposta ERA solo cortesia:
  // meglio richiedere il nome che segnarne uno inventato.
  return t;
}

// I titoli: «Don Franco», «Ing. Muto», «Dott.ssa Bianchi». Un titolo non è un
// nome: diviso come gli altri diventava nome «Don.» e cognome «Franco», e il
// bot avrebbe salutato «Che bello rivederti, Don.!» (dai clienti veri di RO
// WORLD, 23 ottobre 2026). Il titolo resta attaccato a quello che segue, tutto
// nel nome, scritto per bene: così il saluto, la sala («Ing. Muto», non «Muto
// Ing.») e la rubrica dicono la stessa cosa.
const TITOLI = {
  don: 'Don', dott: 'Dott.', dottssa: 'Dott.ssa', dottor: 'Dottor', dottore: 'Dottore', dottoressa: 'Dottoressa',
  dr: 'Dr.', ing: 'Ing.', avv: 'Avv.', prof: 'Prof.', profssa: 'Prof.ssa', professor: 'Professor',
  professore: 'Professore', professoressa: 'Professoressa', sig: 'Sig.', sigra: 'Sig.ra', signor: 'Signor',
  signora: 'Signora', arch: 'Arch.', geom: 'Geom.', rag: 'Rag.', mons: 'Mons.', padre: 'Padre', suor: 'Suor',
  cav: 'Cav.', comm: 'Comm.',
};
const chiaveTitolo = (parola) => String(parola || '').toLowerCase().replace(/[.\s]/g, '');
function nomeConTitolo(nome, cognome) {
  const n = String(nome || '').trim().replace(/\s+/g, ' ');
  const c = String(cognome || '').trim().replace(/\s+/g, ' ');
  const [primo, ...resto] = n.split(' ');
  const titolo = TITOLI[chiaveTitolo(primo)];
  const dopo = [...resto, c].filter(Boolean).join(' ');
  // «Don» da solo non ha niente a cui attaccarsi: resta com'è.
  if (!titolo || !dopo) return { nome: n, cognome: c };
  return { nome: `${titolo} ${dopo}`, cognome: '' };
}

function dividiNome(testo) {
  const pulito = ripulisciNome(testo).slice(0, 80);
  if (!pulito) return { nome: '', cognome: '' };
  const pezzi = pulito.split(' ');
  if (pezzi.length === 1) return { nome: pezzi[0], cognome: '' };
  return nomeConTitolo(pezzi[0], pezzi.slice(1).join(' '));
}

// Un numero di telefono scritto da una persona: con o senza prefisso, con
// spazi, punti o trattini. Sotto le 8 cifre non è un numero — è un civico, un
// orario o un errore di battitura, e prenderlo per buono significa dare al
// locale un contatto che non risponde.
function interpretaTelefono(testo) {
  const t = normalizza(testo).replace(/[^\d+]/g, '');
  const cifre = t.replace(/\D/g, '');
  if (cifre.length < 8 || cifre.length > 15) return null;
  return cifre;
}

const SI = new RegExp('^(si|s|sì|ok|okay|va bene|confermo|certo|perfetto|yes|👍|✅'
  // ⚠️ Queste tre cominciano per «no» e vogliono dire il contrario. Senza,
  // chi rispondeva «nessun problema» al riepilogo si vedeva rifiutare il
  // tavolo. Stanno nel SÌ perché il sì si legge per primo.
  + "|no problem|no problema|nessun problema|non c'?e problema|non ci sono problemi)\\b");
// ⚠️ «non» da solo NON sta più qui, ed è il guasto più caro che questo file
// abbia avuto. Bastava che il messaggio COMINCIASSE per «non» perché venisse
// letto come un rifiuto. Due danni veri, tutti e due silenziosi:
//   «non mangiamo carne»  → alla domanda sulle allergie, nota BUTTATA
//   «non vedo l'ora!»     → al riepilogo, prenotazione RIFIUTATA
// Chi scriveva quelle parole era entusiasta o stava segnalando un'allergia, e
// si è sentito rispondere che non era stata segnata nessuna prenotazione.
// Adesso «non» vale come no solo nelle frasi in cui nega DAVVERO, qui sotto.
const NO = /^(no|n|annulla|lascia|niente|no grazie)\b/;
const NON_CHE_NEGA = new RegExp('^non\\s+(va bene|mi va|mi sta bene|confermo'
  + '|voglio|posso|riesco|serve|mi serve|importa|piu)\\b');

function interpretaSiNo(testo) {
  const t = normalizza(testo);
  if (SI.test(t)) return true;
  if (NO.test(t) || NON_CHE_NEGA.test(t)) return false;
  return null;
}

// ---------------------------------------------------------------------------
//  «Niente da segnalare», alla domanda sulle allergie
// ---------------------------------------------------------------------------
//  ⚠️ Lì la domanda NON è una domanda da sì o no: è «dimmi qualcosa». Usarci un
//  lettore di sì/no era l'errore di fondo, e buttava via note vere:
//
//      «niente glutine per favore»      → letto NO, nota persa
//      «no, ma abbiamo un passeggino»   → letto NO, nota persa
//      «non ho allergie ma mia moglie è celiaca» → letto NO, CELIACA PERSA
//
//  La regola giusta è una sola: un no vale **solo se il messaggio è soltanto
//  quello**. Se dentro c'è dell'altro, quell'altro è la nota — sempre. Meglio
//  una nota inutile in più («no grazie» scritto sulla riga) che un'allergia in
//  meno: la prima la legge chi è in sala e sorride, la seconda manda qualcuno
//  al pronto soccorso.
const SOLO_UN_NO = new RegExp('^(no+|n|nope|negativo|nada|niente|nulla|nessuno|nessuna|nessun'
  + '|annulla|annullare|lascia|lascia stare|lascia perdere|no no|assolutamente no'
  + '|direi di no|meglio di no|per niente|tutto ok|tutto a posto|tutto bene|a posto'
  + '|nessun problema|no problem|no problema)$');
const NON_SOLO_UN_NO = new RegExp('^non\\s+(ho|abbiamo|c\'?e|ci sono)\\s+'
  + '(nulla|niente|allergie|intolleranze|esigenze|preferenze|richieste|problemi'
  + '|allergie particolari|esigenze particolari|richieste particolari)$');

// ⚠️ Il danno peggiore che questo programma possa fare è promettere qualcosa
// al posto del ristorante. «Si può avere una torta?» seguito da «OK, grazie» è
// un sì che il locale non ha mai dato: quel cliente si presenta aspettandosi la
// torta e in cucina non ne sanno niente.
//
// ⚠️ La prima versione cercava un «?» o un'apertura da domanda, e l'ha mancato
// al primo colpo su una chat vera: «ho bisogno di una torta» non ha né l'uno né
// l'altra, ed è una richiesta a tutti gli effetti. La lezione è che la
// distinzione fra «ti INFORMO» (allergia alle noci) e «ti CHIEDO» (una torta)
// non si riconosce in modo affidabile — quindi non ci si appoggia per decidere
// cosa dire al cliente. Vedi il passo «note»: la frase è la stessa per tutti e
// non conferma mai niente. Questa serve solo a decidere se AVVISARE il locale,
// dove un falso positivo costa una notifica e un falso negativo costa un
// cliente che aspetta una risposta che non arriverà mai.
const INIZI_DI_RICHIESTA = new RegExp("^(si puo|si riesce|posso|possiamo|potete|puoi|potreste"
  + "|e possibile|sarebbe possibile|avete|fate|c'?e modo|ci sarebbe|vorrei|volevo|vorremmo"
  + "|volevamo|mi sapete dire|si fa in tempo|ho bisogno|abbiamo bisogno|avrei bisogno"
  + "|avremmo bisogno|mi serve|ci serve|mi servirebbe|ci servirebbe|serve|servirebbe"
  + "|mi piacerebbe|ci piacerebbe|riuscite|riuscireste|preparate|potreste preparare"
  + "|chiedo|chiederei|chiediamo|per favore|gradirei|gradiremmo|desidero|desidererei)\\b");

// Un elenco scritto in un campo: virgole o a capo, uno vale l'altro. Le voci
// vuote si buttano, i doppioni pure.
function elencoParole(valore) {
  const viste = new Set();
  for (const pezzo of String(valore || '').split(/[,\n;]/)) {
    const parola = normalizza(pezzo);
    if (parola) viste.add(parola);
  }
  return [...viste];
}

// ⚠️ Queste due liste stanno in un'IMPOSTAZIONE, non nel codice. Le parole che
// contano cambiano da locale a locale — una pasticceria vive di torte, un
// agriturismo di seggioloni e passeggini, chi fa banchetti di preventivi — e
// fin qui per aggiungerne una serviva una versione nuova. Il confronto è per
// pezzo di parola, così «torta» prende anche «una torta al cioccolato».
function coseDaChiedere(cfg) {
  return elencoParole((cfg || PREDEFINITI).bot_parole_richiesta);
}

// ⚠️ Solo le aperture che rendono la frase una DOMANDA SU ALTRO. Volutamente
// più stretta di INIZI_DI_RICHIESTA: lì dentro c'è «vorrei», che quasi sempre
// apre una prenotazione («vorrei per sabato sera»), e qui manderebbe a una
// persona proprio chi voleva un tavolo.
const APERTURE_DI_DOMANDA = new RegExp("^(e |ma |scusa |scusate |senti |buongiorno |buonasera )*"
  + "(possibile|si puo|si riesce|posso|possiamo|potete|puoi|potreste|avete|fate|accettate"
  + "|c'?e |ci sono|quanto|quando|dove|come|quale|quali|per caso|sapete|mi sapete)\\b");

function eUnaRichiesta(testo, cfg) {
  const t = String(testo || '');
  if (t.includes('?')) return true;
  const n = normalizza(t);
  if (INIZI_DI_RICHIESTA.test(n)) return true;
  return coseDaChiedere(cfg).some((parola) => n.includes(parola));
}

function soloUnNo(testo, cfg) {
  const t = normalizza(testo)
    .replace(/[!?.,;:…]/g, ' ')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
    .replace(/\b(grazie|mille|per favore|per cortesia|comunque)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return false;
  if (SOLO_UN_NO.test(t) || NON_SOLO_UN_NO.test(t)) return true;
  // ⚠️ Queste si AGGIUNGONO a quelle incorporate, non le sostituiscono: un
  // campo svuotato per sbaglio non deve far finire «no» sulla riga delle
  // allergie di ogni prenotazione. Il confronto è esatto — la frase deve essere
  // SOLO quella — perché è la stessa regola che vale per «no» e «nessuna».
  return elencoParole((cfg || PREDEFINITI).bot_parole_nessuna).includes(t);
}

// ⚠️ «Non sono io» al riepilogo. Il nome l'abbiamo messo noi riconoscendo il
// numero, e il caso vero è il telefono di casa: il figlio prenota per la madre.
// Deve poterlo correggere senza perdere persone, giorno e ora.
//
// ⚠️ Si guarda la FORMA, non una parola sola: «per» da solo comparirebbe in
// mezzo a troppe frasi normali. E si esclude «per 4» e simili, che al riepilogo
// è gente che sta correggendo il numero di persone, non il nome.
const NON_SONO_IO = new RegExp(
  '(^|\\s)('
  + 'non sono io|non (?:e|è) per me|non e per me|'
  + 'non mi chiamo|nome sbagliato|il nome (?:e|è) sbagliato|'
  + '(?:e|è) per (?!\\d)|a nome (?:di )?|prenoto per (?!\\d)|(?:e|è) a nome'
  + ')'
);

function nonSonoIo(testo, cfg) {
  const t = normalizza(testo);
  if (!t) return false;
  if (NON_SONO_IO.test(t)) return true;
  // ⚠️ Queste si AGGIUNGONO a quelle incorporate, non le sostituiscono: un
  // campo svuotato per sbaglio non deve togliere al cliente l'unica via per
  // correggere un nome sbagliato.
  return elencoParole((cfg || PREDEFINITI).bot_parole_altro_nome).includes(t);
}

// Alla domanda sul numero dell'altra persona: chi non lo sa, o non vuole
// darlo, lo dice in questi modi. Non è un numero storto, e non va contato
// come un equivoco.
function nonCeLHa(testo) {
  return /^(non (ce )?l ?ho|non lo so|non so|non ce l ?ho|salta|lascia( stare| perdere)?|nessuno|niente)\b/
    .test(normalizza(testo).replace(/'/g, ' '));
}

// Il nome dentro la stessa frase: «a nome di Anna Bianchi», «è per Marco».
// ⚠️ Solo da forme ESPLICITE. Indovinarlo da una frase qualunque vorrebbe dire
// scrivere sul foglio della sala una parola presa a caso — e un nome sbagliato
// è peggio di una domanda in più. Se non è chiaro, si chiede.
function nomeDentro(testo) {
  const m = String(testo || '').match(
    /(?:a nome(?:\s+di)?|è per|e per|prenoto per)\s+([A-Za-zÀ-ÿ'’]{2,}(?:\s+[A-Za-zÀ-ÿ'’]{2,})?)/i);
  if (!m) return null;
  // «mia madre», «un amico» non sono nomi: sono parentele. Il nome, se c'è,
  // viene dopo — e se non c'è si chiede, che è il comportamento giusto.
  const NON_NOMI = /^(mia|mio|miei|mie|un|una|il|lo|la|i|gli|le|nostro|nostra|sua|suo)\b/i;
  if (NON_NOMI.test(m[1].trim())) return null;
  const { nome, cognome } = dividiNome(m[1].trim());
  return nome ? { nome, cognome } : null;
}

// ---------------------------------------------------------------------------
//  Disponibilità
// ---------------------------------------------------------------------------

// ⚠️ Gli orari dei turni li scrive una persona in un campo di testo, e quel
// campo accettava qualunque cosa: «25:99» finiva davvero fra gli orari
// proposti al cliente, «20:00, 20:00» compariva due volte nella tendina, e un
// «2:0» (che quasi sempre vuol dire 20:00) diventava un turno delle due e un
// minuto. Qui si tiene solo quello che è un'ora vera, una volta sola.
function turniValidi(testo) {
  const buoni = [];
  for (const pezzo of String(testo || '').split(',')) {
    const m = pezzo.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m || +m[1] > 23 || +m[2] > 59) continue;
    const ora = `${String(+m[1]).padStart(2, '0')}:${m[2]}`;
    if (!buoni.includes(ora)) buoni.push(ora);
  }
  return buoni;
}

// ---------------------------------------------------------------------------
//  Le fasce orarie
// ---------------------------------------------------------------------------
//  Prima gli orari erano tre o quattro turni fissi, uguali per tutti i giorni
//  aperti: il sabato non poteva fare orari diversi dal martedì, e un pranzo
//  della domenica voleva dire un pranzo tutti i giorni. Adesso ogni giorno ha
//  le sue fasce — «12:30–14:00» e «19:30–22:00» — e il bot propone un orario
//  ogni `bot_passo` minuti dentro ciascuna.
//
//  ⚠️ Una fascia è dal PRIMO all'ULTIMO ARRIVO, non dall'apertura alla
//  chiusura. «Chiudiamo alle 23» con tavoli da due ore vorrebbe dire ultimo
//  arrivo alle 21, ma più d'uno l'avrebbe scritto pensando alle 22:30: un conto
//  nascosto fatto dal programma è un orario che il locale non riconosce. Qui
//  si scrive l'ora che si vuole veder proporre, e il bot propone quella.

// Il più delle volte ne basta una per servizio; i turni fissi però sono una
// fascia per turno, e quattro turni a pranzo e quattro a cena fanno otto. Il
// tetto c'è solo perché un elenco senza fondo, in una pagina, non è un elenco.
const FASCE_PER_GIORNO = 16;

// ⚠️ Ogni fascia è di un SERVIZIO, pranzo o cena. Il locale lo sceglie nella
// pagina (le due righe di ogni giorno), e quello vale. Quando non c'è scritto
// — i turni di prima, o fasce salvate prima che esistesse — si ricava
// dall'ora: prima delle 17 è pranzo. Serve al bot per dividere gli orari nel
// messaggio («Pranzo: … / Cena: …») e per capire «a pranzo» e «a cena».
const SERVIZI = ['pranzo', 'cena'];
const INIZIO_CENA = 17 * 60;

function servizioPerOrario(hhmm) {
  return inMinuti(hhmm) < INIZIO_CENA ? 'pranzo' : 'cena';
}

// ⚠️ Il passo NON si imposta più. C'era una tendina «proponi un orario ogni…»
// in cima agli orari, e il titolare l'ha fatta togliere: stava da sola,
// staccata da tutto, e contraddiceva il modo in cui il locale lavora — a turni,
// ognuno con l'orario scritto da lui. Resta solo per due cose che non si
// scrivono più ma possono esserci: le fasce «dalle… alle…» salvate prima, e i
// turni di prima delle fasce (vedi `fasceDaiTurni`, che resta esatto con
// qualunque passo).
const PASSO_FISSO = 30;
function passoDi() {
  return PASSO_FISSO;
}

function daMinuti(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
// Mezzanotte (dal titolare, 24 ottobre 2026): al cliente si dice «00:00».
// Dentro resta 23:59, l'ultimo minuto del giorno: con «la fine viene dopo
// l'inizio» funziona in ogni conto, e i turni salvati così non cambiano.
// Chi scrive 00:00 (o 24:00) come FINE intende quello, non un turno che
// finisce prima di cominciare: prima la fascia spariva in silenzio.
const MEZZANOTTE = '23:59';
const oraDetta = (hhmm) => (hhmm === MEZZANOTTE ? '00:00' : hhmm);
function fineDellaFascia(da, a) {
  const fine = String(a == null ? '' : a).trim();
  const inizio = turniValidi(da)[0];
  return /^(?:0?0:00|24:00)$/.test(fine) && inizio && inizio !== '00:00' ? MEZZANOTTE : a;
}

// Le fasce ripulite: ore vere, l'ultimo arrivo non prima del primo, niente
// doppioni, in ordine. `null` vuol dire «non ci sono fasce salvate» — che non
// è la stessa cosa di «tutti i giorni chiusi», che è un oggetto con sette
// elenchi vuoti.
function fasceValide(valore) {
  let grezze = valore;
  if (typeof grezze === 'string') {
    if (!grezze.trim()) return null;
    try { grezze = JSON.parse(grezze); } catch { return null; }
  }
  if (!grezze || typeof grezze !== 'object' || Array.isArray(grezze)) return null;
  const fasce = {};
  for (let g = 0; g < 7; g++) {
    const buone = [];
    for (const f of Array.isArray(grezze[g]) ? grezze[g] : []) {
      if (!f || typeof f !== 'object') continue;
      const [da] = turniValidi(f.da);
      const [a] = turniValidi(fineDellaFascia(f.da, f.a));
      if (!da || !a || inMinuti(a) < inMinuti(da)) continue;
      const servizio = SERVIZI.includes(f.servizio) ? f.servizio : servizioPerOrario(da);
      // Un turno ha un inizio e una fine: il cliente arriva all'inizio, il
      // tavolo è suo fino alla fine. (I turni salvati prima avevano solo
      // l'inizio: `da` uguale ad `a`, e la fine la decide `fineDelTavolo`.)
      const turno = f.turno === true;
      const uguale = buone.find((x) => x.da === da && x.a === a && x.servizio === servizio);
      if (uguale) { if (turno) uguale.turno = true; continue; }
      // Due turni dello stesso servizio che cominciano alla stessa ora sono
      // uno solo: il cliente arriva a quell'ora, e non si saprebbe in quale.
      if (turno && buone.some((x) => x.turno && x.servizio === servizio && x.da === da)) continue;
      buone.push(turno ? { da, a, servizio, turno } : { da, a, servizio });
    }
    buone.sort((x, y) => inMinuti(x.da) - inMinuti(y.da));
    fasce[g] = buone.slice(0, FASCE_PER_GIORNO);
  }
  return fasce;
}

// Le fasce di un locale che non le ha ancora impostate, ricavate dai turni di
// prima. ⚠️ Devono dare GLI STESSI ORARI di prima, uno per uno: i turni che
// distano esattamente un passo diventano una fascia sola, gli altri restano
// fasce di un orario. «19:30, 20:00, 21:30» col passo di 30 diventa
// «19:30–20:00» e «21:30»: le 20:30 e le 21:00, che prima non c'erano, non
// compaiono da sole dopo un aggiornamento.
function fasceDaiTurni(cfg) {
  const aperti = String(cfg.bot_giorni).split(',').map((x) => parseInt(x, 10));
  const passo = passoDi(cfg);
  // Il servizio c'era già, nei due campi di prima: «turni del pranzo» e
  // «turni della cena». Si tiene quello.
  const corse = [];
  for (const [servizio, testo] of [['pranzo', cfg.bot_turni_pranzo], ['cena', cfg.bot_turni_cena]]) {
    let ultima = null;
    for (const o of turniValidi(testo).sort()) {
      if (ultima && inMinuti(o) - inMinuti(ultima.a) === passo) ultima.a = o;
      else { ultima = { da: o, a: o, servizio }; corse.push(ultima); }
    }
  }
  const fasce = {};
  for (let g = 0; g < 7; g++) fasce[g] = aperti.includes(g) ? corse.map((c) => ({ ...c })) : [];
  return fasce;
}

function fasceDi(cfg) {
  return fasceValide(cfg.bot_fasce) || fasceDaiTurni(cfg);
}

// ---- Gli orari da prenotare (dal titolare, 27 ottobre 2026) ----
// «Devo decidere io: lunedì metto disponibile lo slot 20, 20:30, 21, 21:30»,
// e «il vincolo è quello in mezzo»: gli orari d'apertura (le fasce) restano
// il limite. Per un giorno e un servizio con degli orari scelti, il bot
// propone QUELLI (tutti quelli con un tavolo), non i turni; i turni restano
// a dire quando il locale apre e chiude. Senza orari scelti, a turni come
// prima. Un orario fuori dall'apertura non vale (anche se le fasce cambiano
// dopo): lo toglie `slotDelGiorno`, non chi li salva.
function slotValidi(valore) {
  let grezzi = valore;
  if (typeof grezzi === 'string') {
    if (!grezzi.trim()) return {};
    try { grezzi = JSON.parse(grezzi); } catch { return null; }
  }
  if (!grezzi || typeof grezzi !== 'object' || Array.isArray(grezzi)) return null;
  const puliti = {};
  for (let g = 0; g < 7; g++) {
    const giorno = grezzi[g];
    if (!giorno || typeof giorno !== 'object') continue;
    for (const s of SERVIZI) {
      const orari = [...new Set((Array.isArray(giorno[s]) ? giorno[s] : []).flatMap((o) => turniValidi(o)))].sort().slice(0, 48);
      if (orari.length) (puliti[g] = puliti[g] || {})[s] = orari;
    }
  }
  return puliti;
}
// Letti una volta sola per testo: `fasceDelGiorno` passa di qui a ogni
// prenotazione guardata.
let slotLetti = { testo: null, valore: {} };
function slotDi(cfg) {
  const testo = String(cfg.bot_slot || '');
  if (slotLetti.testo !== testo) slotLetti = { testo, valore: slotValidi(testo) || {} };
  return slotLetti.valore;
}
// Gli orari scelti di quel giorno, per servizio, SOLO dentro l'apertura: dal
// primo inizio alla fine del servizio, la fine esclusa (a quell'ora si chiude).
// {} se quel giorno si lavora a turni.
function slotDelGiorno(cfg, iso) {
  const [a, m, g] = String(iso).split('-').map(Number);
  const giorno = new Date(a, m - 1, g).getDay();
  const scelti = slotDi(cfg)[giorno];
  if (!scelti) return {};
  const fasce = fasceDi(cfg)[giorno] || [];
  const durata = Math.max(num(cfg.bot_durata_tavolo, 120), 1);
  const esito = {};
  for (const s of SERVIZI) {
    const sue = fasce.filter((f) => f.servizio === s);
    if (!sue.length || !(scelti[s] || []).length) continue;
    const apre = Math.min(...sue.map((f) => inMinuti(f.da)));
    // Un turno di prima senza fine chiude dopo la durata del tavolo.
    const chiude = Math.max(...sue.map((f) => (inMinuti(f.a) > inMinuti(f.da) ? inMinuti(f.a) : inMinuti(f.da) + durata)));
    const dentro = scelti[s].filter((o) => inMinuti(o) >= apre && inMinuti(o) < chiude);
    if (dentro.length) esito[s] = dentro;
  }
  return esito;
}

// Gli orari di una fascia. L'ultimo arrivo c'è SEMPRE, anche quando non cade
// su un passo: è l'ora che il locale ha scritto, e toglierla vorrebbe dire
// chiudere prima di quando ha detto.
function orariDellaFascia(f, passo) {
  // Un turno si propone solo al suo inizio: «19:30 → 21:00» vuol dire che si
  // arriva alle 19:30, non ogni mezz'ora fino alle 21.
  if (f.turno) return [f.da];
  const fine = inMinuti(f.a);
  const orari = [];
  for (let m = inMinuti(f.da); m <= fine; m += passo) orari.push(daMinuti(m));
  if (orari[orari.length - 1] !== f.a) orari.push(f.a);
  return orari;
}

// Di che servizio è un orario di quel giorno: quello della fascia che lo
// contiene, e se nessuna lo contiene (un orario scritto a mano, fuori dalle
// fasce) quello dell'ora.
function fasceDelGiorno(cfg, iso) {
  const [a, m, g] = String(iso).split('-').map(Number);
  const fasce = fasceDi(cfg)[new Date(a, m - 1, g).getDay()] || [];
  // Le fasce di un servizio a orari scelti portano il segno `slot`: lì dicono
  // solo quando si apre e si chiude (vedi `fineDelTavolo`, `numeroDelTurno`).
  const slot = slotDelGiorno(cfg, iso);
  return Object.keys(slot).length ? fasce.map((f) => (slot[f.servizio] ? { ...f, slot: true } : f)) : fasce;
}

function servizioDellOra(cfg, iso, ora) {
  const minuti = inMinuti(ora);
  const f = fasceDelGiorno(cfg, iso).find((x) => inMinuti(x.da) <= minuti && minuti <= inMinuti(x.a));
  return f ? f.servizio : servizioPerOrario(ora);
}

// Che turno è quell'orario: 1, 2… se il suo servizio quel giorno è a turni
// fissi, null se è a orari continui (lì non ci sono «turni» da numerare).
function numeroDelTurno(cfg, iso, ora) {
  const fasce = fasceDelGiorno(cfg, iso);
  const servizio = servizioDellOra(cfg, iso, ora);
  const sue = fasce.filter((f) => f.servizio === servizio);
  // A orari scelti non ci sono turni da numerare, anche se le fasce lo sono.
  if (!sue.length || !sue.every((f) => f.turno) || sue.some((f) => f.slot)) return null;
  const i = sue.map((f) => f.da).sort().indexOf(ora);
  return i < 0 ? null : i + 1;
}

// Fin quando tiene il tavolo chi arriva a quell'ora, in minuti dalla
// mezzanotte di quel giorno.
//
// ⚠️ Con i TURNI decide il turno, non la durata: chi prenota un turno tiene il
// tavolo fino alla FINE del turno, scritta dal titolare («19:30 → 21:00»).
// I turni salvati prima che avessero una fine ce l'hanno implicita: chi
// prenota il primo turno tiene il tavolo fino a quando comincia il secondo, e da lì il tavolo è
// di nuovo prenotabile. È il modo in cui lavora un locale a turni: con primo
// turno alle 19:30 e secondo alle 21:00, il tavolo delle 19:30 si rivende alle
// 21:00 anche se la «durata del tavolo» è di due ore. L'ultimo turno di un
// servizio — dopo di lui non c'è un altro turno — tiene il tavolo per la durata.
//
// Tutto il resto (orari continui, i turni di prima delle fasce, un orario
// scritto a mano) tiene il tavolo per la durata, come sempre. I turni di prima
// NON diventano turni fissi da soli: «19:30, 20:00, 21:30» trattati così
// libererebbero alle 20:00 il tavolo delle 19:30.
function fineDelTavolo(cfg, fasceGiorno, ora) {
  const durata = Math.max(num(cfg.bot_durata_tavolo, 120), 1);
  const inizio = inMinuti(ora);
  // A orari scelti (vedi `slotDelGiorno`): il tavolo per la durata, ma mai
  // oltre la chiusura del servizio — deciso col titolare, 27 ottobre 2026.
  // ⚠️ Si passa di qui per ogni prenotazione guardata: il conto si fa solo se
  // quel giorno ha davvero orari scelti (la prova di carico lo misura).
  if (fasceGiorno.some((x) => x.slot)) {
    const contiene = fasceGiorno.find((x) => inMinuti(x.da) <= inizio && inizio <= inMinuti(x.a));
    const servizio = contiene ? contiene.servizio : servizioPerOrario(ora);
    const delServizio = fasceGiorno.filter((x) => x.servizio === servizio);
    if (delServizio.some((x) => x.slot)) {
      const chiude = Math.max(...delServizio.map((x) => inMinuti(x.a)));
      return chiude > inizio ? Math.min(inizio + durata, chiude) : inizio + durata;
    }
  }
  const turno = fasceGiorno.find((x) => x.turno && inMinuti(x.da) === inizio);
  if (!turno) return inizio + durata;
  // Il turno con la sua fine scritta: il tavolo è suo fino a lì, né prima né
  // dopo. È il caso normale da quando ogni turno ha inizio e fine.
  if (inMinuti(turno.a) > inizio) return inMinuti(turno.a);
  const dopo = fasceGiorno
    .filter((x) => x.turno && x.servizio === turno.servizio && inMinuti(x.da) > inizio)
    .map((x) => inMinuti(x.da));
  return dopo.length ? Math.min(...dopo) : inizio + durata;
}

function turniDelGiorno(cfg, iso) {
  const passo = passoDi(cfg);
  // Un servizio a orari scelti propone quelli; gli altri i loro turni.
  const slot = slotDelGiorno(cfg, iso);
  const tutti = fasceDelGiorno(cfg, iso).filter((f) => !f.slot).flatMap((f) => orariDellaFascia(f, passo))
    .concat(...Object.values(slot));
  // Due fasce che si toccano danno lo stesso orario due volte: è uno solo.
  return [...new Set(tutti)].sort();
}

function inMinuti(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

// Quante volte, in quel giorno, la sala si può riempire da capo. È il numero
// contro cui si misura quanto è piena una giornata.
//
// ⚠️ Prima si moltiplicavano i coperti per il NUMERO DI TURNI, e già con
// «19:30, 20:00, 21:30» il conto era gonfio: chi arriva alle 19:30 e chi alle
// 20:00 non si siedono sugli stessi posti uno dopo l'altro, li occupano
// insieme. Con le fasce — un orario ogni mezz'ora — quel conto sarebbe
// diventato assurdo: sei «turni» da 40 fanno 240 coperti in una sera da 80, e
// il planning avrebbe mostrato mezzo vuota una sala piena. Qui si conta
// quante volte un tavolo si può davvero liberare e rioccupare.
function giriDelGiorno(cfg, iso) {
  const fasce = fasceDelGiorno(cfg, iso);
  let giri = 0;
  let libero = -Infinity;
  for (const t of turniDelGiorno(cfg, iso)) {
    const m = inMinuti(t);
    if (m >= libero) { giri += 1; libero = fineDelTavolo(cfg, fasce, t); }
  }
  return giri;
}

// Coperti già impegnati che si sovrappongono al turno richiesto.
// La durata del tavolo è il motivo per cui questo non è una semplice somma per
// orario: un tavolo delle 19:30 con durata 120 è ancora occupato alle 20:00 ma
// libero alle 21:30. Senza questo conto il locale perderebbe il secondo giro.
// `escludiId` serve a chi sta SPOSTANDO una prenotazione: la sua vecchia riga
// non deve contare contro di lui. Senza, spostare dalle 20:00 alle 21:00 con
// tavoli da due ore lo faceva scontrare col proprio stesso tavolo — e il posto
// risultava occupato da se stesso.
function copertiOccupati(db, cfg, iso, ora, escludiId) {
  return prenotazioniSovrapposte(db, cfg, iso, ora, escludiId).reduce((n, r) => n + r.persone, 0);
}

// Le prenotazioni ancora vive che, a quell'ora, sono sedute (o lo saranno).
// È la domanda che stava dentro `copertiOccupati`, tirata fuori perché adesso
// la fanno in due: chi conta i coperti e chi cerca un tavolo libero.
function prenotazioniSovrapposte(db, cfg, iso, ora, escludiId) {
  // ⚠️ Durata zero (o negativa) NON vuol dire «nessun limite»: con quella, la
  // formula della sovrapposizione non trovava nemmeno un tavolo con SE STESSO,
  // e il locale risultava vuoto sempre — il bot avrebbe accettato prenotazioni
  // all'infinito su ogni turno. Un minuto è il minimo che tiene in piedi il
  // significato: il tavolo occupa almeno il suo orario.
  //
  // Quanto dura, lo dice `fineDelTavolo`: la durata, o il turno dopo.
  const ieri = giornoPrima(iso);
  const fasceOggi = fasceDelGiorno(cfg, iso);
  const fasceIeri = fasceDelGiorno(cfg, ieri);
  const inizio = inMinuti(ora);
  const fine = fineDelTavolo(cfg, fasceOggi, ora);
  // ⚠️ Solo la sala di sempre: chi ha prenotato un altro locale (il bistrot
  // del 25 ottobre) ha i suoi coperti, e non toglie posto ai tavoli di qui.
  const righeDel = (data) => db.prepare(
    'SELECT id, ora, persone, tavolo FROM prenotazioni WHERE data = ? AND fuori_sala = 0 AND stato IN ' + dentro(STATI_VIVI)
  ).all(data);
  const siSovrappone = (scarto, fasce) => (r) => {
    if (escludiId && r.id === escludiId) return false;
    const i = inMinuti(r.ora) - scarto;
    const f = fineDelTavolo(cfg, fasce, r.ora) - scarto;
    return i < fine && f > inizio;
  };
  // ⚠️ E il tavolo che scavalca la mezzanotte: alle 23:30 con due ore di
  // durata si alza all'una e mezza, cioè occupa un turno dell'una del giorno
  // DOPO. Contando solo le righe della data richiesta quel tavolo spariva, e
  // in una notte di Capodanno lo stesso posto veniva promesso due volte.
  return [
    ...righeDel(iso).filter(siSovrappone(0, fasceOggi)),
    ...righeDel(ieri).filter(siSovrappone(1440, fasceIeri)),
  ];
}

// Un anno avanti è il limite oltre il quale una prenotazione non è più una
// prenotazione: è un appunto. Il locale potrebbe non esserci, gli orari saranno
// altri, e nessuno sfoglierà cinquantadue settimane per accorgersene.
const GIORNI_ORIZZONTE = 365;

function oltreLOrizzonte(iso, adesso = new Date()) {
  const [a, m, g] = String(iso).split('-').map(Number);
  const quando = new Date(a, m - 1, g, 12, 0, 0);
  const oggi = new Date(adesso.getFullYear(), adesso.getMonth(), adesso.getDate(), 12, 0, 0);
  return (quando - oggi) / 86400000 > GIORNI_ORIZZONTE;
}

// Il giorno prima, sempre a mezzogiorno per non farsi spostare dal fuso.
function giornoPrima(iso) {
  const [a, m, g] = String(iso).split('-').map(Number);
  const d = new Date(a, m - 1, g, 12, 0, 0);
  d.setDate(d.getDate() - 1);
  return d.toLocaleDateString('sv-SE');
}

function postiLiberi(db, cfg, iso, ora, escludiId) {
  const capienza = num(cfg.bot_coperti_turno, 40) - num(cfg.bot_coperti_liberi, 0);
  return capienza - copertiOccupati(db, cfg, iso, ora, escludiId);
}

// ---------------------------------------------------------------------------
//  I tavoli
// ---------------------------------------------------------------------------
//  Contare solo i coperti sbaglia in due direzioni. Dice SÌ quando non c'è
//  posto: venti coppie fanno quaranta coperti, ma se i tavoli sono dodici otto
//  coppie restano in piedi. E dice sì a un gruppo che non si può sedere: sei
//  persone con soli tavoli da quattro, e il bot vede «34 posti liberi».
//
//  Con i tavoli la domanda cambia: non più «quanti coperti restano?», ma
//  «c'è un tavolo libero abbastanza grande per QUESTO gruppo?». E le regole
//  sono tre:
//
//   1. Una prenotazione, un tavolo. Due prenotazioni non dividono mai lo
//      stesso tavolo nello stesso momento, anche se di posti ce ne sarebbero:
//      una coppia a un tavolo da quattro lascia due sedie vuote, ed è giusto.
//   2. Il tavolo più piccolo che basta. Una coppia prende un tavolo da due se
//      c'è, poi da quattro, e quello da otto solo se non è rimasto altro: dato
//      alla prima coppia che scrive, lascerebbe fuori il gruppo da sette che
//      arriva dopo. Darlo comunque quando è l'ultimo è meglio che rifiutare.
//   3. Un tavolo è occupato per la durata del tavolo, come prima i coperti: il
//      T4 delle 19:30 con due ore di durata torna libero per le 21:30.
//
//  I tavoli «solo sala» il bot non li dà mai: sono per chi entra senza
//  prenotare. La sala e la piattaforma sì — sono persone che vedono il locale.
//
//  ⚠️ Senza nessun tavolo elencato si conta a coperti come sempre. Un locale
//  che si aggiorna non deve trovarsi il bot che rifiuta tutti perché un
//  elenco che non ha mai compilato è vuoto.

// I tavoli si uniscono a mano, in sala: al bot non si chiede. Dodici è il più
// grande tavolo vero che si prenota da soli; oltre, è un gruppo che vuole
// parlare con qualcuno.
const POSTI_MASSIMI_TAVOLO = 12;

// Il nome del tavolo è anche quello che la sala scrive a mano nella riga della
// prenotazione: «T4», «t4 » e «T4» devono essere lo stesso tavolo.
function chiaveTavolo(nome) {
  return String(nome === null || nome === undefined ? '' : nome).replace(/\s+/g, ' ').trim().toLowerCase();
}

function tavoliDi(db) {
  return db.prepare('SELECT * FROM bot_tavoli ORDER BY ordine, id').all();
}

function usaTavoli(db) {
  return !!db.prepare('SELECT 1 FROM bot_tavoli LIMIT 1').get();
}

// Il più piccolo prima; a pari posti quello col minimo più basso, poi uno
// prenotabile prima di uno della sala, poi l'ordine in cui il locale li ha
// elencati.
function perMisura(x, y) {
  return x.posti - y.posti || minimoDi(x) - minimoDi(y) || x.solo_sala - y.solo_sala
    || x.ordine - y.ordine || x.id - y.id;
}

// ── Il minimo di un tavolo ──
//
// Deciso dal titolare: ogni tavolo è «da 2 a 4», «da 6 a 10». Sotto il minimo
// il tavolo è troppo grande: una coppia non va al tavolo da 6–10 nemmeno se è
// l'ultimo libero — quello serve al gruppo che arriva dopo.
//
// ⚠️ Con UNA eccezione, scelta da lui: se nessun tavolo del locale copre quel
// numero (5 persone, coi tavoli da 2–4 e da 6–10), il minimo non vale e il
// gruppo va al più piccolo in cui ci sta. Sennò un gruppo da 5 non
// troverebbe posto mai, in un locale mezzo vuoto.
function minimoDi(t) { return Math.max(1, Number(t.posti_min) || 1); }
function giustoPer(t, persone) { return minimoDi(t) <= persone && persone <= t.posti; }
function adattoA(t, persone, tavoli) {
  if (t.posti < persone) return false;
  if (minimoDi(t) <= persone) return true;
  return !tavoli.some((x) => giustoPer(x, persone));
}

// I coperti della sala: la somma dei tavoli, o il numero di prima se di
// tavoli non ce ne sono.
function capienzaDi(db, cfg) {
  const tavoli = tavoliDi(db);
  if (tavoli.length) return tavoli.reduce((n, t) => n + t.posti, 0);
  return num(cfg.bot_coperti_turno, 0);
}

// Chi tiene quale tavolo, a quell'ora. Restituisce id tavolo → id prenotazione.
//
// ⚠️ Non tutte le prenotazioni hanno un tavolo che si riconosce: quelle di
// prima dei tavoli, una scritta a mano «terrazza», un tavolo tolto
// dall'elenco, due prenotazioni che la sala ha messo per sbaglio sullo stesso
// numero. Quelle persone a cena vengono lo stesso, quindi si siedono da
// qualche parte: le si mette al tavolo più piccolo che basta fra quelli
// rimasti, dalla più grande alla più piccola. Ignorarle vorrebbe dire
// promettere a un altro il tavolo su cui stanno mangiando.
function occupazioneTavoli(db, cfg, iso, ora, escludiId, tavoli = tavoliDi(db)) {
  const presi = new Map();
  const perNome = new Map(tavoli.map((t) => [chiaveTavolo(t.nome), t]));
  const senza = [];
  // La più vecchia tiene il tavolo: è quella che l'aveva per prima.
  const righe = prenotazioniSovrapposte(db, cfg, iso, ora, escludiId).sort((x, y) => x.id - y.id);
  for (const r of righe) {
    const t = perNome.get(chiaveTavolo(r.tavolo));
    if (t && !presi.has(t.id)) presi.set(t.id, r.id);
    else senza.push(r);
  }
  senza.sort((x, y) => y.persone - x.persone || x.id - y.id);
  for (const r of senza) {
    const liberi = tavoli.filter((t) => !presi.has(t.id));
    // Prima un tavolo della misura giusta; ma la prenotazione c'è già, e
    // quelle persone si siedono comunque: se non resta che uno più grande del
    // suo minimo, nei conti va lì.
    const uno = liberi.filter((t) => adattoA(t, r.persone, tavoli)).sort(perMisura)[0]
      || liberi.filter((t) => t.posti >= r.persone).sort(perMisura)[0];
    if (uno) { presi.set(uno.id, r.id); continue; }
    // Più grande di ogni tavolo libero: in sala li hanno uniti. Si tolgono i
    // più grandi finché ci stanno tutti.
    let restano = r.persone;
    for (const t of liberi.sort((x, y) => y.posti - x.posti)) {
      if (restano <= 0) break;
      presi.set(t.id, r.id);
      restano -= t.posti;
    }
  }
  return presi;
}

// ⚠️ Il bot NON scrive il numero del tavolo sulle prenotazioni. Deciso dal
// titolare: i tavoli gli servono per CONTARE — se un gruppo ci sta, senza mai
// due prenotazioni sullo stesso tavolo — ma il numero lo assegna l'operatore,
// prima della serata, guardando la sala. Le prenotazioni senza numero il bot
// le siede nei suoi conti al tavolo più piccolo che basta (`occupazioneTavoli`),
// quindi non promette mai un posto che non c'è. In sala un avviso dice quante
// ne mancano (`daAssegnare`).
//
// Il tavolo scritto dall'operatore, invece, si rispetta: spostando una
// prenotazione resta suo se all'ora nuova è ancora libero (`tavoloCheResta`).
function tavoloCheResta(db, cfg, iso, ora, attuale, escludiId) {
  if (!chiaveTavolo(attuale)) return '';
  return chiTieneIlTavolo(db, cfg, iso, ora, attuale, escludiId) ? '' : attuale;
}

// Le prenotazioni di un giorno che aspettano ancora il numero del tavolo:
// senza, o con un nome che fra i tavoli non c'è (un tavolo tolto, scritto
// male). Vuoto se il locale non ha elencato i tavoli: lì il numero non serve
// a contare, e un avviso su una cosa che nessuno ha chiesto è rumore.
function daAssegnare(db, iso) {
  const tavoli = tavoliDi(db);
  if (!tavoli.length) return { senza: [], sconosciuti: [] };
  const nomi = new Set(tavoli.map((t) => chiaveTavolo(t.nome)));
  // Chi è in un altro locale un tavolo di qui non ce l'ha, e non lo aspetta.
  const vive = db.prepare('SELECT * FROM prenotazioni WHERE data = ? AND fuori_sala = 0 AND stato IN ' + dentro(STATI_VIVI)
    + ' ORDER BY ora, id').all(iso);
  return {
    senza: vive.filter((r) => !chiaveTavolo(r.tavolo)),
    sconosciuti: vive.filter((r) => chiaveTavolo(r.tavolo) && !nomi.has(chiaveTavolo(r.tavolo))),
  };
}

// Il tavolo per un gruppo, o null se non ce n'è uno libero abbastanza grande.
//
// `opzioni.ancheSala`: conta anche i tavoli «solo sala» (chi prenota è una
//   persona del locale, non il bot).
// `opzioni.escludiId`: la prenotazione che si sta spostando non occupa se stessa.
// `opzioni.preferito`: il tavolo che ha già. Se va ancora bene lo tiene — la
//   sala ha un piano della serata, e cambiarle i tavoli sotto i piedi per un
//   minuto spostato è peggio di un tavolo un po' più grande del necessario.
function trovaTavolo(db, cfg, iso, ora, persone, opzioni = {}) {
  const tavoli = tavoliDi(db);
  const presi = occupazioneTavoli(db, cfg, iso, ora, opzioni.escludiId, tavoli);
  const buoni = tavoli.filter((t) => !presi.has(t.id) && adattoA(t, persone, tavoli)
    && (opzioni.ancheSala || !t.solo_sala));
  if (!buoni.length) return null;
  const preferito = chiaveTavolo(opzioni.preferito);
  return (preferito && buoni.find((t) => chiaveTavolo(t.nome) === preferito)) || buoni.sort(perMisura)[0];
}

// C'è posto per questo gruppo, a quell'ora? E se ci sono i tavoli, quale.
//
// `tavolo` è null quando il locale conta a coperti: vuol dire «non toccare il
// campo», che resta quello che la sala ci ha scritto.
function postoPer(db, cfg, iso, ora, persone, opzioni = {}) {
  if (!usaTavoli(db)) {
    return { ok: postiLiberi(db, cfg, iso, ora, opzioni.escludiId) >= persone, tavolo: null };
  }
  const t = trovaTavolo(db, cfg, iso, ora, persone, opzioni);
  return { ok: !!t, tavolo: t ? t.nome : null };
}

function ciStanno(db, cfg, iso, ora, persone, opzioni = {}) {
  return postoPer(db, cfg, iso, ora, persone, opzioni).ok;
}

// Il gruppo più grande che, a quell'ora, si può ancora sedere: il tavolo
// libero più grande. Serve alle tendine «quante persone».
function gruppoMassimo(db, cfg, iso, ora, opzioni = {}) {
  const tavoli = tavoliDi(db);
  const presi = occupazioneTavoli(db, cfg, iso, ora, opzioni.escludiId, tavoli);
  return tavoli.filter((t) => !presi.has(t.id) && (opzioni.ancheSala || !t.solo_sala))
    .reduce((m, t) => Math.max(m, t.posti), 0);
}

function tavoliLiberi(db, cfg, iso, ora, opzioni = {}) {
  const tavoli = tavoliDi(db);
  const presi = occupazioneTavoli(db, cfg, iso, ora, opzioni.escludiId, tavoli);
  return tavoli.filter((t) => !presi.has(t.id) && (opzioni.ancheSala || !t.solo_sala));
}

// Chi ha già quel tavolo a quell'ora, se qualcuno ce l'ha. Per la sala, che lo
// scrive a mano: due gruppi allo stesso tavolo si scoprono quando arriva il
// secondo, ed è il momento peggiore per scoprirlo.
// Com'è messa una giornata, per chi la guarda: una riga per TURNO (turni
// fissi) o per SERVIZIO (orari continui) — mai una per ogni mezz'ora.
//
// ⚠️ Visto dal titolare nel pannello: con gli orari continui la scheda «Oggi»
// scriveva quindici righe uguali, «12:30 0/52 coperti», «13:00 0/52
// coperti»… fino alle 23:00. Un elenco così non si legge, e non dice la cosa
// che serve: quanto è pieno il pranzo, quanto la cena.
//
// Con i tavoli si contano i TAVOLI: due sedie vuote al tavolo di una coppia
// non sono vendibili, e un turno coi tavoli tutti presi è pieno anche a metà
// coperti — è così che lo vede il bot. I coperti restano scritti: alla cucina
// servono.
//
// Ogni riga: { servizio, etichetta, testo, pieno, occupati, totale, coperti,
//              tipo, turno, orario, unita } — `etichetta` e `testo` per chi
// legge una riga di testo (WhatsApp, la scheda «Oggi»), il resto per chi la
// disegna (le schede per turno del servizio del giorno).
//   tipo: 'turno' (turni), 'orario' (un orario solo dei turni di prima),
//         'servizio' (orari continui di prima: il momento più pieno),
//         'chiuso' (servizio chiuso, ma con gente prenotata).
//   unita: 'tavoli' o 'coperti' — di cosa sono `occupati` e `totale`.
function riepilogoDelGiorno(db, cfg, iso) {
  // Gli altri locali di quel giorno (il bistrot del 25 ottobre): una scheda
  // ciascuno, coi SUOI coperti. In fondo al loro servizio: pranzo prima di cena.
  const altri = localiDi(cfg).altri.filter((a) => a.data === iso).map((a) => {
    const presi = a.coperti - postiAltroLocale(db, a);
    const pieno = presi >= a.coperti;
    return { servizio: servizioPerOrario(a.da), etichetta: `${a.nome} ${a.da}–${oraDetta(a.a)}`,
             testo: `${presi}/${a.coperti} coperti${pieno ? ' · pieno' : ''}`,
             pieno, occupati: presi, totale: a.coperti, coperti: presi, senzaTavolo: 0,
             tipo: 'locale', turno: null, titolo: a.nome, orario: `${a.da}–${oraDetta(a.a)}`, unita: 'coperti' };
  });
  // Con un altro locale lo stesso giorno, le schede della sala dicono di chi
  // sono: «REAR Restaurant · 1° turno» accanto a «RO bistrot».
  const principale = altri.length ? localiDi(cfg).principale : null;
  const sala = riepilogoDellaSala(db, cfg, iso)
    .map((r) => (principale ? { ...r, locale: principale.nome, etichetta: `${principale.nome} · ${r.etichetta}` } : r));
  return [...sala, ...altri]
    .map((r, i) => [r, i]).sort((x, y) => SERVIZI.indexOf(x[0].servizio) - SERVIZI.indexOf(y[0].servizio) || x[1] - y[1])
    .map(([r]) => r);
}
function riepilogoDellaSala(db, cfg, iso) {
  const fasce = fasceDelGiorno(cfg, iso);
  const tavoli = tavoliDi(db);
  const conTavoli = tavoli.length > 0;
  const totale = conTavoli ? tavoli.length : capienzaDi(db, cfg);
  const passo = passoDi(cfg);
  const vive = db.prepare('SELECT ora, persone, tavolo FROM prenotazioni WHERE data = ? AND fuori_sala = 0 AND stato IN ' + dentro(STATI_VIVI)).all(iso);
  // Quante aspettano ancora il numero del tavolo (vedi `daAssegnare`).
  const nomi = new Set(tavoli.map((x) => chiaveTavolo(x.nome)));
  const senzaTavolo = (lista) => (conTavoli ? lista.filter((r) => !nomi.has(chiaveTavolo(r.tavolo))).length : 0);
  const occupatiAlle = (ora) => (conTavoli
    ? occupazioneTavoli(db, cfg, iso, ora, null, tavoli).size
    : copertiOccupati(db, cfg, iso, ora));
  const misura = (occupati) => (conTavoli ? `${occupati}/${totale} tavoli` : `${occupati}/${totale}`);
  const cop = (n) => `${n} ${n === 1 ? 'coperto' : 'coperti'}`;
  const NOMI = { pranzo: 'Pranzo', cena: 'Cena' };
  const righe = [];
  for (const servizio of SERVIZI) {
    const sue = fasce.filter((f) => f.servizio === servizio);
    const delServizio = vive.filter((r) => servizioDellOra(cfg, iso, r.ora) === servizio);
    const coperti = delServizio.reduce((n, r) => n + r.persone, 0);
    if (!sue.length) {
      // ⚠️ Chiuso, ma con gente dentro: è il caso che spariva. Si dice.
      if (delServizio.length) {
        righe.push({ servizio, etichetta: `${NOMI[servizio]} (chiuso)`, testo: `⚠️ ${cop(coperti)} prenotati`,
                     pieno: false, occupati: 0, totale, coperti, senzaTavolo: senzaTavolo(delServizio),
                     tipo: 'chiuso', turno: null, orario: '', unita: conTavoli ? 'tavoli' : 'coperti' });
      }
      continue;
    }
    // A orari scelti (vedi `slotDelGiorno`): una scheda per orario, come i
    // turni di prima — niente «1° turno», anche se l'orario cade sull'inizio
    // di un turno.
    const aOrari = sue.some((f) => f.slot);
    const orari = aOrari ? (slotDelGiorno(cfg, iso)[servizio] || [])
      : [...new Set(sue.flatMap((f) => orariDellaFascia(f, passo)))].sort();
    // Orari singoli — i turni fissi, e anche i turni di prima come «20:00,
    // 22:00», che erano due giri di sala — si leggono uno per riga. Solo i
    // turni fissi si chiamano «1° turno».
    if (aOrari || sue.every((f) => f.turno || f.da === f.a)) {
      orari.forEach((o, i) => {
        // Al turno va chi arriva da quell'ora fino al turno dopo: un orario
        // scritto a mano a metà fra due turni sta in quello cominciato.
        const fino = orari[i + 1] ? inMinuti(orari[i + 1]) : Infinity;
        const loro = delServizio.filter((r) => (i === 0 || inMinuti(r.ora) >= inMinuti(o)) && inMinuti(r.ora) < fino);
        const coperti = loro.reduce((n, r) => n + r.persone, 0);
        const occupati = occupatiAlle(o);
        const pieno = occupati >= totale;
        const fissa = aOrari ? null : sue.find((f) => f.da === o);
        const fascia = fissa && fissa.turno && fissa.a !== fissa.da ? `${o}–${oraDetta(fissa.a)}` : o;
        // Il numero solo se i turni sono più di uno (vedi `turnoDellOra`).
        const numerato = fissa && fissa.turno && orari.length > 1;
        righe.push({ servizio, etichetta: `${NOMI[servizio]} ${numerato ? `· ${i + 1}° turno ` : ''}${fascia}`,
                     testo: conTavoli ? `${misura(occupati)} · ${cop(coperti)}${pieno ? ' · pieno' : ''}`
                       : `${misura(occupati)} coperti${pieno ? ' · pieno' : ''}`,
                     pieno, occupati, totale, coperti, senzaTavolo: senzaTavolo(loro),
                     tipo: fissa && fissa.turno ? 'turno' : 'orario', turno: numerato ? i + 1 : null,
                     orario: fascia, unita: conTavoli ? 'tavoli' : 'coperti' });
      });
    } else {
      // Orari continui: il momento più pieno del servizio, perché è lì che
      // il bot comincia a dire di no.
      // ⚠️ Chi è seduto NELLO STESSO MOMENTO, non chi darebbe fastidio a un
      // nuovo arrivo di quell'ora: quella è la domanda del bot, e conta anche
      // chi arriverà fra un'ora. Con le 20:00 e le 22:00 — mai sedute insieme —
      // la riga diceva «al massimo 6 insieme». (Trovato dalla sua prova.) Il
      // momento più pieno cade sempre su un arrivo: si guardano quelli.
      const seduti = (t) => vive.filter((r) => inMinuti(r.ora) <= t && t < fineDelTavolo(cfg, fasce, r.ora));
      const picco = delServizio.reduce((m, r) => {
        const insieme = seduti(inMinuti(r.ora));
        return Math.max(m, conTavoli ? insieme.length : insieme.reduce((n, x) => n + x.persone, 0));
      }, 0);
      const pieno = picco >= totale;
      righe.push({ servizio, etichetta: `${NOMI[servizio]} ${orari[0]}${orari.length > 1 ? `–${orari[orari.length - 1]}` : ''}`,
                   testo: !delServizio.length ? 'nessuna prenotazione'
                     : `${cop(coperti)} · al massimo ${misura(picco)} insieme${pieno ? ' · pieno' : ''}`,
                   pieno, occupati: picco, totale, coperti, senzaTavolo: senzaTavolo(delServizio),
                   tipo: 'servizio', turno: null,
                   orario: `${orari[0]}${orari.length > 1 ? `–${orari[orari.length - 1]}` : ''}`,
                   unita: conTavoli ? 'tavoli' : 'coperti' });
    }
  }
  return righe;
}

function chiTieneIlTavolo(db, cfg, iso, ora, nome, escludiId) {
  const chiave = chiaveTavolo(nome);
  if (!chiave) return null;
  const r = prenotazioniSovrapposte(db, cfg, iso, ora, escludiId)
    .find((x) => chiaveTavolo(x.tavolo) === chiave);
  return r ? db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(r.id) : null;
}

// Per la tendina della sala: i tavoli che, all'ora di questa prenotazione,
// hanno già il numero scritto su un'ALTRA, e di chi sono. Solo quelli scritti:
// le prenotazioni senza numero un tavolo non ce l'hanno ancora — è proprio
// quello che la sala sta assegnando — e dirle «sedute» al tavolo che il bot
// ha immaginato per i suoi conti farebbe sembrare occupati tavoli liberi.
function tavoliPresiPer(db, cfg, p, tavoli = tavoliDi(db)) {
  const perNome = new Map(tavoli.map((t) => [chiaveTavolo(t.nome), t]));
  const presi = new Map();
  // La più vecchia tiene il tavolo, come in `occupazioneTavoli`.
  for (const r of prenotazioniSovrapposte(db, cfg, p.data, p.ora, p.id).sort((x, y) => x.id - y.id)) {
    const t = perNome.get(chiaveTavolo(r.tavolo));
    if (!t || presi.has(t.id)) continue;
    const chi = db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(r.id);
    presi.set(t.id, { nome: t.nome, di: nomeInSala(chi), ora: r.ora, persone: r.persone });
  }
  return [...presi.values()];
}

// Il gruppo più grande che il bot prende da solo. Con i tavoli è anche il
// tavolo prenotabile più grande: un gruppo che non entra in nessun tavolo il
// bot lo cercherebbe giorno dopo giorno senza trovarlo mai, e alla fine
// direbbe «siamo pieni» a chi invece andava passato a una persona — l'unica
// che può decidere di unire due tavoli.
function personeMassimeBot(db, cfg) {
  const max = num(cfg.bot_max_persone, 8);
  const tavoli = tavoliDi(db);
  if (!tavoli.length) return max;
  return Math.min(max, tavoli.filter((t) => !t.solo_sala).reduce((m, t) => Math.max(m, t.posti), 0));
}

// Il giorno è bloccato? E per quale dei due motivi?
//
// ⚠️ Le tre funzioni non sono una sola con un parametro perché rispondono a
// tre domande diverse, e confonderle è già costato: chi decide se PROPORRE un
// giorno deve sapere solo che è bloccato; chi sceglie la FRASE da mandare al
// cliente deve sapere quale dei due motivi, o dirà «siamo chiusi» a chi ha
// trovato il locale pieno.
function giornoBloccato(db, iso) {
  return db.prepare('SELECT data, tipo, motivo FROM bot_chiusure WHERE data = ?').get(iso) || null;
}

// Bloccato per qualunque motivo: è questo che toglie il giorno dalle proposte.
function eBloccato(db, iso) {
  return !!giornoBloccato(db, iso);
}

// Chiuso davvero. Il sold out NON è una chiusura: il locale c'è, i posti no.
function eChiuso(db, iso) {
  const r = giornoBloccato(db, iso);
  return !!r && r.tipo !== 'pieno';
}

function ePieno(db, iso) {
  const r = giornoBloccato(db, iso);
  return !!r && r.tipo === 'pieno';
}

// I giorni segnati pieni, dall'oggi in avanti. I passati non si mostrano e non
// si cancellano da soli: restano in archivio come traccia di com'è andata.
function giorniPieni(db, adesso = new Date()) {
  return db.prepare("SELECT data FROM bot_chiusure WHERE tipo = 'pieno' AND data >= ? ORDER BY data")
    .all(comeData(adesso)).map((r) => r.data);
}

function segnaPieno(db, iso) {
  db.prepare("INSERT INTO bot_chiusure (data, tipo, motivo) VALUES (?, 'pieno', '') "
    + "ON CONFLICT(data) DO UPDATE SET tipo = 'pieno'").run(iso);
}

// ⚠️ Si toglie SOLO se era un sold out. Una chiusura per ferie non deve
// sparire perché qualcuno ha scritto «sold out no» sul giorno sbagliato.
function togliPieno(db, iso) {
  return db.prepare("DELETE FROM bot_chiusure WHERE data = ? AND tipo = 'pieno'").run(iso).changes > 0;
}

// I turni di quel giorno dove ci stanno `persone`, già filtrati per preavviso.
//
// `opzioni.escludiId` toglie dal conto una prenotazione (chi sta spostando la
// propria). `opzioni.senzaPreavviso` salta l'anticipo minimo: chi ha GIÀ un
// tavolo e vuole solo spostarlo di un turno non è come chi prenota all'ultimo
// momento — il locale lo aspettava comunque.
function turniDisponibili(db, cfg, iso, persone, adesso, opzioni = {}) {
  if (eBloccato(db, iso)) return [];
  // Con un'esperienza scelta valgono solo gli orari del servizio in cui vale
  // quel giorno: il business lunch non si propone il sabato sera.
  const turni = turniAmmessi(cfg, iso, opzioni.esperienza, turniDelGiorno(cfg, iso));
  if (!turni.length) return [];
  const oggi = comeData(adesso);
  const preavviso = opzioni.senzaPreavviso ? 0 : num(cfg.bot_preavviso_ore, 2) * 60;
  const adessoMin = adesso.getHours() * 60 + adesso.getMinutes();
  return turni.filter((t) => {
    // Un turno già cominciato non si propone mai, nemmeno spostando: si può
    // arrivare dieci minuti prima delle 20:00, non alle 20:30 per le 20:00.
    if (iso === oggi && inMinuti(t) < adessoMin) return false;
    if (iso === oggi && inMinuti(t) - adessoMin < preavviso) return false;
    return ciStanno(db, cfg, iso, t, persone, { escludiId: opzioni.escludiId });
  });
}

// ⚠️ Il cliente chiede un orario che il locale fa davvero, ma che non gli è
// stato proposto perché è pieno. `interpretaOra` guarda solo gli orari
// PROPOSTI, quindi restituiva «non ho capito» — e il bot partiva con la
// procedura degli equivoci, che alla seconda volta lo passa a una persona.
// Ma il bot ha capito benissimo: la risposta è «no», non «come, scusa?».
// Dire «non ho capito» a chi si è spiegato bene è il modo più veloce per
// far pensare che dall'altra parte non ci sia nessuno.
function oraNonProposta(db, cfg, dati, testo) {
  if (!dati.data) return null;
  const ora = interpretaOra(testo, turniDelGiorno(cfg, dati.data));
  if (!ora || (dati.turni || []).includes(ora)) return null;
  // Un orario in cui l'esperienza scelta non vale non è «pieno» né «troppo
  // tardi»: è un turno che per lui non c'è, e lo dice `oraSenzaTurno`.
  if (dati.esperienza && !ammessoPer(cfg, esperienzaDi(cfg, dati.esperienza), dati.data, ora)) return null;
  // Pieno e «troppo tardi» sono due no diversi, e al cliente servono distinti:
  // sul primo può scegliere un altro orario, sul secondo un altro giorno.
  return { ora, pieno: !ciStanno(db, cfg, dati.data, ora, dati.persone, { escludiId: dati.id }) };
}

// I prossimi giorni con almeno un turno libero, per proporre un menu.
// `opzioni.servizio`: solo i giorni con posto a QUEL servizio. `opzioni.tranne`:
// i giorni da saltare (quelli appena rifiutati dal cliente).
function giorniDisponibili(db, cfg, persone, adesso, quanti = 5, opzioni = {}) {
  const trovati = [];
  const massimo = num(cfg.bot_max_giorni, 60);
  const tranne = new Set(opzioni.tranne || []);
  for (let i = 0; i <= massimo && trovati.length < quanti; i++) {
    const iso = comeData(piuGiorni(adesso, i));
    if (tranne.has(iso)) continue;
    const turni = turniDisponibili(db, cfg, iso, persone, adesso, opzioni);
    if (opzioni.servizio ? turni.some((o) => servizioDellOra(cfg, iso, o) === opzioni.servizio) : turni.length) trovati.push(iso);
  }
  return trovati;
}

// ---------------------------------------------------------------------------
//  I testi
// ---------------------------------------------------------------------------

// ⚠️ {orari} dal 20 ottobre 2026 sono RIGHE («🍽️ Pranzo: …», «🌙 Cena: …»),
// non più un pezzo di frase (vedi «orariDetti»). Le frasi personalizzate prima
// hanno ancora «🕒 Siamo aperti {orari}.»: messe così darebbero «Siamo aperti
// 🍽️ Pranzo: …» con la cena a capo. Si sistemano qui, al momento di mandarle,
// e il testo salvato non si tocca (è del ristorante): la frase vecchia diventa
// «Siamo aperti:» con le righe sotto, e {orari} in mezzo a una riga va a capo.
// Senza orari la frase che li presenta sparisce tutta: non resta «Siamo
// aperti:» da solo.
function orariARighe(testo, valori) {
  const t = String(testo || '');
  if (!t.includes('{orari}')) return t;
  const sistemato = t.replace(/(?:🕒[ \t]*)?Siamo aperti[ \t]*:?[ \t]*\n?[ \t]*\{orari\}\.?/g, 'Siamo aperti:\n{orari}');
  if (!String((valori && valori.orari) || '').trim()) {
    return sistemato.replace(/Siamo aperti:\n\{orari\}[^\n]*\n?/g, '').replace(/[^\n]*\{orari\}[^\n]*\n?/g, '');
  }
  return sistemato.replace(/([^\s])[ \t]*\{orari\}/g, '$1\n{orari}').replace(/\{orari\}\./g, '{orari}');
}

// ⚠️ La frase del richiamo personalizzata prima del 20 ottobre 2026 ha ancora
// «Eravamo rimasti a {cosa}»: con le voci di COSA_MANCA non è italiano («a
// quale esperienza preferisci», «a l'orario»). Si sistema al momento di
// mandarla, come gli orari; il testo salvato resta del ristorante.
const conCosaSistemata = (t) => t.replace(/Eravamo rimasti a \{cosa\}/g, 'Ti stavo chiedendo {cosa}');

function riempi(testo, valori) {
  const pieno = conCosaSistemata(orariARighe(testo, valori)).replace(/\{(\w+)\}/g, (intero, chiave) => {
    const v = valori[chiave];
    return v === undefined || v === null ? intero : String(v);
  });
  // Un segnaposto lasciato vuoto (il nome dell'assistente, per esempio) lascia
  // dietro di sé uno spazio doppio o una virgola appesa. Sono i dettagli da
  // cui si capisce che dall'altra parte c'è una macchina, e costa due righe
  // evitarli: «Sono  l'assistente virtuale di» si nota subito.
  return pieno
    .split('\n')
    .map((riga) => riga.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1')
      // «Grazie, .» con il nome vuoto diventava «Grazie,.»: la virgola prima
      // di un punto non sta mai bene.
      .replace(/,([.!?])/g, '$1').trimEnd())
    .join('\n');
}

// Il numero di telefono è l'unico dato del riepilogo che può non esserci: il
// locale può aver spento la domanda, o il cliente può non aver risposto. Quindi
// la sua riga non si può lasciare scritta com'è — resterebbe un «📞» che non
// dice niente — e non si può nemmeno appendere in fondo al messaggio, dove
// finirebbe sotto la domanda di conferma, cioè dopo la riga che chiude il
// discorso. Si lavora sul testo PRIMA dei segnaposto: così la riga si toglie
// tutta quando il numero non c'è.
const SEGNAPOSTI_DATI = ['{data}', '{ora}', '{persone}', '{nome}', '{cognome}'];

// Le righe di una frase che vengono PRIMA della prima domanda: da quella col
// punto di domanda in giù (compreso il suo «(esempio: 2)») resta fuori. Serve
// alla frase di RICOMINCIA, che sta sopra una presentazione con la sua
// domanda. Se non resta niente, chi la usa mette quella predefinita.
function primaDellaDomanda(testo) {
  const righe = String(testo || '').split('\n');
  const domanda = righe.findIndex((r) => r.includes('?'));
  return (domanda < 0 ? righe : righe.slice(0, domanda)).join('\n').trim();
}

// ⚠️ «📝 Note:» da sola, senza niente dopo, sembra un guasto. Una riga che
// contiene SOLO segnaposto vuoti si toglie tutta. «Solo»: se sulla stessa riga
// ce n'è anche uno pieno la riga resta, sennò si porterebbe via del testo vero.
function senzaRigheVuote(testo, valori) {
  return orariARighe(testo, valori).split('\n').filter((riga) => {
    const chiavi = (riga.match(/\{(\w+)\}/g) || []).map((x) => x.slice(1, -1));
    if (!chiavi.length) return true;
    return chiavi.some((k) => String(valori[k] == null ? '' : valori[k]).trim() !== '');
  }).join('\n');
}

// L'esempio sotto «me lo riscrivi in un altro modo?» (`bot_t_riscrivi`),
// adatto alla domanda rimasta in sospeso. Dove si può, preso da quello che il
// bot ha appena proposto: un giorno dell'elenco, un orario dei turni. '' dove
// un esempio non aiuta, e la riga allora non esce (vedi `senzaRigheVuote`).
const ESEMPI_FISSI = {
  servizio: 'Per esempio «pranzo» oppure «cena».',
  sposta_servizio: 'Per esempio «pranzo» oppure «cena».',
  esperienza: 'Per esempio il numero: «1».',
  persone: 'Per esempio «4».',
  nome: 'Per esempio «Mario Rossi».',
  nome_altro: 'Per esempio «Mario Rossi».',
  nome_nuovo: 'Per esempio «Mario Rossi».',
  telefono: 'Per esempio «333 123 4567».',
  telefono_altro: 'Per esempio «333 123 4567».',
  email: 'Per esempio «nome@esempio.it».',
  conferma: 'Rispondi SÌ oppure NO.',
  sposta_conferma: 'Rispondi SÌ oppure NO.',
  annulla_conferma: 'Rispondi SÌ oppure NO.',
};
function esempioPer(passo, d = {}, adesso = new Date()) {
  if (['giorno', 'sposta_giorno', 'attesa_offerta'].includes(passo)) {
    const giorni = (Array.isArray(d.giorni) ? d.giorni : []).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(String(x)));
    const comeGiorno = (iso) => { const [a, m, g] = iso.split('-').map(Number); return new Date(a, m - 1, g); };
    const primo = giorni.length ? comeGiorno(giorni[0]) : piuGiorni(adesso, 3);
    const altro = giorni.length > 1 ? comeGiorno(giorni[giorni.length - 1]) : piuGiorni(adesso, 10);
    return `Per esempio «${NOMI_GIORNI[primo.getDay()]}» oppure «${altro.getDate()} ${NOMI_MESI[altro.getMonth()]}».`;
  }
  if (passo === 'ora' || passo === 'sposta_ora') {
    const turno = (Array.isArray(d.turni) ? d.turni : []).find((x) => /^\d{1,2}:\d{2}$/.test(String(x)));
    return `Per esempio «${turno || '20:30'}».`;
  }
  return ESEMPI_FISSI[passo] || '';
}

// La riga dell'esperienza nel riepilogo, per chi ha riscritto la frase prima
// che il segnaposto esistesse: come `colTelefono`, sotto l'ultima riga coi dati.
function conEsperienza(testo, esperienza) {
  const righe = String(testo || '').split('\n');
  if (!esperienza || righe.some((r) => r.includes('{esperienza}'))) return righe.join('\n');
  let dove = -1;
  righe.forEach((r, i) => { if (SEGNAPOSTI_DATI.some((sp) => r.includes(sp))) dove = i; });
  if (dove === -1) righe.push('🍽️ {esperienza}');
  else righe.splice(dove + 1, 0, '🍽️ {esperienza}');
  return righe.join('\n');
}

function colTelefono(testo, numero) {
  const righe = String(testo || '').split('\n');
  if (righe.some((r) => r.includes('{telefono}'))) {
    return numero ? righe.join('\n') : righe.filter((r) => !r.includes('{telefono}')).join('\n');
  }
  if (!numero) return righe.join('\n');
  // Il testo è modificabile dal locale: chi l'ha riscritto prima che questo
  // segnaposto esistesse non ce l'ha. Il numero va comunque INSIEME agli altri
  // dati — sotto l'ultima riga che ne contiene uno — e non in coda al
  // messaggio, dove finirebbe dopo la domanda.
  let dove = -1;
  righe.forEach((r, i) => { if (SEGNAPOSTI_DATI.some((sp) => r.includes(sp))) dove = i; });
  if (dove === -1) righe.push('📞 {telefono}');
  else righe.splice(dove + 1, 0, '📞 {telefono}');
  return righe.join('\n');
}

// Come si scrive un cliente nei messaggi a chi lavora in sala.
//
// ⚠️ Il COGNOME per primo. In un ristorante una prenotazione è «il tavolo
// Rossi»: è il cognome che si cerca sul foglio, che si chiama ad alta voce e
// che il cliente dice arrivando. Scrivere «Daniele» in un avviso obbliga chi
// legge a cercare fra i nomi propri, che in una serata sono tutti uguali.
// Il nome resta comunque, dopo: serve a distinguere due Rossi.
function nomeInSala(p) {
  const cognome = String((p && p.cognome) || '').trim();
  const nome = String((p && p.nome) || '').trim();
  const insieme = [cognome, nome].filter(Boolean).join(' ');
  return insieme || 'senza nome';
}

// Chi ha chiesto di essere lasciato in pace. Va chiesto PRIMA di ogni messaggio
// che parte da noi e che il cliente non ha sollecitato — la richiesta di
// recensione oggi, il promemoria domani.
// Lo stesso numero può arrivare scritto in cinque modi: «+39 333 1234567»,
// «3331234567», «393331234567». Vanno ridotti a una forma sola, o il confronto
// fallisce proprio quando conta.
function numeroConfrontabile(valore) {
  let n = String(valore || '').replace(/\D/g, '');
  if (n.startsWith('00')) n = n.slice(2);
  if (/^3\d{8,9}$/.test(n)) n = '39' + n;   // numero italiano senza prefisso
  return n;
}

// Il numero DELLA CHAT, quando la chat ne ha davvero uno.
//
// ⚠️ Serve perché la spunta «chiedi il numero di telefono» decideva due cose
// diverse: se CHIEDERLO al cliente, e se AVERLO in archivio. Spenta, la sala
// restava senza recapito — e per richiamare chi non si presenta, o avvisare
// che il forno si è rotto, il numero serve. Ma il cliente non l'ha nascosto:
// lo sta dicendo mentre scrive, perché scrive da lì.
//
// Da un indirizzo `@lid` NON si ricava niente: le sue cifre sono un
// identificativo interno di WhatsApp, e scriverle come telefono riempirebbe la
// rubrica di codici che non chiamano nessuno. Da un gruppo nemmeno: un gruppo
// non è una persona. In tutti e due i casi torna stringa vuota — meglio nessun
// numero che un numero falso, che qualcuno prima o poi prova a chiamare.
function numeroDallaChat(chiave) {
  const s = String(chiave || '').trim();
  if (!s || /@lid/i.test(s) || /@g\.us/i.test(s)) return '';
  const n = numeroConfrontabile(s.split('@')[0]);
  return (n.length >= 8 && n.length <= 14) ? n : '';
}

// ---------------------------------------------------------------------------
//  Il pagamento della prenotazione
// ---------------------------------------------------------------------------

// Da euro scritti a mano a centesimi interi.
//
// ⚠️ Il locale scrive «12,50» o «12.50», e con la virgola `Number()` restituisce
// NaN — che diventerebbe zero, cioè un pagamento che non si chiede mai, senza
// nessun errore da nessuna parte. Il guasto silenzioso peggiore: l'impostazione
// dice 12,50 e il bot non chiede niente.
//
// L'arrotondamento è al centesimo, e serve: 0,1 + 0,2 in virgola mobile non fa
// 0,3, e su una somma di soldi un centesimo che balla è una discussione.
function inCentesimi(valore) {
  const t = String(valore == null ? '' : valore).trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(t)) return 0;
  return Math.round(parseFloat(t) * 100);
}

// Quanto si deve pagare, in centesimi.
//
//   totale  = prezzo × persone (o × 1, se l'importo è a prenotazione)
//   adesso  = totale × percentuale
//   resto   = quello che si salderà al ristorante
//
// Il «resto» non è un di più da mostrare: è la riga che evita la discussione
// all'arrivo — «ma io avevo già pagato». Con il 100% non c'è, e non si scrive.
function importoDaPagare(cfg, persone) {
  if (!boolDi(cfg.bot_pagamento_attivo)) return { totale: 0, adesso: 0, resto: 0 };
  const prezzo = inCentesimi(cfg.bot_pagamento_prezzo);
  const quanti = String(cfg.bot_pagamento_modo || 'persona') === 'prenotazione'
    ? 1 : Math.max(num(persone, 0), 0);
  const totale = prezzo * quanti;
  // La percentuale si tiene fra 0 e 100: sopra il 100 si chiederebbe più di
  // quanto il locale ha scritto come prezzo, e nessuno lo vorrebbe.
  const perc = Math.min(Math.max(num(cfg.bot_pagamento_percentuale, 100), 0), 100);
  const adesso = Math.round(totale * perc / 100);
  return { totale, adesso, resto: Math.max(totale - adesso, 0) };
}

// ⚠️ Stripe non addebita meno di mezzo euro, e non lascia scadere una sessione
// prima di mezz'ora né dopo 24 ore. Sono vincoli suoi, non nostri: metterli qui
// vuol dire che il pannello può rifiutare una configurazione impossibile PRIMA
// che ci sbatta contro il primo cliente.
const MINIMO_ADDEBITO = 50;          // centesimi
const MINUTI_MINIMI = 30;
const MINUTI_MASSIMI = 24 * 60;

// Quanto tempo ha il cliente, in minuti, tenuto dentro i limiti di Stripe.
function minutiPerPagare(cfg) {
  return Math.min(Math.max(num(cfg.bot_pagamento_minuti, MINUTI_MINIMI), MINUTI_MINIMI), MINUTI_MASSIMI);
}

// Il momento in cui il posto torna libero, scritto come lo scrive SQLite
// («aaaa-mm-gg hh:mm:ss», ora locale) così si confronta con le altre date
// dell'archivio senza conversioni.
function scadenzaPagamento(cfg, adesso = new Date()) {
  return comeOrario(new Date(adesso.getTime() + minutiPerPagare(cfg) * 60000));
}

// Un momento scritto come lo scrive SQLite: «aaaa-mm-gg hh:mm:ss», ora locale.
//
// ⚠️ Sta separata da `scadenzaPagamento` perché serve anche per dire «adesso», e
// lì il minimo dei 30 minuti NON va applicato. Riusando l'altra, «adesso»
// diventava mezz'ora nel futuro e le prenotazioni scadevano appena nate: il
// posto tornava libero prima che il cliente potesse aprire il link.
function comeOrario(quando) {
  const due = (n) => String(n).padStart(2, '0');
  return `${quando.getFullYear()}-${due(quando.getMonth() + 1)}-${due(quando.getDate())} `
    + `${due(quando.getHours())}:${due(quando.getMinutes())}:${due(quando.getSeconds())}`;
}

// Un importo in centesimi, scritto come lo legge un italiano: «12,50 €».
function euro(centesimi) {
  return (Math.round(num(centesimi, 0)) / 100).toFixed(2).replace('.', ',') + ' €';
}

// Serve un pagamento per questa prenotazione?
//
// ⚠️ Con l'importo a zero NON si chiede niente e si conferma subito. Un link da
// zero euro Stripe lo rifiuta, e il cliente resterebbe appeso a una pagina che
// non funziona — con il tavolo tenuto fermo fino alla scadenza, per niente.
function serveIlPagamento(cfg, persone) {
  return importoDaPagare(cfg, persone).adesso >= MINIMO_ADDEBITO;
}

// Il pagamento BLOCCA la prenotazione?
//
// ⚠️ Sono due domande diverse, e tenerle separate è tutto il senso di questa
// funzione. «C'è qualcosa da pagare?» decide se mandare il collegamento.
// «Blocca?» decide se il tavolo è prenotato o no nel frattempo. Prima erano la
// stessa cosa, e volerne una senza l'altra non si poteva.
//
// Facoltativo vuol dire: il tavolo è prenotato SUBITO, la caparra è un invito.
// Niente scadenza, niente posto che torna libero — e quindi niente di quello
// che, in questo pezzo di programma, può togliere un tavolo a qualcuno.
function pagamentoObbligatorio(cfg) {
  return boolDi(cfg.bot_pagamento_obbligatorio);
}

// Questa prenotazione nasce «in attesa» (e quindi può scadere) oppure
// confermata? È l'unica riga che lo decide, e la usano sia il motore sia le
// prove: due posti che rispondono a questa domanda finirebbero per rispondere
// in modo diverso.
function bloccaLaPrenotazione(cfg, persone) {
  return serveIlPagamento(cfg, persone) && pagamentoObbligatorio(cfg);
}

// Da «2026-09-02 20:30:00» a «20:30». Al cliente si dice l'ora, non la data:
// la scadenza è sempre di oggi o al massimo di domani, e una data intera in
// mezzo a un messaggio breve si legge peggio.
function oreEMinuti(quando) {
  const m = String(quando || '').match(/(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
}

// I posti tenuti da chi non ha pagato in tempo tornano liberi.
//
// ⚠️ Torna le righe liberate, non un conto: chi chiama deve poter avvisare
// quelle persone. Liberare un tavolo senza dirlo a chi credeva di averlo è il
// modo più rapido di ritrovarselo alla porta.
//
// Lo stato finale è «annullata» e non uno nuovo: tutto il resto del programma
// sa già cosa farsene di una annullata, mentre uno stato sconosciuto verrebbe
// contato come viva da qualche query dimenticata. Che sia scaduta invece che
// disdetta si vede da `importo_dovuto > 0` con `pagato_at` vuoto.
function liberaScadute(db, adesso = new Date()) {
  const ora = comeOrario(adesso);
  const scadute = db.prepare(
    "SELECT * FROM prenotazioni WHERE stato = 'attesa_pagamento' "
    + 'AND pagamento_scade_at IS NOT NULL AND pagamento_scade_at <= ?'
  ).all(ora);
  if (!scadute.length) return [];
  const chiudi = db.prepare(
    "UPDATE prenotazioni SET stato = 'annullata', annullata_at = datetime('now','localtime') WHERE id = ?"
  );
  db.transaction((righe) => { for (const r of righe) chiudi.run(r.id); })(scadute);
  return scadute;
}

// «Questa ha pagato». La usano sia Stripe sia la persona che spunta a mano, e
// `da` dice quale dei due: è la prima domanda che ci si fa quando i conti non
// tornano.
//
// ⚠️ Ricontrolla che i posti ci siano ANCORA. Un pagamento arrivato un istante
// dopo la scadenza troverebbe il tavolo già dato a un altro, e confermarlo in
// silenzio vorrebbe dire due tavoli sullo stesso posto. Se non ci stanno più,
// non conferma: lo dice, e resta un incasso da restituire — che è una decisione
// di una persona, non del programma.
// `incassato` è quanto è stato pagato DAVVERO, in centesimi, quando lo si sa —
// Stripe lo dice. Serve perché fra il momento in cui il collegamento è stato
// creato e il momento in cui il cliente paga può essere cambiato qualcosa: il
// prezzo nelle impostazioni, o le persone della prenotazione. Senza, la riga
// direbbe «incassati 360 €» su un pagamento da 120: una bugia sui soldi,
// scritta in sala, che nessuno può smentire senza aprire Stripe.
function segnaPagata(db, cfg, id, da = 'mano', adesso = new Date(), incassato = null) {
  const p = db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(id);
  if (!p) return { ok: false, motivo: 'non c\'è' };
  // ⚠️ Già confermata NON vuol più dire «già pagata». Col pagamento
  // FACOLTATIVO il tavolo nasce confermato e la caparra arriva dopo — o non
  // arriva affatto. Uscendo di qui senza scrivere niente, quel versamento
  // sparirebbe: incassato su Stripe e invisibile in sala, che è il modo più
  // sicuro di litigare con un cliente all'arrivo.
  //
  // I posti non si ricontrollano: li sta già tenendo, è confermata. Il
  // controllo serve a chi era in attesa, dove il posto poteva essere andato a
  // un altro nel frattempo.
  if (p.stato === 'confermata' || p.stato === 'presentata') {
    if (p.pagato_at) return { ok: true, gia: true, prenotazione: p };
    db.prepare(
      "UPDATE prenotazioni SET pagato_at = datetime('now','localtime'), pagata_da = ?, "
      + 'importo_dovuto = ? WHERE id = ?'
    ).run(String(da || 'mano'), quantoDavvero(p, incassato), id);
    return {
      ok: true,
      // Chi legge deve poter dire cose diverse nei due casi: qui il tavolo era
      // già suo, e annunciargli «prenotazione CONFERMATA» sarebbe una notizia
      // che ha già avuto mezz'ora fa.
      eraGiaConfermata: true,
      prenotazione: db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(id),
    };
  }
  // ⚠️ I posti che sta GIÀ tenendo non contano contro di lei — e la condizione
  // era scritta al rovescio: chi era ancora in attesa (quindi già contato fra
  // gli occupati) risultava senza posto, e chi era scaduto (quindi non contato)
  // veniva confermato sopra il tavolo di un altro. Esattamente il caso che
  // questa funzione esiste per impedire. Escluderla per id fa le due cose
  // giuste insieme: in attesa non conta contro se stessa, scaduta non contava
  // comunque.
  const posto = postoPer(db, cfg, p.data, p.ora, p.persone, { escludiId: p.id, preferito: p.tavolo });
  if (!posto.ok) {
    return { ok: false, motivo: 'niente posto', prenotazione: p };
  }
  db.prepare(
    "UPDATE prenotazioni SET stato = 'confermata', pagato_at = datetime('now','localtime'), "
    + 'pagata_da = ?, importo_dovuto = ?, annullata_at = NULL, tavolo = ? WHERE id = ?'
  ).run(String(da || 'mano'), quantoDavvero(p, incassato),
    posto.tavolo === null ? p.tavolo : tavoloCheResta(db, cfg, p.data, p.ora, p.tavolo, p.id), id);
  return { ok: true, prenotazione: db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(id) };
}

// Quanto è entrato davvero. Se non lo sappiamo — la spunta a mano, dove non
// c'è nessuno a dircelo — resta quello che avevamo chiesto: è l'unica cifra di
// cui disponiamo, e inventarne un'altra sarebbe peggio.
function quantoDavvero(p, incassato) {
  const n = Math.round(num(incassato, -1));
  return n >= 0 ? n : p.importo_dovuto;
}

// Che chiave di Stripe è questa?
//
// ⚠️ La cosa che conta più di tutte è `prova`. Stripe dà due chiavi: una vera e
// una di prova. Un ristorante lasciato per sbaglio in prova incasserebbe
// pagamenti che NON ESISTONO, e nessuno se ne accorgerebbe fino all'estratto
// conto. Va riconosciuto da solo e scritto grosso ovunque.
//
// `forma` è solo un controllo della forma: che cominci come una chiave di
// Stripe. Non dice che sia valida — quello lo può dire solo Stripe — ma prende
// l'errore di incollatura, che è il più frequente.
function chiaveStripe(cfg) {
  const k = String((cfg || {}).bot_pagamento_chiave || '').trim();
  return {
    presente: k.length > 0,
    forma: /^(rk|sk)_(test|live)_[A-Za-z0-9]{8,}$/.test(k),
    prova: /^(rk|sk)_test_/.test(k),
    coda: k ? k.slice(-4) : '',
  };
}

// Il pezzo dell'email che parla di soldi.
//
// ⚠️ È UN pezzo che cambia, dentro UN testo solo, invece di due email diverse.
// Il riepilogo è lo stesso in tutti e due i momenti — quando la prenotazione
// nasce e quando viene pagata — e l'unica cosa che cambia è cosa si dice del
// pagamento. Con due testi separati, chi ne corregge uno lascia l'altro
// indietro, e il cliente riceve due email che si somigliano ma non si dicono
// le stesse cose.
//
// Senza pagamento torna stringa vuota, e il riepilogo resta pulito: nessuna
// riga che parla di soldi dove soldi non ce ne sono.
function bloccoPagamento(p, link) {
  if (!p || !p.importo_dovuto) return '';
  const resto = p.importo_totale > p.importo_dovuto
    ? `Il resto — ${euro(p.importo_totale - p.importo_dovuto)} — si salda al ristorante.` : '';
  // ⚠️ «Ricevuto» lo dice `pagato_at`, NON lo stato. Col pagamento facoltativo
  // il tavolo nasce confermato senza che nessuno abbia versato niente:
  // guardando lo stato, l'email avrebbe ringraziato per un acconto mai
  // arrivato. Fra tutti i modi di sbagliare, questo è quello che il cliente
  // porta al ristorante stampato.
  if (p.pagato_at) {
    return `💳 Pagamento ricevuto: ${euro(p.importo_dovuto)}\n` + (resto ? resto + '\n' : '');
  }
  // Confermata ma non pagata: è la caparra facoltativa. Il tavolo È suo, e
  // quella è la prima cosa da dire — cominciare dai soldi trasformerebbe un
  // invito in una richiesta.
  if (p.stato === 'confermata' || p.stato === 'presentata') {
    const inviti = [`✅ Il tavolo è tuo: non devi fare altro.`];
    if (link) {
      inviti.push(`Se vuoi, puoi lasciare fin d'ora un acconto di ${euro(p.importo_dovuto)}:`);
      inviti.push(`👉 ${link}`);
    }
    if (resto) inviti.push(resto);
    return inviti.join('\n') + '\n';
  }
  const righe = [
    '⚠️ Il tavolo NON è ancora prenotato: lo diventa appena riceviamo il pagamento.',
    `💳 Da pagare adesso: ${euro(p.importo_dovuto)}`,
  ];
  if (link) righe.push(`👉 Paga qui: ${link}`);
  if (p.pagamento_scade_at) righe.push(`Hai tempo fino alle ${oreEMinuti(p.pagamento_scade_at)}.`);
  if (resto) righe.push(resto);
  return righe.join('\n') + '\n';
}

// Gli stati che «tengono il posto»: la prenotazione esiste e va contata.
//
// ⚠️ È un elenco esplicito, e sta scritto UNA volta sola. Prima la stessa
// condizione era ripetuta dentro nove query — `stato IN ('confermata',
// 'presentata')` — e con uno stato nuovo se ne sarebbero aggiornate sette,
// accorgendosi delle altre due un sabato sera, col locale che risulta libero e
// non lo è.
//
// «attesa_pagamento» sta qui dentro di proposito: chi deve ancora pagare TIENE
// il posto. Se non lo tenesse, due persone potrebbero pagare per lo stesso
// ultimo tavolo, e una andrebbe rimborsata — molto peggio di un posto fermo
// mezz'ora. È il tempo limite a rendere accettabile tenerlo.
const STATI_VIVI = ['confermata', 'presentata', 'attesa_pagamento'];

// Quelli su cui si può ancora agire: annullare, spostare. «presentata» non c'è,
// a cena finita non si sposta più niente.
const STATI_TOCCABILI = ['confermata', 'attesa_pagamento'];

// La forma per le query: dentro(STATI_VIVI) → "('confermata','presentata',…)"
const dentro = (elenco) => '(' + elenco.map((x) => `'${x}'`).join(',') + ')';

function segnaBasta(db, chiave, numero) {
  db.prepare('INSERT OR REPLACE INTO bot_stop (chiave, numero) VALUES (?, ?)')
    .run(String(chiave || ''), numeroConfrontabile(numero));
}

// Si guarda per indirizzo E per numero: la stessa persona può aver scritto da
// una chat «@lid» e comparire altrove col numero, e basta che UNA delle due
// combaci perché quel «basta» valga.
function haDettoBasta(db, chiave, numero) {
  const righe = db.prepare('SELECT chiave, numero FROM bot_stop').all();
  const c = String(chiave || '');
  const n = numeroConfrontabile(numero);
  return righe.some((r) => (c && r.chiave === c)
    || (n && r.numero && numeroConfrontabile(r.numero) === n));
}

// ---------------------------------------------------------------------------
//  Domande frequenti e frasi non capite
// ---------------------------------------------------------------------------

function cercaFaq(db, testo) {
  const t = normalizza(testo);
  if (!t) return null;
  const righe = db.prepare('SELECT id, parole, risposta FROM bot_faq').all();
  for (const r of righe) {
    const parole = String(r.parole).split(',').map((p) => normalizza(p)).filter(Boolean);
    for (const p of parole) {
      if (new RegExp(`(^|\\W)${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t)) {
        db.prepare('UPDATE bot_faq SET usi = usi + 1 WHERE id = ?').run(r.id);
        return r.risposta;
      }
    }
  }
  return null;
}

// Ogni volta che il menu parte, si segna chi l'ha chiesto e a che punto era.
function annotaMenu(db, telefono, adesso, passo, quale = 'menu') {
  db.prepare('INSERT INTO bot_menu_richieste (telefono, passo, quando, quale) VALUES (?, ?, ?, ?)')
    .run(telefono, passo || '', quandoLeggibile(adesso), quale);
}

// I menu con un collegamento: solo quelli sono «attivi», e solo quelli il
// bot annuncia e manda.
// Ogni menu attivo è { link, file }: col file il bot ALLEGA (PDF o immagine),
// col solo link lo scrive. Il file, se c'è, vince.
// ---------------------------------------------------------------------------
//  Le esperienze: «business lunch», «alla carta», «menu degustazione»
// ---------------------------------------------------------------------------
//  Chiesto dal titolare: in un locale con tre offerte diverse la prima
//  domanda giusta non è «per quante persone» ma «cosa vuoi mangiare», perché
//  da quella discendono i giorni e gli orari possibili. Ogni esperienza ha un
//  nome, le parole con cui la si riconosce, una riga di presentazione, i
//  giorni in cui vale a pranzo e a cena e — volendo — il menu da offrire
//  (quello della scheda Menu) con una frase di cappello.
//
//  ⚠️ Con MENO DI DUE esperienze il bot non chiede niente e lavora come
//  sempre: la lista vuota è la regola, non l'eccezione. Con una sola vale
//  senza domanda: i suoi giorni filtrano, il nome finisce sulla prenotazione.
const ESPERIENZE_MASSIME = 6;
// Il menu dell'esperienza: nessuno, uno dei due della scheda Menu, oppure uno
// SUO ('suo': un file caricato nella sua scheda, o un collegamento).
const MENU_DELLE_ESPERIENZE = ['', 'menu', 'degustazione', 'suo'];
// ⚠️ Il nome del file lo decide il server (`esp-` + dodici cifre esadecimali):
// qui si accetta SOLO quella forma. Il nome finisce in un percorso su disco, e
// un «../» arrivato dalla pagina non deve poter uscire dalla cartella dei menu.
const FILE_MENU_ESPERIENZA = /^esp-[0-9a-f]{12}\.(pdf|png|jpg|webp)$/;
function linkDiMenu(v) {
  const l = String(v || '').trim();
  return /^https?:\/\/\S+$/i.test(l) && l.length <= 500 ? l : '';
}

// La lista letta e ripulita: un array (anche vuoto), o null se non si legge.
function esperienzeValide(valore) {
  let grezze = valore;
  if (typeof grezze === 'string') {
    if (!grezze.trim()) return [];
    try { grezze = JSON.parse(grezze); } catch { return null; }
  }
  if (!Array.isArray(grezze)) return null;
  const giorni = (v) => [...new Set((Array.isArray(v) ? v : []).map((g) => parseInt(g, 10)).filter((g) => g >= 0 && g <= 6))].sort();
  const buone = [];
  for (const e of grezze) {
    if (!e || typeof e !== 'object') continue;
    const nome = String(e.nome || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!nome || buone.some((x) => normalizza(x.nome) === normalizza(nome))) continue;
    buone.push({
      nome,
      parole: String(e.parole || '').split(',').map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 12).join(', '),
      riga: String(e.riga || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      pranzo: giorni(e.pranzo),
      cena: giorni(e.cena),
      menu: MENU_DELLE_ESPERIENZE.includes(e.menu) ? e.menu : '',
      cappello: String(e.cappello || '').trim().slice(0, 400),
      menuFile: FILE_MENU_ESPERIENZA.test(String(e.menuFile || '')) ? String(e.menuFile) : '',
      menuNome: String(e.menuNome || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      menuLink: linkDiMenu(e.menuLink),
    });
  }
  return buone.slice(0, ESPERIENZE_MASSIME);
}
// Le esperienze COME LE HA SCRITTE il titolare: per la scheda, da mostrare e
// da risalvare. Il bot invece usa `esperienzeDi`, qui sotto.
function esperienzeScritte(cfg) { return esperienzeValide(cfg.bot_esperienze) || []; }
// I servizi aperti, giorno della settimana per giorno, da «Orari e tavoli».
function serviziAperti(cfg) {
  const fasce = fasceDi(cfg);
  const aperti = { pranzo: new Set(), cena: new Set() };
  for (let g = 0; g < 7; g++) {
    for (const f of fasce[g] || []) if (aperti[f.servizio]) aperti[f.servizio].add(g);
  }
  return aperti;
}
// ⚠️ LE ESPERIENZE COME LE VEDE IL BOT: solo i giorni in cui quel servizio è
// APERTO (19 ottobre 2026). Visto dal titolare: «Alla carta» aveva la D
// spuntata anche a cena, la domenica sera in «Orari e tavoli» era chiusa, e il
// bot scriveva «tutti i giorni a cena» e proponeva «Domenica a cena puoi
// scegliere». I giorni dell'esperienza dicono dove VALE, gli orari dove il
// locale è APERTO: per il cliente conta dove valgono tutti e due. Quella che
// non ha più nessun giorno aperto non si propone affatto.
// ⚠️ Il filtro sta QUI e non nel salvataggio: le spunte del titolare restano
// com'erano, e se domani riapre la domenica sera tornano a valere da sole.
function esperienzeDi(cfg) {
  const aperti = serviziAperti(cfg);
  return esperienzeScritte(cfg)
    .map((e) => ({ ...e, pranzo: e.pranzo.filter((g) => aperti.pranzo.has(g)), cena: e.cena.filter((g) => aperti.cena.has(g)) }))
    .filter((e) => e.pranzo.length || e.cena.length);
}
function esperienzaDi(cfg, nome) {
  if (!nome) return null;
  return esperienzeDi(cfg).find((e) => normalizza(e.nome) === normalizza(nome)) || null;
}

// ---------------------------------------------------------------------------
//  I locali: la prima domanda («RO bistrot o REAR Restaurant?»)
// ---------------------------------------------------------------------------
//  Chiesto dal titolare (19 ottobre 2026): sotto lo stesso nome («RO WORLD»)
//  ci sono due locali. Il PRINCIPALE è quello di sempre: orari, tavoli,
//  esperienze di «Orari e tavoli» e «Esperienze» — non cambia niente. Gli
//  ALTRI sono serate a sé, con TUTTO il loro: una data, un turno, i coperti
//  (il bistrot: il pranzo della Giornata mondiale della Pasta, 25 ottobre,
//  12:30–15:30, 60 coperti, nessun tavolo). Il cliente sceglie per primo, e
//  dall'altro locale non gli si chiede né il giorno né l'ora: sono scritti
//  nella presentazione.
//
//  ⚠️ Le prenotazioni di un altro locale hanno `fuori_sala = 1` e NON contano
//  sui tavoli e sui coperti del principale (`prenotazioniSovrapposte`), né il
//  principale sui loro. Il segno sta sulla riga e non si ricava dal nome: se
//  domani la serata si toglie dalla scheda, le sue prenotazioni non devono
//  cominciare a occupare i tavoli del REAR.
//
//  La domanda c'è solo quando c'è da scegliere: passata la data, l'altro
//  locale sparisce da solo e il bot torna a lavorare come prima.
const LOCALI_MASSIMI = 4;
const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;
function dataEsiste(iso) {
  if (!DATA_ISO.test(String(iso || ''))) return false;
  const [a, m, g] = iso.split('-').map(Number);
  const d = new Date(a, m - 1, g);
  return d.getFullYear() === a && d.getMonth() === m - 1 && d.getDate() === g;
}
// Letti e ripuliti: { principale: { nome, parole } | null, altri: [...] }.
// Un altro locale senza nome, data, turno o coperti si scarta: la scheda dice
// perché prima di salvare (`erroriLocali`). null se non si legge affatto.
function localiValidi(valore) {
  let grezzi = valore;
  if (typeof grezzi === 'string') {
    if (!grezzi.trim()) return { principale: null, altri: [] };
    try { grezzi = JSON.parse(grezzi); } catch { return null; }
  }
  if (!grezzi || typeof grezzi !== 'object' || Array.isArray(grezzi)) return null;
  const pulito = (x, max) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, max);
  const parole = (x) => String(x == null ? '' : x).split(',').map((p) => pulito(p, 40)).filter(Boolean).join(', ');
  const p = grezzi.principale && typeof grezzi.principale === 'object' ? grezzi.principale : null;
  const principale = p && pulito(p.nome, 40) ? { nome: pulito(p.nome, 40), parole: parole(p.parole) } : null;
  const visti = new Set(principale ? [normalizza(principale.nome)] : []);
  const altri = [];
  for (const a of Array.isArray(grezzi.altri) ? grezzi.altri : []) {
    if (!a || typeof a !== 'object') continue;
    const nome = pulito(a.nome, 40);
    const [da] = turniValidi(a.da);
    const [fine] = turniValidi(fineDellaFascia(a.da, a.a));
    const coperti = parseInt(a.coperti, 10);
    if (!nome || visti.has(normalizza(nome)) || !dataEsiste(a.data) || !da || !fine
        || inMinuti(fine) <= inMinuti(da) || !(coperti >= 1 && coperti <= 5000)) continue;
    visti.add(normalizza(nome));
    altri.push({ nome, parole: parole(a.parole), testo: String(a.testo == null ? '' : a.testo).trim().slice(0, 1000),
      data: a.data, da, a: fine, coperti });
  }
  return { principale, altri: altri.slice(0, LOCALI_MASSIMI) };
}
// Perché un altro locale non si salverebbe: una frase per ognuno, vuoto se
// vanno tutti bene. Per la rotta delle impostazioni.
function erroriLocali(valore) {
  let grezzi = valore;
  if (typeof grezzi === 'string') { try { grezzi = JSON.parse(grezzi || '{}'); } catch { return ['I locali non si leggono.']; } }
  const errori = [];
  const nomi = new Set();
  const p = grezzi && grezzi.principale;
  if (p && String(p.nome || '').trim()) nomi.add(normalizza(p.nome));
  const altri = Array.isArray(grezzi && grezzi.altri) ? grezzi.altri : [];
  if (altri.length > LOCALI_MASSIMI) errori.push(`Al massimo ${LOCALI_MASSIMI} altri locali.`);
  for (const a of altri) {
    const nome = String((a && a.nome) || '').trim();
    const chi = nome ? `«${nome}»` : 'Un locale senza nome';
    if (!nome) { errori.push(`${chi}: scrivi il nome.`); continue; }
    if (nomi.has(normalizza(nome))) errori.push(`${chi}: c'è già un locale con questo nome.`);
    nomi.add(normalizza(nome));
    if (!dataEsiste(a.data)) errori.push(`${chi}: manca la data.`);
    const [da] = turniValidi(a.da);
    const [fine] = turniValidi(fineDellaFascia(a.da, a.a));
    if (!da || !fine) errori.push(`${chi}: scrivi l'orario di inizio e di fine (per esempio 12:30 e 15:30).`);
    else if (inMinuti(fine) <= inMinuti(da)) errori.push(`${chi}: l'orario di fine viene prima dell'inizio.`);
    const c = parseInt(a.coperti, 10);
    if (!(c >= 1 && c <= 5000)) errori.push(`${chi}: scrivi quanti coperti ha (un numero da 1 a 5000).`);
  }
  if (altri.length && !(p && String(p.nome || '').trim())) {
    errori.push('Scrivi anche il nome del locale di sempre: è la seconda scelta della domanda.');
  }
  return errori;
}
function localiDi(cfg) { return localiValidi(cfg.bot_locali) || { principale: null, altri: [] }; }
// Un altro locale per nome, anche passato (serve a dire la sua ora e a
// contarne i posti). null se non c'è.
function altroLocaleDi(cfg, nome) {
  if (!nome) return null;
  return localiDi(cfg).altri.find((a) => normalizza(a.nome) === normalizza(nome)) || null;
}
// Si può ancora prenotare? Fino all'anticipo minimo, come per i turni.
function altroLocaleAperto(cfg, a, adesso = new Date()) {
  const [y, m, g] = a.data.split('-').map(Number);
  const inizio = new Date(y, m - 1, g, Math.floor(inMinuti(a.da) / 60), inMinuti(a.da) % 60);
  return inizio.getTime() - num(cfg.bot_preavviso_ore, 2) * 3600000 > adesso.getTime();
}
// Quello che si propone alla prima domanda: gli altri locali ancora aperti,
// poi quello di sempre. Vuoto se non c'è niente da scegliere (nessun altro
// locale aperto): allora la domanda non si fa.
function localiDaProporre(cfg, adesso = new Date()) {
  const { principale, altri } = localiDi(cfg);
  const aperti = altri.filter((a) => altroLocaleAperto(cfg, a, adesso));
  const tutti = [...aperti, ...(principale ? [principale] : [])];
  return tutti.length >= 2 ? tutti : [];
}
// I posti che restano in un altro locale: i coperti meno le persone già
// prenotate lì (le prenotazioni vive, come per i tavoli).
function postiAltroLocale(db, a, escludiId = null) {
  const r = db.prepare('SELECT COALESCE(SUM(persone), 0) AS n FROM prenotazioni WHERE fuori_sala = 1 AND locale_scelto = ? '
    + 'AND data = ? AND stato IN ' + dentro(STATI_VIVI) + (escludiId ? ' AND id <> ?' : ''))
    .get(...[a.nome, a.data, ...(escludiId ? [escludiId] : [])]);
  return a.coperti - (r ? r.n : 0);
}
// L'ora di una prenotazione, come si dice al cliente: per un altro locale il
// suo turno («12:30 (fino alle 15:30)»), sennò quella di sempre (`oraColTurno`).
function oraDellaPrenotazione(cfg, p) {
  const fuori = p.fuori_sala || p.fuoriSala;
  const a = fuori ? altroLocaleDi(cfg, p.locale_scelto || p.localeScelto) : null;
  if (a && a.da === p.ora) return `${p.ora} (fino alle ${oraDetta(a.a)})`;
  if (fuori) return p.ora;
  return oraColTurno(cfg, p.data, p.ora);
}
// «RO bistrot o per REAR Restaurant» e «Scrivi *bistrot* per RO bistrot e
// *ristorante* per REAR Restaurant.», per la domanda.
function nomiDeiLocali(lista) {
  const n = lista.map((l) => l.nome);
  return n.length <= 1 ? n.join('') : `${n.slice(0, -1).join(', per ')} o per ${n[n.length - 1]}`;
}
function sceltaDeiLocali(lista) {
  const pezzi = lista.map((l) => `*${(String(l.parole || '').split(',')[0] || l.nome).trim().toLowerCase()}* per ${l.nome}`);
  return `Scrivi ${pezzi.length <= 1 ? pezzi.join('') : `${pezzi.slice(0, -1).join(', ')} e ${pezzi[pezzi.length - 1]}`}.`;
}
// Quale ha scelto: come per le esperienze (numero, nome, parole), e in più le
// parole scritte con una lettera sbagliata («bistot»).
// ⚠️ Niente numeri: la domanda chiede una PAROLA, e «2» lì è quasi sempre
// «siamo in 2» — si tiene da parte (vedi il passo «locale»).
function interpretaLocale(testo, lista) {
  const i = esperienzaNominata(testo, lista);
  if (i !== null) return i;
  const parole = normalizza(testo).split(' ').filter(Boolean);
  if (parole.length > 4) return null;
  const trovati = new Set();
  lista.forEach((l, j) => {
    // Una volta sola ciascuna: «bistrot» sta sia nel nome sia fra le parole, e
    // `parolaVicina` vuole UNA parola vicina, non due uguali.
    const sue = [...new Set(paroleDellEsperienza(l).flatMap((x) => x.split(' ')).filter((x) => x.length >= 5))];
    if (parole.some((p) => parolaVicina(p, sue))) trovati.add(j);
  });
  return trovati.size === 1 ? [...trovati][0] : null;
}

// I giorni a parole: «dal lunedì al venerdì», «il sabato», «la domenica»,
// «il venerdì e il sabato». La settimana comincia dal lunedì.
const conArticolo = (g) => (g === 0 ? 'la domenica' : `il ${NOMI_GIORNI[g]}`);
function giorniDetti(giorni) {
  const ordine = [1, 2, 3, 4, 5, 6, 0];
  const presenti = ordine.filter((g) => giorni.includes(g));
  if (presenti.length === 7) return 'tutti i giorni';
  const serie = [];
  for (const g of presenti) {
    const ultima = serie[serie.length - 1];
    if (ultima && ordine.indexOf(g) === ordine.indexOf(ultima[ultima.length - 1]) + 1) ultima.push(g);
    else serie.push([g]);
  }
  const pezzi = serie.flatMap((s) => (s.length >= 3
    ? [`dal ${NOMI_GIORNI[s[0]]} ${s[s.length - 1] === 0 ? 'alla' : 'al'} ${NOMI_GIORNI[s[s.length - 1]]}`]
    : s.map(conArticolo)));
  return pezzi.length <= 1 ? pezzi.join('') : `${pezzi.slice(0, -1).join(', ')} e ${pezzi[pezzi.length - 1]}`;
}
// Quando vale: «dal lunedì al venerdì a pranzo», «dal lunedì al sabato a
// cena e la domenica a pranzo», «tutti i giorni, a pranzo e a cena».
function quandoDetto(e) {
  const p = e.pranzo || [], c = e.cena || [];
  if (!p.length && !c.length) return '';
  if (p.length && c.length && p.join() === c.join()) return `${giorniDetti(p)}, a pranzo e a cena`;
  const pezzi = [];
  if (p.length) pezzi.push([p.length, `${giorniDetti(p)} a pranzo`]);
  if (c.length) pezzi.push([c.length, `${giorniDetti(c)} a cena`]);
  // Prima il servizio con più giorni: «dal lunedì al sabato a cena e la domenica a pranzo».
  return pezzi.sort((x, y) => y[0] - x[0]).map((x) => x[1]).join(' e ');
}
// Chi al menu non sceglie (lo dice, o due risposte che non si capiscono)
// prenota lo stesso: sulla prenotazione, al posto dell'esperienza, c'è questo.
// La sala lo legge; il report lo conta come una voce a sé.
const MENU_AL_TAVOLO = 'Menu da scegliere al tavolo';
// «Non lo so», «non saprei», «decido al tavolo», «scelgo lì», «indifferente»:
// al menu, un «non scelgo» detto chiaro. All'inizio del messaggio: «non so se
// avete il parcheggio» è un'altra cosa. «Boh» e «mah» no: sono anche il
// «non ho capito» di chi legge l'elenco.
function nonSceglieIlMenu(testo) {
  const t = normalizza(testo);
  const dove = '(?:dopo|poi|li|al tavolo|a tavola|in sala|sul posto|al ristorante|quando arrivo|quando arriviamo|la sera stessa)';
  return new RegExp('^(?:mah?\\s+|boh?\\s+|ehm\\s+|guarda\\s+|sinceramente\\s+)?(?:'
    // «Non so se avete il parcheggio» è una domanda: dopo «non so» non deve
    // venire «se», «come», «quando»… («non so quale» sì: è proprio lui).
    + 'non\\s+(?:lo\\s+)?so\\b(?!\\s+(?:se|come|quando|dove|perche|cosa|chi|quanto|quanti|quante)\\b)|non\\s+saprei\\b|non\\s+(?:ho|abbiamo)\\s+(?:ancora\\s+)?deciso\\b|(?:devo|dobbiamo)\\s+ancora\\s+decidere\\b'
    + `|(?:decido|decidiamo|decidero|decideremo|scelgo|scegliamo|sceglieremo|vediamo|vedremo)\\s+${dove}\\b`
    + '|indifferente\\b|non\\s+importa\\b|fa\\s+lo\\s+stesso\\b|(?:e|è)\\s+uguale\\b|uno\\s+qualsiasi\\b|qualsiasi\\b|nessuno\\s+in\\s+particolare\\b)').test(t);
}
const NUMERI_IN_CERCHIO = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
// L'elenco per il cliente: numero, nome in grassetto, la riga. Con `numeri`
// i numeri sono quelli dati (una parte dell'elenco, coi numeri che il cliente
// ha già letto); sennò da 1.
// ⚠️ SENZA i giorni (dal titolare, 22 ottobre 2026): prima la scelta, poi gli
// orari di quella scelta (vedi «orariDellEsperienza»). «· dal lunedì al
// venerdì a pranzo» resta solo dove serve a distinguere: due voci con lo
// stesso nome e giorni diversi, o `conQuando` (chi chiede «quale fra
// queste?» e le sa diverse solo per i giorni).
function elencoEsperienze(esperienze, opzioni = {}) {
  const quandiPerNome = new Map();
  for (const e of esperienze) {
    const k = normalizza(e.nome);
    if (!quandiPerNome.has(k)) quandiPerNome.set(k, new Set());
    quandiPerNome.get(k).add(quandoDetto(e));
  }
  return esperienze.map((e, i) => {
    const distingue = opzioni.conQuando || quandiPerNome.get(normalizza(e.nome)).size > 1;
    const quando = distingue ? quandoDetto(e) : '';
    const n = opzioni.numeri ? opzioni.numeri[i] : i + 1;
    return `${NUMERI_IN_CERCHIO[n - 1] || `${n}.`} *${e.nome}*${quando ? ` · ${quando}` : ''}${e.riga ? `\n${e.riga}` : ''}`;
  }).join('\n\n');
}
// «1, 2 o 3»: i numeri da scrivere, nella domanda sotto un elenco.
function numeriDetti(numeri) {
  const n = numeri.map(String);
  return n.length <= 1 ? n.join('') : `${n.slice(0, -1).join(', ')} o ${n[n.length - 1]}`;
}
const daUnoA = (k) => Array.from({ length: k }, (_, i) => i + 1);
// Vale quel giorno (a quel servizio, se detto)? Per restringere l'elenco a
// chi il giorno l'ha già scritto: «sabato sera» non ha il business lunch.
function valeIlGiorno(e, iso, servizio) {
  const g = new Date(`${iso}T12:00:00`).getDay();
  return (servizio ? [servizio] : SERVIZI).some((s) => (s === 'pranzo' ? e.pranzo : e.cena).includes(g));
}
// Gli orari d'apertura, dalle fasce di «Orari e tavoli». Una riga per servizio,
// come l'ha scritta il titolare (20 ottobre 2026) — la riga unica di prima, «a
// pranzo 12:30–15:30 dal lunedì al venerdì e la domenica, a cena …», si
// leggeva male:
//   🍽️ Pranzo: 12:30–15:30, dal lunedì al venerdì e la domenica.
//   🌙 Cena: 19:30–23:00, dal lunedì al sabato.
//   Chiusi il martedì.            (solo se c'è un giorno senza niente)
// Quando un servizio ha orari diversi da un giorno all'altro (dal titolare,
// 24 ottobre 2026) la riga unica diventava «12:30–15:30, dal lunedì al
// venerdì; 12:30–16:00, la domenica.», da rileggere due volte. Allora il
// servizio fa da titolo e ogni orario ha la sua riga, coi giorni davanti:
//   🍽️ Pranzo
//   dal lunedì al venerdì · 12:30–15:30
//   la domenica · 12:30–16:00
//
//   🌙 Cena
//   dal lunedì al giovedì · 19:30–23:30
//   venerdì e sabato · 19:30–00:00
// e fra un servizio e l'altro resta una riga vuota. Con un orario solo resta
// la riga unica. I giorni con lo stesso orario stanno insieme; un servizio va
// dal primo arrivo all'ultima fine, e mezzanotte si dice «00:00» (vedi
// `oraDetta`). Niente elenco dei turni. Vuoto se non c'è nessun orario.
// «Siamo aperti:» sta nella frase, non qui.
// Nelle righe «giorni · orario» più giorni sciolti vanno senza articolo
// («venerdì e sabato», non «il venerdì e il sabato»); uno solo lo tiene
// («la domenica»).
function giorniDellaRiga(giorni) {
  const detti = giorniDetti(giorni);
  return / e /.test(detti) ? detti.replace(/(^|, | e )(?:il|la) /g, '$1') : detti;
}
function orariDetti(cfg, solo = null) {
  const fasce = fasceDi(cfg);
  const pezzi = [];
  for (const servizio of SERVIZI) {
    const perOrario = new Map();
    for (const g of [1, 2, 3, 4, 5, 6, 0]) {   // dal lunedì: la domenica chiude la settimana
      if (solo && !(solo[servizio] || []).includes(g)) continue;
      const sue = (fasce[g] || []).filter((f) => f.servizio === servizio);
      if (!sue.length) continue;
      const da = Math.min(...sue.map((f) => inMinuti(f.da)));
      const a = Math.max(...sue.map((f) => Math.max(inMinuti(f.a), inMinuti(f.da))));
      // Un orario solo (i turni di prima, senza fine): «dalle 20:00».
      const chiave = a > da ? `${daMinuti(da)}–${oraDetta(daMinuti(a))}` : `dalle ${daMinuti(da)}`;
      if (!perOrario.has(chiave)) perOrario.set(chiave, []);
      perOrario.get(chiave).push(g);
    }
    if (!perOrario.size) continue;
    const testa = servizio === 'pranzo' ? '🍽️ Pranzo' : '🌙 Cena';
    const orari = [...perOrario.entries()];
    pezzi.push(orari.length === 1
      ? `${testa}: ${orari[0][0]}, ${giorniDetti(orari[0][1])}.`
      : [testa, ...orari.map(([orario, giorni]) => `${giorniDellaRiga(giorni)} · ${orario}`)].join('\n'));
  }
  if (!pezzi.length) return '';
  const chiusi = solo ? [] : [0, 1, 2, 3, 4, 5, 6].filter((g) => !(fasce[g] || []).length);
  if (chiusi.length) pezzi.push(`Chiusi ${giorniDetti(chiusi)}.`);
  // A righe sciolte, una riga vuota fra un blocco e l'altro: sennò la cena
  // si attacca all'ultimo orario del pranzo.
  return pezzi.join(pezzi.some((p) => p.includes('\n')) ? '\n\n' : '\n');
}
// Gli orari di UNA esperienza, nello stesso formato: solo i suoi giorni, a
// ogni servizio, con gli orari di «Orari e tavoli» di quei giorni. Vanno sotto
// «Perfetto, Business lunch 👍», dopo la scelta (dal titolare, 22 ottobre
// 2026): «🍽️ Pranzo: 12:30–15:30, dal lunedì al venerdì.», o a righe se
// quei giorni hanno orari diversi. Niente «Chiusi»:
// qui si dice quando c'è, non quando il locale è chiuso.
function orariDellEsperienza(cfg, e) {
  return orariDetti(cfg, { pranzo: (e && e.pranzo) || [], cena: (e && e.cena) || [] });
}
// «Che orari fate?», «quando siete aperti?», «a che ora aprite?». Parole
// intere e precise: «alle 20» o «l'orario delle 21» sono risposte, e non
// contengono nessuna di queste.
function chiedeGliOrari(testo) {
  const t = normalizza(testo);
  if (!t) return false;
  return /\b(orari|orario di apertura|orario d'apertura|siete aperti|siete chiusi|quando siete apert\w*|a che ora (aprite|chiudete)|aprite|chiudete)\b/.test(t);
}
// Le parole che la fanno riconoscere: quelle scritte dal locale, più il nome.
function paroleDellEsperienza(e) {
  return [...new Set([e.nome, ...String(e.parole || '').split(',')].map((p) => normalizza(p)).filter(Boolean))];
}
// Quale ha scelto: il numero («2», «2️⃣», «la seconda») oppure una delle sue
// parole, intera. Fra più esperienze che combaciano vince la parola più
// lunga: «menu degustazione» batte «menu». null se nessuna.
function interpretaEsperienza(testo, esperienze) {
  const t = normalizza(testo);
  if (!t || !esperienze.length) return null;
  const n = t.match(/^(?:la |il |l')?(\d)(?:️?⃣)?[.)]?$/);
  if (n) return +n[1] >= 1 && +n[1] <= esperienze.length ? +n[1] - 1 : null;
  const ord = ordinaleDi(testo);
  if (ord && !/\d/.test(t) && ord <= esperienze.length) return ord - 1;
  return esperienzaNominata(testo, esperienze);
}
// Solo per PAROLE, senza numeri: «il menu del business lunch», «menu alla
// carta». Serve alla richiesta del menu, dove un numero non vuol dire
// un'esperienza. Indice, o null.
// ⚠️ Un nome solo, oppure null — anche quando ne nomina più d'una: allora
// indovinarne una è il guasto (vedi `esperienzeNominate`).
function esperienzaNominata(testo, esperienze) {
  const n = esperienzeNominate(testo, esperienze);
  return n.length === 1 ? n[0] : null;
}
// I pezzi di un nome, per spareggiare: «Business lunch da €45» → business,
// lunch, da, 45.
function pezziDelNome(testo) {
  return normalizza(testo).split(/[^a-z0-9]+/).filter(Boolean);
}
// QUALI esperienze nomina il testo (indici). Le parole intere, e vince la più
// lunga: «menu degustazione» batte «menu».
// ⚠️ IL GUASTO, visto in una chat vera (19 ottobre 2026): due esperienze,
// «Business lunch da €35» e «da €45», con le stesse parole. Il cliente
// scriveva «business lunch» e il bot prendeva la PRIMA, senza dirlo. Ora a
// parità spareggia il resto del nome («da 45 euro» ha il 45); se resta il
// pari le restituisce tutte, e il bot chiede quale.
// Senza nessuna parola, vale un prezzo che sta nel nome di una sola — ma solo
// scritto da prezzo: «quello da 45», «45 euro», «45€». «Siamo in 45» sono
// persone, e «2» è la scelta dall'elenco.
function esperienzeNominate(testo, esperienze) {
  const t = normalizza(testo);
  if (!t || !esperienze.length) return [];
  const lunghezze = esperienze.map((e) => {
    let lunga = 0;
    for (const p of paroleDellEsperienza(e)) {
      const re = new RegExp(`(^|[^a-z0-9])${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
      if (p.length > lunga && re.test(t)) lunga = p.length;
    }
    return lunga;
  });
  const pezzi = new Set(pezziDelNome(t));
  const max = Math.max(...lunghezze);
  if (!max) {
    const prezzi = [...t.matchAll(/(?:\bda\s*€?\s*|€\s*)(\d+)\b|\b(\d+)\s*(?:€|euro\b|eur\b)/g)].map((m) => m[1] || m[2]);
    const col = prezzi.length ? daUnoA(esperienze.length).map((n) => n - 1)
      .filter((i) => pezziDelNome(esperienze[i].nome).some((x) => prezzi.includes(x))) : [];
    return col.length === 1 ? col : [];
  }
  const pari = daUnoA(esperienze.length).map((n) => n - 1).filter((i) => lunghezze[i] === max);
  if (pari.length === 1) return pari;
  const punti = pari.map((i) => pezziDelNome(esperienze[i].nome).filter((x) => pezzi.has(x)).length);
  const meglio = Math.max(...punti);
  const vincono = pari.filter((_, k) => punti[k] === meglio);
  return vincono.length === 1 ? vincono : pari;
}
// ⚠️ IL MENU DI UN'ESPERIENZA (16 ottobre 2026). Chiesto dal titolare: dopo
// «business lunch» il cliente scriveva MENU e gli arrivava quello alla carta,
// perché la scheda Menu ha due posti soli e il business lunch non ne aveva
// uno. Ora ogni esperienza dice qual è il SUO: uno dei due della scheda Menu,
// oppure uno suo (file o collegamento). null se non ne ha — e allora il bot
// lo dice, invece di mandarne un altro.
// `quale` è quello che finisce nel registro dei menu e decide il «te l'ho già
// mandato oggi»: 'menu', 'degustazione', oppure 'esperienza:<nome>'.
function menuDellEsperienza(cfg, e) {
  if (!e) return null;
  const attivi = menuAttivi(cfg);
  if ((e.menu === 'menu' || e.menu === 'degustazione') && attivi[e.menu]) {
    return { quale: e.menu, ...attivi[e.menu], frase: e.menu === 'menu' ? 'bot_t_menu' : 'bot_t_menu_degustazione', esperienza: e.nome };
  }
  if (e.menu === 'suo' && (e.menuFile || e.menuLink)) {
    return { quale: `esperienza:${e.nome}`, link: e.menuLink || '', file: e.menuFile || '', frase: 'bot_t_menu_esperienza', esperienza: e.nome };
  }
  return null;
}

// Vale quel giorno a quell'ora? Il servizio dell'ora, e i giorni
// dell'esperienza per quel servizio.
function ammessoPer(cfg, e, iso, ora) {
  if (!e) return true;
  const g = new Date(`${iso}T12:00:00`).getDay();
  return (servizioDellOra(cfg, iso, ora) === 'pranzo' ? e.pranzo : e.cena).includes(g);
}
function turniAmmessi(cfg, iso, e, turni) {
  return e ? turni.filter((o) => ammessoPer(cfg, e, iso, o)) : turni;
}

function menuAttivi(cfg) {
  const m = {};
  const uno = (link, file) => {
    const l = String(link || '').trim();
    const f = String(file || '').trim();
    return l || f ? { link: l, file: f } : null;
  };
  const menu = uno(cfg.bot_menu_link, cfg.bot_menu_file);
  const degustazione = uno(cfg.bot_menu_degustazione_link, cfg.bot_menu_degustazione_file);
  if (menu) m.menu = menu;
  if (degustazione) m.degustazione = degustazione;
  return m;
}
// La frase del menu quando parte come allegato: la riga col {link} non ha
// senso sotto un file, e si toglie. Quello che resta è la didascalia.
function senzaLaRigaDelLink(testo) {
  return String(testo || '').split('\n').filter((r) => !r.includes('{link}')).join('\n').trim();
}
// Quale menu chiede: «degustazione» se lo nomina, «menu» per tutto il resto.
function qualeMenu(testo) {
  const t = normalizza(testo);
  if (/\bdegustazion\w*\b/.test(t)) return 'degustazione';
  return chiedeIlMenu(t) ? 'menu' : null;
}
// Gli è già stato mandato oggi? Allora non si rimanda da soli: si chiede.
function menuGiaMandatoOggi(db, telefono, adesso, quale) {
  const oggi = comeData(adesso);
  const righe = db.prepare('SELECT quale FROM bot_menu_richieste WHERE telefono = ? AND substr(quando, 1, 10) = ?').all(telefono, oggi);
  return righe.some((r) => r.quale === 'tutti' || r.quale === quale);
}

// Il menu nel report: quante richieste, da quante persone, e quante di
// quelle persone hanno POI prenotato — una prenotazione viva nata dopo la
// prima richiesta. È il numero che dice se il menu convince.
function statisticheMenu(db, dal, al) {
  const righe = db.prepare(
    'SELECT telefono, MIN(quando) AS prima, COUNT(*) AS volte FROM bot_menu_richieste '
    + 'WHERE substr(quando, 1, 10) >= ? AND substr(quando, 1, 10) <= ? GROUP BY telefono'
  ).all(dal, al);
  const haPrenotato = db.prepare(
    'SELECT 1 FROM prenotazioni WHERE (telefono = ? OR chat_id = ?) AND creata_at >= ? '
    + "AND stato != 'annullata' LIMIT 1");
  return {
    richieste: righe.reduce((n, r) => n + r.volte, 0),
    persone: righe.length,
    poiPrenotato: righe.filter((r) => haPrenotato.get(r.telefono, r.telefono, r.prima)).length,
  };
}

// A che domanda si torna dopo aver mandato il menu, passo per passo. I passi
// che NON ci sono non lo intercettano: «note» è testo libero («menu
// degustazione per il compleanno» è una nota), i nomi sono nomi, le offerte
// della lista d'attesa scadono per conto loro, e i comandi della sala sono
// un'altra cosa.
const DOMANDA_DOPO_IL_MENU = {
  inizio: '', persone: '',          // niente da riprendere: si propone di prenotare
  esperienza: 'quale esperienza preferisci',
  locale: 'dove vuoi prenotare', altro_locale_persone: 'per quante persone',
  giorno: 'per che giorno', servizio: 'pranzo o cena', ora: 'a che ora',
  telefono: 'il numero di telefono', telefono_altro: 'il numero di telefono',
  email: "l'indirizzo email", conferma: 'se confermi la prenotazione',
  sposta_giorno: 'per che giorno la sposto', sposta_servizio: 'pranzo o cena', sposta_ora: 'a che ora la sposto',
  sposta_conferma: 'se confermi lo spostamento',
};

// «Mi mandate il menu?», «avete la carta dei vini?», «cosa si mangia?».
// ⚠️ Parole intere: «menu» non deve scattare dentro «menutrasporto», e «carta»
// da sola è anche la carta di credito — vale solo «la carta», «carta dei…».
function chiedeIlMenu(testo) {
  const t = normalizza(testo);
  // «la carta» solo se la si chiede (mandare, vedere, avere…) o se è «la
  // carta dei vini»: «accettate la carta?» e «pago con la carta» sono la
  // carta di credito, e il menu lì sarebbe una risposta da macchina.
  return /\b(menu|(mand\w*|invi\w*|ved\w*|mostr\w*|av\w+|ricev\w*|pass\w*|gir\w*) (mi |ci )?la carta\b|carta (dei|delle|del) \w+|cosa si mangia|cosa (avete|c e|ce) da mangiare|(che|quali) piatti|listino)\b/.test(t);
}

function annotaNonCapita(db, testo) {
  const n = normalizza(testo).slice(0, 200);
  if (!n) return;
  const esiste = db.prepare('SELECT id FROM bot_non_capite WHERE normalizzato = ?').get(n);
  if (esiste) {
    db.prepare("UPDATE bot_non_capite SET volte = volte + 1, ultima_at = datetime('now','localtime') WHERE id = ?").run(esiste.id);
  } else {
    db.prepare('INSERT INTO bot_non_capite (testo, normalizzato) VALUES (?, ?)').run(String(testo).slice(0, 500), n);
  }
}

// ---------------------------------------------------------------------------
//  Lo stato della conversazione
// ---------------------------------------------------------------------------

// ⚠️ Una conversazione lasciata a metà NON dura per sempre. Alla sala questa
// scadenza c'era già (mezz'ora); al cliente no, ed era il lato che fa danno.
//
// Il guasto visto: un cliente comincia a prenotare il 30 agosto e si ferma
// alla domanda sul giorno. Tre settimane dopo torna e scrive «ciao» — e il bot
// gli risponde «non ho capito la data», riproponendogli l'elenco di allora,
// che comincia con «domenica 30 agosto». Se lui scrive quella data,
// interpretaData la porta all'anno dopo (è passata) e il tavolo finisce nel
// 2027. Nessuno se ne accorge: né il cliente, né il locale.
//
// Dodici ore: coprono «stasera ne parlo con mia moglie e ti dico», e non
// arrivano al giorno dopo, quando l'elenco dei giorni proposti è comunque da
// rifare.
const CONVERSAZIONE_ORE = 12;

function conversazioneScaduta(riga, adesso = new Date()) {
  if (!riga || !riga.passo || riga.passo === 'inizio') return false;
  if (!riga.aggiornata_at) return false;
  const quando = new Date(String(riga.aggiornata_at).replace(' ', 'T'));
  if (Number.isNaN(quando.getTime())) return false;
  return (adesso - quando) / 3600000 >= CONVERSAZIONE_ORE;
}

// ---------------------------------------------------------------------------
//  La conversazione lasciata a metà
// ---------------------------------------------------------------------------
//  Due cose diverse, e vale la pena tenerle distinte:
//
//  A. il SALUTO RIAPRE — chi torna dopo un po' e scrive «ciao» vuole
//     ricominciare, non rispondere alla domanda rimasta in sospeso. Prima
//     quel «ciao» veniva letto come risposta e tornava indietro un «non ho
//     capito la data». Nessun timer butta via niente: decide il cliente.
//  B. il RICHIAMO — dopo un po' di silenzio il bot chiede «sei ancora lì?»,
//     una volta sola. È l'unico dei due che RECUPERA prenotazioni invece di
//     limitarsi a non rovinarle.

// Minuti di silenzio su quella riga. null se non si sa.
function minutiFermi(riga, adesso = new Date()) {
  if (!riga || !riga.aggiornata_at) return null;
  const quando = new Date(String(riga.aggiornata_at).replace(' ', 'T'));
  if (Number.isNaN(quando.getTime())) return null;
  return (adesso - quando) / 60000;
}

// ⚠️ I passi su cui il saluto riapre sono un elenco ESPLICITO, non «tutti
// tranne inizio». Fuori restano di proposito:
//  - «nome»: «Salvi» e «Salvo» sono cognomi veri, e scambiarli per un «salve»
//    vorrebbe dire buttare via il nome di chi sta prenotando;
//  - «note»: è testo libero, e «ciao» lì dentro potrebbe essere davvero la nota;
//  - «attesa_*»: c'è un posto offerto che scade per conto suo, e riaprire
//    vorrebbe dire far perdere l'offerta a chi stava per accettarla;
//  - «sposta_*» e «annulla_*»: sono percorsi corti e voluti, non ci si perde;
//  - «sala_*»: sono i comandi del locale, hanno una scadenza loro.
const PASSI_CHE_RIAPRONO = ['locale', 'altro_locale_persone', 'esperienza', 'persone', 'giorno', 'servizio', 'ora', 'telefono', 'email'];

function riapreConUnSaluto(cfg, riga, testo, adesso = new Date()) {
  if (!riga || !PASSI_CHE_RIAPRONO.includes(riga.passo)) return false;
  const minuti = num(cfg.bot_riapre_minuti, 10);
  if (minuti <= 0) return false;            // 0 = spento
  const fermi = minutiFermi(riga, adesso);
  if (fermi === null || fermi < minuti) return false;
  return eSalutoStorto(testo);
}

// Cosa manca, detto a parole, per la frase del richiamo. Un «sei ancora lì?»
// che non dice a cosa costringe a scorrere indietro la chat. Ognuna sta dopo
// «Ti stavo chiedendo …»: «Eravamo rimasti a {cosa}» dava «a quale esperienza
// preferisci», «a per che giorno», «a l'orario» (20 ottobre 2026).
const COSA_MANCA = {
  locale: 'dove vuoi prenotare',
  altro_locale_persone: 'per quante persone',
  esperienza: 'quale esperienza preferisci',
  persone: 'per quante persone',
  giorno: 'per che giorno',
  servizio: 'se preferisci pranzo o cena',
  ora: "l'orario",
  nome: 'il nome',
  telefono: 'il numero di telefono',
  note: 'se hai allergie o richieste particolari',
  email: "l'indirizzo email",
  // I passi di «non sono io» — sennò chi correggeva il nome e si distraeva
  // non veniva richiamato, a differenza di chi era rimasto su una domanda
  // qualsiasi.
  nome_nuovo: 'il nome',
  nome_altro: 'a che nome segnarla',
  telefono_altro: 'il numero di telefono della persona per cui prenoti',
};
const PASSI_DA_RICHIAMARE = Object.keys(COSA_MANCA);

// «Non voglio più prenotare», «lascia stare», «ho cambiato idea»: il cliente
// RINUNCIA. Visto in una chat vera (23 ottobre 2026): dopo il menu, «Non
// voglio più prenotare» passava per un «no» all'esperienza scelta e il bot
// riproponeva l'elenco; e la conversazione restava aperta, quindi più tardi
// sarebbe partito anche «Sei ancora lì?». Si chiude: «OK! Non ho prenotato
// niente», passo «inizio» — che il richiamo non guarda.
// ⚠️ Solo se il messaggio è QUELLO, tolte le cortesie («no grazie», «ok»,
// «purtroppo»). «Lascia stare il business lunch, prendo la carta» non è una
// rinuncia: è una correzione, e se ne occupa il passo. «Niente» da solo
// neanche: alla domanda delle allergie vuol dire «nessuna».
const CORTESIE_DELLA_RINUNCIA = /\b(no|grazie|mille|ciao|ok|okay|va bene|allora|scusa|scusate|scusami|comunque|per ora|per adesso|alla fine|purtroppo|magari|buona giornata|buona serata|arrivederci|a presto|guarda|senti|ehm|davvero|sorry|per favore|perfavore|per piacere|please)\b/g;
const RINUNCIA = new RegExp('^(?:'
  + 'non (?:voglio|vogliamo|vorrei|vorremmo|devo|dobbiamo|desidero|desideriamo) (?:piu )?(?:prenotare(?: piu)?|prenotarlo|prenotarla|fare la prenotazione|piu)'
  + '|non (?:prenoto|prenotiamo|prenotare|prenotate)(?: piu)?'
  + '|non (?:mi|ci) (?:serve|interessa)(?: piu)?(?: prenotare)?'
  + '|non (?:e|serve) piu(?: (?:necessario|il caso))?'
  + '|non (?:posso|possiamo) piu(?: venire)?|non (?:posso|possiamo) venire piu'
  + '|lascia(?:mo|te)? (?:perdere|stare)'
  + '|(?:ho|abbiamo) cambiato idea|ci (?:ho|abbiamo) ripensato|(?:ho|abbiamo) deciso di non prenotare'
  + '|(?:niente|nessuna) prenotazione'
  + ')$');
function vuoleRinunciare(testo) {
  const t = normalizza(testo).replace(/[^a-z\s]/g, ' ').replace(CORTESIE_DELLA_RINUNCIA, ' ').replace(/\s+/g, ' ').trim();
  return !!t && RINUNCIA.test(t);
}
// «Voglio cambiare il menu», «un altro menu», «cambio esperienza»: dopo aver
// scelto, il cliente ci ripensa (dal titolare, 23 ottobre 2026). Si torna
// all'elenco delle esperienze, tenendo le persone. Solo il messaggio intero,
// come per la rinuncia: «cambio esperienza, prendo la carta» lo prende già il
// passo, che riconosce il nome.
const PAROLE_DEL_CAMBIO = /\b(?:voglio|vorrei|volevo|posso|possiamo|preferisco|preferirei|vorremmo|vogliamo|ho|abbiamo|cambiare|cambio|cambia|cambiamo|scegliere|sceglierne|prendere|sbagliato|il|la|l|un|una|di|altro|altra|diverso|diversa|menu|esperienza|formula|proposta)\b/g;
function vuoleCambiareEsperienza(testo) {
  const t = normalizza(testo).replace(/[^a-z\s]/g, ' ').replace(CORTESIE_DELLA_RINUNCIA, ' ').replace(/\s+/g, ' ').trim();
  if (!/\b(?:menu|esperienza|formula|proposta)\b/.test(t)) return false;
  // Altre parole («il menu di pesce», «la carta dei vini») e non è solo un cambio.
  if (t.replace(PAROLE_DEL_CAMBIO, ' ').trim()) return false;
  // E serve il cambio: «il menu» da solo è la richiesta del menu (MENU).
  return /\b(?:cambiare|cambio|cambia|cambiamo|altro|altra|diverso|diversa|sbagliato)\b/.test(t);
}
// «Torna indietro», «indietro», «ho sbagliato»: la domanda di prima (vedi
// «elaboraMessaggio», che tiene la storia dei passi).
const INDIETRO = /^(?:(?:torna|tornare|torniamo|tornate|vai|andiamo|torno|possiamo tornare|posso tornare|voglio tornare|vorrei tornare) )?(?:indietro|al passo (?:precedente|prima)|alla domanda (?:precedente|di prima)|un passo indietro|passo precedente)$|^(?:ho|abbiamo) sbagliato(?: (?:risposta|scelta|giorno|data|orario|ora|numero|nome))?$/;
function vuoleTornareIndietro(testo) {
  const t = normalizza(testo).replace(/[^a-z\s]/g, ' ').replace(CORTESIE_DELLA_RINUNCIA, ' ').replace(/\s+/g, ' ').trim();
  return !!t && INDIETRO.test(t);
}

// I passi di una prenotazione NUOVA in corso: lì una rinuncia chiude tutto.
// Fuori (nessuna conversazione aperta, chi ha già un tavolo, lo spostamento)
// «non voglio più» può voler dire altro, e se ne occupano quei rami.
const PASSI_DELLA_PRENOTAZIONE = new Set([...PASSI_DA_RICHIAMARE, 'conferma', 'email']);

// Il simulatore della piattaforma usa numeri finti che cominciano per 000:
// non sono su WhatsApp, e niente di automatico deve provare a scrivergli.
function eSimulatore(telefono) {
  return /^000/.test(String(telefono || ''));
}

// Chi va richiamato adesso. NON manda niente: chi manda è il server, che è
// l'unico posto che sa se WhatsApp è collegato.
function daRichiamare(db, cfg, adesso = new Date()) {
  if (!boolDi(cfg.bot_richiamo_attivo)) return [];
  const minuti = num(cfg.bot_richiamo_minuti, 15);
  if (minuti <= 0) return [];
  // ⚠️ Non di notte. Un «sei ancora lì?» alle due del mattino è il modo più
  // rapido di far bloccare il numero del ristorante.
  if (!eOrarioAvvisi(cfg, adesso)) return [];
  const righe = db.prepare(
    'SELECT * FROM bot_conversazioni WHERE richiamata_at IS NULL'
  ).all();
  const adessoTesto = quandoLeggibile(adesso);
  return righe.filter((r) => {
    if (!PASSI_DA_RICHIAMARE.includes(r.passo)) return false;
    // ⚠️ Mai al simulatore: il suo numero finto (000…) non è su WhatsApp, e
    // il richiamo falliva ogni minuto per dodici ore — «1 richiamo non
    // partiti» a raffica nel registro, visto dal titolare.
    if (eSimulatore(r.telefono)) return false;
    // ⚠️ Mai su chi è in mano a una persona. Il silenzio dell'operatore è la
    // colonna «muto_fino» su QUESTA STESSA riga: un richiamo lì vorrebbe dire
    // il bot che parla sopra chi sta rispondendo a mano.
    if (r.muto_fino && r.muto_fino > adessoTesto) return false;
    // Chi ha scritto STOP non riceve più niente, e questo non fa eccezione.
    if (haDettoBasta(db, r.telefono, r.telefono)) return false;
    // Già scaduta: non è più una conversazione da riprendere, è roba vecchia.
    if (conversazioneScaduta(r, adesso)) return false;
    const fermi = minutiFermi(r, adesso);
    return fermi !== null && fermi >= minuti;
  }).map((r) => ({ ...r, cosa: COSA_MANCA[r.passo] || 'i dettagli della prenotazione' }));
}

// Si lascia andare: passo a «inizio» e dati buttati. ⚠️ Passa da «scriviStato»
// di proposito, che è l'unico posto che sa cosa NON si deve toccare su quella
// riga — «muto_fino» sopra tutto.
function lasciaAndare(db, telefono, adesso = new Date()) {
  scriviStato(db, telefono, 'inizio', {}, adesso);
}

function segnaRichiamata(db, telefono, adesso = new Date()) {
  db.prepare('UPDATE bot_conversazioni SET richiamata_at = ? WHERE telefono = ?')
    .run(quandoLeggibile(adesso), telefono);
}

// ⚠️ Richiamato e ancora zitto: dopo un'altra attesa si lascia andare. Il
// moltiplicatore è quattro, non uno: col richiamo a 15 minuti vuol dire un'ora,
// che è quanto un ristoratore si aspetta da «poi lascia perdere». E non è mai
// un'amnesia a sorpresa — a quel cliente il bot ha già chiesto «sei ancora lì?».
const DOPO_IL_RICHIAMO = 4;

function daLasciareAndare(db, cfg, adesso = new Date()) {
  const minuti = num(cfg.bot_richiamo_minuti, 15);
  if (minuti <= 0) return [];
  return db.prepare('SELECT * FROM bot_conversazioni WHERE richiamata_at IS NOT NULL').all()
    .filter((r) => {
      if (!PASSI_DA_RICHIAMARE.includes(r.passo)) return false;
      const fermi = minutiFermi(r, adesso);
      return fermi !== null && fermi >= minuti * DOPO_IL_RICHIAMO;
    });
}

// ---------------------------------------------------------------------------
//  La lista d'attesa
// ---------------------------------------------------------------------------
//  Chi trova pieno lascia il nome. Ogni minuto il server chiede a
//  `chiDaAvvisareInAttesa` se per qualcuno si è liberato un posto, e a quello
//  scrive. Le regole che contano:
//   - UNO alla volta per giornata: un posto solo non si propone a due persone,
//     sennò la seconda che dice SÌ trova di nuovo pieno e ci resta male due volte;
//   - chi riceve la proposta ha un tempo per rispondere (bot_attesa_minuti); se
//     non risponde torna IN CODA, non sparisce — magari stava guidando;
//   - un turno passato chiude l'attesa da solo, senza scrivere niente: «non si
//     è liberato niente» a serata finita è una notizia che non serve a nessuno.
const ATTESE_APERTE = ['in_attesa', 'avvisata'];

function attesaAperta(db, telefono, data) {
  return db.prepare('SELECT * FROM bot_attese WHERE telefono = ? AND data = ? AND stato IN '
    + dentro(ATTESE_APERTE) + ' ORDER BY creata_at LIMIT 1').get(telefono, data);
}

// Una richiesta per persona per giornata: chi scrive due volte «sì» non deve
// finire in lista due volte, e chi chiedeva le 20:00 e poi «qualunque orario»
// tiene la prima richiesta.
function mettiInAttesa(db, d, adesso = new Date()) {
  const gia = attesaAperta(db, d.telefono, d.data);
  if (gia) return { riga: gia, gia: true };
  const info = db.prepare('INSERT INTO bot_attese (telefono, nome, cognome, persone, data, ora, creata_at) '
    + 'VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(d.telefono, d.nome || '', d.cognome || '', d.persone, d.data, d.ora || '', quandoLeggibile(adesso));
  return { riga: db.prepare('SELECT * FROM bot_attese WHERE id = ?').get(info.lastInsertRowid), gia: false };
}

function listaDAttesa(db, data) {
  return db.prepare('SELECT * FROM bot_attese WHERE data = ? AND stato IN ' + dentro(ATTESE_APERTE)
    + ' ORDER BY creata_at, id').all(data);
}

// Se il cliente stava rispondendo a una proposta, la conversazione va
// riportata all'inizio: sennò il suo prossimo «ciao» verrebbe letto come
// risposta a un posto che non c'è più.
function azzeraSeAspettava(db, telefono) {
  db.prepare("UPDATE bot_conversazioni SET passo = 'inizio', dati = '{}' WHERE telefono = ? AND passo = 'attesa_libero'")
    .run(telefono);
}

function togliDallaAttesa(db, id, stato = 'tolta') {
  const r = db.prepare('SELECT * FROM bot_attese WHERE id = ?').get(id);
  if (!r || !ATTESE_APERTE.includes(r.stato)) return null;
  db.prepare('UPDATE bot_attese SET stato = ? WHERE id = ?').run(stato, id);
  azzeraSeAspettava(db, r.telefono);
  return r;
}

// ⚠️ CHI HA UN TAVOLO NON ASPETTA PIÙ UN POSTO PER QUEL GIORNO.
// Vale comunque sia nato il tavolo: dal bot, dalla sala, da una telefonata
// segnata a mano. Prima valeva SOLO per chi prenotava dalla lista (`attesaId`),
// e chi otteneva un tavolo per un'altra strada ci restava dentro: più tardi il
// bot gli scriveva «🎉 Si è liberato un posto!» per un tavolo che aveva già in
// mano, e quello chiamava il locale per capire se ne aveva uno o due.
// Riprodotto, non immaginato.
// ⚠️ Si chiama DOPO aver creato o spostato la prenotazione, e da tutte le
// strade: una sistemata e le altre no è come non averlo fatto.
function esceDallaLista(db, telefono, data, prenotazioneId = null) {
  if (!telefono || !data) return [];
  const righe = db.prepare('SELECT * FROM bot_attese WHERE telefono = ? AND data = ? AND stato IN '
    + dentro(ATTESE_APERTE)).all(telefono, data);
  for (const r of righe) {
    db.prepare("UPDATE bot_attese SET stato = 'prenotata', prenotazione_id = ? WHERE id = ?")
      .run(prenotazioneId, r.id);
    // Se stava rispondendo a «si è liberato un posto», la sua conversazione
    // torna all'inizio: il suo «sì» non deve prenotare una seconda volta.
    azzeraSeAspettava(db, r.telefono);
  }
  return righe;
}

// CANCELLA da chi non ha prenotazioni ma sta in lista: è la lista che vuole lasciare.
function toglieDaTutteLeAttese(db, telefono) {
  const aperte = db.prepare('SELECT id FROM bot_attese WHERE telefono = ? AND stato IN ' + dentro(ATTESE_APERTE)).all(telefono);
  for (const r of aperte) togliDallaAttesa(db, r.id, 'rinunciata');
  return aperte.length;
}

// La proposta non è andata a buon fine (nessuna risposta, o il messaggio non
// è partito): si torna in coda, in fondo. Chi c'era dietro passa avanti.
function rimettiInAttesa(db, id, adesso = new Date()) {
  const r = db.prepare('SELECT * FROM bot_attese WHERE id = ?').get(id);
  if (!r || r.stato !== 'avvisata') return null;
  db.prepare("UPDATE bot_attese SET stato = 'in_attesa', avvisata_at = NULL, avvisata_ora = '', scade_at = NULL, "
    + 'creata_at = ? WHERE id = ?').run(quandoLeggibile(adesso), id);
  azzeraSeAspettava(db, r.telefono);
  return r;
}

function turnoPassato(cfg, r, adesso) {
  const oggi = comeData(adesso);
  if (r.data < oggi) return true;
  if (r.data > oggi) return false;
  const adessoMin = adesso.getHours() * 60 + adesso.getMinutes();
  if (r.ora) return inMinuti(r.ora) <= adessoMin;
  const turni = turniDelGiorno(cfg, r.data);
  return !turni.length || Math.max(...turni.map(inMinuti)) <= adessoMin;
}

// Il turno da proporre a questa richiesta, o '' se non c'è. Passa da
// `turniDisponibili`, cioè dalle stesse regole di chi prenota (posti, preavviso,
// giorno bloccato): un posto che il bot non darebbe a un nuovo cliente non lo
// propone nemmeno a chi aspetta.
function turnoLiberoPer(db, cfg, r, adesso) {
  const liberi = turniDisponibili(db, cfg, r.data, r.persone, adesso);
  if (r.ora) return liberi.includes(r.ora) ? r.ora : '';
  return liberi[0] || '';
}

// Ogni minuto. Fa pulizia (turni passati, proposte senza risposta) e poi
// decide a chi proporre un posto. NON manda niente: restituisce a chi
// scrivere, e il messaggio lo manda il server — che è l'unico a sapere se
// WhatsApp è collegato. Le righe vengono segnate «avvisata» qui, prima
// dell'invio: se l'invio poi fallisce, il server le rimette in coda.
// La pulizia, e chi va avvisato che il suo tempo è finito.
// ⚠️ Chi non risponde in tempo tornava in coda IN SILENZIO: aveva letto «si è
// liberato un posto, rispondi SÌ entro trenta minuti», e poi più niente. Se
// rispondeva al minuto trentacinque si sentiva dire «il posto è stato preso»,
// che per giunta è un'altra cosa — lì il posto l'ha preso qualcun altro, qui è
// il tempo a essere finito. Adesso glielo si dice, e si dice anche che resta
// in lista: è la differenza fra una porta chiusa e una coda.
// ⚠️ NON avvisa chi scade perché il turno è passato (serata finita): «non si è
// liberato niente» a cose fatte è una notizia che non serve a nessuno.
// Come per le proposte, qui non si manda niente: si dice a chi scrivere, e il
// messaggio lo manda il server, che è l'unico a sapere se WhatsApp è collegato.
function scadenzeDellaAttesa(db, cfg, adesso = new Date()) {
  const adessoStr = quandoLeggibile(adesso);
  const aperte = db.prepare('SELECT * FROM bot_attese WHERE stato IN ' + dentro(ATTESE_APERTE)
    + ' ORDER BY creata_at, id').all();
  const tornati = [];
  for (const r of aperte) {
    if (turnoPassato(cfg, r, adesso)) togliDallaAttesa(db, r.id, 'scaduta');
    else if (r.stato === 'avvisata' && r.scade_at && r.scade_at < adessoStr) {
      // L'ora da nominare è quella PROPOSTA, che «rimettiInAttesa» sta per
      // cancellare: si legge prima.
      const ora = r.avvisata_ora || r.ora || '';
      if (rimettiInAttesa(db, r.id, adesso)) tornati.push({ ...r, ora });
    }
  }
  return tornati;
}

function chiDaAvvisareInAttesa(db, cfg, adesso = new Date()) {
  const adessoStr = quandoLeggibile(adesso);
  scadenzeDellaAttesa(db, cfg, adesso);

  const minuti = Math.max(num(cfg.bot_attesa_minuti, 30), 5);
  const scadenza = quandoLeggibile(new Date(adesso.getTime() + minuti * 60 * 1000));
  const proposte = [];
  const giorniConProposta = new Set(db.prepare("SELECT DISTINCT data FROM bot_attese WHERE stato = 'avvisata'").all().map((x) => x.data));
  const inCoda = db.prepare("SELECT * FROM bot_attese WHERE stato = 'in_attesa' ORDER BY creata_at, id").all();
  for (const r of inCoda) {
    if (giorniConProposta.has(r.data)) continue;
    const ora = turnoLiberoPer(db, cfg, r, adesso);
    if (!ora) continue;
    db.prepare("UPDATE bot_attese SET stato = 'avvisata', avvisata_at = ?, avvisata_ora = ?, scade_at = ? WHERE id = ?")
      .run(adessoStr, ora, scadenza, r.id);
    scriviStato(db, r.telefono, 'attesa_libero',
      { attesaId: r.id, persone: r.persone, data: r.data, ora, nome: r.nome, cognome: r.cognome }, adesso);
    giorniConProposta.add(r.data);
    proposte.push({ ...r, ora, minuti });
  }
  return proposte;
}

function statoDi(db, telefono, adesso) {
  let r = db.prepare('SELECT * FROM bot_conversazioni WHERE telefono = ?').get(telefono);
  if (!r) {
    db.prepare('INSERT INTO bot_conversazioni (telefono, passo) VALUES (?, ?)').run(telefono, 'inizio');
    r = db.prepare('SELECT * FROM bot_conversazioni WHERE telefono = ?').get(telefono);
  }
  let dati = {};
  try { dati = JSON.parse(r.dati || '{}'); } catch { dati = {}; }
  // Scaduta: si riparte da capo, e soprattutto si buttano i DATI. Tenerli
  // vorrebbe dire riproporre l'elenco dei giorni di tre settimane fa.
  if (adesso && conversazioneScaduta(r, adesso)) return { ...r, passo: 'inizio', dati: {} };
  return { ...r, dati };
}

// ⚠️ L'ora la si RICEVE, non la si prende dall'orologio. Chi scrive lo stato e
// chi ne misura l'età devono guardare lo stesso orologio: scrivendo l'ora vera
// e leggendola con l'`adesso` di chi ha chiamato, una conversazione appena
// salvata può risultare vecchia di giorni. In prova salta subito; in esercizio
// salterebbe fuori il giorno in cui l'ora del computer viene corretta.
function scriviStato(db, telefono, passo, dati, adesso = new Date()) {
  // ⚠️ Si tocca SOLO quello che riguarda il percorso. In particolare NON si
  // tocca «muto_fino», che sta sulla stessa riga: è il silenzio di quando una
  // persona sta rispondendo a mano, e azzerarlo qui vorrebbe dire il bot che
  // ricomincia a parlare sopra di lei.
  //
  // Il richiamo invece si dimentica quando si riparte da capo: «una volta sola»
  // vale per la conversazione, non per sempre. Senza questo, chi ha prenotato
  // una volta non verrebbe più richiamato mai più.
  db.prepare(
    'UPDATE bot_conversazioni SET passo = ?, dati = ?, aggiornata_at = ?'
    + (passo === 'inizio' ? ', richiamata_at = NULL' : '')
    + ' WHERE telefono = ?'
  ).run(passo, JSON.stringify(dati || {}), quandoLeggibile(adesso), telefono);
}

// «2026-08-30 22:54:37», come lo scriveva SQLite: l'archivio è già pieno di
// righe in quel formato e si confrontano fra loro come testo.
function quandoLeggibile(adesso) {
  const d = adesso instanceof Date ? adesso : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function salvaStato(db, telefono, passo, dati) {
  scriviStato(db, telefono, passo, dati, new Date());
}

function azzeraStato(db, telefono) {
  salvaStato(db, telefono, 'inizio', {});
}

// L'ora di riferimento arriva da fuori e non da `Date.now()`: mescolare due
// sorgenti di tempo nello stesso confronto è il modo classico per ottenere un
// silenzio che non scatta, o che non finisce mai. Tutto il file usa l'ora
// LOCALE nel formato 'sv-SE', come il resto del progetto.
function zittisci(db, telefono, ore, adesso = new Date()) {
  const fino = new Date(adesso.getTime() + ore * 3600 * 1000).toLocaleString('sv-SE');
  // ⚠️ La riga si CREA se manca. Era un UPDATE e basta: a chi non aveva mai
  // scritto al bot — il locale gli risponde a mano per primo — il silenzio non
  // si salvava, e al suo primo messaggio il bot gli parlava sopra alla
  // persona. Trovato dalla prova sull'annuncio della persona, non in sala.
  db.prepare('INSERT OR IGNORE INTO bot_conversazioni (telefono) VALUES (?)').run(telefono);
  db.prepare('UPDATE bot_conversazioni SET muto_fino = ? WHERE telefono = ?').run(fino, telefono);
}

// L'annuncio «ti risponde una persona»: quando è stato fatto, se è recente,
// e come si dimentica quando la persona ha finito. Vale per tutte le strade
// con cui una persona entra (codice R, telefono del locale, scheda Chat): un
// cliente che se lo sente dire due volte pensa che ci siano due persone.
function segnaPersona(db, telefono, adesso = new Date()) {
  db.prepare('INSERT OR IGNORE INTO bot_conversazioni (telefono) VALUES (?)').run(telefono);
  db.prepare('UPDATE bot_conversazioni SET persona_at = ? WHERE telefono = ?')
    .run(adesso.toLocaleString('sv-SE'), telefono);
}

function personaAnnunciata(db, telefono, ore, adesso = new Date()) {
  const r = db.prepare('SELECT persona_at FROM bot_conversazioni WHERE telefono = ?').get(telefono);
  if (!r || !r.persona_at) return false;
  const limite = new Date(adesso.getTime() - Math.max(1, ore) * 3600 * 1000).toLocaleString('sv-SE');
  return r.persona_at > limite;
}

function scordaPersona(db, telefono) {
  return db.prepare('UPDATE bot_conversazioni SET persona_at = NULL WHERE telefono = ? AND persona_at IS NOT NULL')
    .run(telefono).changes;
}

function eMuto(db, telefono, adesso) {
  const r = db.prepare('SELECT muto_fino FROM bot_conversazioni WHERE telefono = ?').get(telefono);
  if (!r || !r.muto_fino) return false;
  return r.muto_fino > adesso.toLocaleString('sv-SE');
}

// Il tetto di risposte per chat, fra 3 e 200 (scritto male vale 20).
function tettoRisposte(cfg) {
  return Math.min(Math.max(num(cfg.bot_max_risposte, 20), 3), 200);
}
// Quante ne ha contate oggi questa chat, senza contarne un'altra.
function risposteDiOggi(db, telefono, adesso) {
  const r = db.prepare('SELECT risposte_oggi, giorno_risposte FROM bot_conversazioni WHERE telefono = ?').get(telefono);
  return r && r.giorno_risposte === comeData(adesso) ? r.risposte_oggi : 0;
}
function rimettiIlConto(db, telefono, adesso, quante) {
  db.prepare('UPDATE bot_conversazioni SET risposte_oggi = ?, giorno_risposte = ? WHERE telefono = ?')
    .run(quante, comeData(adesso), telefono);
}

// Tetto di risposte per chat: se qualcuno scrive a raffica, il bot si ferma
// invece di fare ping-pong all'infinito.
function contaRisposta(db, telefono, adesso) {
  const oggi = comeData(adesso);
  const r = db.prepare('SELECT risposte_oggi, giorno_risposte FROM bot_conversazioni WHERE telefono = ?').get(telefono);
  if (!r || r.giorno_risposte !== oggi) {
    db.prepare('UPDATE bot_conversazioni SET risposte_oggi = 1, giorno_risposte = ? WHERE telefono = ?').run(oggi, telefono);
    return 1;
  }
  const nuovo = r.risposte_oggi + 1;
  db.prepare('UPDATE bot_conversazioni SET risposte_oggi = ? WHERE telefono = ?').run(nuovo, telefono);
  return nuovo;
}

// ---------------------------------------------------------------------------
//  IL CUORE: da un messaggio a una risposta
// ---------------------------------------------------------------------------
//  Non sa cosa sia WhatsApp. Prende testo e restituisce:
//    { risposte: ['...'], passaAUmano: bool, prenotazione: {...} | null }
//  È la parte che `prova-bot.js` fa girare senza telefono e senza internet.

// Senza numeri davanti: un cliente al primo messaggio non sa cosa vuol dire
// «rispondi con 2», e in tanti hanno provato a scrivere «2» pensando fosse il
// numero di persone lasciato a metà. Si risponde ricopiando l'orario o il
// giorno così com'è, che è esattamente quello che interpretaOra/interpretaData
// sanno già leggere.
//
// Uno per riga: in colonna si scorrono con l'occhio, mentre in fila su una riga
// sola diventano un blocco di testo che su un telefono si legge male.
//
// Gli orari vanno a capo SENZA virgola in fondo. Quella virgola è la stessa che
// il ristoratore scrive nelle impostazioni per separare i turni («20:00,22:00»),
// e ritrovarsela stampata nel messaggio al cliente fa sembrare che il bot stia
// ricopiando l'impostazione invece di comporre una frase.
// Gli orari da proporre al cliente. Uno per riga, senza numeri davanti e
// senza virgole: si risponde copiando l'orario (vedi le prove). Ma quando ci
// sono pranzo E cena, dodici righe di fila non si leggono più — e il cliente
// che vuole cenare deve scorrere tutto il pranzo per arrivarci. Allora una
// riga per servizio, con gli orari separati dal punto in mezzo.
//
// ⚠️ Coi TURNI ogni riga dice anche la fascia: «*1° turno* · dalle 19:30
// alle 21:00». Deciso dal titolare: chi prenota sa da subito fin quando il
// tavolo è suo, e nessuno si sente dire a sorpresa «dobbiamo liberare il
// tavolo». La fine si scrive solo se il titolare l'ha scritta: i turni salvati
// col solo inizio dicono «alle 19:30», senza inventare un orario.
function elencoTurni(turni, cfg, iso) {
  if (!cfg || !iso) return turni.join('\n');
  const riga = (t) => rigaTurno(cfg, iso, t);
  const conTurni = turni.some((t) => numeroDelTurno(cfg, iso, t));
  const pranzo = turni.filter((t) => servizioDellOra(cfg, iso, t) === 'pranzo');
  const cena = turni.filter((t) => !pranzo.includes(t));
  // Gli orari scelti (vedi `slotDelGiorno`) stanno su una riga sola:
  // «19:30 · 20:00 · 20:30» — un turno per riga, invece, perché ha la fine.
  const slot = slotDelGiorno(cfg, iso);
  const blocco = (lista, s) => (slot[s] ? lista.join(' · ') : lista.map(riga).join('\n'));
  if (!pranzo.length || !cena.length) return blocco(turni, pranzo.length ? 'pranzo' : 'cena');
  if (conTurni) return `*Pranzo*\n${blocco(pranzo, 'pranzo')}\n\n*Cena*\n${blocco(cena, 'cena')}`;
  return `Pranzo: ${pranzo.join(' · ')}\nCena: ${cena.join(' · ')}`;
}

// Il turno di un orario, per dirlo al cliente: { numero, da, a, unico }. `a`
// c'è solo se il titolare ha scritto la fine del turno. `unico`: è l'unico
// turno del suo servizio quel giorno. null se l'orario non è un turno.
//
// ⚠️ Con un turno solo il numero NON si dice (deciso dal titolare, 19 ottobre
// 2026): «1° turno» quando non c'è un secondo sembra un modulo, e al cliente
// non dice niente. Si dice l'orario: «dalle 12:30 alle 15:30», «12:30 (fino
// alle 15:30)». Il numero resta per la logica (`numeroDelTurno`): chi scrive
// comunque «il primo» viene capito lo stesso.
function turnoDellOra(cfg, iso, ora) {
  const numero = numeroDelTurno(cfg, iso, ora);
  if (!numero) return null;
  const fasce = fasceDelGiorno(cfg, iso);
  const f = fasce.find((x) => x.turno && x.da === ora);
  const servizio = servizioDellOra(cfg, iso, ora);
  const unico = fasce.filter((x) => x.servizio === servizio).length === 1;
  return { numero, da: ora, a: f && inMinuti(f.a) > inMinuti(f.da) ? f.a : '', unico };
}
// Il numero del turno da DIRE: null se il turno è l'unico del servizio (vedi
// sopra). Per le tendine della piattaforma e le schede del servizio.
function numeroDaDire(cfg, iso, ora) {
  const t = turnoDellOra(cfg, iso, ora);
  return t && !t.unico ? t.numero : null;
}
function rigaTurno(cfg, iso, ora) {
  const t = turnoDellOra(cfg, iso, ora);
  if (!t) return ora;
  const fascia = t.a ? `dalle ${t.da} alle ${oraDetta(t.a)}` : `alle ${t.da}`;
  return t.unico ? fascia : `*${t.numero}° turno* · ${fascia}`;
}
// «dalle 13:00 alle 15:00», o «alle 13:00» se la fine non è scritta.
function fasciaDetta(cfg, iso, ora) {
  const t = turnoDellOra(cfg, iso, ora);
  return t && t.a ? `dalle ${ora} alle ${oraDetta(t.a)}` : `alle ${ora}`;
}
// Il numero detto, come turno: «il primo», «2°», «secondo», «turno 3».
// null se il messaggio non sceglie un turno per numero.
function ordinaleDi(testo) {
  const t = normalizza(testo).replace(/^(il|la|al|per il|per la)\s+/, '').replace(/\s*turno\s*/, ' ').trim();
  if (/\d{1,2}\s*[:.,]\s*\d{2}/.test(t) || /\b\d{2}\b/.test(t)) return null;
  const parole = t.split(' ');
  return (ORDINALI.find(([, ovunque, sole]) => sole.includes(t) || parole.some((p) => ovunque.includes(p))) || [])[0] || null;
}

// L'orario col suo turno, per il riepilogo e lo spostamento:
// «19:30 (1° turno, fino alle 21:00)». Fuori dai turni, l'orario e basta.
function oraColTurno(cfg, iso, ora) {
  const t = turnoDellOra(cfg, iso, ora);
  if (!t) return ora;
  if (t.unico) return t.a ? `${ora} (fino alle ${oraDetta(t.a)})` : ora;
  return `${ora} (${t.numero}° turno${t.a ? `, fino alle ${oraDetta(t.a)}` : ''})`;
}
// «alle 12:30, e il tavolo è tuo fino alle 15:30», o «alle 12:30» se la fine
// del turno non è scritta. Per la domanda sul turno che resta.
function arrivoDetto(cfg, iso, ora) {
  const t = turnoDellOra(cfg, iso, ora);
  return t && t.a ? `alle ${ora}, e il tavolo è tuo fino alle ${oraDetta(t.a)}` : `alle ${ora}`;
}

// «il primo», «2° turno», «secondo», o un «1» da solo: il turno scelto,
// come orario, o null. Fra i turni PROPOSTI (`turni`), e del servizio
// `servizio` se c'è: «il primo» a pranzo e a cena sono due turni diversi, e
// senza sapere quale non si indovina.
//
// ⚠️ Un «1» da solo, davanti a un elenco di turni numerati, è il primo turno
// e non l'una: leggerlo come orario lo trasformava nelle 13:00 («alle 1» =
// le 13), cioè in un turno che il cliente non aveva chiesto.
// I passi della scelta dell'orario, prenotando e spostando: le stesse
// domande, in due conversazioni diverse.
const PASSI_NUOVA = { servizio: 'servizio', ora: 'ora' };
const PASSI_SPOSTA = { servizio: 'sposta_servizio', ora: 'sposta_ora' };

// Le parole valgono ovunque nel messaggio («va bene il primo»); le cifre e
// «uno», «due»… solo da sole («2», «turno 2»): «alle 2» è un orario, e «siamo
// in due» non è una scelta di turno.
const ORDINALI = [
  [1, ['primo', 'prima', '1°', '1º', '1o'], ['1', 'uno']],
  [2, ['secondo', 'seconda', '2°', '2º', '2o'], ['2', 'due']],
  [3, ['terzo', 'terza', '3°', '3º', '3o'], ['3', 'tre']],
  [4, ['quarto', 'quarta', '4°', '4º', '4o'], ['4', 'quattro']],
];
function interpretaTurno(testo, cfg, iso, turni, servizio) {
  // Un orario scritto («alle 19:30», «20») non è un turno: lo legge interpretaOra.
  const quale = ordinaleDi(testo);
  if (!quale) return null;
  const servizi = servizio ? [servizio] : [...new Set(turni.map((o) => servizioDellOra(cfg, iso, o)))];
  const trovati = servizi.flatMap((sv) => turni.filter((o) => servizioDellOra(cfg, iso, o) === sv
    && numeroDelTurno(cfg, iso, o) === quale));
  return trovati.length === 1 ? trovati[0] : null;
}

// «a pranzo», «domani sera», «per cena»: il servizio che il cliente ha detto,
// o null. Tutti e due nello stesso messaggio non è una scelta: null.
// ⚠️ «sera» e non «buonasera»: i confini di parola tengono fuori il saluto.
function servizioDetto(testo) {
  const t = normalizza(testo);
  const pranzo = /\b(pranzo|pranzare|pranziamo|mezzogiorno)\b/.test(t);
  const cena = /\b(cena|cenare|ceniamo|stasera|sera)\b/.test(t);
  if (pranzo === cena) return null;
  return pranzo ? 'pranzo' : 'cena';
}

// Difesa doppia, e non è per scrupolo: una lista costruita alle 23 con dentro
// «oggi» viene riletta alle 8 del mattino dopo, quando «oggi» è ieri. Sta
// dentro le dodici ore e sarebbe comunque sbagliata. Quello che si propone si
// ricontrolla al momento di proporlo.
function giorniAncoraBuoni(giorni, adesso) {
  const oggi = comeData(adesso);
  return (giorni || []).filter((g) => g >= oggi);
}

function elencoGiorni(giorni) {
  return giorni.map((g) => dataItaliana(g)).join('\n');
}

// Cerca la prenotazione futura di chi sta scrivendo.
//
// ⚠️ Si guarda in DUE colonne, e non è per scrupolo: la riga nasce con
// l'indirizzo della chat nella colonna `telefono`, e subito dopo il server ci
// scrive sopra il numero vero spostando l'indirizzo in `chat_id`. Cercando in
// una sola colonna, ad ANNULLA il bot rispondeva «non trovo prenotazioni a tuo
// nome» a chi la prenotazione ce l'aveva eccome.
// Tutte le facce con cui la stessa persona può comparire in archivio:
// l'indirizzo della chat da cui sta scrivendo adesso e il suo numero di
// telefono, ciascuno anche nella forma «numero@c.us».
//
// ⚠️ Serve perché le due cose non nascono insieme. Una prenotazione presa
// dalla sala («NUOVA», oppure il modulo della pagina) ha SOLO il numero: non è
// mai passata da una chat, quindi non ha nessun `chat_id`. Cercandola con il
// solo indirizzo non si trovava, e al cliente che riscriveva il bot rispondeva
// come se non avesse prenotato niente — invitandolo a prenotare di nuovo. Due
// tavoli per la stessa persona, e nessuno se ne accorgeva fino alla sera.
//
// Da un indirizzo `@lid` NON si ricava un numero: le sue cifre sono un
// identificativo interno di WhatsApp, e prenderle per un telefono accosterebbe
// due persone diverse.
function chiaviDellaPersona(chiave, numero) {
  const chiavi = new Set();
  for (const v of [chiave, numero]) {
    const s = String(v || '').trim();
    if (!s) continue;
    chiavi.add(s);
    if (/@lid/i.test(s)) continue;
    const n = numeroConfrontabile(s);
    if (n.length >= 8 && n.length <= 14) {
      chiavi.add(n); chiavi.add(n + '@c.us');
      // Anche la forma SENZA prefisso: in archivio possono esserci righe
      // vecchie scritte come le ha dettate il cliente («3274670195»). È la
      // regola di numeroConfrontabile letta al contrario, quindi non produce
      // niente che quella non avrebbe già unito.
      if (/^39(3\d{8,9})$/.test(n)) chiavi.add(n.slice(2));
    }
  }
  return [...chiavi];
}

// ---------------------------------------------------------------------------
//  Lo storico di una persona
// ---------------------------------------------------------------------------
//
// La domanda vera non è mai «fammi vedere le prenotazioni passate»: è «chi è
// questo che ha appena prenotato?». È già stato qui, quante volte, in quanti
// viene di solito, ha un'allergia che si ripete. Tutto quello che segue serve
// a rispondere a QUELLA domanda.
//
// ⚠️ Il conto si chiama «prenotazioni», non «visite». Finché non c'è l'appello
// di fine serata il locale non sa chi si è presentato davvero, e chiamarle
// visite sarebbe un numero inventato con l'aria di essere vero — il tipo di
// dato su cui poi qualcuno decide di offrire un tavolo.

// Tutte le facce di una riga: gli indirizzi e i numeri con cui quella persona
// può comparire altrove in archivio. Il nome NON c'entra: di Rossi Mario ce ne
// sono tanti, e unirli vorrebbe dire raccontare a uno la serata di un altro.
function chiaviStoriche(riga) {
  const chiavi = new Set();
  // ⚠️ Una prenotazione fatta PER UN ALTRO appartiene a chi cena, non a chi
  // ha scritto: le sue facce sono il numero lasciato come contatto, e basta.
  // Sennò la madre finiva nella scheda del figlio, e la scheda della madre
  // — aperta dalla sua prenotazione — si portava dietro tutte le sere del
  // figlio. Se un numero suo non c'è (il figlio ha detto «no»), resta legata
  // a chi ha scritto: meglio nella scheda sbagliata che sparita.
  const facce = riga.per_altri && String(riga.telefono_contatto || '').trim()
    ? [riga.telefono_contatto]
    : [riga.chat_id, riga.telefono, riga.telefono_contatto];
  for (const v of facce) {
    for (const k of chiaviDellaPersona(v, '')) chiavi.add(k);
  }
  return [...chiavi];
}

// L'email è una chiave a parte perché si confronta minuscola: «Mario@Esempio.it»
// e «mario@esempio.it» sono la stessa casella, e chi la detta al telefono la fa
// scrivere come capita.
function emailChiave(riga) {
  return String(riga.email || '').trim().toLowerCase();
}

// Tutte le prenotazioni della stessa persona, dalla più recente.
//
// ⚠️ Una riga senza NESSUN recapito (una presa a mano al banco, senza numero e
// senza email) sta da sola: senza un aggancio, «la stessa persona» non si può
// sapere, e tirare a indovinare sul nome accosterebbe estranei.
function prenotazioniDellaPersona(db, id, massimo = 200) {
  const riga = db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(id);
  if (!riga) return null;

  // ⚠️ Gli agganci vanno seguiti a CATENA, non solo quelli della riga di
  // partenza. La stessa persona arriva da strade diverse: una prenotazione dal
  // bot ha la chat e il numero, una presa in sala ha solo il numero, una terza
  // ha numero ed email, una quarta solo l'email. Il numero lega le prime tre,
  // e solo la terza lega alla quarta. Fermandosi al primo giro, la scheda
  // mostrava tre prenotazioni su quattro — e aperta dalla quarta ne mostrava
  // due: due persone leggevano due storie diverse della stessa persona.
  //
  // Il prezzo di seguire la catena va detto: due persone che condividono un
  // numero di casa risultano una sola. È come ragiona anche il locale, ma è
  // una scelta, non una verità.
  const chiavi = new Set(chiaviStoriche(riga));
  const email = new Set();
  if (emailChiave(riga)) email.add(emailChiave(riga));
  let righe = [];
  // Cinque giri sono molti più di quanti ne servano: la catena vera è lunga
  // due o tre. Il limite c'è perché un anello senza fine su un archivio grosso
  // blocca la pagina, e nessuno capirebbe perché.
  for (let giro = 0; giro < 5; giro++) {
    const parti = [];
    const valori = [];
    if (chiavi.size) {
      const lista = [...chiavi];
      const seg = lista.map(() => '?').join(',');
      // Per chat e numero contano solo le righe che uno ha fatto PER SÉ: la
      // prenotazione per la madre non è una sera del figlio. Per il numero di
      // contatto invece contano tutte: lì c'è scritto chi cena.
      parti.push(`((chat_id IN (${seg}) OR telefono IN (${seg})) AND per_altri = 0)`,
        `telefono_contatto IN (${seg})`);
      valori.push(...lista, ...lista, ...lista);
    }
    if (email.size) {
      const lista = [...email];
      parti.push(`lower(email) IN (${lista.map(() => '?').join(',')})`);
      valori.push(...lista);
    }
    // Nessun aggancio: la riga è sola con se stessa. Senza questo ramo la
    // condizione sarebbe vuota e tornerebbe l'archivio intero — cioè le serate
    // di tutti gli altri sotto il nome di uno.
    if (!parti.length) { parti.push('id = ?'); valori.push(id); }
    righe = db.prepare(
      `SELECT * FROM prenotazioni WHERE (${parti.join(' OR ')}) ORDER BY data DESC, ora DESC, id DESC LIMIT ?`
    ).all(...valori, massimo);

    let cresciuto = false;
    for (const r of righe) {
      for (const k of chiaviStoriche(r)) if (!chiavi.has(k)) { chiavi.add(k); cresciuto = true; }
      const e = emailChiave(r);
      if (e && !email.has(e)) { email.add(e); cresciuto = true; }
    }
    if (!cresciuto) break;
  }
  return righe;
}

// «Modifica» nella scheda del cliente (23 ottobre 2026): chi ha scritto male
// il suo nome se lo portava dietro per sempre, perché il bot lo riconosce dal
// numero e prende il nome dall'ultima prenotazione. Si corregge su TUTTE le sue
// sere — le stesse righe della scheda, quelle in cui è lui a cenare — e sulla
// lista d'attesa delle stesse chat: da lì in poi il saluto, il riepilogo, i
// promemoria e la sala dicono il nome giusto. Le prenotazioni che ha fatto
// per un'altra persona non sono sue, e non si toccano (la scheda non le ha).
// Il nome passa dai titoli come quello scritto dal cliente.
function rinominaPersona(db, id, nome, cognome) {
  const righe = prenotazioniDellaPersona(db, id, 100000);
  if (!righe || !righe.length) return null;
  const pulito = (x) => String(x || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const giusto = nomeConTitolo(pulito(nome), pulito(cognome));
  if (!giusto.nome && !giusto.cognome) return { errore: 'Scrivi almeno il nome.' };
  const prima = nomeInSala(righe[0]);
  const chiavi = [...new Set(righe.flatMap((r) => chiaviStoriche(r)))];
  db.transaction(() => {
    const scrivi = db.prepare('UPDATE prenotazioni SET nome = ?, cognome = ? WHERE id = ?');
    for (const r of righe) scrivi.run(giusto.nome, giusto.cognome, r.id);
    if (chiavi.length) {
      db.prepare(`UPDATE bot_attese SET nome = ?, cognome = ? WHERE telefono IN (${chiavi.map(() => '?').join(',')})`)
        .run(giusto.nome, giusto.cognome, ...chiavi);
    }
  })();
  return { ...giusto, prima, prenotazioni: righe.length };
}

// «Elimina cliente» dalla scheda (24 ottobre 2026, dal titolare: «così da
// azzerare in memoria il cliente al bot»). Si cancella quello che il bot sa di
// lui — le sue serate (cioè il nome con cui lo saluta e le cose da ricordare),
// la conversazione lasciata a metà, la lista d'attesa, le richieste al
// personale, il menu chiesto, il numero imparato dal profilo — e al prossimo
// messaggio è una persona nuova. Le stesse righe della scheda: quelle in cui è
// lui a cenare. Restano:
// - lo STOP (`bot_stop`). Chi l'ha scritto non riceve più niente, e STOP non
//   si annulla con un tasto: cancellato, il bot ricomincerebbe a scrivergli;
// - le prenotazioni che ha fatto per un'altra persona: sono di chi cena;
// - ⚠️ e un tavolo IN ARRIVO ferma tutto. Cancellarlo da qui vorrebbe dire una
//   sera prenotata che sparisce senza che nessuno l'abbia disdetta, e il
//   cliente che arriva e non c'è. Prima si cancella quello, dal servizio.
// La rubrica è della piattaforma, e la decide il server (vedi la rotta).
function dimenticaPersona(db, id, adesso = new Date()) {
  const righe = prenotazioniDellaPersona(db, id, 100000);
  if (!righe || !righe.length) return null;
  const oggi = comeData(adesso);
  const inArrivo = righe.filter((r) => r.data >= oggi && STATI_VIVI.includes(r.stato))
    .sort((a, b) => (a.data + a.ora < b.data + b.ora ? -1 : 1));
  if (inArrivo.length) {
    const p = inArrivo[0];
    return { errore: `Ha una prenotazione in arrivo (${dataItaliana(p.data)} alle ${p.ora}): `
      + 'prima cancellala dal servizio, poi elimini il cliente.', inArrivo: inArrivo.length };
  }
  const chiavi = [...new Set(righe.flatMap((r) => chiaviStoriche(r)))];
  const numeri = chiavi.filter((k) => /^\d+$/.test(k));
  const conti = { nome: [righe[0].nome, righe[0].cognome].map((x) => String(x || '').trim()).filter(Boolean).join(' '),
    prenotazioni: 0, conversazioni: 0, attese: 0, richieste: 0 };
  db.transaction(() => {
    const via = db.prepare('DELETE FROM prenotazioni WHERE id = ?');
    for (const r of righe) conti.prenotazioni += via.run(r.id).changes;
    if (chiavi.length) {
      const seg = chiavi.map(() => '?').join(',');
      conti.conversazioni = db.prepare(`DELETE FROM bot_conversazioni WHERE telefono IN (${seg})`).run(...chiavi).changes;
      conti.attese = db.prepare(`DELETE FROM bot_attese WHERE telefono IN (${seg})`).run(...chiavi).changes;
      conti.richieste = db.prepare(`DELETE FROM bot_richieste WHERE chat_id IN (${seg}) OR telefono IN (${seg})`)
        .run(...chiavi, ...chiavi).changes;
      db.prepare(`DELETE FROM bot_menu_richieste WHERE telefono IN (${seg})`).run(...chiavi);
    }
    if (numeri.length) {
      db.prepare(`DELETE FROM numeri_visti WHERE telefono IN (${numeri.map(() => '?').join(',')})`).run(...numeri);
    }
  })();
  return conti;
}

// La scheda: chi è, e cosa si vede a colpo d'occhio.
function schedaPersona(db, id, adesso = new Date()) {
  const righe = prenotazioniDellaPersona(db, id);
  if (!righe || !righe.length) return null;
  const oggi = comeData(adesso);
  const attive = righe.filter((r) => r.stato !== 'annullata');
  const passate = attive.filter((r) => r.data < oggi);
  const prossime = attive.filter((r) => r.data >= oggi);
  const annullate = righe.filter((r) => r.stato === 'annullata');

  // Il nome e i recapiti si prendono dalla riga più recente che ce li ha: sono
  // quelli buoni. Uno vecchio può essere un numero cambiato.
  const primo = (campo) => {
    for (const r of righe) { const v = String(r[campo] || '').trim(); if (v && !v.includes('@lid')) return v; }
    return '';
  };

  // Le note che si RIPETONO sono la cosa più utile della scheda: un'allergia
  // scritta una volta due anni fa vale quanto una scritta ieri.
  //
  // ⚠️ Ma non tutte le note sono un fatto permanente. «Compleanno» e «cenone»
  // valevano per quella sera e basta, e messe sotto «da ricordare» insieme a
  // un'allergia fanno lo stesso rumore: chi legge smette di distinguere, ed è
  // esattamente l'allergia a rimetterci. Si dice quindi anche QUANTE volte una
  // nota è comparsa, e le più ricorrenti vengono per prime.
  const volte = {};
  for (const r of attive) {
    const t = String(r.note || '').trim();
    if (t) volte[t] = (volte[t] || 0) + 1;
  }
  const note = Object.entries(volte)
    .map(([testo, quante]) => ({ testo, volte: quante }))
    .sort((a, b) => b.volte - a.volte || a.testo.localeCompare(b.testo));

  // Le richieste fatte al personale — una torta, un seggiolone, «posso
  // portare il cane?» — con cosa gli è stato risposto, e se qualcuna è ancora
  // in attesa. Sono la parte della storia che le prenotazioni non raccontano.
  const chiaviRichieste = new Set();
  for (const r of righe) for (const k of chiaviStoriche(r)) chiaviRichieste.add(k);
  let richieste = [];
  if (chiaviRichieste.size) {
    const lista = [...chiaviRichieste];
    const seg = lista.map(() => '?').join(',');
    richieste = db.prepare(
      'SELECT codice, testo, stato, creata_at, risposta, risposta_da, risposta_at FROM bot_richieste '
      + `WHERE chat_id IN (${seg}) OR telefono IN (${seg}) ORDER BY id DESC LIMIT 8`
    ).all(...lista, ...lista);
  }

  return {
    nome: [primo('nome'), primo('cognome')].filter(Boolean).join(' '),
    // Anche separati: la rubrica li tiene così, e da qui ci si mette.
    nomeProprio: primo('nome'),
    cognome: primo('cognome'),
    telefono: primo('telefono_contatto') || primo('telefono'),
    email: (righe.find((r) => emailChiave(r)) || {}).email || '',
    // «Prenotazioni» sono TUTTE quelle fatte, annullate comprese: è la domanda
    // «quante volte questa persona ci ha scritto». Le passate non si contano
    // più a parte — si vedono nell'elenco, e un numero in più nella riga dei
    // conti è un numero in meno che si legge.
    prenotazioni: righe.length,
    prossime: prossime.length,
    annullate: annullate.length,
    // Solo quelle segnate a mano come concluse: è l'unica presenza che il
    // locale ha davvero registrato. Finché non c'è l'appello resta un numero
    // piccolo, e va bene così — meglio piccolo che inventato.
    concluse: righe.filter((r) => r.stato === 'presentata').length,
    // Le persone portate, sere annullate escluse: «2» o «40» dicono due
    // clienti diversi (24 ottobre 2026, la scheda rifatta).
    coperti: attive.reduce((n, r) => n + (Number(r.persone) || 0), 0),
    primaVolta: passate.length ? passate[passate.length - 1].data : '',
    ultimaVolta: passate.length ? passate[0].data : '',
    note,
    richieste,
    righe,
  };
}


// TUTTI i clienti, per l'elenco della scheda Clienti: le stesse voci della
// ricerca, senza cercare niente. È da qui che il locale mette in rubrica chi
// ha prenotato — cioè il motivo per cui la piattaforma esiste.
// Il tetto è alto ma c'è: un archivio di anni non deve bloccare la pagina.
function elencoPersone(db, adesso = new Date(), massimo = 3000) {
  const righe = db.prepare('SELECT * FROM prenotazioni ORDER BY data DESC, id DESC LIMIT 20000').all();
  return raggruppaPersone(righe, massimo, adesso);
}

// Le righe di una stessa persona diventano una voce sola: la stessa catena
// della scheda, letta sulle righe già in mano invece che sull'archivio. La
// ricerca la fa la pagina su questo elenco: una ricerca a parte, con un suo
// modo di raggruppare, faceva comparire lo stesso Rossi in due modi diversi.
function raggruppaPersone(righe, massimo, adesso = new Date()) {
  const oggi = comeData(adesso);
  // ⚠️ Raggruppare per «il primo aggancio disponibile» spezzava la stessa
  // persona in due voci: quella con l'email da una parte e quella col solo
  // numero dall'altra. Si uniscono invece i gruppi che condividono ANCHE UNA
  // SOLA faccia — è la stessa catena della scheda, letta sulle righe già in
  // mano invece che sull'archivio.
  const gruppi = [];
  for (const r of righe) {
    const facce = new Set(chiaviStoriche(r));
    if (emailChiave(r)) facce.add('email:' + emailChiave(r));
    const tocca = gruppi.filter((g) => [...facce].some((f) => g.facce.has(f)));
    if (!tocca.length) { gruppi.push({ facce, righe: [r] }); continue; }
    // Se ne tocca più d'uno erano già la stessa persona senza saperlo: si
    // fondono, se no resterebbero due voci che si sdoppiano a ogni ricerca.
    const primo = tocca[0];
    for (const f of facce) primo.facce.add(f);
    primo.righe.push(r);
    for (const altro of tocca.slice(1)) {
      for (const f of altro.facce) primo.facce.add(f);
      primo.righe.push(...altro.righe);
      gruppi.splice(gruppi.indexOf(altro), 1);
    }
  }
  // La riga senza nessun aggancio non si fonde con niente: resta una voce sua.
  return gruppi.slice(0, massimo).map(({ righe: g }) => {
    // Il nome è di chi ha scritto per sé, non l'ultimo passato di lì: se il
    // figlio ha prenotato per la madre senza lasciarne il numero, la voce
    // resta intestata al figlio.
    const mio = g.find((r) => !r.per_altri) || g[0];
    return {
    id: g[0].id,
    nome: [mio.nome, mio.cognome].filter(Boolean).join(' ') || '—',
    // Nome e cognome anche separati: l'elenco dei clienti li mostra in due
    // colonne, e la rubrica li tiene separati da sempre.
    nomeProprio: String(mio.nome || '').trim(),
    cognome: String(mio.cognome || '').trim(),
    // Il numero e l'email si prendono dalla prima riga che ce li ha: la più
    // recente può essere quella in cui il cliente non li ha lasciati.
    telefono: (g.find((r) => r.telefono_contatto) || {}).telefono_contatto
      || (g.find((r) => r.telefono && !String(r.telefono).includes('@')) || {}).telefono || '',
    email: (g.find((r) => r.email) || {}).email || '',
    prenotazioni: g.length,
    // ⚠️ «ultima» dev'essere l'ultima volta che è VENUTO, non l'ultima riga in
    // archivio: con una prenotazione futura in mezzo, l'elenco diceva «ultima
    // 8 settembre» di una sera che deve ancora arrivare. Le due cose si dicono
    // separate, che sono due notizie diverse.
    ultima: (g.find((r) => r.data < oggi && r.stato !== 'annullata') || {}).data || '',
    prossima: [...g].reverse().find((r) => r.data >= oggi && r.stato !== 'annullata')?.data || '',
    };
  });
}

// Il pezzo di SQL che cerca la persona in entrambe le colonne, con tutte le
// sue facce. Scritto una volta sola: le due ricerche qui sotto devono guardare
// negli stessi posti, altrimenti ANNULLA trova una prenotazione che l'elenco
// non aveva mostrato.
function dovePersona(chiavi) {
  const segnaposti = chiavi.map(() => '?').join(',');
  return `(chat_id IN (${segnaposti}) OR telefono IN (${segnaposti}))`;
}

function prenotazioneFutura(db, chiave, adesso, numero = '') {
  const chiavi = chiaviDellaPersona(chiave, numero);
  return db.prepare(
    `SELECT * FROM prenotazioni WHERE ${dovePersona(chiavi)} `
    + 'AND stato IN ' + dentro(STATI_VIVI) + ' AND data >= ? ORDER BY data, ora LIMIT 1'
  ).get(...chiavi, ...chiavi, comeData(adesso));
}

// ⚠️ Lo stesso numero PUÒ avere più tavoli prenotati: chi ha già una serata
// segnata può prenotarne un'altra, e il bot glielo propone lui. Guardando solo
// la prima, tutto quello che il bot dice al cliente parlava di quella e basta:
// gli mostrava una prenotazione sola, e CAMBIA e CANCELLA lavoravano su quella
// senza dirlo. Chi credeva di aver disdetto restava prenotato — e in sala
// restava un tavolo apparecchiato per nessuno.
function prenotazioniFuture(db, chiave, adesso, massimo = 5, numero = '') {
  const chiavi = chiaviDellaPersona(chiave, numero);
  return db.prepare(
    `SELECT * FROM prenotazioni WHERE ${dovePersona(chiavi)} `
    + 'AND stato IN ' + dentro(STATI_VIVI) + ' AND data >= ? ORDER BY data, ora, id LIMIT ?'
  ).all(...chiavi, ...chiavi, comeData(adesso), massimo);
}

// ⚠️ CHI TORNA NON DEVE RIDIRE COME SI CHIAMA. Il numero lo conosciamo già —
// è lo stesso aggancio con cui il bot dice «hai già un tavolo giovedì» — e il
// nome ce l'ha dato lui l'ultima volta.
//
// ⚠️ Si prende dalle PRENOTAZIONI, mai dal nome del profilo WhatsApp: quello
// non è un nome. È «Mamma», un'emoji, «Idraulico Luca» — e finirebbe stampato
// sul foglio della sala. Qui c'è solo quello che il cliente ci ha detto lui.
//
// Se lo stesso numero ha più nomi (il telefono di casa) vince il più recente, e
// al riepilogo si può correggere senza perdere niente: vedi il passo «conferma».
function ultimoNomeDi(db, chiave, numero = '') {
  const chiavi = chiaviDellaPersona(chiave, numero);
  if (!chiavi.length) return null;
  const seg = chiavi.map(() => '?').join(',');
  // ⚠️ Il TITOLARE del numero è chi ha scritto il nome di suo pugno. Una
  // prenotazione nata da «non sono io» (`per_altri`) è un'eccezione — il figlio
  // che prenota per la madre — e non cambia mai di chi è il telefono: si
  // scarta anche se è l'ultima, anche se è quella con la data più avanti.
  // Fra le sue vince l'ULTIMA CONVERSAZIONE (id), non la data più lontana.
  const r = db.prepare(
    `SELECT nome, cognome FROM prenotazioni WHERE ${dovePersona(chiavi)} AND per_altri = 0 `
    + "AND TRIM(COALESCE(nome, '')) <> '' ORDER BY id DESC LIMIT 1"
  ).get(...chiavi, ...chiavi);
  if (r) return nomeConTitolo(String(r.nome || '').trim(), String(r.cognome || '').trim());
  // Poi: qualcuno ha prenotato lasciando QUESTO numero come contatto. Chi
  // scrive adesso è la persona nominata su quella prenotazione — la madre,
  // dal suo telefono — e va riconosciuta con il suo nome. Si escludono le
  // righe che quel numero le ha scritte lui stesso: lì è già passato sopra.
  const c = db.prepare(
    `SELECT nome, cognome FROM prenotazioni WHERE telefono_contatto IN (${seg}) `
    + `AND chat_id NOT IN (${seg}) AND telefono NOT IN (${seg}) `
    + "AND TRIM(COALESCE(nome, '')) <> '' ORDER BY id DESC LIMIT 1"
  ).get(...chiavi, ...chiavi, ...chiavi);
  if (c) return nomeConTitolo(String(c.nome || '').trim(), String(c.cognome || '').trim());
  // Ripiego: la rubrica del locale, dove il nome l'ha scritto il ristorante.
  // ⚠️ Si guarda prima se la tabella c'è: il motore del bot gira anche su
  // archivi senza le tabelle della piattaforma (è il caso delle prove), e una
  // query su una tabella assente non fallirebbe piano — farebbe saltare tutto.
  try {
    const c = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'contacts'").get();
    if (!c) return null;
    const numeri = chiavi.filter((k) => /^\d+$/.test(k));
    if (!numeri.length) return null;
    const segnaposti = numeri.map(() => '?').join(',');
    const t = db.prepare(
      `SELECT nome, cognome FROM contacts WHERE telefono IN (${segnaposti}) `
      + "AND TRIM(COALESCE(nome, '')) <> '' ORDER BY id DESC LIMIT 1").get(...numeri);
    if (t) return nomeConTitolo(String(t.nome || '').trim(), String(t.cognome || '').trim());
  } catch (e) {
    // Un ripiego che non riesce non deve portarsi via la conversazione: si
    // torna a chiedere il nome, che è come funzionava prima.
    return null;
  }
  return null;
}

// Per chi da questo numero ha già prenotato per qualcun altro: i nomi usati,
// dal più recente, senza doppioni. Serve al riepilogo — «Per Anna, come
// l'altra volta?» — così la seconda volta non si ribatte nemmeno il nome.
function altriNomiDi(db, chiave, numero = '') {
  const chiavi = chiaviDellaPersona(chiave, numero);
  if (!chiavi.length) return [];
  const righe = db.prepare(
    `SELECT nome, cognome, telefono_contatto FROM prenotazioni WHERE ${dovePersona(chiavi)} `
    + "AND per_altri = 1 AND TRIM(COALESCE(nome, '')) <> '' ORDER BY id DESC LIMIT 20"
  ).all(...chiavi, ...chiavi);
  const visti = new Set();
  const fuori = [];
  for (const r of righe) {
    const nome = String(r.nome || '').trim();
    const cognome = String(r.cognome || '').trim();
    const k = normalizza(`${nome} ${cognome}`);
    if (visti.has(k)) continue;
    visti.add(k);
    // Il numero lasciato l'altra volta si ripropone insieme al nome, ma solo
    // se era davvero un numero SUO: se il figlio aveva detto «no», lì c'è il
    // numero del figlio, e riproporlo come «quello di Anna» sarebbe una bugia.
    const suo = String(r.telefono_contatto || '').trim();
    const telefono = suo && !chiavi.includes(suo) && !chiavi.includes(numeroConfrontabile(suo)) ? suo : '';
    fuori.push({ nome, cognome, telefono });
  }
  return fuori;
}

const FRASE_NON_PIU_ATTIVA = 'Quella prenotazione non è più attiva: nel frattempo è cambiata. '
  + 'Scrivimi di nuovo cosa vuoi fare.';

// Legge la cifra e ricontrolla che quella riga sia ancora buona. Il ricontrollo
// non è pignoleria: fra la domanda e la risposta possono passare ore, e in
// mezzo la sala può aver già annullato quella stessa prenotazione.
function sceltaFraCandidati(candidati, testo, db) {
  const lista = candidati || [];
  const n = /^\d+$/.test(String(testo).trim()) ? +String(testo).trim() : 0;
  if (!n || n < 1 || n > lista.length) {
    return { errore: `Rispondi con un numero da 1 a ${lista.length}.` };
  }
  const riga = db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(lista[n - 1]);
  if (!riga || !STATI_TOCCABILI.includes(riga.stato)) return { riga: null };
  return { riga };
}

// Un elenco numerato corto: si legge su un telefono e si risponde con una
// cifra sola. Data breve, ora, persone — niente altro: il nome è sempre lo
// stesso (è lui), e le note non aiutano a distinguere una sera dall'altra.
//
// Il locale sì, quando non è quello di sempre: il 25 ottobre chi ha il
// bistrot a pranzo e il REAR a cena deve capire quale delle due sta toccando.
function elencoDaScegliere(righe) {
  return righe.map((r, i) => `${i + 1}. ${dataBreve(r.data)} · ${r.ora} · `
    + `${r.persone} ${r.persone === 1 ? 'persona' : 'persone'}`
    + (r.fuori_sala && r.locale_scelto ? ` · ${r.locale_scelto}` : '')).join('\n');
}

// Il testo lo scrive il ristoratore, l'elenco lo mette il programma: se nella
// frase c'è {elenco} va lì, altrimenti in fondo. Così una frase riscritta
// senza il segnaposto non lascia il cliente davanti a una domanda («quale?»)
// senza le cose fra cui scegliere.
function conElenco(testo, righe) {
  const elenco = elencoDaScegliere(righe);
  return String(testo || '').includes('{elenco}')
    ? String(testo).replace(/\{elenco\}/g, elenco)
    : `${testo}\n${elenco}`;
}

// Tutte le prenotazioni da oggi in avanti, in un colpo solo. Serve a chi in
// sala vuole farsi un'idea della settimana senza chiedere giorno per giorno.
//
// ---------------------------------------------------------------------------
//  Il report di un periodo
// ---------------------------------------------------------------------------
//
// Tutto in una funzione sola, lontano dalle rotte: così si può provare senza
// far finta di essere un browser, ed è dove sta il conto che poi qualcuno
// guarda per decidere quanti camerieri chiamare sabato.
//
// ⚠️ Le annullate NON si sommano ai coperti. Sembra ovvio scritto qui, ed è
// l'errore che si fa scrivendo in fretta un SELECT: un report che le conta
// racconta una sala più piena di com'era, e su quel numero si prendono
// decisioni vere.

// I gruppi in cui si contano i tavoli. Non uno per ogni numero: da sette in su
// sono casi rari e una barra per ciascuno è rumore.
const DIMENSIONI = [
  { etichetta: '1', dentro: (n) => n === 1 },
  { etichetta: '2', dentro: (n) => n === 2 },
  { etichetta: '3-4', dentro: (n) => n >= 3 && n <= 4 },
  { etichetta: '5-6', dentro: (n) => n >= 5 && n <= 6 },
  { etichetta: '7 o più', dentro: (n) => n >= 7 },
];

const NOMI_SETTIMANA = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

// Quanti giorni ci sono fra due date comprese.
function giorniFra(dal, al) {
  const a = new Date(dal + 'T12:00:00');
  const b = new Date(al + 'T12:00:00');
  return Math.round((b - a) / 86400000) + 1;
}

function reportPrenotazioni(db, cfg, dal, al) {
  const giorni = Math.max(giorniFra(dal, al), 1);
  const righe = db.prepare(
    'SELECT * FROM prenotazioni WHERE data >= ? AND data <= ? ORDER BY data, ora'
  ).all(dal, al);
  const vive = righe.filter((r) => r.stato !== 'annullata');
  const annullate = righe.filter((r) => r.stato === 'annullata');
  const coperti = vive.reduce((n, r) => n + r.persone, 0);

  const somma = (elenco, chiave) => {
    const m = new Map();
    for (const r of elenco) {
      const k = chiave(r);
      if (!m.has(k)) m.set(k, { prenotazioni: 0, coperti: 0 });
      const v = m.get(k);
      v.prenotazioni += 1;
      v.coperti += r.persone;
    }
    return m;
  };

  // ⚠️ Gli altri locali (il bistrot del 25 ottobre) hanno i loro posti e il
  // loro orario: nei conti della SALA non entrano (24 ottobre 2026). Prima i
  // sessanta coperti del bistrot alzavano il riempimento — calcolato sui posti
  // della sala — e gonfiavano le 12:30 di un turno che la sala non aveva. Nei
  // totali ci sono tutti; il bistrot ha la sua riga in `perLocale`.
  const inSala = vive.filter((r) => !r.fuori_sala);
  const copertiSala = inSala.reduce((n, r) => n + r.persone, 0);

  const perTurno = [...somma(inSala, (r) => r.ora).entries()]
    .map(([ora, v]) => ({ ora, ...v }))
    .sort((a, b) => (a.ora < b.ora ? -1 : 1));

  const perSettimana = somma(inSala, (r) => new Date(r.data + 'T12:00:00').getDay());
  const perGiornoSettimana = NOMI_SETTIMANA.map((nome, i) => ({
    giorno: i, nome, ...(perSettimana.get(i) || { prenotazioni: 0, coperti: 0 }),
  }));

  const perDimensione = DIMENSIONI.map((d) => {
    const dentro = vive.filter((r) => d.dentro(r.persone));
    return {
      etichetta: d.etichetta,
      prenotazioni: dentro.length,
      coperti: dentro.reduce((n, r) => n + r.persone, 0),
    };
  });

  // ⚠️ Il passo della serie cambia col periodo. Un anno giorno per giorno sono
  // trecentosessantacinque colonne larghe un pixel: un grafico che non si legge
  // è peggio di nessun grafico, perché sembra che dica qualcosa.
  const passo = giorni <= 62 ? 'giorno' : giorni <= 400 ? 'settimana' : 'mese';
  const inizioSettimana = (iso) => {
    const d = new Date(iso + 'T12:00:00');
    // Settimana che comincia di lunedì, come la legge chi lavora in un locale.
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return comeData(d);
  };
  const chiaveSerie = (r) => (passo === 'giorno' ? r.data
    : passo === 'settimana' ? inizioSettimana(r.data)
    : r.data.slice(0, 7));
  const serie = [...somma(vive, chiaveSerie).entries()]
    .map(([k, v]) => ({ chiave: k, ...v }))
    .sort((a, b) => (a.chiave < b.chiave ? -1 : 1));

  // Quanto si è riempito: i coperti serviti sui coperti che si potevano
  // servire nei giorni in cui il locale era aperto. I giorni chiusi non
  // entrano nel conto — se no un locale chiuso il lunedì risulterebbe sempre
  // mezzo vuoto per il solo fatto di riposare.
  const perTurnoCfg = usaTavoli(db)
    ? capienzaDi(db, cfg)
    : num(cfg.bot_coperti_turno, 0) - num(cfg.bot_coperti_liberi, 0);
  let possibili = 0;
  let apertiConta = 0;
  let pieniConta = 0;
  for (let i = 0; i < giorni; i++) {
    const iso = comeData(piuGiorni(new Date(dal + 'T12:00:00'), i));
    const turni = turniDelGiorno(cfg, iso);
    if (ePieno(db, iso)) pieniConta += 1;
    if (!turni.length || eBloccato(db, iso)) continue;
    apertiConta += 1;
    possibili += Math.max(perTurnoCfg, 0) * giriDelGiorno(cfg, iso);
  }

  // Chi era già stato qui prima di questo periodo. È la domanda che dice se il
  // locale sta crescendo o sta girando sugli stessi.
  const chiaveCliente = (r) => String(r.email || '').trim().toLowerCase()
    || numeroConfrontabile(r.telefono_contatto || r.telefono)
    || String(r.chat_id || '') || `riga:${r.id}`;
  const prima = new Set(
    db.prepare('SELECT * FROM prenotazioni WHERE data < ?').all(dal).map(chiaveCliente)
  );
  const clienti = new Set(vive.map(chiaveCliente));
  let diRitorno = 0;
  for (const c of clienti) if (prima.has(c)) diRitorno += 1;

  const piuAlto = (elenco) => elenco.reduce(
    (max, x) => (!max || x.coperti > max.coperti ? x : max), null);

  // ---- Quello che il report non diceva (24 ottobre 2026) ----
  // Pranzo e cena: due servizi con la loro sala e il loro personale.
  const perServizio = { pranzo: { prenotazioni: 0, coperti: 0 }, cena: { prenotazioni: 0, coperti: 0 } };
  for (const r of inSala) {
    const s = servizioDellOra(cfg, r.data, r.ora) === 'pranzo' ? 'pranzo' : 'cena';
    perServizio[s].prenotazioni += 1;
    perServizio[s].coperti += r.persone;
  }
  // Le esperienze: quanto vale il business lunch, quanto il degustazione. Vuoto
  // se nessuna prenotazione ne ha una — allora la sezione non c'è.
  const conEsperienza = vive.some((r) => String(r.esperienza || '').trim());
  const perEsperienza = conEsperienza
    ? [...somma(vive.filter((r) => !r.fuori_sala), (r) => String(r.esperienza || '').trim() || '').entries()]
      .map(([nome, v]) => ({ nome, ...v }))
      .sort((a, b) => (!a.nome) - (!b.nome) || b.coperti - a.coperti)
    : [];
  // Quanto prima prenotano: se tutti scrivono il giorno stesso, il promemoria
  // del giorno prima non serve a niente, e la sala si decide all'ultimo.
  const ANTICIPI = [
    { etichetta: 'stesso giorno', dentro: (g) => g <= 0 },
    { etichetta: 'giorno prima', dentro: (g) => g === 1 },
    { etichetta: '2–6 giorni prima', dentro: (g) => g >= 2 && g <= 6 },
    { etichetta: '7+ giorni prima', dentro: (g) => g >= 7 },
  ];
  const anticipoDi = (r) => {
    const quando = String(r.creata_at || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(quando) ? giorniFra(quando, r.data) - 1 : null;
  };
  const conAnticipo = vive.map(anticipoDi).filter((g) => g !== null);
  const anticipo = ANTICIPI.map((a) => ({ etichetta: a.etichetta, prenotazioni: conAnticipo.filter(a.dentro).length }));
  // Quando scrivono al bot: a che ora sono arrivate le prenotazioni che ha
  // preso lui. Quelle della notte sono il lavoro che senza bot non si faceva.
  const FASCE_ORARIE = [
    { etichetta: 'notte 0–8', da: 0, a: 8 },
    { etichetta: 'mattina 8–12', da: 8, a: 12 },
    { etichetta: 'pranzo 12–15', da: 12, a: 15 },
    { etichetta: 'pomeriggio 15–19', da: 15, a: 19 },
    { etichetta: 'sera 19–24', da: 19, a: 24 },
  ];
  const dalBot = vive.filter((r) => r.origine !== 'manuale');
  const oraDi = (r) => { const m = String(r.creata_at || '').match(/ (\d{2}):/); return m ? Number(m[1]) : null; };
  const quandoScrivono = FASCE_ORARIE.map((f) => ({
    etichetta: f.etichetta,
    prenotazioni: dalBot.filter((r) => { const h = oraDi(r); return h !== null && h >= f.da && h < f.a; }).length,
  }));
  // I clienti che sono venuti più volte nel periodo: due o più, i primi cinque.
  const perCliente = new Map();
  for (const r of vive) {
    const k = chiaveCliente(r);
    if (!perCliente.has(k)) perCliente.set(k, { nome: '', prenotazioni: 0, coperti: 0, ultima: '' });
    const c = perCliente.get(k);
    c.prenotazioni += 1;
    c.coperti += r.persone;
    if (r.data >= c.ultima) { c.ultima = r.data; c.nome = [r.nome, r.cognome].map((x) => String(x || '').trim()).filter(Boolean).join(' '); }
  }
  const fedeli = [...perCliente.values()].filter((c) => c.prenotazioni >= 2)
    .sort((a, b) => b.prenotazioni - a.prenotazioni || b.coperti - a.coperti || a.nome.localeCompare(b.nome))
    .slice(0, 5)
    .map(({ nome, prenotazioni, coperti: suoi }) => ({ nome: nome || 'senza nome', prenotazioni, coperti: suoi }));
  // I locali, se ce n'è più d'uno con prenotazioni nel periodo: ognuno coi
  // suoi coperti, gli altri anche sui loro posti.
  const fuori = vive.filter((r) => r.fuori_sala);
  const locali = localiDi(cfg);
  const perLocale = fuori.length ? [
    { nome: (locali.principale && locali.principale.nome) || cfg.bot_locale || 'Il locale', prenotazioni: inSala.length, coperti: copertiSala, posti: 0 },
    ...[...somma(fuori, (r) => String(r.locale_scelto || '').trim() || 'Altro locale').entries()].map(([nome, v]) => {
      const a = altroLocaleDi(cfg, nome);
      return { nome, ...v, posti: a ? num(a.coperti, 0) : 0 };
    }),
  ] : [];

  // Le cancellazioni, TUTTE (dal titolare, 24 ottobre 2026: prima «Perché si
  // cancella» guardava solo quelle a mano). Il bot non scrive né motivo né da
  // dove — e non deve —, ma l'ora la scrive sempre (`annullata_at`), mentre le
  // pagine fino al 24 ottobre non la scrivevano. Così:
  //   - sala, piattaforma, appello: il loro motivo (le tre scelte rapide
  //     scritte in qualunque modo; «Altro motivo» quelle a mano; e chi non
  //     l'ha scritto);
  //   - senza «da dove» ma con l'ora: il bot. Scaduta senza pagare (vedi
  //     `liberaScadute`: dovuto, non pagato, con una scadenza) o «Su
  //     WhatsApp» (il cliente che disdice, o il responsabile col comando);
  //   - senza né l'uno né l'altra: a mano, prima del 24 ottobre.
  const RAPIDI = ['Ha disdetto', 'Non si è presentato', 'Errore / doppione'];
  const motivoDi = (r) => {
    if (r.annullata_da) {
      const m = String(r.motivo_annullamento || '').trim();
      return !m ? 'A mano, senza motivo' : (RAPIDI.find((x) => normalizza(x) === normalizza(m)) || 'Altro motivo');
    }
    if (!r.annullata_at) return 'Prima del 24 ottobre';
    return r.importo_dovuto > 0 && !r.pagato_at && r.pagamento_scade_at ? 'Pagamento non arrivato' : 'Su WhatsApp';
  };
  const IN_FONDO = ['Altro motivo', 'A mano, senza motivo', 'Prima del 24 ottobre'];
  const perMotivo = [...somma(annullate, motivoDi).entries()].map(([motivo, v]) => ({ motivo, ...v }))
    .sort((a, b) => IN_FONDO.indexOf(a.motivo) - IN_FONDO.indexOf(b.motivo) || b.prenotazioni - a.prenotazioni);

  return {
    dal, al, giorni,
    totale: {
      prenotazioni: vive.length,
      coperti,
      // I coperti della sala, senza gli altri locali (vedi `inSala`).
      copertiSala,
      annullate: annullate.length,
      copertiPersi: annullate.reduce((n, r) => n + r.persone, 0),
      concluse: righe.filter((r) => r.stato === 'presentata').length,
      // Una media che si legge: «2,4 persone a tavolo», non 2.3999999.
      mediaCoperti: vive.length ? Math.round((coperti / vive.length) * 10) / 10 : 0,
    },
    origine: {
      bot: vive.filter((r) => r.origine !== 'manuale').length,
      manuale: vive.filter((r) => r.origine === 'manuale').length,
    },
    perTurno,
    perGiornoSettimana,
    perDimensione,
    serie: { passo, punti: serie },
    riempimento: {
      possibili, aperti: apertiConta,
      // Solo la sala: i posti sono i suoi (vedi `inSala`).
      quota: possibili ? Math.round((copertiSala / possibili) * 100) : 0,
    },
    soldOut: pieniConta,
    clienti: { totali: clienti.size, diRitorno, nuovi: clienti.size - diRitorno },
    menu: statisticheMenu(db, dal, al),
    perServizio,
    perEsperienza,
    anticipo,
    quandoScrivono,
    fedeli,
    perLocale,
    perMotivo,
    turnoTop: piuAlto(perTurno),
    giornoTop: piuAlto(perGiornoSettimana.filter((g) => g.coperti > 0)),
  };
}

// Qui NON si stampano telefoni e note: e' una veduta dall'alto, e riempirla di
// dettagli la renderebbe illeggibile proprio nel momento in cui serve corta.
// Per il dettaglio di una serata c'e' gia' PRENOTAZIONI.
function elencoTutte(db, cfg, adesso = new Date(), massimo = 40) {
  const oggi = comeData(adesso);
  const righe = db.prepare(
    'SELECT * FROM prenotazioni WHERE data >= ? AND stato IN ' + dentro(STATI_VIVI) + ' '
    + 'ORDER BY data, ora, id'
  ).all(oggi);

  if (!righe.length) return '📋 Non c\'è nessuna prenotazione da oggi in avanti.';

  // ⚠️ Si legge su WhatsApp, su un telefono: una riga oltre i trenta caratteri
  // va a capo, e un elenco che va a capo a ogni riga non si scorre più — si
  // legge. Quindi righe corte: ora, chi, quanti. Niente «pers.», niente «(a
  // mano)» — quello serve nell'elenco della serata, non nella veduta d'insieme.
  const mostrate = righe.slice(0, massimo);
  const restano = righe.length - mostrate.length;
  const parti = ['📋 Prenotazioni da oggi'];
  let giornoCorrente = null;

  for (const r of mostrate) {
    if (r.data !== giornoCorrente) {
      giornoCorrente = r.data;
      const coperti = righe.filter((x) => x.data === r.data).reduce((n, x) => n + x.persone, 0);
      parti.push('');
      parti.push(`📅 ${r.data === oggi ? 'OGGI' : dataBreve(r.data)} — ${coperti} ${coperti === 1 ? 'coperto' : 'coperti'}`);
    }
    // Le persone fra parentesi in fondo: sono un numero, e un numero si trova
    // a colpo d'occhio meglio di «3 pers.» in mezzo alla riga.
    parti.push(`${r.ora} · ${nomeInSala(r)} (${r.persone})`);
  }

  const coperti = righe.reduce((n, r) => n + r.persone, 0);
  parti.push('');
  if (restano) parti.push(`⚠️ Ne mancano ${restano}: chiedi PRENOTAZIONI di un giorno.`);
  parti.push(`Totale: ${righe.length} ${righe.length === 1 ? 'prenotazione' : 'prenotazioni'} · `
    + `${coperti} ${coperti === 1 ? 'coperto' : 'coperti'}`);
  return parti.join('\n');
}

// ---------- La prenotazione presa dalla sala, chiesta passo per passo ----------
//
// Il responsabile scrive NUOVA e il bot gli fa le stesse domande che farebbe a
// un cliente. Le domande sono le stesse, ma la conversazione è un'altra cosa e
// tenerle separate è voluto:
//
//   • gli interpreti sono gli STESSI del percorso cliente (giorno, ora,
//     persone, nome, telefono). Le regole di lettura restano una sola: se
//     domani «sabato prossimo» cambia significato, cambia per tutti e due;
//   • il percorso invece è diverso, e deve esserlo. Chi è in sala può
//     sforare i coperti, può prendere le 21:15 che non è un turno, può
//     prenotare per stasera fra dieci minuti, e il telefono che scrive è di
//     un ALTRO — non suo. A un cliente niente di tutto questo è permesso.
//
// Le frasi qui sono scritte nel programma e non fra i testi modificabili: le
// legge il personale, non il cliente. Non c'è nessun tono da curare, e una
// manopola in più nelle impostazioni è una manopola che qualcuno sposta.

const PAROLE_NUOVA = /^(nuova|nuovaprenotazione|nuova prenotazione|aggiungi|prenota|prenotazione nuova)\b/i;

// «ANNULLA PRENOTAZIONE Rossi» — due parole, non una sola: la parola singola
// «annulla» è già presa dall'uscita di emergenza qui sopra, e dal cliente che
// disdice la SUA prenotazione (in elaboraMessaggio, un altro percorso). Qui il
// nome è obbligatorio nello stesso messaggio: senza, la sala dovrebbe prima
// scrivere «annulla prenotazione» e poi il nome in un secondo messaggio, e i
// due si confonderebbero con l'uscita di emergenza vista sopra.
// E vale anche «CANCELLA PRENOTAZIONE Rossi»: da quando è CANCELLA la parola
// che il bot dice ai clienti, chi sta in sala la legge tutto il giorno e
// prima o poi la scrive. Farla rimbalzare sarebbe una distinzione che
// esiste solo nella testa di chi ha scritto il programma.
const PAROLE_ANNULLA_PRENOTAZIONE = /^(?:annulla|cancella)\s+prenotazione(?:\s+(.+))?$/i;

// La parola secca che il bot suggerisce: «CAMBIA», al massimo «cambiare la
// prenotazione». Niente di più lungo, perché una frase intera può chiedere di
// cambiare tutt'altro — le persone, il nome — e su quello il bot non decide.
// «NUOVA» — la parola con cui il cliente fa ripartire una prenotazione da capo.
//
// ⚠️ Prima non c'era. A chi aveva già un tavolo il bot diceva «se vuoi
// prenotarne un altro, dimmi per quante persone» e SI METTEVA IN ATTESA di un
// numero. Chi rispondeva «ok» o «va bene» — cioè quasi tutti — si sentiva dire
// «non ho capito il numero», rispondeva ancora, e alla seconda volta la
// conversazione passava a una persona. Un giro a vuoto nato da una domanda che
// nessuno aveva fatto: il bot aspettava la risposta a una cosa che aveva solo
// accennato.
//
// Con una parola sola il cliente DICE quando vuole ricominciare, e il bot non
// deve indovinarlo.
const PAROLA_NUOVA = /^(?:vorrei |voglio |posso |puoi |fare |una |un |si |sì |ok )*(?:nuova|nuovo)(?:\s+(?:prenotazione|tavolo))?\s*[.!]*$/i;

// Un'email scritta bene. È volutamente permissiva: qui si intercetta chi ha
// battuto «mario.rossi» senza chiocciola, non chi ha una casella che non
// esiste — quello si scopre solo provando a scrivergli. Un controllo severo
// respingerebbe indirizzi veri e farebbe perdere la prenotazione.
const EMAIL_SEMPLICE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const SOLO_CAMBIA = /^(?:vorrei |voglio |posso |puoi |si |sì )*(?:cambia(?:re|la|rla)?|cambio)(?:\s+la)?(?:\s+prenotazione)?\s*[.!]*$/i;

// ⚠️ Una prenotazione dettata a metà e poi lasciata lì bloccava TUTTO. Finché
// quella conversazione risultava «in corso», ogni messaggio successivo del
// responsabile veniva letto come la risposta alla domanda rimasta in sospeso:
// scriveva LISTA e si sentiva rispondere «non ho capito il numero», per
// sempre. E in servizio capita di continuo di cominciare una prenotazione al
// telefono e di essere interrotti.
//
// Mezz'ora è più di quanto serva a dettare una prenotazione, e molto meno di
// quanto passa fra un servizio e l'altro: dopo, il messaggio nuovo è un
// comando nuovo. Quello che era stato dettato resta nell'archivio, ma non
// tiene più in ostaggio la conversazione.
const SALA_MINUTI = 30;

function salaInCorso(db, chiave, adesso = new Date()) {
  const r = db.prepare('SELECT passo, aggiornata_at FROM bot_conversazioni WHERE telefono = ?').get(chiave);
  if (!r || !String(r.passo || '').startsWith('sala_')) return false;
  if (!r.aggiornata_at) return true;
  // Le date qui sono scritte in ora locale con lo spazio in mezzo: la «T» la
  // vuole il costruttore, altrimenti su alcuni motori la lettura fallisce.
  const quando = new Date(String(r.aggiornata_at).replace(' ', 'T'));
  if (Number.isNaN(quando.getTime())) return true;
  return (adesso - quando) / 60000 < SALA_MINUTI;
}

// Un'ora qualsiasi, anche fuori dai turni: «21:15» per un tavolo che si sa che
// si libera. Il cliente non può, la sala sì.
function oraQualsiasi(testo) {
  const m = normalizza(testo).match(/^(\d{1,2})\s*(?::|\.|,|e)?\s*(\d{2})?$/);
  if (!m) return null;
  const ore = +m[1], min = m[2] ? +m[2] : 0;
  if (ore > 23 || min > 59) return null;
  return `${String(ore).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function elaboraMessaggioSala(db, chiave, testo, adesso = new Date()) {
  // Tutto quello che si salva qui dentro porta la data di QUESTO adesso.
  const salvaStato = (d, t, p, dd) => scriviStato(d, t, p, dd, adesso);
  const azzeraStato = (d, t) => scriviStato(d, t, 'inizio', {}, adesso);
  const cfg = config(db);
  const risposte = [];
  const esito = { gestito: true, risposte, prenotazione: null, avvisa: null, annullata: null };
  const t = String(testo || '').trim();
  // ⚠️ L'orologio si PASSA, sempre. Chiamando `statoDi` e `salaInCorso` senza,
  // quelle guardavano l'ora vera mentre lo stato era stato scritto con l'ora
  // ricevuta qui: due orologi diversi sulla stessa conversazione. In esercizio
  // coincidono e non si vede niente; in prova la via d'uscita «ANNULLA» smetteva
  // di funzionare a seconda dell'ora in cui si lanciavano le prove — e sarebbe
  // saltata fuori davvero il giorno in cui si corregge l'ora del computer.
  const stato = statoDi(db, chiave, adesso);
  const dati = stato.dati || {};
  const chiedi = (passo, d, domanda) => { salvaStato(db, chiave, passo, d); risposte.push(domanda); return esito; };

  // Una via d'uscita che funziona a ogni passo. Senza, chi sbaglia a metà
  // resta prigioniero delle domande e l'unico modo di uscirne è aspettare.
  if (/^(annulla|stop|basta|lascia perdere|esci)$/i.test(t) && salaInCorso(db, chiave, adesso)) {
    azzeraStato(db, chiave);
    risposte.push('Lasciato perdere: non ho segnato niente.');
    return esito;
  }

  if (PAROLE_NUOVA.test(t) && !salaInCorso(db, chiave, adesso)) {
    return chiedi('sala_persone', {}, 'Prenotazione a mano.\nPer quante persone?');
  }

  const chiedeAnnullo = t.match(PAROLE_ANNULLA_PRENOTAZIONE);
  if (chiedeAnnullo && !salaInCorso(db, chiave, adesso)) {
    const cercato = normalizza(chiedeAnnullo[1]);
    if (!cercato) {
      risposte.push('Dopo CANCELLA PRENOTAZIONE serve il nome, per esempio: CANCELLA PRENOTAZIONE Rossi.');
      return esito;
    }
    // Solo le attive, da oggi in avanti: una già passata l'ha già gestita
    // l'appello di fine serata (conclusa o cancellata), non questo
    // comando — cercarla qui vorrebbe dire far scegliere alla sala fra
    // dozzine di righe vecchie per trovare quella di stasera.
    const righe = db.prepare(
      'SELECT * FROM prenotazioni WHERE stato IN ' + dentro(STATI_TOCCABILI) + ' AND data >= ? ORDER BY data, ora, id'
    ).all(comeData(adesso)).filter(
      (r) => normalizza([r.nome, r.cognome].filter(Boolean).join(' ')).includes(cercato)
    );
    return avviaAnnullo(righe, chiedeAnnullo[1].trim());
  }

  function rigaAnnullo(r) {
    return `${dataItaliana(r.data)} alle ${r.ora}, ${r.persone} ${r.persone === 1 ? 'persona' : 'persone'}, `
      + nomeInSala(r)
      + (r.note ? ` (${r.note})` : '');
  }

  function avviaAnnullo(righe, query) {
    if (!righe.length) {
      risposte.push(`Non trovo nessuna prenotazione attiva a nome «${query}».`);
      return esito;
    }
    if (righe.length === 1) {
      salvaStato(db, chiave, 'sala_annulla_conferma', { id: righe[0].id });
      risposte.push(`Annullo questa?\n\n📅 ${rigaAnnullo(righe[0])}\n\nScrivi SI per annullarla, NO per lasciar perdere.`);
      return esito;
    }
    // Nove righe bastano a leggersi su un telefono, ma se ce ne sono altre va
    // DETTO: chi cerca un cognome comune sceglierebbe fra le prime nove
    // credendo che siano tutte, e non annullerebbe mai la decima.
    const mostrate = righe.slice(0, 9);
    const restano = righe.length - mostrate.length;
    salvaStato(db, chiave, 'sala_annulla_quale', { candidati: mostrate.map((r) => r.id) });
    risposte.push(`Ne trovo ${righe.length} a nome «${query}»`
      + (restano ? `, ti mostro le prime ${mostrate.length}` : '') + ':\n\n'
      + mostrate.map((r, i) => `${i + 1}. ${rigaAnnullo(r)}`).join('\n')
      + (restano ? `\n\n(altre ${restano}: scrivi il nome per esteso per restringere)` : '')
      + '\n\nQuale? Rispondi con il numero, oppure ANNULLA per lasciar perdere.');
    return esito;
  }

  if (stato.passo === 'sala_annulla_quale') {
    const candidati = dati.candidati || [];
    const n = /^\d+$/.test(t) ? +t : 0;
    if (!n || n < 1 || n > candidati.length) {
      risposte.push(`Rispondi con un numero da 1 a ${candidati.length}, oppure ANNULLA per lasciar perdere.`);
      return esito;
    }
    const scelta = db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(candidati[n - 1]);
    if (!scelta || !STATI_TOCCABILI.includes(scelta.stato)) {
      // Nel tempo fra la ricerca e la scelta qualcuno può averla già toccata
      // (un altro responsabile, un cliente che l'ha annullata da sé): meglio
      // dirlo che annullare qualcosa che non è più quello che si vede a video.
      azzeraStato(db, chiave);
      risposte.push('Quella prenotazione non è più attiva: nel frattempo è cambiata. Ripeti pure la ricerca.');
      return esito;
    }
    salvaStato(db, chiave, 'sala_annulla_conferma', { id: scelta.id });
    risposte.push(`Annullo questa?\n\n📅 ${rigaAnnullo(scelta)}\n\nScrivi SI per annullarla, NO per lasciar perdere.`);
    return esito;
  }

  if (stato.passo === 'sala_annulla_conferma') {
    const scelta = interpretaSiNo(t);
    if (scelta === null) {
      risposte.push('Scrivi SI per annullarla oppure NO per lasciar perdere.');
      return esito;
    }
    azzeraStato(db, chiave);
    if (scelta === false) {
      risposte.push('Lasciato perdere: la prenotazione resta attiva.');
      return esito;
    }
    const p = db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(dati.id);
    if (!p || !STATI_TOCCABILI.includes(p.stato)) {
      risposte.push('Non è più una prenotazione attiva: qualcuno l\'ha già toccata nel frattempo.');
      return esito;
    }
    db.prepare("UPDATE prenotazioni SET stato = 'annullata', annullata_at = datetime('now','localtime') WHERE id = ?").run(p.id);
    esito.annullata = db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(p.id);
    risposte.push(`✅ Annullata: ${rigaAnnullo(esito.annullata)}.`);
    return esito;
  }

  if (stato.passo === 'sala_persone') {
    // Nessun tetto massimo, al contrario del cliente: se la sala scrive 30 è
    // perché ha davvero un gruppo di 30, e il bot non è quello che deve dirle
    // di no. Il controllo sui coperti arriva dopo, al riepilogo.
    const persone = interpretaPersone(t);
    if (!persone || persone < 1 || persone > 300) {
      risposte.push('Non ho capito il numero. Scrivi solo quante persone (per esempio: 4).');
      return esito;
    }
    return chiedi('sala_giorno', { ...dati, persone }, 'Per quale giorno?\n(oggi, domani, sabato, 25/8…)');
  }

  if (stato.passo === 'sala_giorno') {
    const data = interpretaData(t, adesso);
    if (!data) {
      risposte.push('Non ho capito il giorno. Scrivi «oggi», «domani», il nome del giorno oppure 25/8.');
      return esito;
    }
    if (data < comeData(adesso)) {
      risposte.push(`${dataItaliana(data)} è già passato. Che giorno intendevi?`);
      return esito;
    }
    const turni = turniDelGiorno(cfg, data);
    const avviso = eChiuso(db, data) || !turni.length
      ? `\n⚠️ ${dataItaliana(data)} il locale risulta chiuso: se la segno lo stesso, la segno fuori orario.` : '';
    return chiedi('sala_ora', { ...dati, data },
      `${dataItaliana(data)}. A che ora?`
      + (turni.length ? `\nTurni: ${turni.join(' · ')} — o scrivi un'ora qualsiasi.` : '')
      + avviso);
  }

  if (stato.passo === 'sala_ora') {
    const turni = turniDelGiorno(cfg, dati.data);
    const ora = interpretaOra(t, turni) || oraQualsiasi(t);
    if (!ora) {
      risposte.push('Non ho capito l\'ora. Scrivila così: 20:00.');
      return esito;
    }
    return chiedi('sala_nome', { ...dati, ora }, 'A che nome?');
  }

  if (stato.passo === 'sala_nome') {
    const { nome, cognome } = dividiNome(t);
    if (!nome) {
      risposte.push('Mi serve almeno un nome: senza, in sala non si capisce di chi è il tavolo.');
      return esito;
    }
    return chiedi('sala_telefono', { ...dati, nome, cognome },
      'Il telefono del cliente?\n(scrivi NO se non ce l\'hai)');
  }

  if (stato.passo === 'sala_telefono') {
    if (interpretaSiNo(t) === false) return chiedi('sala_note', { ...dati, telefono: '' }, 'Note? (allergie, occasione…)\nScrivi NO se non ce ne sono.');
    const numero = interpretaTelefono(t);
    if (!numero) {
      risposte.push('Quel numero non mi torna. Riscrivilo, oppure scrivi NO per lasciarlo vuoto.');
      return esito;
    }
    // Qui, a differenza del cliente, il prefisso internazionale va aggiunto
    // subito: il numero del cliente lo detta la sala a voce, non arriva già
    // completo dall'indirizzo della chat. Senza questo passaggio il riepilogo
    // mostra un numero e la tabella ne salva un altro — la stessa incoerenza
    // che il resto del bot evita sempre.
    const conPrefisso = /^3\d{8,9}$/.test(numero) ? '39' + numero : numero;
    return chiedi('sala_note', { ...dati, telefono: conPrefisso }, 'Note? (allergie, occasione…)\nScrivi NO se non ce ne sono.');
  }

  if (stato.passo === 'sala_note') {
    const note = interpretaSiNo(t) === false ? '' : t.slice(0, 200);
    const d = { ...dati, note };
    salvaStato(db, chiave, 'sala_conferma', d);
    // Il numero che serve qui e' quello che resta DOPO aver segnato questa,
    // non prima: chi sta per scrivere SI vuole sapere com'e' messo il turno
    // quando avra' finito. Dicendo «restano 6» mentre se ne stanno segnando 2
    // sembrava che dopo ne restassero ancora 6, e il conto non tornava mai.
    // Con i tavoli la riga che serve è QUALE tavolo: «restano 6 coperti» non
    // dice se quei sei sono un tavolo o sei sedie sparse. Chi detta dal
    // personale può sforare — è una persona, decide lei — ma lo deve sapere
    // prima del SI, non scoprirlo in sala.
    let posto;
    if (usaTavoli(db)) {
      const t = trovaTavolo(db, cfg, d.data, d.ora, d.persone, { ancheSala: true });
      posto = t
        ? `🪑 C'è un tavolo libero per ${d.persone}: il numero lo assegnate voi in sala.`
        : `⚠️ A quell'ora non c'è un tavolo libero per ${d.persone}: la segno lo stesso, e il posto lo trovate voi.`;
    } else {
      const liberi = postiLiberi(db, cfg, d.data, d.ora);
      const dopo = liberi - d.persone;
      posto = dopo >= 0
        ? `Dopo questa restano ${dopo} ${dopo === 1 ? 'coperto libero' : 'coperti liberi'} su quel turno.`
        : `⚠️ Su quel turno restano ${liberi < 0 ? 0 : liberi} coperti: la sfori di ${-dopo}.`;
    }
    risposte.push(
      `Controlla:\n\n`
      + `📅 ${dataItaliana(d.data)} alle ${d.ora}\n`
      + `👥 ${d.persone} ${d.persone === 1 ? 'coperto' : 'coperti'}\n`
      + `🙍 ${nomeInSala(d)}\n`
      + (d.telefono ? `📞 +${d.telefono}\n` : '📞 —\n')
      + (d.note ? `📝 ${d.note}\n` : '')
      + `\n${posto}\n`
      + `\nScrivi SI per segnarla, NO per lasciar perdere.`);
    return esito;
  }

  if (stato.passo === 'sala_conferma') {
    const scelta = interpretaSiNo(t);
    if (scelta === null) { risposte.push('Scrivi SI per segnarla oppure NO per lasciar perdere.'); return esito; }
    if (scelta === false) { azzeraStato(db, chiave); risposte.push('Lasciato perdere: non ho segnato niente.'); return esito; }

    // `origine = 'manuale'` non è un dettaglio contabile: nella pagina questa
    // prenotazione porta la targhetta «admin», e chi la legge sa che il
    // cliente non ha mai scritto al bot — quindi non ha ricevuto nessuna
    // conferma, se non gliel'hanno mandata apposta.
    // Il tavolo NON si sceglie qui: lo assegna la sala (vedi `daAssegnare`).
    const info = db.prepare(
      'INSERT INTO prenotazioni (telefono, nome, cognome, data, ora, persone, note, telefono_contatto, tavolo, origine) '
      + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'manuale')"
    ).run(dati.telefono || '', dati.nome || '', dati.cognome || '', dati.data, dati.ora,
          dati.persone, dati.note || '', dati.telefono || '', '');
    const p = db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(info.lastInsertRowid);
    esito.prenotazione = p;
    // Se quel cliente stava in lista per quel giorno, adesso ha un tavolo.
    esceDallaLista(db, p.telefono, p.data, p.id);

    const occupati = copertiOccupati(db, cfg, p.data, p.ora);
    salvaStato(db, chiave, 'sala_fatta', { ultima: p.id });
    risposte.push(
      `✅ Segnata: ${dataItaliana(p.data)} alle ${p.ora}, ${p.persone} ${p.persone === 1 ? 'coperto' : 'coperti'}, `
      + `${nomeInSala(p)}.\n`
      + (p.tavolo ? `🪑 Tavolo ${p.tavolo}.\n` : '')
      + `Ora ${p.ora} è a ${occupati}/${capienzaDi(db, cfg)}.`
      + (p.telefono ? '\n\nScrivi AVVISA se vuoi che gli mandi la conferma su WhatsApp.' : ''));
    return esito;
  }

  if (stato.passo === 'sala_fatta') {
    // Il messaggio al cliente NON parte da solo, e non è pigrizia: è un
    // WhatsApp a qualcuno che al locale non ha mai scritto. Per una
    // prenotazione presa al telefono ci sta; per un numero copiato di fretta è
    // un messaggio a uno sconosciuto. Lo decide chi era al telefono.
    if (/^avvisa\b/i.test(t)) {
      const p = db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(dati.ultima);
      azzeraStato(db, chiave);
      if (!p || !p.telefono) { risposte.push('Di quella prenotazione non ho il telefono.'); return esito; }
      esito.avvisa = p;
      return esito;
    }
    // Qualunque altra cosa: la parentesi è chiusa e il messaggio riparte da
    // capo. Il giro daccapo NON è un vezzo: chi segna due tavoli di fila
    // scrive «NUOVA» subito dopo la conferma, e senza questo passaggio quella
    // parola veniva mangiata dalla domanda «vuoi avvisarlo?» — la seconda
    // prenotazione non partiva e nessuno capiva perché.
    azzeraStato(db, chiave);
    return elaboraMessaggioSala(db, chiave, testo, adesso);
  }

  esito.gestito = false;
  return esito;
}

// ---------- L'elenco per chi è in sala ----------

// Un numero si mostra solo se è davvero un numero. Sopra le 14 cifre è un
// identificativo interno di WhatsApp: stamparlo col + davanti fa credere a un
// recapito vero, e qualcuno prima o poi ci prova a chiamare.
function numeroMostrabile(valore) {
  const t = String(valore || '');
  if (!t || t.includes('@')) return '';
  const cifre = t.replace(/\D/g, '');
  if (cifre.length < 8 || cifre.length > 14) return '';
  return '+' + cifre;
}

// Le prenotazioni di un giorno, scritte come le legge chi è in sala: un solo
// messaggio, in ordine di orario, coi totali per turno in fondo.
//
// La numerazione è la STESSA di `rispondiAppello` (ORDER BY ora, id): chi legge
// questo elenco alle 20:00 e risponde all'appello a mezzanotte deve trovare gli
// stessi numeri accanto agli stessi nomi, altrimenti segna assente chi c'era.
function elencoPrenotazioni(db, cfg, iso, adesso = new Date()) {
  const quando = comeData(adesso) === iso ? 'di oggi'
    : comeData(piuGiorni(adesso, 1)) === iso ? 'di domani'
    : 'di ' + dataItaliana(iso);
  const titolo = `📋 Prenotazioni ${quando} — ${dataItaliana(iso)}`;

  const righe = db.prepare(
    'SELECT * FROM prenotazioni WHERE data = ? AND stato IN ' + dentro(STATI_VIVI) + ' ORDER BY ora, id'
  ).all(iso);

  if (!righe.length) {
    const chiuso = eChiuso(db, iso) || !turniDelGiorno(cfg, iso).length;
    return `${titolo}\n\nNessuna prenotazione.${chiuso ? '\n(quel giorno il locale è chiuso)' : ''}`;
  }

  const parti = [titolo, ''];
  let oraCorrente = null;
  let coperti = 0;
  righe.forEach((r, i) => {
    if (r.ora !== oraCorrente) {
      oraCorrente = r.ora;
      if (i) parti.push('');
      parti.push(`🕗 ${r.ora}`);
    }
    coperti += r.persone;
    const nome = nomeInSala(r);
    const numero = numeroMostrabile(r.telefono_contatto) || numeroMostrabile(r.telefono);
    parti.push(`${i + 1}. ${nome} — ${r.persone} ${r.persone === 1 ? 'coperto' : 'coperti'}`
      + (r.origine === 'manuale' ? ' (admin)' : ''));
    // L'esperienza subito sotto il nome: è la prima cosa che la sala deve
    // sapere di quel tavolo (chiesto dal titolare, 16 ottobre 2026).
    // Il locale, quando non è quello di sempre (il bistrot del 25 ottobre).
    if (r.fuori_sala && r.locale_scelto) parti.push(`   🍝 ${r.locale_scelto}`);
    if (r.esperienza) parti.push(`   🍽️ ${r.esperienza}`);
    if (numero) parti.push(`   📞 ${numero}`);
    if (r.note) parti.push(`   📝 ${r.note}`);
  });

  // I totali per turno: è la riga che serve davvero prima di aprire, perché
  // dice quanti posti restano senza doverli contare a mente. Per turno o per
  // servizio, non per ogni mezz'ora (vedi `riepilogoDelGiorno`).
  const riepilogo = riepilogoDelGiorno(db, cfg, iso).map((r) => `${r.etichetta}: ${r.testo}`).join('\n');

  parti.push('');
  parti.push(`Totale: ${coperti} ${coperti === 1 ? 'coperto' : 'coperti'} su ${righe.length} ${righe.length === 1 ? 'prenotazione' : 'prenotazioni'}.`);
  if (riepilogo) parti.push(riepilogo);
  return parti.join('\n');
}

// ⚠️ IL TETTO NON SI CONSUMA PRENOTANDO (16 ottobre 2026). Il tetto di
// risposte al giorno (`bot_max_risposte`, 20) ferma il ping-pong: un altro
// risponditore automatico, qualcuno che scrive a raffica. Ma contava TUTTO, e
// con le esperienze una prenotazione sono otto-dieci messaggi: il titolare,
// provando dal suo telefono, alla terza prenotazione del giorno si è sentito
// dire «ti passo a un operatore» alla domanda sulle note — e da lì silenzio
// fino a mezzanotte. Un cliente vero che prenota, chiede il menu e gli orari,
// sbaglia una data e poi sposta, ci arriva uguale.
//
// La regola: si conta ogni messaggio (in `rispondiAlMessaggio`), ma quello che
// fa AVANZARE la prenotazione — il passo dopo è un altro, e non è l'inizio —
// viene restituito; e una prenotazione confermata azzera il conto, perché
// dall'altra parte c'è una persona vera. Restano contati i saluti ripetuti, le
// domande, il menu e gli orari chiesti, le risposte non capite, e ogni ritorno
// all'inizio: tutto quello che fa un giro a vuoto.
// ⚠️ NON «dentro una prenotazione non si conta»: passare a una persona non
// zittisce il bot, e un giro a vuoto fatto di «ciao», MENU o domande frequenti
// dentro un passo non finirebbe mai.
// ---- «Torna indietro»: la storia dei passi ----
// Dal titolare (23 ottobre 2026): chi sceglie un menu e ci ripensa scrive
// «torna indietro», e deve ritrovarsi alla domanda di prima. Ogni passo di una
// prenotazione si ricorda la DOMANDA con cui è cominciato (il messaggio del
// bot, così com'era) e i passi prima di lui, con i loro dati: tornare indietro
// è rimettere quelli e riscrivere quella domanda. Si fa qui, attorno a
// `rispondiAlMessaggio`, perché è l'unico punto che vede il passo di prima e
// quello di dopo: dentro, gli stati si scrivono da cinquanta posti diversi.
const MAX_STORIA = 8;
const senzaStoria = (d) => { const { storia, domanda, ...resto } = d || {}; return resto; };
// Le risposte di chi ha ripreso DA CAPO (RICOMINCIA, un saluto dopo un po'):
// la storia di prima è di una prenotazione buttata, e «torna indietro» non deve
// riportarci dentro. Accanto, la frase messa in cima («Va bene, ricominciamo da
// capo!»): non è la domanda, e tornando lì non va ripetuta. A parte, per non
// cambiare la forma dell'esito.
const DA_CAPO = new WeakMap();

function ricordaLaDomanda(db, telefono, prima, esito, adesso) {
  const dopo = statoDi(db, telefono, adesso);
  if (!PASSI_DELLA_PRENOTAZIONE.has(dopo.passo)) return;
  const pd = prima.dati || {};
  let detta = [...(esito.risposte || [])].reverse().find((r) => typeof r === 'string' && r.trim()) || '';
  const testa = DA_CAPO.get(esito);
  const pulita = senzaRigheDiTroppo({ risposte: [testa || ''] }).risposte[0];
  if (pulita && detta.startsWith(pulita)) detta = detta.slice(pulita.length).trim();
  let storia; let domanda;
  const { tentativi: t1, ...datiPrima } = senzaStoria(pd);
  const { tentativi: t2, ...datiDopo } = senzaStoria(dopo.dati);
  if (!PASSI_DELLA_PRENOTAZIONE.has(prima.passo) || testa !== undefined) {
    storia = []; domanda = detta;                       // la prenotazione comincia adesso
  } else if (!Array.isArray(pd.storia)) {
    // ⚠️ Cominciata prima del 23 ottobre 2026, senza storia: dei passi di
    // prima non si sa niente, e una storia cominciata a metà direbbe «siamo
    // già alla prima domanda» a chi è al terzo passo. Resta senza, fino in
    // fondo a quella prenotazione (vedi «tornaIndietro»).
    return;
  } else if (dopo.passo === prima.passo) {
    // Stesso passo. «Non ho capito», una domanda frequente, il MENU: non sono la
    // domanda, e resta quella di prima. Ma se sono cambiati i dati («venerdì»
    // al posto di «giovedì», alla domanda dell'ora) la domanda è quella nuova:
    // la vecchia avrebbe gli orari dell'altro giorno.
    storia = pd.storia || [];
    domanda = JSON.stringify(datiPrima) === JSON.stringify(datiDopo) ? (pd.domanda || '') : detta;
  } else {
    storia = [...(pd.storia || []), { passo: prima.passo, dati: senzaStoria(pd), domanda: pd.domanda || '' }].slice(-MAX_STORIA);
    domanda = detta;
  }
  scriviStato(db, telefono, dopo.passo, { ...senzaStoria(dopo.dati), storia, domanda }, adesso);
}

function tornaIndietro(db, telefono, prima, adesso) {
  const cfg = config(db);
  const valori = { locale: cfg.bot_locale || 'noi' };
  const esito = { risposte: [], passaAUmano: false, prenotazione: null, annullata: null, spostata: null, attesa: null };
  const pd = prima.dati || {};
  const storia = pd.storia || [];
  const domandaDi = (passo, testo) => String(testo || '').trim()
    || `Ti stavo chiedendo ${COSA_MANCA[passo] || 'i dettagli della prenotazione'}.`;
  // Senza storia (vedi «ricordaLaDomanda»): non si sa dove tornare, e lo si dice.
  if (!Array.isArray(pd.storia)) {
    esito.risposte.push(`${domandaDi(prima.passo, '')} Se preferisci ripartire da capo, scrivi RICOMINCIA.`);
    return esito;
  }
  if (!storia.length) {
    esito.risposte.push(`${riempi(cfg.bot_t_indietro_inizio, valori)}\n\n${domandaDi(prima.passo, pd.domanda)}`.trim());
    return esito;
  }
  const torna = storia[storia.length - 1];
  scriviStato(db, telefono, torna.passo, { ...torna.dati, storia: storia.slice(0, -1), domanda: torna.domanda }, adesso);
  esito.risposte.push(`${riempi(cfg.bot_t_indietro, valori)}\n\n${domandaDi(torna.passo, torna.domanda)}`.trim());
  return esito;
}

// ⚠️ Una frase che finisce con un a capo, attaccata a un pezzo che comincia
// con una riga vuota («📖 Se vuoi dare prima un'occhiata al menu…», «Se
// preferisci, scrivi RICOMINCIA…»), lasciava su WhatsApp DUE righe vuote di
// fila. Trovato facendo girare migliaia di conversazioni a caso (19 ottobre
// 2026). Si sistema all'uscita, una volta per tutte le frasi — comprese
// quelle riscritte dai locali.
function senzaRigheDiTroppo(esito) {
  if (Array.isArray(esito.risposte)) {
    esito.risposte = esito.risposte.map((r) => (typeof r === 'string' ? r.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : r));
  }
  return esito;
}

function elaboraMessaggio(db, telefono, testo, adesso = new Date(), contesto = {}) {
  const prima = statoDi(db, telefono, adesso);
  const passoPrima = prima.passo;
  // «Torna indietro» prima di tutto: dentro il passo una parola come
  // «indietro» non vuol dire niente, e diventerebbe «non ho capito».
  if (PASSI_DELLA_PRENOTAZIONE.has(passoPrima) && vuoleTornareIndietro(testo)) {
    return senzaRigheDiTroppo(tornaIndietro(db, telefono, prima, adesso));
  }
  const contoPrima = risposteDiOggi(db, telefono, adesso);
  const esito = senzaRigheDiTroppo(rispondiAlMessaggio(db, telefono, testo, adesso, contesto));
  // Dopo la pulizia: la domanda si ricorda com'è partita.
  ricordaLaDomanda(db, telefono, prima, esito, adesso);
  if (esito.prenotazione || esito.daPagare) {
    rimettiIlConto(db, telefono, adesso, 0);
  } else {
    const passoDopo = statoDi(db, telefono, adesso).passo;
    if (passoDopo !== 'inizio' && passoDopo !== passoPrima && risposteDiOggi(db, telefono, adesso) > contoPrima) {
      rimettiIlConto(db, telefono, adesso, contoPrima);
    }
  }
  return esito;
}

function rispondiAlMessaggio(db, telefono, testo, adesso = new Date(), contesto = {}) {
  // Tutto quello che si salva qui dentro porta la data di QUESTO adesso.
  const salvaStato = (d, t, p, dd) => scriviStato(d, t, p, dd, adesso);
  const azzeraStato = (d, t) => scriviStato(d, t, 'inizio', {}, adesso);
  const cfg = config(db);
  const risposte = [];
  const esito = { risposte, passaAUmano: false, prenotazione: null, annullata: null, spostata: null, attesa: null };
  const t = normalizza(testo);
  let stato = statoDi(db, telefono, adesso);
  // --- Il saluto che riapre una conversazione lasciata a metà ---
  // ⚠️ Il guasto: si comincia a prenotare, ci si distrae, e mezz'ora dopo si
  // torna e si scrive «ciao». Quel «ciao» veniva letto come risposta alla
  // domanda in sospeso, e tornava indietro «non ho capito la data». Dopo
  // qualche minuto di silenzio un saluto non è una risposta: è uno che
  // ricomincia. Non butta via niente a tempo — decide il cliente, e solo sui
  // passi dove un saluto non può essere una risposta vera.
  if (riapreConUnSaluto(cfg, stato, testo, adesso)) {
    scriviStato(db, telefono, 'inizio', {}, adesso);
    stato = { ...stato, passo: 'inizio', dati: {} };
    DA_CAPO.set(esito, '');
  }
  const dati = stato.dati || {};
  // ⚠️ Chi torna non deve ridire come si chiama. Si guarda UNA volta per
  // messaggio: è una lettura d'archivio, e farla a ogni frase sarebbe sprecarla.
  const giaVisto = boolDi(cfg.bot_riconosci) ? ultimoNomeDi(db, telefono, contesto.numero) : null;
  const valori = {
    locale: cfg.bot_locale || 'noi',
    // ⚠️ Il saluto resta «Buonasera» e basta: per un giorno il nome stava qui
    // dentro, e a chi aveva già un tavolo usciva «Buonasera Marco Marco Rossi!»
    // — perché quella frase il nome lo mette da sé. Il nome di chi torna sta
    // in una frase sua (`bot_t_bentornato`), e in {nome}: solo il nome.
    saluto: salutoOra(adesso),
    nome: giaVisto ? giaVisto.nome : '',
    assistente: cfg.bot_assistente || '',
    apertura: cfg.bot_avvisi_da || '',
    // Il collegamento al menu, per chi lo vuole in una frase sua (il benvenuto).
    menu: String(cfg.bot_menu_link || '').trim(),
    degustazione: String(cfg.bot_menu_degustazione_link || '').trim(),
    // Gli orari d'apertura a parole, per il benvenuto e per chi scrive ORARI.
    orari: orariDetti(cfg),
  };

  const di = (chiave, extra) => riempi(cfg[chiave], { ...valori, ...(extra || {}) });
  // ⚠️ Le frasi con l'elenco delle esperienze le scrive il titolare, l'elenco
  // no. Riscrivendo «Ecco cosa puoi prenotare da noi:» senza {esperienze}, il
  // bot chiedeva «a quale sei interessato?» senza dire le scelte: visto dal
  // titolare, che credeva sparite le esperienze. Se il segnaposto manca
  // l'elenco va in fondo; se la frase è vuota resta l'elenco da solo.
  const diConElenco = (chiave, elenco, extra) => (String(cfg[chiave] || '').includes('{esperienze}')
    ? di(chiave, { ...(extra || {}), esperienze: elenco })
    : [di(chiave, extra).trim(), elenco].filter(Boolean).join('\n\n'));
  // Le esperienze del locale. Con almeno due si chiede; con una vale da sé.
  const esperienze = esperienzeDi(cfg);
  const conEsperienze = esperienze.length >= 2;
  // Le persone, senza il prezzo di un'esperienza: in «no quello da 45» o
  // «business lunch da 45 per 4» il 45 è il business lunch, non la tavolata
  // (visto in una chat vera, 19 ottobre 2026). Solo «da» + un numero che sta
  // nel nome di un'esperienza: «siamo in 45» resta 45.
  const numeriDeiNomi = new Set(esperienze.flatMap((e) => pezziDelNome(e.nome)).filter((x) => /^\d+$/.test(x)));
  const personeDette = (x) => interpretaPersone(numeriDeiNomi.size
    ? normalizza(x).replace(/\bda\s*€?\s*(\d+)\b/g, (intero, n) => (numeriDeiNomi.has(n) ? ' ' : intero)) : x);
  // I locali della prima domanda (vedi «I locali»): vuoto se non c'è da scegliere.
  const localiProposti = localiDaProporre(cfg, adesso);
  const conLocali = localiProposti.length >= 2;
  const localePrincipale = localiDi(cfg).principale;
  // La domanda, con le scelte anche se il titolare ha riscritto la frase senza
  // {nomi} né {scelte} (come per l'elenco delle esperienze).
  const diLocali = (chiave, extra) => {
    const scritta = String(cfg[chiave] || '');
    const scelte = sceltaDeiLocali(localiProposti);
    const piena = di(chiave, { ...(extra || {}), nomi: nomiDeiLocali(localiProposti), scelte }).trim();
    if (!piena) return scelte;
    const nominati = localiProposti.every((l) => normalizza(scritta).includes(normalizza(l.nome)));
    return scritta.includes('{nomi}') || scritta.includes('{scelte}') || nominati ? piena : `${piena}\n\n${scelte}`;
  };
  // ⚠️ Un altro locale (il bistrot) non ha le esperienze del locale di sempre:
  // con una sola, quella valeva «da sé» anche per lui.
  const esperienzaScelta = (d = dati) => (d.fuoriSala ? null
    : esperienzaDi(cfg, d.esperienza) || (esperienze.length === 1 ? esperienze[0] : null));
  const perEsperienza = (d = dati) => { const e = esperienzaScelta(d); return e ? { esperienza: e } : {}; };
  // «Menu da scegliere al tavolo» (vedi il passo del menu) viaggia come un
  // nome, ma non è un'esperienza: non restringe giorni e turni.
  const nomeEsperienza = (d = dati) => {
    const e = esperienzaScelta(d);
    if (e) return { esperienza: e.nome };
    return d.esperienza === MENU_AL_TAVOLO && !d.fuoriSala ? { esperienza: MENU_AL_TAVOLO } : {};
  };

  // Quante risposte non capite di fila prima di passare (`bot_tentativi`).
  const tentativiMassimi = Math.min(Math.max(num(cfg.bot_tentativi, 3), 2), 5);
  // «Me lo riscrivi?» con l'esempio adatto alla domanda. '' se la frase è vuota.
  const riscrivi = (passo, d = {}) => {
    const esempio = esempioPer(passo, d, adesso);
    return riempi(senzaRigheVuote(cfg.bot_t_riscrivi, { esempio }), { ...valori, esempio }).trim();
  };
  // Erano due, fisse: ora sono `tentativiMassimi` (tre di partenza), su
  // QUALSIASI domanda — non solo
  // sulla prima. Chi risponde a un'altra cosa («ma avete il parcheggio?»)
  // si sentiva ripetere la stessa domanda all'infinito: da lì in poi
  // insistere non serve, e il cliente se ne va senza che nessuno lo sappia.
  //
  // Prima di contare un errore si guarda fra le domande frequenti: se la
  // risposta ce l'abbiamo, quello non e' un fallimento — e' una domanda a cui
  // si risponde, e la conversazione resta dov'era.
  const nonCapito = (passo, d, testoDaRipetere) => {
    const risposta = cercaFaq(db, testo);
    if (risposta) { risposte.push(riempi(risposta, valori)); return esito; }
    const tentativi = (d.tentativi || 0) + 1;
    if (tentativi >= tentativiMassimi) {
      annotaNonCapita(db, testo);
      azzeraStato(db, telefono);
      esito.passaAUmano = true;
      return esito;
    }
    salvaStato(db, telefono, passo, { ...d, tentativi });
    // Ripetere le STESSE identiche parole e' quello che fa sentire il cliente
    // davanti a un muro. La seconda volta la domanda arriva con una frase di
    // ricucitura davanti, che dice anche come uscirne. Si puo' svuotare dalle
    // impostazioni per tornare alla sola domanda.
    // La guida va IN FONDO, non davanti: prima si legge cosa fare, poi la via
    // d'uscita. Messa in cima diceva «non mi sono spiegato» subito prima di
    // «non ho capito», cioe' due volte la stessa cosa.
    // Dal secondo sbaglio di fila non si ripete la stessa domanda: si chiede
    // di riscriverla, con un esempio. Svuotata la frase, torna la domanda.
    const corpo = (tentativi >= 2 && riscrivi(passo, d)) || testoDaRipetere;
    const guida = di('bot_t_ricominciamo');
    risposte.push(guida ? `${corpo}\n\n${guida}` : corpo);
    return esito;
  };

  // Ogni passo superato azzera il conto: i due tentativi valgono per la
  // domanda in corso, non per tutta la conversazione.
  const avanzato = (d) => { const { tentativi, ...resto } = d; return resto; };

  // ---- La lista d'attesa, dentro la conversazione ----
  const listaAttiva = boolDi(cfg.bot_lista_attesa);
  const minutiAttesa = Math.max(num(cfg.bot_attesa_minuti, 30), 5);
  const quandoAttesa = (data, ora) => (ora ? `per ${dataItaliana(data)} alle ${ora}` : `per ${dataItaliana(data)}`);
  // La proposta in coda a un «pieno»: una riga in più, o niente se la lista è spenta.
  const propostaAttesa = (data, ora) => (listaAttiva
    ? `\n\n${di('bot_t_attesa_proposta', { quando: quandoAttesa(data, ora), data: dataItaliana(data), ora: ora || '' })}`
    : '');
  // «Sì», ma anche «mettimi in lista» o «attesa»: la proposta usa quelle parole.
  const vuoleLaAttesa = () => interpretaSiNo(testo) === true || /\b(attesa|lista)\b/.test(t);
  function mettiInLista(d) {
    const r = mettiInAttesa(db, { telefono, nome: d.nome || '', cognome: d.cognome || '',
      persone: d.persone, data: d.data, ora: d.ora || '' }, adesso);
    esito.attesa = r.riga;
    risposte.push(di(r.gia ? 'bot_t_attesa_gia' : 'bot_t_attesa_segnata',
      { quando: quandoAttesa(d.data, d.ora), persone: d.persone, minuti: minutiAttesa }));
    azzeraStato(db, telefono);
    return esito;
  }
  // Il giorno è pieno e non c'è nessun altro turno da proporre: o la lista, o
  // il saluto di sempre. `ora` è quella chiesta, e in lista si aspetta quella.
  function tuttoPieno(d, ora) {
    risposte.push(di('bot_t_completo', { data: dataItaliana(d.data) }) + propostaAttesa(d.data, ora));
    if (!listaAttiva) { azzeraStato(db, telefono); return esito; }
    salvaStato(db, telefono, 'attesa_offerta', { ...avanzato(d), ora });
    return esito;
  }

  // --- La parola che zittisce il bot, sempre prima di tutto ---
  const parolaOperatore = normalizza(cfg.bot_parola_operatore);
  if (parolaOperatore && t.includes(parolaOperatore)) {
    zittisci(db, telefono, num(cfg.bot_silenzio_ore, 6), adesso);
    azzeraStato(db, telefono);
    // ⚠️ «qualcunoLegge», non «eOrarioAvvisi»: nel giorno di riposo alle 15:00
    // si è dentro la finestra oraria e la sala è vuota. Il cliente si sentiva
    // promettere una risposta imminente da nessuno.
    if (qualcunoLegge(db, cfg, adesso)) {
      risposte.push(di('bot_t_operatore'));
    } else {
      const fra = prossimaLettura(db, cfg, adesso);
      risposte.push(riempi(cfg.bot_t_operatore_chiuso,
        { ...valori, quando: fra.quando, apertura: fra.ora }));
    }
    esito.passaAUmano = true;
    return esito;
  }

  // --- «RICOMINCIA»: si riparte dalla presentazione ---
  // Chi si è incartato a metà prenotazione poteva solo continuare a sbagliare
  // o chiedere un operatore: ripartire da capo è spesso quello che vuole, e
  // non deve costare il disturbo di una persona.
  // ⚠️ DA CAPO vuol dire da capo (chiesto dal titolare, 20 ottobre 2026): la
  // presentazione e la prima domanda, come al primo messaggio — con più
  // locali «RO bistrot o REAR Restaurant?», con le esperienze l'elenco. Prima
  // si chiedevano subito le persone, e chi ricominciava proprio per passare
  // dal REAR al bistrot non aveva più la domanda per farlo. Il promemoria del
  // tavolo che ha già non c'entra: ha scritto RICOMINCIA, sta prenotando.
  // Risponde QUI, prima di tutto il resto: «annulla tutto» è un ricomincia, e
  // più sotto diventerebbe «vuoi cancellare la prenotazione?».
  // ⚠️ La frase va IN CIMA alla presentazione, che la domanda la fa lei. Fino
  // al 20 ottobre 2026 la domanda la faceva la frase («…per quante persone?»),
  // e chi l'aveva personalizzata se l'è tenuta così: il cliente riceveva DUE
  // domande, le persone e subito sotto «RO bistrot o REAR?» (visto dal
  // titolare, con uno screenshot, il giorno stesso). Della frase va solo
  // quello che sta prima della domanda (vedi «primaDellaDomanda»).
  if (/^(ricomincia|ricominciamo|da capo|riparti|annulla tutto)\b/i.test(t)) {
    azzeraStato(db, telefono);
    const testa = primaDellaDomanda(di('bot_t_ricominciato')) || riempi(PREDEFINITI.bot_t_ricominciato, valori);
    DA_CAPO.set(esito, testa);
    return presentati({}, null, testa);
  }

  // --- «Non voglio più prenotare» (vedi «vuoleRinunciare») ---
  if (PASSI_DELLA_PRENOTAZIONE.has(stato.passo) && vuoleRinunciare(testo)) {
    azzeraStato(db, telefono);
    risposte.push(di('bot_t_rinuncia'));
    return esito;
  }

  // --- «Voglio cambiare il menu» (vedi «vuoleCambiareEsperienza») ---
  // Solo dove un'esperienza c'è da scegliere o è stata scelta: dal bistrot,
  // che non ne ha, la frase non porta all'elenco del REAR.
  if (conEsperienze && PASSI_DELLA_PRENOTAZIONE.has(stato.passo) && (dati.esperienza || stato.passo === 'esperienza')
    && vuoleCambiareEsperienza(testo)) {
    return sceltaDaCapo(dati.persone ? { persone: dati.persone } : {});
  }

  // --- Tetto di risposte ---
  // Si conta qui ogni messaggio; quello che fa avanzare la prenotazione viene
  // restituito dopo, in `elaboraMessaggio` (vedi lì il perché).
  const quante = contaRisposta(db, telefono, adesso);
  const tetto = tettoRisposte(cfg);
  if (quante > tetto) {
    if (quante === tetto + 1) {
      risposte.push(di('bot_t_troppe'));
      esito.passaAUmano = true;
    }
    return esito;   // oltre, silenzio totale: insistere peggiora
  }

  // --- ANNULLA, in qualunque momento ---
  // --- «SPOSTA»: cambiare giorno o ora senza disdire ---
  //
  // ⚠️ La regola che decide tutto: si cerca PRIMA il posto nuovo, si fa
  // confermare, e solo alla fine si sposta. Liberando prima il vecchio, un
  // cliente che scopre il turno pieno resterebbe senza niente — e per colpa
  // nostra. Se il posto non c'è, la prenotazione vecchia non viene sfiorata.
  //
  // «CAMBIA» da solo è una delle due parole che il bot mette in bocca al
  // cliente: se lui la scrive e il bot non la capisce, è il bot ad avergli
  // fatto sbagliare. Vale però SOLO da sola: «cambia il numero di persone»
  // non è uno spostamento di giorno, e deve continuare ad arrivare a una
  // persona invece di finire nella tendina delle date.
  const soloCambia = SOLO_CAMBIA.test(t);
  const chiedeSposta = /^(?:vorrei |voglio |posso |puoi |si |sì )*(spost\w*|rimand\w*|postici?p\w*|anticip\w*|cambia\w* (?:giorno|ora|orario|prenotazione))\b/.test(t);
  // E vale solo se c'è davvero qualcosa da cambiare: senza una prenotazione in
  // archivio «cambia» è quasi sempre una parola detta mentre si prenota
  // («cambia, siamo in quattro»), e non deve buttare all'aria il percorso.
  // Da qui in poi lo spostamento vero: vale su UNA prenotazione, quella scelta.
  const avviaSposta = (p) => {
    // ⚠️ Un altro locale (il bistrot) ha un giorno solo: non si sposta. Lo si
    // dice, invece di proporre i giorni del locale di sempre.
    if (p.fuori_sala) {
      risposte.push(di('bot_t_altro_locale_sposta', { scelto: p.locale_scelto, data: dataItaliana(p.data) }));
      azzeraStato(db, telefono);
      return esito;
    }
    // Chi sposta ha già un tavolo: l'anticipo minimo non lo riguarda, e la sua
    // riga non deve contare contro di lui nel cercare il posto nuovo.
    const opzioni = { escludiId: p.id, senzaPreavviso: true, ...perEsperienza({ esperienza: p.esperienza }) };
    const giorni = giorniDisponibili(db, cfg, p.persone, adesso, 5, opzioni);
    if (!giorni.length) {
      risposte.push(di('bot_t_completo', { data: 'i prossimi giorni' }));
      esito.passaAUmano = true;
      azzeraStato(db, telefono);
      return esito;
    }
    salvaStato(db, telefono, 'sposta_giorno', { id: p.id, persone: p.persone, giorni, ...(p.esperienza ? { esperienza: p.esperienza } : {}) });
    risposte.push(`${di('bot_t_sposta_quale', {
      data: dataItaliana(p.data), ora: oraColTurno(cfg, p.data, p.ora), persone: p.persone,
    })}\n${elencoGiorni(giorni)}`);
    return esito;
  };

  if ((chiedeSposta || (soloCambia && prenotazioneFutura(db, telefono, adesso, contesto.numero)))
      && !String(stato.passo).startsWith('sposta_')) {
    const tutte = prenotazioniFuture(db, telefono, adesso, 5, contesto.numero);
    if (!tutte.length) {
      risposte.push(di('bot_t_annulla_niente'));
      azzeraStato(db, telefono);
      return esito;
    }
    // ⚠️ Con più tavoli prenotati NON si sceglie per lui il primo: spostargli
    // la serata sbagliata senza nemmeno dirglielo è peggio che chiedere.
    if (tutte.length > 1) {
      salvaStato(db, telefono, 'sposta_scegli', { candidati: tutte.map((r) => r.id) });
      risposte.push(conElenco(di('bot_t_quale_sposta'), tutte));
      return esito;
    }
    return avviaSposta(tutte[0]);
  }

  // La risposta alla nota «ho segnato le 21:30. Se preferisci un altro
  // orario, scrivimelo»: un orario, un turno col suo numero o un «no» secco
  // tornano alla scelta dell'orario, invece di finire nel nome; un «ok» alla
  // domanda del nome la fa solo ripetere. Il segno si toglie comunque, al
  // primo messaggio: tre passi dopo, «20:30» è quello che è lì.
  let cambiaOra = false;
  if (dati.notaOra) {
    const passoOra = dati.notaOra;
    delete dati.notaOra;
    salvaStato(db, telefono, stato.passo, dati);
    const t = normalizza(testo);
    const unTurno = ordinaleDi(testo) && (/\bturno\b|[°º]/.test(t) || /^(il |la )?(prim|second|terz|quart)[oa]$/.test(t));
    if (oraScritta(testo) || unTurno) {
      stato.passo = passoOra;
      cambiaOra = true;
    } else if (interpretaSiNo(testo) === false) {
      return proponiOrari(passoOra, dati, dati.data, dati.turni || [], dati.servizio);
    } else if (stato.passo === 'nome' && eSoloDaccordo(testo)) {
      risposte.push(di('bot_t_nome'));
      return esito;
    }
  }

  if (stato.passo === 'sposta_scegli') {
    const scelta = sceltaFraCandidati(dati.candidati, t, db);
    if (scelta.errore) { risposte.push(scelta.errore); return esito; }
    if (!scelta.riga) { azzeraStato(db, telefono); risposte.push(FRASE_NON_PIU_ATTIVA); return esito; }
    return avviaSposta(scelta.riga);
  }

  if (stato.passo === 'sposta_giorno') {
    const iso = interpretaData(testo, adesso, { storti: true });
    if (!iso) {
      const buoni = giorniAncoraBuoni(dati.giorni, adesso);
      return nonCapito('sposta_giorno', dati, `${di('bot_t_giorno_no')}\n${elencoGiorni(
        buoni.length ? buoni : giorniDisponibili(db, cfg, dati.persone || 2, adesso))}`);
    }
    const opzioni = { escludiId: dati.id, senzaPreavviso: true, ...perEsperienza() };
    const turni = turniDisponibili(db, cfg, iso, dati.persone, adesso, opzioni);
    if (!turni.length) {
      const alternativi = giorniDisponibili(db, cfg, dati.persone, adesso, 5, opzioni);
      risposte.push(`${di(eChiuso(db, iso) || !turniDelGiorno(cfg, iso).length ? 'bot_t_chiuso' : 'bot_t_completo', { data: dataItaliana(iso) })}\n${elencoGiorni(alternativi)}`);
      salvaStato(db, telefono, 'sposta_giorno', { ...avanzato(dati), giorni: alternativi });
      return esito;
    }
    return chiediServizio(PASSI_SPOSTA, dati, iso, turni, servizioDetto(testo));
  }

  if (stato.passo === 'sposta_servizio') {
    const chiesto = servizioDetto(testo);
    if (chiesto) return proponiOrari('sposta_ora', dati, dati.data, dati.turni || [], chiesto);
    if (!oraScelta(dati)) {
      return nonCapito('sposta_servizio', dati, di('bot_t_servizio_no', { data: dataItaliana(dati.data) }));
    }
    stato.passo = 'sposta_ora';
  }

  if (stato.passo === 'sposta_ora') {
    const ora = oraScelta(dati);
    if (!ora) {
      const no = oraNonProposta(db, cfg, dati, testo);
      if (no) return rispondiOraNo(no, 'sposta_ora', dati, { escludiId: dati.id, senzaPreavviso: true });
      const chiesto = servizioDetto(testo);
      if (chiesto) return proponiOrari('sposta_ora', dati, dati.data, dati.turni || [], chiesto);
      const nonTrovata = oraSenzaTurno('sposta_ora', dati);
      if (nonTrovata) return nonTrovata;
      return nonCapito('sposta_ora', dati, `${di('bot_t_ora_no')}\n${elencoTurni(turniDaMostrare(dati), cfg, dati.data)}`);
    }
    return conLaNotaDellOra(ora, 'sposta_ora', () => chiediConfermaSposta(avanzato(dati), ora));
  }

  if (stato.passo === 'sposta_conferma') {
    const scelta = interpretaSiNo(testo);
    if (scelta === null) {
      return nonCapito('sposta_conferma', dati, 'Non ho capito: scrivi SÌ per spostarla o NO per lasciarla dov\'è.');
    }
    const p = db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(dati.id);
    if (scelta === false) {
      // ⚠️ NON «bot_t_rinuncia»: qui il cliente ha detto NO a uno SPOSTAMENTO,
      // e la sua prenotazione è viva. Con la frase della rinuncia si sentiva
      // dire che non c'era più niente — e a quel punto non si presenta.
      risposte.push(di('bot_t_lasciato'));
      azzeraStato(db, telefono);
      return esito;
    }
    if (!p || !STATI_TOCCABILI.includes(p.stato)) {
      risposte.push(di('bot_t_annulla_niente'));
      azzeraStato(db, telefono);
      return esito;
    }
    // Ultimo controllo prima di toccare la riga: fra la proposta e il «sì»
    // qualcun altro può aver preso quel posto.
    const posto = postoPer(db, cfg, dati.data, dati.ora, p.persone, { escludiId: p.id, preferito: p.tavolo });
    if (!posto.ok) {
      risposte.push(di('bot_t_sposta_pieno', {
        data: dataItaliana(dati.data), ora: dati.ora,
        vecchiaData: dataItaliana(p.data), vecchiaOra: p.ora,
      }));
      azzeraStato(db, telefono);
      return esito;
    }
    // ⚠️ Il tavolo assegnato dalla sala vale per QUELLA serata: portato su un
    // altro giorno, il numero lì appartiene a qualcun altro, e la sera si
    // trovano due gruppi allo stesso tavolo. Con i tavoli elencati il bot sa
    // se all'ora nuova quel tavolo è ancora libero: allora resta, sennò si
    // azzera. Un numero NUOVO non lo sceglie lui — lo assegna la sala, e
    // l'avviso «da assegnare» lo ricorda. Senza tavoli si azzera, come sempre.
    db.prepare('UPDATE prenotazioni SET data = ?, ora = ?, tavolo = ? WHERE id = ?')
      .run(dati.data, dati.ora, usaTavoli(db) ? tavoloCheResta(db, cfg, dati.data, dati.ora, p.tavolo, p.id) : '', p.id);
    // Spostandosi può essere finito proprio sul giorno per cui era in lista.
    esceDallaLista(db, p.telefono, dati.data, p.id);
    // `prima` serve a chi legge l'avviso in sala: «spostata» senza sapere DA
    // dove non dice niente a chi ha il foglio del servizio in mano.
    esito.spostata = {
      prima: { data: p.data, ora: p.ora, tavolo: p.tavolo || '' },
      dopo: db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(p.id),
    };
    risposte.push(di('bot_t_spostata', {
      data: dataItaliana(dati.data), ora: oraColTurno(cfg, dati.data, dati.ora), persone: p.persone,
    }));
    azzeraStato(db, telefono);
    return esito;
  }

  const chiediConfermaAnnullo = (p) => {
    salvaStato(db, telefono, 'annulla_conferma', { id: p.id });
    // Dall'altro locale: dove, e fino a che ora (vedi `bot_t_gia_altro_locale`).
    risposte.push(p.fuori_sala ? di('bot_t_annulla_altro_locale', {
      scelto: p.locale_scelto, data: dataItaliana(p.data), ora: oraDellaPrenotazione(cfg, p), persone: p.persone,
    }) : di('bot_t_annulla_quale', {
      data: dataItaliana(p.data), ora: p.ora, persone: p.persone,
    }));
    return esito;
  };

  if (/^(?:vorrei |voglio |posso |puoi |si |sì )*(annull\w*|disdi\w*|disdett\w*|cancell\w*)\b/.test(t)
      && stato.passo !== 'annulla_conferma' && stato.passo !== 'annulla_scegli') {
    const tutte = prenotazioniFuture(db, telefono, adesso, 5, contesto.numero);
    if (!tutte.length) {
      // Niente da disdire, ma in lista d'attesa sì: è quella che vuole lasciare.
      if (toglieDaTutteLeAttese(db, telefono)) {
        risposte.push(di('bot_t_attesa_tolta'));
        azzeraStato(db, telefono);
        return esito;
      }
      risposte.push(di('bot_t_annulla_niente'));
      azzeraStato(db, telefono);
      return esito;
    }
    // ⚠️ Qui l'errore costa più che altrove: annullare per lui la prima e non
    // dirglielo vuol dire che il cliente crede di aver disdetto la serata
    // sbagliata, e la sala tiene un tavolo per uno che non viene.
    if (tutte.length > 1) {
      salvaStato(db, telefono, 'annulla_scegli', { candidati: tutte.map((r) => r.id) });
      risposte.push(conElenco(di('bot_t_quale_annulla'), tutte));
      return esito;
    }
    return chiediConfermaAnnullo(tutte[0]);
  }

  if (stato.passo === 'annulla_scegli') {
    const scelta = sceltaFraCandidati(dati.candidati, t, db);
    if (scelta.errore) { risposte.push(scelta.errore); return esito; }
    if (!scelta.riga) { azzeraStato(db, telefono); risposte.push(FRASE_NON_PIU_ATTIVA); return esito; }
    return chiediConfermaAnnullo(scelta.riga);
  }

  if (stato.passo === 'annulla_conferma') {
    const scelta = interpretaSiNo(testo);
    if (scelta === true) {
      db.prepare("UPDATE prenotazioni SET stato = 'annullata', annullata_at = datetime('now','localtime') WHERE id = ?").run(dati.id);
      esito.annullata = db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(dati.id);
      risposte.push(di('bot_t_annullata'));
      azzeraStato(db, telefono);
      return esito;
    }
    if (scelta === false) {
      // ⚠️ Il caso peggiore di tutti, visto in prova: il cliente chiede di
      // annullare, ci ripensa e scrive NO — e si sentiva rispondere «la
      // prenotazione è stata cancellata». Il tavolo era ancora suo, ma lui
      // non lo sapeva più: non si presenta, e la sala tiene un tavolo vuoto
      // in una sera piena.
      risposte.push(di('bot_t_lasciato'));
      azzeraStato(db, telefono);
      return esito;
    }
    return nonCapito('annulla_conferma', dati, 'Non ho capito: scrivi SÌ per annullare o NO per lasciare tutto com\'è.');
  }

  // --- Una risposta pronta alle domande frequenti, se siamo a inizio conversazione ---
  // A metà prenotazione NON si guarda la FAQ: «due» dopo la domanda sulle
  // persone è un numero, non una richiesta di informazioni.
  if (stato.passo === 'inizio') {
    const faq = cercaFaq(db, testo);
    if (faq) {
      risposte.push(riempi(faq, valori));
      return esito;
    }
  }

  // Manda UN menu: col file va in `esito.allegati` (il server lo manda PRIMA
  // dei testi, con la frase come didascalia), col link va nel testo. Sotto,
  // `chiusura`: la domanda da riprendere. Lo usano l'intercetto del menu e
  // il ramo dell'esperienza («vuoi vedere il menu?»).
  // Manda UN menu: `m` è { quale, link, file, frase, esperienza } (vedi
  // `menuDellEsperienza`), oppure il nome di uno dei due della scheda Menu.
  function mandaMenu(m, chiusura) {
    if (typeof m === 'string') {
      const a = menuAttivi(cfg)[m] || {};
      m = { quale: m, link: a.link || '', file: a.file || '', frase: m === 'degustazione' ? 'bot_t_menu_degustazione' : 'bot_t_menu' };
    }
    const extra = { esperienza: m.esperienza || '' };
    const pezzi = [];
    // Col file va in `esito.allegati` (il server lo manda PRIMA dei testi,
    // con la frase come didascalia), col link va nel testo.
    if (m.file) {
      (esito.allegati = esito.allegati || []).push({
        quale: m.quale, file: m.file,
        didascalia: riempi(senzaLaRigaDelLink(cfg[m.frase]), { ...valori, ...extra }),
        // Il collegamento, se c'è: è il ripiego del server quando il file non parte.
        link: m.link || '',
      });
    } else {
      pezzi.push(di(m.frase, { ...extra, link: m.link }));
    }
    const testoMenu = [...pezzi, chiusura].filter(Boolean).join('\n\n');
    if (testoMenu) risposte.push(testoMenu);
    annotaMenu(db, telefono, adesso, stato.passo, m.quale);
  }

  // --- Il menu, in qualunque momento della prenotazione ---
  // Deciso dal titolare: chi lo chiede a metà strada lo riceve, e la
  // prenotazione riprende da dove era — lo stato non si tocca, si ridice solo
  // la domanda. Alla domanda sulle persone vale solo se non ha scritto un
  // numero («menu per 4» è una prenotazione per 4), e una domanda frequente
  // del locale sul menu viene prima.
  {
    const attivi = menuAttivi(cfg);
    const cosa = DOMANDA_DOPO_IL_MENU[stato.passo];
    // Dopo il menu si riprende da dove si era; a inizio, con le esperienze,
    // «da dove si era» è la domanda sull'esperienza.
    const dopo = () => {
      if (cosa) return di('bot_t_menu_riprendi', { cosa });
      if (conLocali && stato.passo === 'inizio') {
        salvaStato(db, telefono, 'locale', {});
        return diLocali('bot_t_locali');
      }
      if (conEsperienze && stato.passo === 'inizio') {
        salvaStato(db, telefono, 'esperienza', {});
        return diConElenco('bot_t_esperienze', elencoEsperienze(esperienze), { numeri: numeriDetti(daUnoA(esperienze.length)) });
      }
      return di('bot_t_menu_prenota');
    };
    // Manda UN menu: uno dei due della scheda Menu ('menu', 'degustazione')
    // o quello di un'esperienza (vedi `menuDellEsperienza`).
    const manda = (m) => mandaMenu(m, dopo());
    // Da quello che si ricorda (`rimandaMenu`) al menu da mandare.
    const menuDaQuale = (q) => (String(q).startsWith('esperienza:')
      ? menuDellEsperienza(cfg, esperienzaDi(cfg, String(q).slice('esperienza:'.length)))
      : (attivi[q] ? q : null));
    const quale = qualeMenu(testo);
    // Con le esperienze, quelle che un menu ce l'hanno.
    const conMenuE = conEsperienze ? esperienze.filter((e) => menuDellEsperienza(cfg, e)) : [];
    // Cosa mandare: un menu, { senza: esperienza } se quella un menu non ce
    // l'ha, oppure null per chiedere quale.
    // ⚠️ Con le esperienze il menu è QUELLO DELL'ESPERIENZA (16 ottobre 2026):
    // quella nominata («menu alla carta»), sennò quella già scelta; e se non
    // ne ha uno si dice, non se ne manda un altro. Era il guasto: dopo
    // «business lunch», MENU mandava la carta. Prima della scelta, fra quelle
    // che un menu ce l'hanno: una sola va dritta, di più si chiede quale.
    const scelto = () => {
      if (conEsperienze) {
        const i = esperienzaNominata(testo, esperienze);
        if (i !== null) return menuDellEsperienza(cfg, esperienze[i]) || { senza: esperienze[i] };
        if (quale === 'degustazione' && attivi.degustazione) return 'degustazione';
        const e = esperienzaDi(cfg, dati.esperienza);
        if (e) return menuDellEsperienza(cfg, e) || { senza: e };
        if (conMenuE.length === 1) return menuDellEsperienza(cfg, conMenuE[0]);
        if (conMenuE.length > 1) return null;
        // Nessuna esperienza ha un menu: vale la scheda Menu, come prima.
      } else {
        // Un'esperienza sola: il suo menu, se ce l'ha, a chi scrive «menu».
        const m = menuDellEsperienza(cfg, esperienzaScelta());
        if (m && quale === 'menu') return m;
      }
      if (quale === 'degustazione') return attivi.degustazione ? 'degustazione' : 'menu';
      if (attivi.menu && attivi.degustazione) return null;
      return attivi.menu ? 'menu' : 'degustazione';
    };
    const mandaOChiedi = (q) => {
      const chiave = typeof q === 'string' ? q : q.quale;
      // Già ricevuto oggi: si chiede prima di rimandarlo, e si ricorda la domanda.
      if (menuGiaMandatoOggi(db, telefono, adesso, chiave)) {
        salvaStato(db, telefono, stato.passo, { ...dati, rimandaMenu: chiave });
        risposte.push(di('bot_t_menu_rimando'));
        return esito;
      }
      manda(q);
      return esito;
    };
    // La risposta a «quale vuoi vedere?». Il segno si toglie comunque.
    if (cosa !== undefined && dati.sceltaMenu) {
      const fra = Array.isArray(dati.sceltaMenu) ? dati.sceltaMenu.map((n) => esperienzaDi(cfg, n)).filter(Boolean) : null;
      delete dati.sceltaMenu;
      salvaStato(db, telefono, stato.passo, dati);
      if (fra) {
        // Con le esperienze: il numero o il nome di uno dell'elenco.
        const i = interpretaEsperienza(testo, fra);
        const m = i !== null ? menuDellEsperienza(cfg, fra[i]) : null;
        if (m) return mandaOChiedi(m);
      } else {
        if (quale === 'degustazione' && attivi.degustazione) return mandaOChiedi('degustazione');
        if (quale === 'menu' && attivi.menu) return mandaOChiedi('menu');
      }
    }
    // La risposta a «vuoi che te lo rimandi?». Il segno si toglie comunque:
    // se ha scritto un'altra cosa, quella cosa si legge normalmente.
    if (cosa !== undefined && dati.rimandaMenu) {
      const rimandaMenu = dati.rimandaMenu;
      // ⚠️ Si toglie dall'oggetto in mano, non solo dall'archivio: i passi qui
      // sotto risalvano `dati` com'è, e il segno sarebbe tornato — e un «sì»
      // al riepilogo, tre messaggi dopo, avrebbe rimandato il menu invece di
      // confermare il tavolo. Visto rompendo una prova.
      delete dati.rimandaMenu;
      salvaStato(db, telefono, stato.passo, dati);
      const si = interpretaSiNo(testo);
      const daRimandare = menuDaQuale(rimandaMenu);
      if (si === true && daRimandare) { manda(daRimandare); return esito; }
      if (si === false) { risposte.push(`Va bene 👍\n\n${dopo()}`); return esito; }
    }
    if (cosa !== undefined && quale && !(stato.passo === 'persone' && personeDette(testo) !== null)
        && !(stato.passo === 'esperienza' && interpretaEsperienza(testo, esperienze) !== null)
        && !(stato.passo === 'locale' && interpretaLocale(testo, localiProposti) !== null)) {
      const faq = stato.passo === 'persone' ? cercaFaq(db, testo) : null;
      if (faq) { risposte.push(riempi(faq, valori)); return esito; }
      // ⚠️ Chi ha scelto un altro locale (il bistrot) non riceve il menu del
      // locale di sempre: lo si dice, come per un'esperienza senza menu.
      if (dati.fuoriSala) {
        risposte.push(`${di('bot_t_esperienza_senza_menu', { esperienza: dati.localeScelto || '' })}\n\n${dopo()}`);
        return esito;
      }
      const q = scelto();
      // L'esperienza un menu non ce l'ha: lo si dice, non se ne manda un altro.
      if (q && q.senza) {
        risposte.push(`${di('bot_t_esperienza_senza_menu', { esperienza: q.senza.nome })}\n\n${dopo()}`);
        return esito;
      }
      // Nessun menu da mandare: lo si dice, invece di far finta di non capire.
      if (q !== null && typeof q === 'string' && !attivi[q]) {
        risposte.push(`${di('bot_t_menu_nessuno')}\n\n${dopo()}`);
        return esito;
      }
      if (!q) {
        // Più di un menu e «menu» generico: quale? Con le esperienze l'elenco
        // è quello delle esperienze che un menu ce l'hanno.
        if (conMenuE.length > 1 && !esperienzaDi(cfg, dati.esperienza)) {
          salvaStato(db, telefono, stato.passo, { ...dati, sceltaMenu: conMenuE.map((e) => e.nome) });
          risposte.push(di('bot_t_menu_quale_esperienze', { menu: elencoEsperienze(conMenuE) }));
          return esito;
        }
        salvaStato(db, telefono, stato.passo, { ...dati, sceltaMenu: true });
        risposte.push(di('bot_t_menu_quale'));
        return esito;
      }
      return mandaOChiedi(q);
    }
  }

  // --- Gli orari, in qualunque momento ---
  // «Che orari fate?» ha la risposta nelle impostazioni (le fasce): si dice
  // e si riprende da dove si era, come per il menu. A inizio, con le
  // esperienze, sotto arriva la domanda sull'esperienza.
  if (valori.orari && DOMANDA_DOPO_IL_MENU[stato.passo] !== undefined && chiedeGliOrari(testo)) {
    const cosa = DOMANDA_DOPO_IL_MENU[stato.passo];
    if (!cosa && conLocali && stato.passo === 'inizio') return chiediLocale({}, '', di('bot_t_orari'));
    if (!cosa && conEsperienze && stato.passo === 'inizio') return chiediEsperienza({}, '', di('bot_t_orari'));
    risposte.push(`${di('bot_t_orari')}\n\n${cosa ? di('bot_t_menu_riprendi', { cosa }) : di('bot_t_menu_prenota')}`);
    return esito;
  }

  // ================= La macchina a stati =================

  if (stato.passo === 'inizio') {
    // Chi ha già un tavolo prenotato quasi sempre scrive per sapere QUANDO, o
    // perché non se lo ricorda. Rispondergli come a uno qualunque — o peggio,
    // fargli fare tutto il giro e prenotare due volte — è il modo più rapido
    // di riempire il locale di doppioni e di telefonate per disfarli.
    const gia = prenotazioneFutura(db, telefono, adesso, contesto.numero);
    // Gli si ricorda il tavolo che ha già, con dentro le due parole per
    // cambiarlo o disdirlo. Serve in due casi diversi che finiscono uguale:
    // quando saluta, e quando scrive qualcosa di incomprensibile.
    // ⚠️ Ricordare il tavolo NON vuol dire mettersi in attesa di un numero.
    // Prima qui si passava al passo «persone»: da lì «ok» era «non ho capito
    // il numero», e due «ok» di fila mandavano la conversazione a una persona.
    // Ora la conversazione resta all'inizio e la strada per prenotare di nuovo
    // ha un nome: NUOVA.
    //
    // Il conto dei tentativi serve solo quando si arriva qui perché NON si è
    // capito: ripetere all'infinito lo stesso ricordino a chi continua a
    // scrivere altro è il modo di non farsi più leggere. Chi saluta, invece,
    // riparte da zero: salutare non è un errore.
    const ricordaIlTavolo = (nonHoCapito = false) => {
      const tentativi = nonHoCapito ? (dati.tentativi || 0) + 1 : 0;
      if (tentativi >= tentativiMassimi) {
        azzeraStato(db, telefono);
        esito.passaAUmano = true;
        return esito;
      }
      // `ricordato`: il messaggio dopo è una risposta al ricordino (vedi sotto).
      salvaStato(db, telefono, 'inizio', { tentativi, ricordato: true });
      const tutte = prenotazioniFuture(db, telefono, adesso, 5, contesto.numero);
      const nome = [gia.nome, gia.cognome].filter(Boolean).join(' ');
      // Con più tavoli si dicono TUTTI. Mostrarne uno solo faceva credere che
      // gli altri non ci fossero: chi ne aveva prenotati due vedeva il primo e
      // pensava che il secondo non fosse mai stato registrato.
      if (tutte.length > 1) {
        risposte.push(conElenco(di('bot_t_gia_prenotate', { nome, quante: tutte.length }), tutte));
        return esito;
      }
      risposte.push(di(gia.fuori_sala ? 'bot_t_gia_altro_locale' : 'bot_t_gia_prenotato', {
        nome, scelto: gia.locale_scelto,
        data: dataItaliana(gia.data), ora: oraDellaPrenotazione(cfg, gia), persone: gia.persone,
      }));
      return esito;
    };
    // «NUOVA» va guardata PRIMA del ricordino: chi la scrive il ricordino lo ha
    // già letto, e gli si sta rispondendo. Senza questa riga «nuova
    // prenotazione» ricadrebbe nel ricordino — la stessa frase, di nuovo.
    if (PAROLA_NUOVA.test(String(testo).trim())) {
      // Con le esperienze, anche a chi scrive NUOVA si chiede prima quale (e
      // con più locali, prima ancora dove).
      if (conLocali) return chiediLocale({}, '');
      if (conEsperienze) return chiediEsperienza({}, '');
      salvaStato(db, telefono, 'persone', nomeEsperienza({}));
      // ⚠️ Qui NON va il benvenuto. Chi scrive NUOVA ha appena letto il nostro
      // messaggio e ci sta rispondendo: ripresentarsi — «sono l'assistente
      // di…» — gli dice che non ci ricordiamo di lui, tre righe dopo che gli
      // avevamo elencato la sua prenotazione.
      risposte.push(di('bot_t_quante'));
      return esito;
    }
    // A un cenno del capo si risponde con un cenno del capo. Ripetere il
    // ricordino identico è un muro, e contarlo come equivoco porta a mettere
    // un operatore addosso a chi ha solo detto che andava bene.
    if (gia && eSoloDaccordo(testo)) {
      salvaStato(db, telefono, 'inizio', { tentativi: 0 });
      risposte.push(di('bot_t_daccordo'));
      return esito;
    }
    if (gia && (eSalutoStorto(testo) || /(prenotaz|tavolo|conferm|quando|ricord|ho prenotato)/.test(t))) {
      return ricordaIlTavolo();
    }
    // ⚠️ Dopo il promemoria (23 ottobre 2026, da una chat vera): «Grazie» →
    // 😊, poi «20.30». Il bot leggeva venti persone e cominciava una
    // prenotazione NUOVA («RO bistrot o REAR?»), e più tardi lo avrebbe
    // richiamato con «Sei ancora lì?». Chi ha un tavolo e scrive solo un
    // orario vuole il suo tavolo a quell'ora, quel giorno: glielo si propone,
    // e decide lui (SÌ). L'ora che ha già è un «ci siamo»: un cenno e basta.
    if (gia && soloUnOrario(testo)) {
      const tutte = prenotazioniFuture(db, telefono, adesso, 5, contesto.numero);
      if (tutte.length === 1 && !gia.fuori_sala) {
        const opzioni = { escludiId: gia.id, senzaPreavviso: true, ...perEsperienza({ esperienza: gia.esperienza }) };
        const liberi = turniDisponibili(db, cfg, gia.data, gia.persone, adesso, opzioni);
        const ora = interpretaOra(testo, liberi.includes(gia.ora) ? liberi : [...liberi, gia.ora].sort());
        if (ora === gia.ora) {
          salvaStato(db, telefono, 'inizio', { tentativi: 0 });
          risposte.push(di('bot_t_daccordo'));
          return esito;
        }
        if (ora) {
          return chiediConfermaSposta({ id: gia.id, persone: gia.persone, data: gia.data,
            ...(gia.esperienza ? { esperienza: gia.esperienza } : {}) }, ora);
        }
      }
      return ricordaIlTavolo();
    }

    const persone = personeDette(testo);
    // ⚠️ Chi ha già un tavolo e scrive un numero e basta («4», «siamo in 6»),
    // senza che gli si sia chiesto niente — dopo il promemoria, dopo un
    // «grazie» — non sta per forza prenotando un altro tavolo: può voler
    // cambiare il suo. Gli si mostra il suo, con le parole per cambiarlo. Uno
    // NUOVO si comincia se lo dice («vorrei prenotare», «un altro tavolo»,
    // NUOVA), o se il numero risponde al ricordino appena mandato: le frasi di
    // prima dicevano «se vuoi un altro tavolo, dimmi per quante persone», e chi
    // le ha ancora deve poter rispondere così.
    if (gia && persone !== null && !dati.ricordato
        && !/(prenot|tavolo|posto|coperti|disponibil|vorrei|possibile|nuov|altr)/.test(t)) {
      return ricordaIlTavolo(true);
    }
    // ⚠️ Il giorno detto già nel primo messaggio (19 ottobre 2026): «vorrei
    // prenotare per 2 domenica sera» si perdeva per strada — senza esperienze
    // il bot richiedeva «quale giorno?», e a chi la domenica sera trovava
    // chiuso nessuno lo diceva. Ora si tiene, e il passo del giorno dice
    // com'è: «a cena siamo chiusi, ma…».
    const giornoDelPrimo = giornoDettoInsieme(testo);
    const conGiorno = giornoDelPrimo ? { giornoDetto: giornoDelPrimo } : {};
    // «vorrei prenotare» senza numero, oppure un numero già nel primo messaggio
    if (persone === null) {
      // ⚠️ IL GUASTO, visto in una chat vera. «possibile» stava in questo
      // elenco, e bastava contenerlo: «È possibile parcheggiare» diventava una
      // prenotazione, e il cliente che aveva chiesto del parcheggio si sentiva
      // rispondere «per quante persone desideri prenotare?». Con la
      // prenotazione già confermata due minuti prima.
      //
      // La regola giusta non è togliere una parola — è guardare la FORMA. Se
      // dentro non c'è niente che parli di prenotare e il messaggio è una
      // domanda, quella è una domanda su altro: il parcheggio, il cane, la
      // carta di credito. Non si risponde con un modulo di prenotazione.
      const parlaDiPrenotare = /(prenot|tavolo|posto|coperti|disponibil)/.test(t);
      const domandaSuAltro = !parlaDiPrenotare
        && (String(testo).includes('?') || APERTURE_DI_DOMANDA.test(t));
      // ⚠️ Il PRIMO messaggio non si controlla: qualunque cosa sia — «we»,
      // «Eih», «cia», una domanda — parte l'introduzione. Deciso dal titolare.
      // Prima a un «we» il bot rispondeva «non sono riuscita a capire cosa
      // intendi»: al primo messaggio non c'è niente da capire, chi scrive sta
      // solo bussando, e sentirsi dire «non ho capito» suona da macchina. In
      // più quel «we» contava già come un equivoco — al secondo la
      // conversazione passava a una persona — e finiva fra le frasi non
      // capite, dove era rumore.
      //
      // Restano fuori, e restano prima: STOP (il server lo guarda prima del
      // bot), le risposte pronte (qui sopra), e chi ha GIÀ un tavolo, che
      // riceve il promemoria del suo — per lui l'introduzione è quella, e
      // senza rischia di prenotare due volte.
      //
      // Fra le non capite ci va solo una DOMANDA vera: è da lì che il
      // ristoratore scopre quali risposte pronte aggiungere.
      if (domandaSuAltro) annotaNonCapita(db, testo);
      // Chi ha già un tavolo e chiede di prenotarne un altro va avanti: è
      // «per quante persone?», qui sotto. Il promemoria è per tutto il resto.
      const sembraPrenotazione = !domandaSuAltro
        && (parlaDiPrenotare || /(vorrei|possibile)/.test(t) || eSalutoStorto(testo));
      if (gia && !sembraPrenotazione) return ricordaIlTavolo(true);
      return presentati({ ...conServizio({}), ...conGiorno }, gia);
    }
    // Le persone già nel primo messaggio: con le esperienze si tengono da
    // parte, si chiede l'esperienza, e la domanda delle persone non si rifà.
    if (conLocali) {
      return chiediLocale({ ...conServizio({}), persone, ...conGiorno },
        gia ? '' : (giaVisto ? 'bot_t_bentornato_locali' : 'bot_t_benvenuto_locali'));
    }
    if (conEsperienze) {
      return chiediEsperienza({ ...conServizio({}), persone, ...conGiorno },
        gia ? '' : (giaVisto ? 'bot_t_bentornato_esperienze' : 'bot_t_benvenuto_esperienze'));
    }
    return passoPersone(persone, giornoDelPrimo, {});
  }

  // ---- L'esperienza: «business lunch», «alla carta», «degustazione» ----
  // Deciso dal titolare. La si chiede subito dopo il benvenuto, quando ce ne
  // sono almeno due: da lei discendono i giorni e gli orari possibili, e il
  // nome finisce sulla prenotazione per la cucina.
  // L'elenco da proporre: tutte, oppure — se il giorno l'ha già detto — solo
  // quelle che valgono quel giorno («sabato sera» non ha il business lunch).
  // I numeri dell'elenco ristretto si ricordano in `scelte`.
  function elencoDaProporre(d) {
    const tutte = { valide: esperienze, ristrette: false,
      testo: diConElenco('bot_t_esperienze', elencoEsperienze(esperienze), { numeri: numeriDetti(daUnoA(esperienze.length)) }) };
    // Il servizio senza il giorno («a cena»): quelle che a cena ci sono, in
    // qualche giorno (24 ottobre 2026: «A cena» non si capiva).
    if (!d.giornoDetto && d.servizio) {
      const valide = esperienze.filter((e) => (d.servizio === 'pranzo' ? e.pranzo : e.cena).length);
      if (!valide.length) return tutte;
      return { valide, ristrette: true,
        testo: diConElenco('bot_t_esperienze_giorno', elencoEsperienze(valide),
          { data: d.servizio === 'pranzo' ? 'A pranzo' : 'A cena', servizio: '', numeri: numeriDetti(daUnoA(valide.length)) }) };
    }
    if (!d.giornoDetto) return tutte;
    const valide = esperienze.filter((e) => valeIlGiorno(e, d.giornoDetto, d.servizio));
    if (!valide.length) return tutte;
    const data = dataItaliana(d.giornoDetto);
    return { valide, ristrette: true,
      testo: diConElenco('bot_t_esperienze_giorno', elencoEsperienze(valide),
        { data: data.charAt(0).toUpperCase() + data.slice(1), servizio: d.servizio ? ` a ${d.servizio}` : '',
          numeri: numeriDetti(daUnoA(valide.length)) }) };
  }
  // Il benvenuto (senza righe coi segnaposto vuoti: la riga degli orari di un
  // locale senza orari non deve uscire mezza) e la domanda. Se il giorno già
  // detto lascia UNA esperienza sola, si prende senza chiedere.
  // ⚠️ Nel benvenuto con le esperienze gli orari del locale non ci vanno più
  // (22 ottobre 2026): arrivano dopo la scelta, quelli dell'esperienza. Chi
  // aveva personalizzato la frase con «Siamo aperti {orari}» la riceve senza
  // quella riga — {orari} vuoto la toglie intera (vedi «orariARighe»).
  function chiediEsperienza(d, benvenuto, testaInPiu = '') {
    const senzaOrari = { ...valori, orari: '' };
    const testa = [testaInPiu, benvenuto ? riempi(senzaRigheVuote(cfg[benvenuto], senzaOrari), senzaOrari).trim() : '']
      .map((x) => String(x || '').trim()).filter(Boolean).join('\n\n');
    const elenco = elencoDaProporre(d);
    // In testa alla risposta che segue: il benvenuto, o «Che bello rivederti».
    const conTesta = (fai) => {
      const prima = risposte.length;
      const r = fai();
      if (testa && risposte.length > prima) risposte[prima] = `${testa}\n\n${risposte[prima]}`;
      return r;
    };
    if (elenco.ristrette && elenco.valide.length === 1) return conTesta(() => presaLEsperienza(elenco.valide[0], d));
    // L'ha già detta («vorrei il business lunch da 45 per 4»): si prende,
    // senza fargliela riscegliere da un elenco. Se il nome vale per più
    // d'una, si chiede fra quelle.
    const detta = esperienzeNominate(testo, elenco.valide);
    if (detta.length === 1) return conTesta(() => presaLEsperienza(elenco.valide[detta[0]], d));
    if (detta.length > 1) return conTesta(() => chiediQualeFra(elenco.valide, detta, elenco.ristrette ? { ...d, scelte: elenco.valide.map((e) => e.nome) } : d));
    salvaStato(db, telefono, 'esperienza', { ...d, ...(elenco.ristrette ? { scelte: elenco.valide.map((e) => e.nome) } : {}) });
    risposte.push([testa, elenco.testo].filter(Boolean).join('\n\n'));
    return esito;
  }
  // Scelta: se ha un menu da offrire (scheda Menu) si fa il cappello e si
  // chiede se lo vuole; sennò avanti con le persone.
  // Scelta: «perfetto», il cappello scritto dal titolare, e — se ha un menu
  // attivo da offrire — «se vuoi vederlo scrivi MENU». Niente domanda in
  // più, deciso dal titolare: si va dritti alle persone.
  // Il nome scritto vale per più d'una («business lunch»: da €35 o da €45?):
  // si chiede quale, con l'elenco di quelle sole e i numeri che il cliente ha
  // già letto. `lista` è l'elenco a cui si riferiscono i numeri: quello
  // proposto (ristretto al giorno) o tutte — e allora i numeri sono di tutte.
  function chiediQualeFra(lista, indici, d) {
    const { scelte, ...resto } = d;
    salvaStato(db, telefono, 'esperienza', { ...resto, ...(lista !== esperienze && scelte ? { scelte } : {}) });
    const sue = indici.map((i) => lista[i]);
    const numeri = indici.map((i) => i + 1);
    // «Quando vale» solo se le distingue: due business lunch dal lunedì al
    // venerdì a pranzo, scritto due volte, è rumore.
    const conQuando = new Set(sue.map((e) => quandoDetto(e))).size > 1;
    risposte.push(diConElenco('bot_t_esperienza_quale', elencoEsperienze(sue, { numeri, conQuando }), { numeri: numeriDetti(numeri) }));
    return esito;
  }
  // «No» a «Perfetto, business lunch 👍»: l'elenco di nuovo, tutte.
  function sceltaDaCapo(d) {
    const { scelte, esperienza, tentativi, ...resto } = d;
    salvaStato(db, telefono, 'esperienza', resto);
    risposte.push(diConElenco('bot_t_esperienza_altra', elencoEsperienze(esperienze), { numeri: numeriDetti(daUnoA(esperienze.length)) }));
    return esito;
  }
  // ⚠️ L'esperienza si corregge anche DOPO averla scelta. Visto in una chat
  // vera (19 ottobre 2026): «business lunch» → «Perfetto, Business lunch da
  // €35 👍 Per quante persone?» → «No business lunch da 45 euro» → «Per 45
  // persone preferisco farti parlare con il locale». Il cliente correggeva.
  // Ai passi delle persone e del giorno (quelli che vengono subito dopo):
  // - ne nomina un'ALTRA, una sola → si cambia, e si riparte da lì;
  // - ne nomina più d'una → si chiede quale;
  // - «no» + quella di adesso fra altre («no, business lunch») → le altre;
  // - un «no» secco, alla domanda delle persone → l'elenco di nuovo.
  // Il servizio e l'ora no: lì «pranzo» o «no» rispondono alla domanda, e una
  // parola dell'esperienza potrebbe essere proprio quella.
  function correggeLEsperienza() {
    // Il giorno e il servizio non contano: «sabato a cena» risponde alla
    // domanda del giorno anche se fra le parole della carta c'è «cena».
    const daGuardare = normalizza(testo)
      .replace(/\b(pranzo|cena|stasera|oggi|domani|dopodomani|lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica)\b/g, ' ');
    const nominate = esperienzeNominate(daGuardare, esperienze);
    const attuale = esperienze.findIndex((e) => e.nome === dati.esperienza);
    const nega = /^(no|non|nono)\b/.test(normalizza(testo));
    let altre = [];
    if (nominate.length && !nominate.includes(attuale)) altre = nominate;
    else if (nominate.length > 1 && nega) altre = nominate.filter((i) => i !== attuale);
    const { esperienza, tentativi, scelte, ...resto } = dati;
    const persone = personeDette(testo);
    const giorno = giornoDettoInsieme(testo);
    const tenuti = { ...resto, ...(persone !== null ? { persone } : {}), ...(giorno ? { giornoDetto: giorno } : {}) };
    if (altre.length === 1) return presaLEsperienza(esperienze[altre[0]], tenuti);
    if (altre.length > 1) return chiediQualeFra(esperienze, altre, tenuti);
    if (stato.passo === 'persone' && !nominate.length && persone === null && interpretaSiNo(testo) === false) {
      return sceltaDaCapo(dati);
    }
    return null;
  }
  function presaLEsperienza(e, d) {
    const { scelte, ...resto } = d;
    const dopo = { ...resto, esperienza: e.nome };
    const conMenu = menuDellEsperienza(cfg, e);
    const testa = [di('bot_t_esperienza_presa', { esperienza: e.nome }), orariDellEsperienza(cfg, e), e.cappello,
      conMenu ? di('bot_t_esperienza_menu') : '']
      .map((x) => String(x || '').trim()).filter(Boolean).join('\n\n');
    return dopoLEsperienza(dopo, testa);
  }
  // Dopo l'esperienza: le persone, se non le ha già dette; sennò il giorno.
  // `testa` va in cima alla prima risposta («Perfetto, business lunch 👍»).
  function dopoLEsperienza(d, testa) {
    const prima = risposte.length;
    let r;
    if (d.persone) {
      const { persone, giornoDetto, ...resto } = d;
      r = passoPersone(persone, giornoDetto || null, resto);
    } else {
      salvaStato(db, telefono, 'persone', d);
      risposte.push(di('bot_t_quante'));
      r = esito;
    }
    const t = String(testa || '').trim();
    if (t && risposte.length > prima) risposte[prima] = `${t}\n\n${risposte[prima]}`;
    return r;
  }

  // ---- Il locale: «RO bistrot o REAR Restaurant?» (vedi «I locali») ----
  // La prima domanda, prima ancora dell'esperienza. `d` porta quello che il
  // cliente ha già detto (persone, giorno, servizio): vale per il locale di
  // sempre, e le persone anche per l'altro.
  // ---- La presentazione: il primo messaggio, e RICOMINCIA ----
  // Con le esperienze la prima domanda è «cosa vuoi mangiare»: il benvenuto
  // senza la domanda delle persone, e sotto l'elenco. Con più locali la prima
  // domanda è DOVE (vedi «I locali»). Sennò il benvenuto, che chiede le
  // persone.
  // Il benvenuto è il PRIMO messaggio, e vale per chi arriva davvero la prima
  // volta. Chi ha già un tavolo da noi (`gia`) ci ha già parlato: gli si fa la
  // domanda e basta. Chi ci scrisse mesi fa e oggi non ha più niente di attivo
  // non si sente ripresentare l'assistente — lo conosce già: gli si dice «che
  // bello rivederti», col nome (vedi `giaVisto`). Sotto il benvenuto, l'invito
  // a vedere il menu: solo se il collegamento c'è e la frase non è stata
  // svuotata. Non a chi ha già un tavolo.
  // `testa` va in cima a tutto («Va bene, ricominciamo da capo!»).
  function presentati(d, gia, testa = '') {
    if (conLocali) {
      return chiediLocale(d, gia ? '' : (giaVisto ? 'bot_t_bentornato_locali' : 'bot_t_benvenuto_locali'), testa);
    }
    if (conEsperienze) {
      return chiediEsperienza(d, gia ? '' : (giaVisto ? 'bot_t_bentornato_esperienze' : 'bot_t_benvenuto_esperienze'), testa);
    }
    salvaStato(db, telefono, 'persone', { ...d, ...nomeEsperienza({}) });
    const invito = !gia && Object.keys(menuAttivi(cfg)).length && String(cfg.bot_t_menu_invito || '').trim()
      ? `\n\n${di('bot_t_menu_invito')}` : '';
    risposte.push([testa, di(gia ? 'bot_t_quante' : (giaVisto ? 'bot_t_bentornato' : 'bot_t_benvenuto')) + invito].filter(Boolean).join('\n\n'));
    return esito;
  }
  function chiediLocale(d, benvenuto, testaInPiu = '') {
    const testa = [testaInPiu, benvenuto ? riempi(senzaRigheVuote(cfg[benvenuto], valori), valori).trim() : '']
      .map((x) => String(x || '').trim()).filter(Boolean).join('\n\n');
    salvaStato(db, telefono, 'locale', d);
    risposte.push([testa, diLocali('bot_t_locali')].filter(Boolean).join('\n\n'));
    return esito;
  }
  // Il locale di sempre: tutto come prima, dall'esperienza (o dalle persone)
  // in giù, con «Perfetto, REAR Restaurant 👍» e i suoi orari in cima.
  function presoIlPrincipale(d) {
    // Con le esperienze gli orari vengono DOPO la loro scelta, e sono i loro
    // (vedi «orariDellEsperienza»); senza, si dicono qui.
    const testa = [di('bot_t_locale_preso', { scelto: localePrincipale.nome }), valori.orari && !conEsperienze ? di('bot_t_orari') : '']
      .map((x) => String(x || '').trim()).filter(Boolean).join('\n\n');
    if (conEsperienze) return chiediEsperienza(d, '', testa);
    return dopoLEsperienza(d, testa);
  }
  // Un altro locale: la sua presentazione, poi le persone. Il giorno e l'ora
  // sono i suoi, e non si chiedono: sono scritti nella presentazione.
  function presoAltroLocale(a, d) {
    if (postiAltroLocale(db, a) <= 0) return altroLocalePieno(a);
    const testa = riempi(a.testo || '', valori).trim();
    if (d.persone) return personeAltroLocale(a, d.persone, testa);
    salvaStato(db, telefono, 'altro_locale_persone', baseAltroLocale(a));
    risposte.push([testa, di('bot_t_quante')].filter(Boolean).join('\n\n'));
    return esito;
  }
  function baseAltroLocale(a) { return { localeScelto: a.nome, fuoriSala: true, data: a.data, ora: a.da }; }
  // Pieno: lo si dice, e si ripropone la scelta (il locale di sempre c'è ancora).
  function altroLocalePieno(a) {
    salvaStato(db, telefono, 'locale', {});
    risposte.push(`${di('bot_t_altro_locale_pieno', { scelto: a.nome, data: dataItaliana(a.data) })}\n\n${diLocali('bot_t_locali')}`);
    return esito;
  }
  function personeAltroLocale(a, persone, testa = '') {
    const conTesta = (x) => [testa, x].filter(Boolean).join('\n\n');
    const base = baseAltroLocale(a);
    // Come per la sala di sempre: i gruppi grossi li prende una persona.
    if (persone > num(cfg.bot_max_persone, 8)) {
      risposte.push(conTesta(`Per ${persone} persone preferisco farti parlare con il locale: ti risponde una persona a breve.`));
      esito.passaAUmano = true;
      azzeraStato(db, telefono);
      return esito;
    }
    if (persone < num(cfg.bot_min_persone, 1)) {
      salvaStato(db, telefono, 'altro_locale_persone', base);
      risposte.push(conTesta(di('bot_t_persone_no')));
      return esito;
    }
    const posti = postiAltroLocale(db, a);
    if (posti <= 0) return altroLocalePieno(a);
    // Meno posti di quelli chiesti: si dice quanti, e si richiede.
    if (persone > posti) {
      salvaStato(db, telefono, 'altro_locale_persone', base);
      risposte.push(conTesta(di('bot_t_altro_locale_restano', { scelto: a.nome, posti: posti === 1 ? '1 posto' : `${posti} posti` })));
      return esito;
    }
    const prima = risposte.length;
    const r = dopoLOra({ ...base, persone });
    if (testa && risposte.length > prima) risposte[prima] = `${testa}\n\n${risposte[prima]}`;
    return r;
  }

  if (stato.passo === 'locale') {
    // Nel frattempo la scelta è sparita (l'altro locale ha chiuso le
    // prenotazioni): si riparte come se fosse il primo messaggio.
    if (!conLocali) {
      azzeraStato(db, telefono);
      return rispondiAlMessaggio(db, telefono, testo, adesso, contesto);
    }
    const i = interpretaLocale(testo, localiProposti);
    if (i === null) {
      const faq = cercaFaq(db, testo);
      if (faq) { risposte.push(riempi(faq, valori)); return esito; }
      // «Siamo in 4», «sabato»: si tiene da parte e si richiede il locale. Non
      // è un equivoco: ha risposto a una domanda che viene dopo.
      const persone = interpretaPersone(testo);
      const giorno = giornoDettoInsieme(testo);
      if (persone !== null || giorno) {
        salvaStato(db, telefono, 'locale', { ...avanzato(dati), ...conServizio(),
          ...(persone !== null ? { persone } : {}), ...(giorno ? { giornoDetto: giorno } : {}) });
        risposte.push(diLocali('bot_t_locali'));
        return esito;
      }
      return nonCapito('locale', dati, diLocali('bot_t_locale_no'));
    }
    const scelto = localiProposti[i];
    if (localePrincipale && normalizza(scelto.nome) === normalizza(localePrincipale.nome)) return presoIlPrincipale(avanzato(dati));
    return presoAltroLocale(scelto, avanzato(dati));
  }

  if (stato.passo === 'altro_locale_persone') {
    const a = altroLocaleDi(cfg, dati.localeScelto);
    // Le prenotazioni per quel locale si sono chiuse mentre scriveva.
    if (!a || !altroLocaleAperto(cfg, a, adesso)) {
      azzeraStato(db, telefono);
      return rispondiAlMessaggio(db, telefono, testo, adesso, contesto);
    }
    const persone = interpretaPersone(testo);
    if (persone === null) return nonCapito('altro_locale_persone', dati, di('bot_t_persone_no'));
    return personeAltroLocale(a, persone);
  }

  if (stato.passo === 'esperienza') {
    // Prima fra quelle proposte (i numeri sono quelli), poi fra tutte: chi
    // di sabato scrive «business lunch» ha scelto, e il giorno glielo dice.
    const proposte = dati.scelte ? esperienze.filter((e) => dati.scelte.includes(e.nome)) : esperienze;
    let fra = proposte;
    let scelta = interpretaEsperienza(testo, proposte);
    if (scelta === null) {
      const ambigue = esperienzeNominate(testo, proposte);
      if (ambigue.length > 1) return chiediQualeFra(proposte, ambigue, { ...avanzato(dati), ...conServizio() });
    }
    if (scelta === null && proposte !== esperienze) {
      fra = esperienze;
      scelta = interpretaEsperienza(testo, esperienze);
      const ambigue = scelta === null ? esperienzeNominate(testo, esperienze) : [];
      if (ambigue.length > 1) return chiediQualeFra(esperienze, ambigue, { ...avanzato(dati), ...conServizio() });
    }
    if (scelta === null) {
      const faq = cercaFaq(db, testo);
      if (faq) { risposte.push(riempi(faq, valori)); return esito; }
      // «Siamo in 4», «sabato», «per questa sera a cena», «a cena»: si tiene
      // da parte e si richiede l'esperienza, solo fra quelle che valgono.
      // Non è un equivoco: ha risposto a una domanda che viene dopo.
      const persone = personeDette(testo);
      const giorno = giornoDettoInsieme(testo);
      // ⚠️ «Non lo so», «decido al tavolo»: non è una risposta che non si
      // capisce, è un «non scelgo» detto chiaro (dal titolare, 24 ottobre
      // 2026, su una chat vera: «Non lo so» si sentiva rispondere «non ho
      // capito», e l'elenco di nuovo). Si va avanti subito, tenendo quello che
      // ha detto insieme («non lo so, siamo in 4»).
      if (nonSceglieIlMenu(testo)) {
        const { scelte, ...resto } = avanzato(dati);
        return dopoLEsperienza({ ...resto, ...conServizio(), ...(persone !== null ? { persone } : {}),
          ...(giorno ? { giornoDetto: giorno } : {}), esperienza: MENU_AL_TAVOLO }, di('bot_t_esperienza_al_tavolo'));
      }
      if (persone !== null || giorno || servizioDetto(testo) || eSaluto(testo)) {
        const { scelte, ...resto } = avanzato(dati);
        return chiediEsperienza({ ...resto, ...conServizio(),
          ...(persone !== null ? { persone } : {}), ...(giorno ? { giornoDetto: giorno } : {}) }, '');
      }
      // ⚠️ Dal titolare (24 ottobre 2026), su una chat vera: due «non ho
      // capito» al menu, e il cliente ha chiesto un operatore. Alla seconda
      // risposta che non si capisce il bot non insiste: si va avanti, e il
      // menu lo sceglie al tavolo. La sala lo vede sulla prenotazione.
      if ((dati.tentativi || 0) >= 1) {
        const { scelte, ...resto } = avanzato(dati);
        return dopoLEsperienza({ ...resto, ...conServizio(), esperienza: MENU_AL_TAVOLO }, di('bot_t_esperienza_al_tavolo'));
      }
      return nonCapito('esperienza', dati, diConElenco('bot_t_esperienza_no', elencoEsperienze(proposte),
        { numeri: numeriDetti(daUnoA(proposte.length)) }));
    }
    return presaLEsperienza(fra[scelta], { ...avanzato(dati), ...conServizio() });
  }

  if ((stato.passo === 'persone' || stato.passo === 'giorno') && conEsperienze && dati.esperienza && !dati.fuoriSala) {
    const corretta = correggeLEsperienza();
    if (corretta) return corretta;
  }

  if (stato.passo === 'persone') {
    const persone = personeDette(testo);
    if (persone === null) {
      // Dopo il benvenuto il cliente può fare tutt'altro: «avete il
      // parcheggio?». Rispondergli «non ho capito il numero di persone»
      // sarebbe da sordi, e ripeterlo all'infinito lo farebbe andare via.
      const faq = cercaFaq(db, testo);
      if (faq) { risposte.push(riempi(faq, valori)); return esito; }
      if (eSaluto(testo)) { risposte.push(di('bot_t_persone_no')); return esito; }
      const tentativi = (dati.tentativi || 0) + 1;
      if (tentativi >= tentativiMassimi) {
        // Basta così (tre di partenza): da qui in poi insistere peggiora
        // soltanto. Passa a una persona.
        annotaNonCapita(db, testo);
        azzeraStato(db, telefono);
        esito.passaAUmano = true;
        return esito;
      }
      salvaStato(db, telefono, 'persone', { ...dati, tentativi });
      risposte.push((tentativi >= 2 && riscrivi('persone', dati)) || di('bot_t_persone_no'));
      return esito;
    }
    // Il giorno detto adesso («4 sabato»), o quello detto prima all'esperienza
    // («giovedì a pranzo» → business lunch → «per quante persone?» → «2»).
    return passoPersone(persone, giornoDettoInsieme(testo) || dati.giornoDetto || null, dati);
  }

  // «Siamo in 3 sabato sera»: il giorno detto insieme alle persone, o null.
  // ⚠️ Solo se nel messaggio c'è un giorno a PAROLE o una data: «siamo in 2»
  // da solo non è «il 2 del mese», e interpretaData lo leggerebbe così.
  // ⚠️ Anche «il 15 ottobre»: prima qui mancava il mese a parole, e «per 4 il
  // 15 ottobre» al primo messaggio perdeva la data — il bot la richiedeva.
  function giornoDettoInsieme(t) {
    const n = dateRaddrizzate(normalizza(t));
    if (!new RegExp(`\\b(oggi|stasera|stanotte|stamattina|(?:questa|sta) (?:sera|mattina|notte)|domani|dopodomani|lunedi|martedi|mercoledi|giovedi|venerdi|sabato|domenica|\\d{1,2}\\/\\d{1,2}|\\d{1,2} (${NOMI_MESI.join('|')}))\\b`).test(n)) return null;
    return interpretaData(t, adesso);
  }

  // Il giorno scritto alla domanda dell'orario, tolta l'ora: in «22 ottobre
  // ore 20.30» il «20.30» sembrerebbe una data. Lì anche «il 10» è un giorno
  // del mese. «Giovedì alle 20:30» mentre si prenota giovedì 10 è QUEL giovedì,
  // non il primo che viene.
  function giornoDettoAllOra(x) {
    const senza = normalizza(x)
      .replace(new RegExp(`\\b${PAROLE_DELL_ORA}\\s*\\d{1,2}(?:\\s*[:.,]?\\s*\\d{2})?\\b`, 'g'), ' ')
      .replace(/\b\d{1,2}\s*[:.,]\s*\d{2}\b/g, ' ');
    const il = senza.match(/\b(?:il|giorno)\s+(\d{1,2})\b(?!\s*(?:[°º]|turno))/);
    const giorno = giornoDettoInsieme(senza) || (il ? interpretaData(il[1], adesso) : null);
    const settimana = (iso) => { const [a, m, g] = iso.split('-').map(Number); return new Date(a, m - 1, g).getDay(); };
    if (giorno && dati.data && !/\d|\b(oggi|domani|dopodomani)\b/.test(senza) && settimana(giorno) === settimana(dati.data)) return dati.data;
    return giorno;
  }
  // Le persone scritte alla domanda dell'orario: solo se dette come persone
  // («4 persone», «siamo in 3», «sabato in 4»). Un numero da solo, lì, è l'ora.
  function personeDetteAllOra(x) {
    const parole = Object.keys(NUMERI_A_PAROLE).join('|');
    const m = normalizza(x).match(new RegExp(`\\b(?:siamo\\s+|saremo\\s+)?(?:in\\s+|siamo\\s+|saremo\\s+)(\\d{1,2}|${parole})\\b(?!\\s*[:.,]\\s*\\d)`
      + `|\\b(\\d{1,2}|${parole})\\s*(?:persone|pax|coperti)\\b`));
    return m ? interpretaPersone(m[1] || m[2]) : null;
  }

  // Il servizio detto adesso, o quello detto prima nella stessa conversazione.
  // «Siamo in 4, a cena» arriva quando si chiedono le persone, e serve due
  // passi dopo, quando si propongono gli orari.
  function conServizio(d = dati) {
    const s = servizioDetto(testo) || d.servizio;
    return s ? { servizio: s } : {};
  }

  // Propone gli orari di quel giorno — solo quelli del servizio chiesto, se
  // ne ha chiesto uno. Si salvano comunque TUTTI: chi ha chiesto il pranzo e
  // poi scrive «20:00» ha cambiato idea, non sbagliato.
  function proponiOrari(passo, d, iso, turni, servizio) {
    let suoi = servizio ? turni.filter((o) => servizioDellOra(cfg, iso, o) === servizio) : turni;
    let prima = di('bot_t_ora', { data: dataItaliana(iso) });
    let resta = servizio;
    if (servizio && !suoi.length) {
      // Chiuso e pieno, di nuovo, sono due notizie diverse.
      const esiste = turniAmmessi(cfg, iso, esperienzaScelta(d), turniDelGiorno(cfg, iso)).some((o) => servizioDellOra(cfg, iso, o) === servizio);
      // ⚠️ Il locale a pranzo c'è, l'esperienza scelta no (la carta, il
      // martedì, solo a cena): «a pranzo siamo chiusi» era falso, e chi voleva
      // il business lunch credeva il locale chiuso. Come per i giorni.
      const e = esperienzaScelta(d);
      const soloLei = !esiste && e && turniDelGiorno(cfg, iso).some((o) => servizioDellOra(cfg, iso, o) === servizio);
      prima = soloLei
        ? di('bot_t_servizio_esperienza', { esperienza: e.nome, data: dataItaliana(iso), servizio, quando: quandoDetto(e) })
        : di(esiste ? 'bot_t_servizio_pieno' : 'bot_t_servizio_chiuso', { data: dataItaliana(iso), servizio });
      suoi = turni;
      resta = undefined;
    } else if (suoi.length === 1 && numeroDelTurno(cfg, iso, suoi[0])) {
      // ⚠️ Un turno solo: un elenco di una riga e «scrivimi l'orario» farebbero
      // ricopiare l'unica scelta possibile. Spostando, è già la domanda di
      // conferma; prenotando, si chiede se va bene.
      const ora = suoi[0];
      if (passo === 'sposta_ora') return chiediConfermaSposta({ ...avanzato(d), data: iso, turni }, ora);
      salvaStato(db, telefono, passo, { ...avanzato(d), data: iso, turni, servizio: servizioDellOra(cfg, iso, ora), unico: ora });
      risposte.push(di('bot_t_turno_unico', {
        data: dataItaliana(iso), servizio: servizioDellOra(cfg, iso, ora), fascia: fasciaDetta(cfg, iso, ora), ora,
        arrivo: arrivoDetto(cfg, iso, ora),
      }));
      return esito;
    }
    // ⚠️ Chiuso a cena, e a pranzo un turno solo (19 ottobre 2026: la
    // domenica del titolare). Si chiede se va bene, come per il turno unico:
    // prima arrivava un elenco di una riga senza domanda, e il «sì» del
    // cliente finiva in «non ho capito quale orario preferisci».
    const unoSolo = !resta && servizio && passo !== 'sposta_ora' && suoi.length === 1 && numeroDelTurno(cfg, iso, suoi[0]) ? suoi[0] : undefined;
    salvaStato(db, telefono, passo, { ...avanzato(d), data: iso, turni, servizio: unoSolo ? servizioDellOra(cfg, iso, unoSolo) : resta, unico: unoSolo });
    const elenco = elencoTurni(suoi, cfg, iso);
    if (!resta && servizio) {
      // Il servizio chiesto è chiuso o pieno: la sua frase, e sotto i turni che restano.
      risposte.push([`${prima}\n${elenco}`, unoSolo ? di('bot_t_unico_va_bene') : ''].filter((x) => String(x).trim()).join('\n\n'));
    } else if (suoi.some((o) => numeroDelTurno(cfg, iso, o))) {
      // ⚠️ Se dalla pagina qualcuno ha tolto {turni}, l'elenco va in fondo:
      // un messaggio di turni senza i turni non si può rispondere.
      const testo = String(cfg.bot_t_ora_turno || '');
      risposte.push(testo.includes('{turni}')
        ? di('bot_t_ora_turno', { data: dataItaliana(iso), turni: elenco })
        : `${di('bot_t_ora_turno', { data: dataItaliana(iso) })}\n${elenco}`);
    } else if (suoi.some((o) => slotDelGiorno(cfg, iso)[servizioDellOra(cfg, iso, o)])) {
      // Gli orari scelti dal locale, come li ha voluti il titolare (27 ottobre
      // 2026): «Per sabato 31 ottobre a cena ho questi orari: 19:30 · 20:00 ·
      // 20:30 · 21:00 · 21:30. Scrivimi l'orario che preferisci.»
      const servizi = [...new Set(suoi.map((o) => servizioDellOra(cfg, iso, o)))];
      const valoriOra = { data: dataItaliana(iso), servizio: servizi.length === 1 ? ` a ${servizi[0]}` : '', orari: elenco };
      risposte.push(String(cfg.bot_t_ora_orari || '').includes('{orari}')
        ? di('bot_t_ora_orari', valoriOra) : `${di('bot_t_ora_orari', { ...valoriOra, orari: '' })}\n${elenco}`.trim());
    } else {
      risposte.push(`${prima}\n${elenco}`);
    }
    return esito;
  }

  // Pranzo o cena? Prima degli orari, deciso dal titolare — ma solo quando
  // serve: ogni domanda in più su WhatsApp è un'attesa, e un'occasione per
  // lasciar perdere. Non si chiede se il cliente l'ha già detto («sabato a
  // cena»), né se quel giorno c'è un servizio solo con posto: lì si va dritti
  // agli orari, e se l'altro c'è ma è pieno lo si dice.
  function chiediServizio(passi, d, iso, turni, servizio) {
    if (servizio) return proponiOrari(passi.ora, d, iso, turni, servizio);
    const liberi = [...new Set(turni.map((o) => servizioDellOra(cfg, iso, o)))];
    if (liberi.length > 1) {
      salvaStato(db, telefono, passi.servizio, { ...avanzato(d), data: iso, turni, servizio: undefined, unico: undefined });
      risposte.push(di('bot_t_servizio', { data: dataItaliana(iso) }));
      return esito;
    }
    const pieno = turniAmmessi(cfg, iso, esperienzaScelta(d), turniDelGiorno(cfg, iso)).map((o) => servizioDellOra(cfg, iso, o)).find((x) => x !== liberi[0]);
    // L'altro servizio c'è ma è pieno: «a pranzo non abbiamo più posto, ma…».
    return proponiOrari(passi.ora, d, iso, turni, pieno || liberi[0]);
  }

  function chiediConfermaSposta(d, ora) {
    salvaStato(db, telefono, 'sposta_conferma', { ...d, ora, unico: undefined });
    risposte.push(di('bot_t_sposta_conferma', {
      data: dataItaliana(d.data), ora: oraColTurno(cfg, d.data, ora), persone: d.persone,
    }));
    return esito;
  }

  // Non vuole nessuno dei turni di quel giorno: si torna ai giorni.
  // ⚠️ L'esperienza resta (19 ottobre 2026): qui si salvavano solo persone e
  // servizio, e dopo un «no» il business lunch spariva — riepilogo senza
  // «🍽️ Business lunch», e i turni della cena proposti a chi l'aveva scelto.
  // Se aveva scelto il servizio («cena»), i giorni con posto a quello.
  function unAltroGiorno(d) {
    const rifiutati = d.rifiutati || [];
    const opzioni = { ...perEsperienza(d), tranne: rifiutati.map((r) => r.split(' ')[0]) };
    const conServ = d.servizio ? giorniDisponibili(db, cfg, d.persone, adesso, 5, { ...opzioni, servizio: d.servizio }) : [];
    const giorni = conServ.length ? conServ : giorniDisponibili(db, cfg, d.persone, adesso, 5, opzioni);
    salvaStato(db, telefono, 'giorno', { ...nomeEsperienza(d), persone: d.persone, giorni,
      ...(conServ.length ? { servizio: d.servizio } : {}), ...(rifiutati.length ? { rifiutati } : {}) });
    risposte.push(`${di('bot_t_giorno')}\n${elencoGiorni(giorni)}`);
    return esito;
  }

  // I turni da rimettere sotto un «non ho capito»: quelli del servizio scelto,
  // se ne ha scelto uno — chi ha detto «cena» non deve rileggersi il pranzo.
  function turniDaMostrare(d) {
    const tutti = d.turni || [];
    const suoi = d.servizio ? tutti.filter((o) => servizioDellOra(cfg, d.data, o) === d.servizio) : [];
    return suoi.length ? suoi : tutti;
  }

  // ⚠️ L'orario scritto a metà, deciso dal titolare: «21» con il solo turno
  // delle 21:30 diventa le 21:30 — ma lo si DICE, in testa alla risposta
  // successiva, invece di aggiustare in silenzio e lasciare che se ne accorga
  // (forse) nel riepilogo. Se l'orario scritto coincide, nessuna riga in più.
  // Un turno scelto per numero («il primo») non è un'approssimazione.
  // La nota dice «se preferisci un altro orario, scrivimelo»: il segno
  // `notaOra` (il passo dell'orario da cui si è passati) resta nei dati per
  // UN messaggio, così un orario scritto lì non finisce nel nome.
  function conLaNotaDellOra(ora, passo, poi) {
    const letta = oraScritta(testo);
    const approssimata = letta && !ordinaleDi(testo)
      && `${String(letta.ore).padStart(2, '0')}:${String(letta.minuti).padStart(2, '0')}` !== ora;
    const prima = risposte.length;
    const r = poi();
    if (approssimata && risposte.length > prima) {
      risposte[prima] = `${di('bot_t_ora_vicina', { scritto: letta.scritto, ora: oraColTurno(cfg, dati.data, ora) })}\n\n${risposte[prima]}`;
      const dopo = statoDi(db, telefono, adesso);
      if (dopo.passo && dopo.passo !== 'inizio') salvaStato(db, telefono, dopo.passo, { ...(dopo.dati || {}), notaOra: passo });
    } else if (cambiaOra && risposte.length > prima) {
      // Ha risposto alla nota con un altro orario, preso com'è: lo si conferma
      // in una riga, sennò la domanda del nome ripetuta sembra un «non ho capito».
      risposte[prima] = `${di('bot_t_ora_cambiata', { ora: oraColTurno(cfg, dati.data, ora) })}\n\n${risposte[prima]}`;
    }
    return r;
  }
  // Ha scritto un orario, ma nessun turno gli somiglia: non è un «non ho
  // capito», e non conta come equivoco. Si dice com'è e si rimette l'elenco.
  // Se invece di turni a quell'ora ce ne sono DUE, si chiede l'orario preciso.
  function oraSenzaTurno(passo, d) {
    const letta = oraScritta(testo);
    if (!letta || ordinaleDi(testo)) return null;
    const turni = turniDaMostrare(d);
    const allOra = (h) => turni.filter((o) => o.startsWith(String(h).padStart(2, '0') + ':'));
    let stessaOra = allOra(letta.ore);
    // «alle 8» sono le 20: se alle 8 non c'è niente si guarda alle 20, come
    // fa `interpretaOra`.
    if (!stessaOra.length && letta.ore >= 1 && letta.ore <= 11 && !letta.conMinuti) stessaOra = allOra(letta.ore + 12);
    salvaStato(db, telefono, passo, { ...avanzato(d) });
    risposte.push(`${di(stessaOra.length > 1 ? 'bot_t_ora_quale' : 'bot_t_ora_niente', { scritto: letta.scritto })}\n${elencoTurni(stessaOra.length > 1 ? stessaOra : turni, cfg, d.data)}`);
    return esito;
  }

  // L'orario scelto: un turno per numero («il primo») o un orario («19:30»).
  // ⚠️ Chi sceglie un turno per numero non ricade sull'orario: «1» a cui non
  // corrisponde un turno non diventa le 13:00.
  // ⚠️ Solo coi turni NUMERATI: con gli orari di prima («12:30, 14:00») un
  // «2» è sempre stato le 14:00, e leggerlo come «secondo turno» che non
  // esiste rispondeva «non ho capito» a chi aveva scritto un orario.
  function oraScelta(d) {
    const numerati = (d.turni || []).some((o) => numeroDelTurno(cfg, d.data, o));
    if (numerati && ordinaleDi(testo)) return interpretaTurno(testo, cfg, d.data, d.turni || [], d.servizio);
    return interpretaOra(testo, d.turni || []);
  }

  function passoPersone(persone, giornoDetto = null, base = {}) {
    const max = personeMassimeBot(db, cfg);
    const min = num(cfg.bot_min_persone, 1);
    if (persone > max) {
      // I gruppi grossi non li conferma da solo: serve una persona, che è
      // l'unica che sa se quei tavoli si possono unire.
      risposte.push(`Per ${persone} persone preferisco farti parlare con il locale: ti risponde una persona a breve.`);
      esito.passaAUmano = true;
      azzeraStato(db, telefono);
      return esito;
    }
    if (persone < min) {
      risposte.push(di('bot_t_persone_no'));
      return esito;
    }
    // L'esperienza viaggia con la prenotazione: i suoi giorni, i suoi orari.
    const conE = nomeEsperienza(base);
    const giorni = giorniDisponibili(db, cfg, persone, adesso, 5, perEsperienza(base));
    if (!giorni.length) {
      risposte.push(di('bot_t_completo', { data: 'i prossimi giorni' }));
      esito.passaAUmano = true;
      azzeraStato(db, telefono);
      return esito;
    }
    // Il giorno l'ha già detto: non si richiede. Se non è fra quelli con
    // posto, `scegliGiorno` dice perché (pieno, chiuso, o un giorno in cui
    // l'esperienza scelta non c'è) e propone le alternative — meglio di
    // richiedere il giorno come se non l'avesse mai scritto.
    if (giornoDetto) {
      return scegliGiorno({ ...conE, persone, giorni, ...conServizio() }, giornoDetto);
    }
    salvaStato(db, telefono, 'giorno', { ...conE, persone, giorni, ...conServizio() });
    risposte.push(`${di('bot_t_giorno')}\n${elencoGiorni(giorni)}`);
    return esito;
  }

  // Il giorno scelto: i suoi turni, o «pieno»/«chiuso» con le alternative.
  // Lo usano il passo del giorno e chi il giorno l'ha detto insieme alle persone.
  function scegliGiorno(d, iso) {
    const turni = turniDisponibili(db, cfg, iso, d.persone, adesso, perEsperienza(d));
    if (!turni.length) {
      const alternativi = giorniDisponibili(db, cfg, d.persone, adesso, 5, perEsperienza(d));
      // Chiuso e pieno sono due cose diverse: in lista d'attesa si entra solo
      // per un giorno in cui il locale c'è e i posti no. Un giorno in cui
      // l'esperienza scelta non vale è «chiuso» per lei.
      const pieno = !(eChiuso(db, iso) || !turniAmmessi(cfg, iso, esperienzaScelta(d), turniDelGiorno(cfg, iso)).length);
      // Il locale quel giorno c'è, l'esperienza scelta no: «il business lunch
      // il sabato non c'è», non «siamo chiusi».
      const e = esperienzaScelta(d);
      const soloLei = !pieno && e && !eChiuso(db, iso) && turniDelGiorno(cfg, iso).length > 0;
      const frase = soloLei ? di('bot_t_esperienza_chiusa', { esperienza: e.nome, data: dataItaliana(iso), quando: quandoDetto(e) })
        : di(pieno ? 'bot_t_completo' : 'bot_t_chiuso', { data: dataItaliana(iso) });
      risposte.push(`${frase}\n${elencoGiorni(alternativi)}${pieno ? propostaAttesa(iso, '') : ''}`);
      salvaStato(db, telefono, 'giorno', { ...d, giorni: alternativi, ...(pieno && listaAttiva ? { attesaData: iso } : {}) });
      return esito;
    }
    return chiediServizio(PASSI_NUOVA, d, iso, turni, conServizio(d).servizio);
  }

  if (stato.passo === 'giorno') {
    // Il giorno chiesto un messaggio fa era pieno del tutto, e gli è stata
    // proposta la lista per QUEL giorno: «sì» è quello, non una data.
    if (dati.attesaData && vuoleLaAttesa()) {
      return mettiInLista({ persone: dati.persone, data: dati.attesaData, ora: '' });
    }
    // Se dell'elenco salvato non resta niente di buono, se ne rifà uno adesso:
    // meglio una lista nuova che una lista di giorni passati.
    const rimasti = giorniAncoraBuoni(dati.giorni, adesso);
    const proposti = rimasti.length ? rimasti
      : giorniDisponibili(db, cfg, dati.persone || 2, adesso, 5, perEsperienza());
    // Niente piu' scorciatoia «rispondi col numero della riga»: da quando le
    // date non sono piu' numerate, un «1» davanti a un elenco che contiene
    // «1 settembre» vuol dire quel giorno, non la prima riga.
    const iso = interpretaData(testo, adesso, { storti: true });
    // «Cena», dopo il «no» all'unico turno del pranzo: la cena di QUEL giorno,
    // che il bot gli ha offerto in fondo all'elenco dei giorni.
    if (!iso && dati.altroGiorno && servizioDetto(testo) === dati.altroGiorno.servizio) {
      const { altroGiorno, ...resto } = dati;
      const turni = turniDisponibili(db, cfg, altroGiorno.data, dati.persone, adesso, perEsperienza(dati));
      return proponiOrari('ora', { ...resto, servizio: altroGiorno.servizio }, altroGiorno.data, turni, altroGiorno.servizio);
    }
    if (!iso) {
      return nonCapito('giorno', dati, `${di('bot_t_giorno_no')}\n${elencoGiorni(proposti)}`);
    }
    // ⚠️ Una data lontanissima («10/09/2028») il bot la prendeva per buona e
    // segnava il tavolo: una riga che nessuno riguarderà mai, in un calendario
    // che si sfoglia a settimane. Oltre l'anno non si dice di no — la festa di
    // fine anno prenotata a gennaio è roba vera — ma la prende una persona,
    // che è chi può dire se il locale a quella data ci sarà ancora.
    if (oltreLOrizzonte(iso, adesso)) {
      // L'anno va detto: «domenica 10 settembre» per una data del 2028 sembra
      // il mese prossimo, e chi legge non capisce di cosa gli si stia parlando.
      risposte.push(di('bot_t_troppo_lontano', { data: `${dataItaliana(iso)} ${iso.slice(0, 4)}` }));
      esito.passaAUmano = true;
      azzeraStato(db, telefono);
      return esito;
    }
    // Ha scelto un giorno: l'offerta «scrivimi cena» valeva per quel messaggio.
    const { altroGiorno, ...senzaOfferta } = dati;
    return scegliGiorno(senzaOfferta, iso);
  }

  // La risposta a «pranzo o cena?». Chi risponde già con un orario o un turno
  // («20:00», «il secondo») ha saltato un passo, non sbagliato: lo legge il
  // passo dell'orario, qui sotto.
  if (stato.passo === 'servizio') {
    const chiesto = servizioDetto(testo);
    if (chiesto) return proponiOrari('ora', dati, dati.data, dati.turni || [], chiesto);
    if (!oraScelta(dati)) {
      return nonCapito('servizio', dati, di('bot_t_servizio_no', { data: dataItaliana(dati.data) }));
    }
    stato.passo = 'ora';
  }

  if (stato.passo === 'ora') {
    // Un messaggio fa gli è stato detto che il suo orario era pieno, e gli è
    // stata proposta la lista: «sì» vuol dire quello, non un orario.
    if (dati.attesaOra && vuoleLaAttesa()) return mettiInLista({ ...dati, ora: dati.attesaOra });
    // «Ti va bene il turno unico?» — sì è quello; no, un altro giorno.
    // ⚠️ IL GUASTO, visto dal titolare (19 ottobre 2026): «pranzo o cena?» →
    // «Pranzo» → «c'è un solo turno, ti va bene?» → «No» → i turni della
    // CENA, senza nemmeno dire «a cena». Il servizio l'aveva scelto lui: «no»
    // all'unico turno del pranzo vuol dire un altro pranzo, non la cena. Ora
    // si propongono i giorni con posto a quel servizio (senza quello appena
    // rifiutato), e in fondo, se quel giorno l'altro servizio ha posto, una
    // riga per chiederlo con una parola. L'esperienza resta.
    let ora = null;
    if (dati.unico) {
      const si = interpretaSiNo(testo);
      if (si === true) ora = dati.unico;
      if (si === false) {
        const suo = servizioDellOra(cfg, dati.data, dati.unico);
        const rifiutati = [...new Set([...(dati.rifiutati || []), `${dati.data} ${suo}`])];
        const altro = (dati.turni || []).find((o) => servizioDellOra(cfg, dati.data, o) !== suo);
        const altroServizio = altro ? servizioDellOra(cfg, dati.data, altro) : null;
        const offrireAltro = altroServizio && !rifiutati.includes(`${dati.data} ${altroServizio}`);
        // Il servizio scelto da lui (c'è un altro servizio nei turni solo se ha
        // scelto: sennò il turno unico era l'unico del giorno).
        const tranne = rifiutati.filter((r) => !altroServizio || r.endsWith(` ${suo}`)).map((r) => r.split(' ')[0]);
        const conServ = altroServizio
          ? giorniDisponibili(db, cfg, dati.persone, adesso, 5, { ...perEsperienza(), servizio: suo, tranne }) : [];
        const giorni = conServ.length ? conServ
          : giorniDisponibili(db, cfg, dati.persone, adesso, 5, { ...perEsperienza(), tranne: rifiutati.map((r) => r.split(' ')[0]) });
        salvaStato(db, telefono, 'giorno', { ...nomeEsperienza(), persone: dati.persone, giorni, rifiutati,
          ...(conServ.length ? { servizio: suo } : {}),
          ...(offrireAltro ? { altroGiorno: { data: dati.data, servizio: altroServizio } } : {}) });
        const testa = conServ.length ? di('bot_t_unico_no', { servizio: suo }) : di('bot_t_giorno');
        const coda = offrireAltro ? di('bot_t_unico_no_altro', { data: dataItaliana(dati.data), altro: altroServizio }) : '';
        risposte.push([`${testa}\n${elencoGiorni(giorni)}`, coda].filter((x) => String(x).trim()).join('\n\n'));
        return esito;
      }
    }
    // ⚠️ Un altro giorno o altre persone, scritti alla domanda dell'orario
    // (23 ottobre 2026): «giovedì 10 settembre», «meglio venerdì», «siamo in
    // 4». Prima ogni numero diventava un'ora («Alle 4 non abbiamo un turno»),
    // e un giorno a parole un «non ho capito». Si riparte da quel giorno, con
    // quelle persone: i suoi turni, o pieno/chiuso con le alternative. Il
    // giorno già scelto, ripetuto insieme all'ora («22 ottobre ore 20:30»),
    // non cambia niente: lì conta l'ora.
    if (!ora && !ordinaleDi(testo)) {
      const giornoNuovo = giornoDettoAllOra(testo);
      const personeNuove = personeDetteAllOra(testo);
      const cambiaGiorno = !!giornoNuovo && giornoNuovo !== dati.data;
      if (cambiaGiorno || (personeNuove && personeNuove !== dati.persone)) {
        const { data, turni, unico, attesaOra, rifiutati, ...resto } = avanzato(dati);
        const iso = cambiaGiorno ? giornoNuovo : dati.data;
        if (personeNuove && personeNuove !== dati.persone) return passoPersone(personeNuove, iso, resto);
        if (oltreLOrizzonte(iso, adesso)) {
          risposte.push(di('bot_t_troppo_lontano', { data: `${dataItaliana(iso)} ${iso.slice(0, 4)}` }));
          esito.passaAUmano = true;
          azzeraStato(db, telefono);
          return esito;
        }
        // Con un orario che quel giorno c'è proprio («venerdì alle 21:15») si
        // prende, e lo si dice. Sennò i turni di quel giorno.
        const liberi = turniDisponibili(db, cfg, iso, resto.persone, adesso, perEsperienza(resto));
        const letta = oraScritta(testo);
        const esatta = letta && liberi.find((o) => o === `${String(letta.ore).padStart(2, '0')}:${String(letta.minuti).padStart(2, '0')}`);
        if (!esatta) return scegliGiorno(resto, iso);
        const prima = risposte.length;
        const r = dopoLOra({ ...resto, data: iso, turni: liberi, ora: esatta });
        const detto = di('bot_t_giorno_cambiato', { data: dataItaliana(iso), ora: oraColTurno(cfg, iso, esatta) });
        if (risposte.length > prima && detto.trim()) risposte[prima] = `${detto}\n\n${risposte[prima]}`;
        return r;
      }
    }
    if (!ora) ora = oraScelta(dati);
    if (!ora) {
      // Prima di dire «non ho capito»: forse ha capito benissimo, e quell'ora
      // semplicemente non c'è più. Non conta come equivoco — perché non lo è.
      const no = oraNonProposta(db, cfg, dati, testo);
      if (no) return rispondiOraNo(no, 'ora', dati);
      // «A pranzo?» non è un orario, ma non è nemmeno un equivoco: si
      // rispondono gli orari del pranzo.
      const chiesto = servizioDetto(testo);
      if (chiesto) return proponiOrari('ora', dati, dati.data, dati.turni || [], chiesto);
      const nonTrovata = oraSenzaTurno('ora', dati);
      if (nonTrovata) return nonTrovata;
      // ⚠️ «No» davanti all'elenco dei turni (19 ottobre 2026): nessuno di
      // quelli gli va. Prima era «non ho capito quale orario preferisci», e
      // contava come un equivoco. Si propone un altro giorno, senza questo.
      // Non dopo «vuoi che ti metta in lista?»: lì «no» vuol dire niente
      // lista, e i turni rimasti di quel giorno valgono ancora.
      if (!dati.attesaOra && interpretaSiNo(testo) === false) {
        return unAltroGiorno({ ...dati, rifiutati: [...new Set([...(dati.rifiutati || []), `${dati.data} ${dati.servizio || 'tutto'}`])] });
      }
      return nonCapito('ora', dati, `${di('bot_t_ora_no')}\n${elencoTurni(turniDaMostrare(dati), cfg, dati.data)}`);
    }
    // Ricontrollo: fra la proposta e la risposta può essersi riempito
    if (!ciStanno(db, cfg, dati.data, ora, dati.persone)) {
      const turni = turniDisponibili(db, cfg, dati.data, dati.persone, adesso);
      if (!turni.length) return tuttoPieno(dati, ora);
      salvaStato(db, telefono, 'ora', { ...dati, turni, ...(listaAttiva ? { attesaOra: ora } : {}) });
      risposte.push(`Quell'orario si è appena riempito. Restano:\n${elencoTurni(turni, cfg, dati.data)}${propostaAttesa(dati.data, ora)}`);
      return esito;
    }
    return conLaNotaDellOra(ora, 'ora', () => dopoLOra({ ...avanzato(dati), ora }));
  }

  // Da qui in poi la strada è la stessa per chi ha scelto un orario libero e
  // per chi, dalla lista d'attesa, ha detto SÌ a un posto liberato: si passa
  // dalle stesse domande (nome, telefono, note, email) e dallo stesso
  // riepilogo. Una strada sola, un modo solo di sbagliare.
  function dopoLOra(d) {
    const { attesaOra, ...avanti } = d;
    // ⚠️ Se sappiamo già come si chiama, la domanda non si fa proprio: è il
    // punto di tutto. Si segna che il nome è stato messo da noi (`nomeNostro`),
    // perché al riepilogo va detto come correggerlo — a chi il nome l'ha
    // scritto lui quella riga non serve, ed è solo rumore.
    if (giaVisto && giaVisto.nome) {
      return dopoIlNome({ ...avanti, nome: giaVisto.nome, cognome: giaVisto.cognome, nomeNostro: true });
    }
    if (boolDi(cfg.bot_chiedi_nome)) {
      salvaStato(db, telefono, 'nome', avanti);
      risposte.push(di('bot_t_nome'));
      return esito;
    }
    return dopoIlNome(avanti);
  }

  // «Vuoi che ti avvisi se si libera un posto?» — dopo un giorno pieno del
  // tutto, quando non c'era nient'altro da proporre.
  if (stato.passo === 'attesa_offerta') {
    if (vuoleLaAttesa()) return mettiInLista(dati);
    // Una data è una risposta legittima a «vuoi scegliere un altro giorno?»:
    // si riparte dal passo del giorno con quella stessa frase.
    if (interpretaData(testo, adesso, { storti: true })) {
      salvaStato(db, telefono, 'giorno', { ...nomeEsperienza(dati), persone: dati.persone, giorni: [] });
      return elaboraMessaggio(db, telefono, testo, adesso, contesto);
    }
    if (interpretaSiNo(testo) === false) {
      risposte.push(di('bot_t_daccordo'));
      azzeraStato(db, telefono);
      return esito;
    }
    return nonCapito('attesa_offerta', dati, di('bot_t_attesa_proposta', { quando: quandoAttesa(dati.data, dati.ora) }));
  }

  // «Si è liberato un posto, lo vuoi?» — il messaggio l'ha mandato il server
  // (vedi chiDaAvvisareInAttesa), e qui arriva la risposta.
  if (stato.passo === 'attesa_libero') {
    const attesa = db.prepare('SELECT * FROM bot_attese WHERE id = ?').get(dati.attesaId);
    if (interpretaSiNo(testo) === false) {
      if (attesa) togliDallaAttesa(db, attesa.id, 'rinunciata');
      risposte.push(di('bot_t_attesa_rinuncia'));
      azzeraStato(db, telefono);
      return esito;
    }
    if (interpretaSiNo(testo) !== true) {
      return nonCapito('attesa_libero', dati, di('bot_t_attesa_libero',
        { quando: quandoAttesa(dati.data, dati.ora), persone: dati.persone, minuti: minutiAttesa }));
    }
    // ⚠️ Fra la proposta e il «sì» il posto può essere stato preso da chi ha
    // prenotato nel frattempo: si ricontrolla, e se non c'è più lo si dice —
    // e si resta in lista, in coda, senza far ricominciare da capo nessuno.
    if (!attesa || attesa.stato !== 'avvisata' || !ciStanno(db, cfg, dati.data, dati.ora, dati.persone)) {
      if (attesa) rimettiInAttesa(db, attesa.id, adesso);
      risposte.push(di('bot_t_attesa_ripieno'));
      azzeraStato(db, telefono);
      return esito;
    }
    return dopoLOra({ attesaId: attesa.id, persone: dati.persone, data: dati.data, ora: dati.ora,
      nome: dati.nome || '', cognome: dati.cognome || '' });
  }

  if (stato.passo === 'nome') {
    const { nome, cognome } = dividiNome(testo);
    if (!nome) {
      return nonCapito('nome', dati, di('bot_t_nome'));
    }
    return dopoIlNome({ ...avanzato(dati), nome, cognome });
  }

  // ⚠️ NON è il passo «nome» di sempre. Qui telefono e note ce li abbiamo già:
  // passare da `dopoIlNome` vorrebbe dire rifare tutte le domande a chi ha solo
  // corretto un nome — tre domande di castigo per aver detto «non sono io».
  // Si torna dritti al riepilogo, e le note non si richiedono.
  if (stato.passo === 'nome_nuovo') {
    const { nome, cognome } = dividiNome(testo);
    if (!nome) {
      return nonCapito('nome_nuovo', dati, di('bot_t_nome'));
    }
    return chiediNumeroAltro({ ...avanzato(dati), nome, cognome });
  }

  // «Per Anna, come l'altra volta?» — a chi da questo numero ha già prenotato
  // per qualcun altro. Un SÌ e ha finito; un nome nuovo e vale quello; un NO
  // e si chiede il nome come a chiunque.
  if (stato.passo === 'nome_altro') {
    const { proposto, ...resto } = dati;
    const scelta = interpretaSiNo(testo);
    if (scelta === true && proposto && proposto.nome) {
      const d = { ...avanzato(resto), nome: proposto.nome, cognome: proposto.cognome || '' };
      // Il numero dell'altra volta, se era davvero il suo, si tiene senza
      // richiederlo: è la seconda domanda in meno.
      if (proposto.telefono) return vaiAlRiepilogo({ ...d, telefono: proposto.telefono, perAltri: true }, true);
      return chiediNumeroAltro(d);
    }
    if (scelta === false) {
      salvaStato(db, telefono, 'nome_nuovo', resto);
      risposte.push(di('bot_t_nome'));
      return esito;
    }
    const { nome, cognome } = dividiNome(testo);
    if (!nome) {
      return nonCapito('nome_altro', dati, di('bot_t_nome'));
    }
    return chiediNumeroAltro({ ...avanzato(resto), nome, cognome });
  }

  // Il numero della persona per cui si prenota. Un SÌ, un NO, un «non ce
  // l'ho» vogliono dire la stessa cosa: lascia il mio. Non si insiste — una
  // prenotazione non si blocca per un numero che il figlio non vuole dare.
  if (stato.passo === 'telefono_altro') {
    if (interpretaSiNo(testo) !== null || nonCeLHa(testo)) return vaiAlRiepilogo(avanzato(dati), true);
    const numero = interpretaTelefono(testo);
    if (!numero) {
      return nonCapito('telefono_altro', dati, di('bot_t_telefono_no'));
    }
    return vaiAlRiepilogo({ ...avanzato(dati), telefono: numero }, true);
  }

  // «Non sono io» al riepilogo: si tiene tutto e si cambia solo la persona.
  // Tre strade, dalla più corta: il nome è già nella frase («è per Anna
  // Bianchi»); da questo numero si è già prenotato per qualcuno («per Anna,
  // come l'altra volta?»); sennò si chiede il nome. Da qui in poi la
  // prenotazione è PER UN ALTRO, e non cambia di chi è il telefono.
  function nonSonoIoAlRiepilogo(d, frase) {
    const { nomeNostro, nome, cognome, ...resto } = d;
    const detto = nomeDentro(frase);
    if (detto) return chiediNumeroAltro({ ...resto, nome: detto.nome, cognome: detto.cognome });
    const altri = altriNomiDi(db, telefono, contesto.numero);
    if (altri.length) {
      salvaStato(db, telefono, 'nome_altro', { ...resto, proposto: altri[0] });
      risposte.push(di('bot_t_nome_altro', { nome: [altri[0].nome, altri[0].cognome].filter(Boolean).join(' ') }));
      return esito;
    }
    salvaStato(db, telefono, 'nome_nuovo', resto);
    risposte.push(di('bot_t_nome'));
    return esito;
  }

  // Il numero della persona per cui si prenota resta sulla prenotazione e
  // nella scheda dei clienti: se poi è lei a scrivere, dal suo telefono, il
  // bot la riconosce col suo nome (vedi `ultimoNomeDi`).
  function chiediNumeroAltro(d) {
    salvaStato(db, telefono, 'telefono_altro', { ...d, perAltri: true });
    risposte.push(di('bot_t_telefono_altro', { nome: d.nome }));
    return esito;
  }

  if (stato.passo === 'telefono') {
    // «OK» vuol dire «richiamami su questo numero». Se non sappiamo qual è —
    // capita con certi indirizzi di WhatsApp — non si finge: si richiede.
    if (interpretaSiNo(testo) === true) {
      if (contesto.numero) return vaiAlRiepilogo({ ...avanzato(dati), telefono: contesto.numero });
      return nonCapito('telefono', dati, di('bot_t_telefono_no'));
    }
    const numero = interpretaTelefono(testo);
    if (!numero) {
      return nonCapito('telefono', dati, di('bot_t_telefono_no'));
    }
    return vaiAlRiepilogo({ ...avanzato(dati), telefono: numero });
  }

  // Dire «alle 20:00 siamo al completo» e poi rimandare la stessa lista di
  // prima sarebbe una presa in giro: la lista si rifà adesso, perché nel
  // frattempo può essere cambiata. E se non resta piu' niente, quel giorno è
  // pieno e va detto — non si tiene il cliente su una domanda senza risposte.
  function rispondiOraNo(no, passo, d, opzioni) {
    const turni = turniDisponibili(db, cfg, d.data, d.persone, adesso, opzioni);
    // La lista d'attesa si propone a chi sta PRENOTANDO e ha trovato pieno.
    // Non a chi sposta (ha già un tavolo) e non per un orario troppo vicino
    // (lì non si libera niente: è il preavviso).
    const conAttesa = passo === 'ora' && no.pieno;
    if (!turni.length) {
      if (conAttesa) return tuttoPieno(d, no.ora);
      risposte.push(di('bot_t_completo', { data: dataItaliana(d.data) }));
      azzeraStato(db, telefono);
      return esito;
    }
    // `avanzato` azzera il conto degli equivoci: qui ci si è capiti benissimo.
    // `attesaOra` ricorda quale orario era pieno: se al prossimo messaggio
    // dice «sì», è a quello che vuole essere messo in lista.
    salvaStato(db, telefono, passo, { ...avanzato(d), turni, ...(conAttesa && listaAttiva ? { attesaOra: no.ora } : {}) });
    // Gli orari che restano, del servizio scelto: chi ha detto «cena» e ha
    // trovato pieno non deve rileggersi tutto il pranzo.
    risposte.push(`${di(no.pieno ? 'bot_t_ora_piena' : 'bot_t_ora_tardi', {
      ora: no.ora, data: dataItaliana(d.data),
    })}\n${elencoTurni(turniDaMostrare({ ...d, turni }), cfg, d.data)}${conAttesa ? propostaAttesa(d.data, no.ora) : ''}`);
    return esito;
  }

  function dopoIlNome(d) {
    if (boolDi(cfg.bot_chiedi_telefono)) {
      salvaStato(db, telefono, 'telefono', d);
      risposte.push(di('bot_t_telefono'));
      return esito;
    }
    return vaiAlRiepilogo(d);
  }

  if (stato.passo === 'note') {
    // ⚠️ NON «interpretaSiNo»: qui la domanda non è da sì o no. Vedi «soloUnNo».
    const note = soloUnNo(testo, cfg) ? '' : String(testo || '').trim().slice(0, 200);
    if (note) {
      // ⚠️ La frase è la STESSA per qualunque nota, e non conferma mai niente.
      // Prima dipendeva dal riconoscere una domanda, e bastava un «ho bisogno di
      // una torta» per tornare al silenzio — cioè al «sì» implicito. Adesso il
      // bot dice sempre e solo quello che è vero: me la sono segnata, la vedono
      // loro, e se c'è da confermare qualcosa lo confermano loro. Va bene per
      // un'allergia (non c'è niente da confermare) come per una torta.
      risposte.push(di('bot_t_nota_domanda'));
      // L'avviso al personale invece SÌ che si sceglie: una notifica in più per
      // un'allergia costa poco, una richiesta che non arriva a nessuno costa un
      // cliente che aspetta una risposta che non arriverà.
      if (eUnaRichiesta(note, cfg)) esito.passaAUmano = true;
    }
    // La prenotazione va avanti comunque: è a un passo dalla fine, e fermarla
    // qui sarebbe peggio del silenzio.
    return vaiAlRiepilogo({ ...dati, note }, true);
  }

  function vaiAlRiepilogo(d, saltaNote) {
    if (boolDi(cfg.bot_chiedi_note) && !saltaNote) {
      salvaStato(db, telefono, 'note', d);
      risposte.push(di('bot_t_note'));
      return esito;
    }
    // ⚠️ Con l'email accesa, il riepilogo NON chiede più «scrivi SÌ»: chiede
    // l'email, e scriverla è la conferma. Una domanda sola invece di due —
    // ogni passo in più è gente che si ferma a metà e non torna.
    const conEmail = boolDi(cfg.bot_chiedi_email);
    salvaStato(db, telefono, conEmail ? 'email' : 'conferma', d);
    // ⚠️ La NOTA va nel riepilogo. Il cliente scriveva «siamo con un bimbo» e
    // poi non la vedeva scritta da nessuna parte: l'unico modo che ha di
    // accorgersi se è stata capita male è rileggerla. La riga sparisce da sola
    // quando non c'è niente da segnalare.
    const valoriRiepilogo = {
      ...valori,
      // L'orario col suo turno e la fine: «19:30 (1° turno, fino alle 21:00)».
      data: dataItaliana(d.data), ora: oraDellaPrenotazione(cfg, d), persone: d.persone,
      nome: [d.nome, d.cognome].filter(Boolean).join(' ') || '—',
      cognome: d.cognome || '',
      telefono: d.telefono || '',
      note: d.note || '',
      // Con più locali, anche il locale: «RO bistrot», «REAR Restaurant · Business lunch».
      esperienza: [d.fuoriSala ? d.localeScelto : (conLocali && localePrincipale ? localePrincipale.nome : ''),
        nomeEsperienza(d).esperienza || ''].filter(Boolean).join(' · '),
    };
    // ⚠️ La riga per correggere il nome esce SOLO se il nome l'abbiamo messo
    // noi. A chi l'ha appena scritto non serve, ed è solo rumore in fondo a un
    // riepilogo che si legge di fretta.
    const coda = d.nomeNostro ? (cfg.bot_t_nome_nostro || '') : '';
    risposte.push(riempi(
      senzaRigheVuote(conEsperienza(colTelefono(conEmail ? cfg.bot_t_email : cfg.bot_t_riepilogo, d.telefono), valoriRiepilogo.esperienza), valoriRiepilogo) + coda,
      valoriRiepilogo,
    ));
    return esito;
  }

  if (stato.passo === 'email') {
    // ⚠️ Anche qui «non sono io» PRIMA di tutto. Con la domanda dell'email
    // accesa il riepilogo non si conferma con un SÌ ma scrivendo l'indirizzo:
    // senza questo ramo chi deve correggere il nome resterebbe con il solo NO,
    // che gli cancella persone, giorno e ora. Stessa via di «conferma».
    if (dati.nomeNostro && nonSonoIo(testo, cfg)) return nonSonoIoAlRiepilogo(dati, testo);
    // «NO» resta la via d'uscita: chi ha cambiato idea non dev'essere
    // costretto a dare un indirizzo per potersene andare.
    if (interpretaSiNo(testo) === false) {
      risposte.push(di('bot_t_rinuncia'));
      azzeraStato(db, telefono);
      return esito;
    }
    const scritta = String(testo || '').trim();
    // ⚠️ Chi scrive «SÌ» per abitudine non ha sbagliato: fino a ieri era quella
    // la parola. Gli si dice solo cosa manca, e NON gli si conta un equivoco —
    // se no due «sì» di fila lo mandano a parlare con una persona per aver
    // fatto la cosa che il bot gli chiedeva prima.
    if (interpretaSiNo(scritta) === true) {
      salvaStato(db, telefono, 'email', dati);
      risposte.push(di('bot_t_email_no'));
      return esito;
    }
    if (!EMAIL_SEMPLICE.test(scritta)) {
      return nonCapito('email', dati, di('bot_t_email_no'));
    }
    return scrivilaInArchivio({ ...avanzato(dati), email: scritta.slice(0, 120) });
  }

  if (stato.passo === 'conferma') {
    // ⚠️ «Non sono io» PRIMA del sì/no. Il nome l'abbiamo messo noi, e il caso
    // vero è il telefono di casa: il figlio prenota per la madre. Senza questo
    // ramo l'unica via sarebbe «NO», che butta via persone, giorno e ora e lo
    // rimanda all'inizio — cioè la comodità si rovescia in un fastidio.
    // Si tiene tutto il resto e si chiede SOLO il nome.
    if (dati.nomeNostro && nonSonoIo(testo, cfg)) return nonSonoIoAlRiepilogo(dati, testo);
    const scelta = interpretaSiNo(testo);
    if (scelta === null) {
      return nonCapito('conferma', dati, 'Non ho capito: scrivi SÌ per confermare o NO per annullare.');
    }
    if (scelta === false) {
      risposte.push(di('bot_t_rinuncia'));
      azzeraStato(db, telefono);
      return esito;
    }
    return scrivilaInArchivio(dati);
  }

  // La prenotazione finisce in archivio da due strade — il «SÌ» di sempre e
  // l'email — e la scrittura è una sola: sdoppiarla vorrebbe dire due modi di
  // sbagliare, e uno dei due lo si scoprirebbe tardi.
  function scrivilaInArchivio(d) {
    // Ultimo controllo prima di scrivere: due clienti possono aver confermato
    // lo stesso ultimo posto mentre scrivevano.
    // Un altro locale ha i suoi coperti, non i tavoli di qui (vedi «I locali»).
    const altro = d.fuoriSala ? altroLocaleDi(cfg, d.localeScelto) : null;
    const posto = d.fuoriSala ? { ok: !!altro && postiAltroLocale(db, altro) >= d.persone }
      : postoPer(db, cfg, d.data, d.ora, d.persone);
    // Il bistrot pieno mentre scriveva: «al completo», e la domanda «dove?» —
    // non «vuoi un altro giorno?», che per lui non c'è.
    if (!posto.ok && altro && conLocali) return altroLocalePieno(altro);
    if (!posto.ok) {
      risposte.push(di('bot_t_completo', { data: dataItaliana(d.data) }));
      azzeraStato(db, telefono);
      esito.passaAUmano = true;
      return esito;
    }
    // ⚠️ Il recapito c'è anche quando non lo si è chiesto: il cliente sta
    // scrivendo da quel numero. Prima, con la spunta spenta, andava perduto e
    // in sala restava un tavolo senza telefono.
    //
    // Quello DETTATO viene prima di quello della chat, e non è un dettaglio:
    // chi prenota per un amico scrive dal proprio WhatsApp ma detta il numero
    // dell'amico — ed è quello il recapito buono per quel tavolo.
    const recapito = d.telefono || numeroDallaChat(telefono);
    // Il pagamento decide con quale stato NASCE la prenotazione. Con l'importo
    // a zero — o il pagamento spento — nasce confermata, come è sempre stato.
    const conti = importoDaPagare(cfg, d.persone);
    // ⚠️ Due domande, non una. `daPagare` dice che c'è un importo e quindi un
    // collegamento da mandare; `blocca` dice se il tavolo resta sospeso nel
    // frattempo. Con il pagamento FACOLTATIVO la prima è vera e la seconda no:
    // il cliente riceve il collegamento, ma il tavolo è già suo.
    const daPagare = serveIlPagamento(cfg, d.persone);
    const blocca = bloccaLaPrenotazione(cfg, d.persone);
    const info = db.prepare(
      'INSERT INTO prenotazioni (telefono, nome, cognome, data, ora, persone, note, telefono_contatto, email, '
      + 'per_altri, tavolo, esperienza, locale_scelto, fuori_sala, stato, importo_dovuto, importo_totale, pagamento_scade_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(telefono, d.nome || '', d.cognome || '', d.data, d.ora, d.persone,
          d.note || '', recapito, d.email || '', d.perAltri ? 1 : 0, '', nomeEsperienza(d).esperienza || '',
          // Il locale: quello scelto, o — se il titolare li ha nominati — quello di sempre.
          d.fuoriSala ? d.localeScelto : (localePrincipale ? localePrincipale.nome : ''), d.fuoriSala ? 1 : 0,
          blocca ? 'attesa_pagamento' : 'confermata',
          // Gli importi si scrivono comunque: anche una caparra facoltativa è
          // un conto che il locale deve poter vedere e ritrovare.
          daPagare ? conti.adesso : 0, daPagare ? conti.totale : 0,
          // ⚠️ Senza scadenza NON scade: è questa riga, e solo questa, a tenere
          // fuori le prenotazioni facoltative da `liberaScadute`. Scriverci
          // un'ora «tanto è confermata» vorrebbe dire fidarsi di un filtro che
          // sta in un altro file.
          blocca ? scadenzaPagamento(cfg, adesso) : null);
    const nata = db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(info.lastInsertRowid);
    esito.prenotazione = nata;
    // La riga in lista d'attesa è servita — sia che il tavolo venga da un posto
    // liberato, sia che il cliente abbia prenotato per conto suo lo stesso
    // giorno per cui stava aspettando.
    esceDallaLista(db, telefono, nata.data, nata.id);
    if (daPagare) {
      // Il link non c'è ancora: lo mette chi sa parlare con Stripe (il server),
      // che è anche l'unico a sapere se ci è riuscito. Qui si prepara tutto il
      // resto, così il messaggio è già scritto e manca solo l'indirizzo.
      const valori = {
        data: dataItaliana(d.data), ora: d.ora, persone: d.persone,
        nome: d.nome || '', cognome: d.cognome || '',
        importo: euro(conti.adesso),
        resto: conti.resto > 0 ? `Il resto — ${euro(conti.resto)} — si salda al ristorante.\n` : '',
        scadenza: oreEMinuti(nata.pagamento_scade_at),
      };
      esito.daPagare = {
        id: nata.id,
        importo: conti.adesso,
        resto: conti.resto,
        scade: nata.pagamento_scade_at,
        obbligatorio: blocca,
        testo: di(blocca ? 'bot_t_pagamento' : 'bot_t_caparra', valori),
        // ⚠️ Il ripiego per quando Stripe non risponde, e vale SOLO col
        // pagamento facoltativo: lì il tavolo è già prenotato, e lasciare il
        // cliente con un «sto preparando il collegamento» gli farebbe credere
        // di essere ancora in sospeso per una caparra che poteva non versare.
        // Col pagamento obbligatorio il ripiego non c'è, ed è giusto: lì la
        // prenotazione È sospesa davvero.
        ripiego: blocca ? '' : di('bot_t_conferma', {
          data: dataItaliana(d.data), ora: d.ora, persone: d.persone,
          nome: d.nome || '', cognome: d.cognome || '', email: d.email || '',
        }),
      };
      azzeraStato(db, telefono);
      return esito;
    }
    risposte.push(di('bot_t_conferma', {
      data: dataItaliana(d.data), ora: d.ora, persone: d.persone,
      nome: d.nome || '', cognome: d.cognome || '', email: d.email || '',
    }));
    azzeraStato(db, telefono);
    return esito;
  }

  // Passo sconosciuto: si riparte pulito invece di restare incastrati
  azzeraStato(db, telefono);
  annotaNonCapita(db, testo);
  esito.passaAUmano = true;
  return esito;
}

// ---------------------------------------------------------------------------
//  Orari di apertura, per decidere il testo del «non ho capito»
// ---------------------------------------------------------------------------
//  Promettere «rispondiamo subito» alle 3 di notte è una bugia che il cliente
//  si ricorda.

function eOrarioAvvisi(cfg, adesso) {
  const ora = adesso.getHours() * 60 + adesso.getMinutes();
  return ora >= inMinuti(cfg.bot_avvisi_da) && ora <= inMinuti(cfg.bot_avvisi_a);
}

// ⚠️ L'orario da solo non basta: dice a che ORA si legge il telefono, non se
// oggi c'è qualcuno. Nel giorno di riposo, alle 15:00, si è dentro la finestra
// e non c'è nessuno — e il cliente si sentiva promettere «ti risponderà appena
// possibile» da una sala vuota.
function qualcunoLegge(db, cfg, adesso) {
  if (!eOrarioAvvisi(cfg, adesso)) return false;
  const oggi = comeData(adesso);
  return turniDelGiorno(cfg, oggi).length > 0 && !eChiuso(db, oggi);
}

// Quando il telefono tornerà a essere guardato, detto a parole: «oggi»,
// «domani», «lunedì». Serve a non lasciare il cliente con un'ora senza giorno:
// «dalle 09:00» scritto la domenica sera di un locale chiuso il lunedì vuol
// dire martedì, e chi legge capisce domani.
function prossimaLettura(db, cfg, adesso = new Date()) {
  const da = inMinuti(cfg.bot_avvisi_da);
  const a = inMinuti(cfg.bot_avvisi_a);
  const ora = adesso.getHours() * 60 + adesso.getMinutes();
  for (let i = 0; i < 8; i++) {
    const giorno = piuGiorni(adesso, i);
    const iso = comeData(giorno);
    if (!turniDelGiorno(cfg, iso).length || eChiuso(db, iso)) continue;
    // Oggi vale solo se la finestra deve ancora cominciare: se è già passata,
    // la prossima lettura è un altro giorno.
    if (i === 0 && ora > a) continue;
    const quando = i === 0 ? 'oggi' : i === 1 ? 'domani' : NOMI_GIORNI[giorno.getDay()];
    return { quando, ora: cfg.bot_avvisi_da || '09:00' };
  }
  // Nessun giorno di apertura nei prossimi otto: meglio non inventare un giorno.
  return { quando: 'alla riapertura', ora: cfg.bot_avvisi_da || '09:00' };
}

module.exports = {
  mettiInAttesa, listaDAttesa, togliDallaAttesa, toglieDaTutteLeAttese, rimettiInAttesa, esceDallaLista,
  chiDaAvvisareInAttesa, scadenzeDellaAttesa, ATTESE_APERTE,
  preparaDatabase,
  PREDEFINITI,
  TESTI_SUPERATI,
  config,
  leggi,
  scrivi,
  normalizza,
  interpretaPersone,
  interpretaData,
  interpretaOra,
  interpretaSiNo, soloUnNo, eUnaRichiesta, senzaRigheVuote, elencoParole,
  interpretaTelefono,
  colTelefono,
  nomeInSala,
  ultimoNomeDi, altriNomiDi,
  segnaBasta,
  haDettoBasta,
  dividiNome,
  comeData,
  piuGiorni,
  dataItaliana,
  dataBreve,
  turniDelGiorno,
  turniValidi,
  MENU_AL_TAVOLO,
  nonSceglieIlMenu,
  fineDellaFascia,
  oraDetta,
  fasceDi, fasceValide, fasceDaiTurni, slotValidi, slotDi, slotDelGiorno, fasceDelGiorno, fineDelTavolo, passoDi, giriDelGiorno, FASCE_PER_GIORNO,
  servizioDellOra, servizioDetto, servizioPerOrario, elencoTurni, SERVIZI, turnoDellOra, numeroDaDire, rigaTurno, oraColTurno, arrivoDetto, fasciaDetta, ordinaleDi, interpretaTurno,
  tavoliDi, usaTavoli, capienzaDi, trovaTavolo, postoPer, ciStanno, gruppoMassimo, tavoliLiberi,
  chiTieneIlTavolo, chiaveTavolo, riepilogoDelGiorno, numeroDelTurno, tavoloCheResta, daAssegnare, tavoliPresiPer, minimoDi, adattoA, personeMassimeBot, prenotazioniSovrapposte, POSTI_MASSIMI_TAVOLO,
  importoDaPagare,
  serveIlPagamento,
  pagamentoObbligatorio,
  bloccaLaPrenotazione,
  scadenzaPagamento,
  minutiPerPagare,
  inCentesimi,
  euro,
  MINIMO_ADDEBITO,
  MINUTI_MINIMI,
  MINUTI_MASSIMI,
  liberaScadute,
  segnaPagata,
  oreEMinuti,
  chiaveStripe,
  comeOrario,
  bloccoPagamento,
  STATI_VIVI,
  dentro,
  STATI_TOCCABILI,
  numeroDallaChat,
  oltreLOrizzonte,
  turniDisponibili,
  giorniDisponibili,
  copertiOccupati,
  postiLiberi,
  elaboraMessaggio,
  statoDi,
  azzeraStato,
  zittisci,
  eMuto, segnaPersona, personaAnnunciata, scordaPersona,
  eOrarioAvvisi, qualcunoLegge, prossimaLettura,
  eSaluto,
  eSalutoStorto,
  distanzaParole,
  salutoOra,
  cercaFaq,
  annotaNonCapita,
  riempi, chiedeIlMenu, qualeMenu, menuAttivi, senzaLaRigaDelLink, oraScritta, DOMANDA_DOPO_IL_MENU, annotaMenu, statisticheMenu,
  esperienzeValide, esperienzeDi, esperienzaDi, quandoDetto, giorniDetti, elencoEsperienze, interpretaEsperienza, ammessoPer, turniAmmessi, conEsperienza, ESPERIENZE_MASSIME,
  dateRaddrizzate, esempioPer, parolaVicina,
  tettoRisposte, risposteDiOggi,
  menuDellEsperienza, esperienzaNominata, esperienzeNominate, FILE_MENU_ESPERIENZA,
  esperienzeScritte, serviziAperti,
  localiValidi, erroriLocali, localiDi, altroLocaleDi, altroLocaleAperto, localiDaProporre, postiAltroLocale,
  oraDellaPrenotazione, nomiDeiLocali, sceltaDeiLocali, interpretaLocale, LOCALI_MASSIMI,
  orariDetti, chiedeGliOrari, valeIlGiorno,
  prenotazioneFutura,
  elencoPrenotazioni,
  elencoTutte,
  elaboraMessaggioSala,
  salaInCorso,
  num,
  boolDi,
  eSoloDaccordo,
  conversazioneScaduta, giorniAncoraBuoni,
  riapreConUnSaluto, daRichiamare, segnaRichiamata, daLasciareAndare, lasciaAndare,
  minutiFermi, PASSI_CHE_RIAPRONO, COSA_MANCA, eSimulatore, orariDellEsperienza, nomeConTitolo, rinominaPersona, dimenticaPersona, vuoleRinunciare,
  vuoleCambiareEsperienza, vuoleTornareIndietro,
  prenotazioniDellaPersona, schedaPersona, elencoPersone,
  reportPrenotazioni, giorniFra, NOMI_SETTIMANA,
  interpretaGiorni,
  giornoBloccato, eBloccato, eChiuso, ePieno, giorniPieni, segnaPieno, togliPieno,
  inMinuti,
};
