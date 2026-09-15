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
  // «chiusura» o «pieno». Le righe già scritte sono chiusure: è quello che
  // voleva dire questa tabella prima che il sold out esistesse.
  try { db.exec("ALTER TABLE bot_chiusure ADD COLUMN tipo TEXT NOT NULL DEFAULT 'chiusura'"); } catch {}

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
    'Perfetto! ✨ \nEcco il riepilogo della tua prenotazione:\n\n📅 Data: {data}\n🕘 Orario: {ora}\n👥 Persone: {persone}\n👤 Nome: {nome}\n\nConfermi la prenotazione?\n\nScrivi SÌ per confermare',  ],
  bot_t_email: [
    'Perfetto! ✨\nEcco il riepilogo della tua prenotazione:\n\n📅 Data: {data}\n🕘 Orario: {ora}\n👥 Persone: {persone}\n👤 Nome: {nome}\n\nPer confermare, scrivimi la tua email: la useremo per mandarti la conferma.\n\n(se hai cambiato idea, scrivi NO)',  ],
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
  bot_t_primo_no: [
    '{saluto}! Sono l\'assistente di {locale} 🍽️\nSe vuoi prenotare, dimmi per quante persone.\nPer tutto il resto scrivi OPERATORE: ti risponde una persona del locale.',
  ],
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
  bot_giorni: '1,2,3,4,5,6,0',
  bot_turni_pranzo: '',
  bot_turni_cena: '19:30,20:00,21:30',
  bot_durata_tavolo: '120',
  bot_preavviso_ore: '2',
  bot_max_giorni: '60',

  // Capienza — a coperti, non a tavoli
  bot_coperti_turno: '40',
  bot_coperti_liberi: '0',
  bot_max_persone: '8',
  bot_min_persone: '1',

  // Quali domande fare
  bot_chiedi_nome: 'true',
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
  bot_email_testo: 'Ciao {nome},\n\necco il riepilogo della tua prenotazione:\n\n📅 Giorno: {data}\n🕘 Orario: {ora}\n👥 Persone: {persone}\n👤 A nome di: {nome} {cognome}\n{note}\n{pagamento}\nA presto!\n{locale}',
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
  // Il richiamo: dopo quanti minuti il bot chiede «sei ancora lì?». Una volta
  // sola per conversazione, e solo dentro gli orari degli avvisi.
  bot_richiamo_attivo: 'true',
  bot_richiamo_minuti: '15',

  // Promemoria
  bot_promemoria_attivo: 'true',
  bot_promemoria_ora: '12:00',
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
  bot_t_primo_no: '{saluto} 😊\nSono {assistente}, l’assistente virtuale di {locale}.\n\nNon sono riuscita a capire cosa intendi, ma posso aiutarti con la prenotazione.\n\nDimmi semplicemente per quante persone vuoi prenotare.\n\nPer tutto il resto scrivi OPERATORE: ti risponde una persona del locale.\n',
  // ⚠️ Quando il cliente ha fatto una DOMANDA chiara — «è possibile
  // parcheggiare», «accettate la carta?» — la frase qui sopra è mezza
  // sbagliata: gli propone di prenotare, che non è quello che ha chiesto.
  // Qui la prenotazione passa in fondo, fra parentesi, e davanti c'è la sola
  // cosa che gli serve: come si ottiene una risposta vera.
  bot_t_domanda_no: 'Su questa non riesco a risponderti io 😊\n\nScrivi OPERATORE e ti risponde una persona di {locale}.\n\n(se invece vuoi prenotare, dimmi per quante persone)',
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
  bot_t_email: 'Perfetto! ✨\nEcco il riepilogo della tua prenotazione:\n\n📅 Data: {data}\n🕘 Orario: {ora}\n👥 Persone: {persone}\n👤 Nome: {nome}\n📝 Note: {note}\n\nPer confermare, scrivimi la tua email: la useremo per mandarti la conferma.\n\n(se hai cambiato idea, scrivi NO)',
  bot_t_daccordo: 'Va bene! 😊\n\nResto qui: se ti serve altro, scrivimi pure.',
  bot_t_email_no: 'Mi serve la tua email per confermare la prenotazione.\nScrivimela per intero, per esempio: nome@esempio.it\n\n(se hai cambiato idea, scrivi NO)',
  bot_t_riepilogo: 'Perfetto! ✨ \nEcco il riepilogo della tua prenotazione:\n\n📅 Data: {data}\n🕘 Orario: {ora}\n👥 Persone: {persone}\n👤 Nome: {nome}\n📝 Note: {note}\n\nConfermi la prenotazione?\n\nScrivi SÌ per confermare',
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
  bot_t_richiamo: 'Sei ancora lì? 🙂\n\nEravamo rimasti a {cosa}: rispondi pure qui e finiamo in un attimo.\n\nSe preferisci ripartire da capo scrivi RICOMINCIA.',
  bot_t_ricominciato: 'Va bene, ricominciamo da capo!\n\nPer quante persone devo prenotare?\n',
  bot_t_annulla_quale: 'Sei sicuro di voler cancellare la prenotazione?\n\n📅 {data}\n🕘 {ora}\n👥 {persone} persone\n\nScrivi SÌ per confermare',
  bot_t_modificata: 'Ciao {nome}, abbiamo aggiornato la tua prenotazione:\n\n📅 {data} \n🕘 {ora} \n👥 {persone}\n\nA presto!\n',
  bot_t_manuale: 'Ciao {nome}! \nTi confermiamo la prenotazione da {locale}:\n\n📅 {data} \n🕘 {ora}  \n👥 {persone}\n\nSe hai un imprevisto scrivi in questa chat.',
  bot_t_annullata: '✅ Prenotazione cancellata.\n\nGrazie per averci avvisato.\nSperiamo di poterti accogliere presto da {locale}. ✨',
  bot_t_annullata_locale: 'Ciao {nome}, \nti avvisiamo che la tua prenotazione di {data} alle {ora} è stata cancellata.\n\n{locale}',
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
  const t = normalizza(testo);
  if (!t) return null;
  const cifre = t.match(/\b(\d{1,2})\b/);
  if (cifre) {
    const n = parseInt(cifre[1], 10);
    return n >= 1 && n <= 50 ? n : null;
  }
  if (/\buna\s+person[ae]\b/.test(t)) return 1;
  for (const [parola, valore] of Object.entries(NUMERI_A_PAROLE)) {
    if (new RegExp(`(^|\\W)${parola}(\\W|$)`).test(t)) return valore;
  }
  return null;
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

// Interpreta un giorno. Accetta: oggi/stasera, domani, dopodomani, il nome del
// giorno della settimana (prossima occorrenza), 22, 22/8, 22/08/2026, 22 agosto.
function interpretaData(testo, adesso) {
  const t = normalizza(testo);
  if (!t) return null;

  if (/\b(oggi|stasera|stanotte|stamattina)\b/.test(t)) return comeData(adesso);
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

// Un orario: 21:30 · 21.30 · 2130 · 21
function interpretaOra(testo, turni) {
  const t = normalizza(testo);
  if (!t) return null;

  // Anche qui niente scorciatoia sul numero di riga: gli orari non sono piu'
  // numerati, e leggere «2» come «la seconda riga» significava confermare un
  // turno che il cliente non aveva chiesto, in silenzio. Meglio richiedere.
  const m = t.match(/\b(\d{1,2})\s*(?::|\.|,)?\s*(\d{2})?\b/);
  if (!m) return null;
  const ore = +m[1];
  const min = m[2] ? +m[2] : 0;
  if (ore > 23 || min > 59) return null;
  const scritto = `${String(ore).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  if (turni.includes(scritto)) return scritto;
  // Ha scritto un orario che non è un turno: se ce n'è UNO solo che comincia con
  // quell'ora lo si usa, altrimenti non si indovina.
  const vicini = turni.filter((x) => x.startsWith(String(ore).padStart(2, '0') + ':'));
  if (vicini.length === 1) return vicini[0];
  // «alle 8» vuol dire le 20:00: in italiano l'ora di cena si dice quasi sempre
  // così. Vale solo se UN turno solo corrisponde, come sopra: mai indovinare.
  if (ore >= 1 && ore <= 11 && !m[2]) {
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

function dividiNome(testo) {
  const pulito = ripulisciNome(testo).slice(0, 80);
  if (!pulito) return { nome: '', cognome: '' };
  const pezzi = pulito.split(' ');
  if (pezzi.length === 1) return { nome: pezzi[0], cognome: '' };
  return { nome: pezzi[0], cognome: pezzi.slice(1).join(' ') };
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

function turniDelGiorno(cfg, iso) {
  const [a, m, g] = iso.split('-').map(Number);
  const giorno = new Date(a, m - 1, g).getDay();
  const aperti = String(cfg.bot_giorni).split(',').map((x) => parseInt(x, 10));
  if (!aperti.includes(giorno)) return [];
  const tutti = [...turniValidi(cfg.bot_turni_pranzo), ...turniValidi(cfg.bot_turni_cena)];
  // Un doppione fra pranzo e cena è comunque un doppione.
  return [...new Set(tutti)].sort();
}

function inMinuti(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
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
  // ⚠️ Durata zero (o negativa) NON vuol dire «nessun limite»: con quella, la
  // formula della sovrapposizione non trovava nemmeno un tavolo con SE STESSO,
  // e il locale risultava vuoto sempre — il bot avrebbe accettato prenotazioni
  // all'infinito su ogni turno. Un minuto è il minimo che tiene in piedi il
  // significato: il tavolo occupa almeno il suo orario.
  const durata = Math.max(num(cfg.bot_durata_tavolo, 120), 1);
  const inizio = inMinuti(ora);
  const fine = inizio + durata;

  const conta = (righe, scarto) => {
    let somma = 0;
    for (const r of righe) {
      if (escludiId && r.id === escludiId) continue;
      const i = inMinuti(r.ora) - scarto;
      const f = i + durata;
      if (i < fine && f > inizio) somma += r.persone;   // si sovrappongono
    }
    return somma;
  };

  const delGiorno = db.prepare(
    'SELECT id, ora, persone FROM prenotazioni WHERE data = ? AND stato IN ' + dentro(STATI_VIVI)
  ).all(iso);

  // ⚠️ E il tavolo che scavalca la mezzanotte: alle 23:30 con due ore di
  // durata si alza all'una e mezza, cioè occupa un turno dell'una del giorno
  // DOPO. Contando solo le righe della data richiesta quel tavolo spariva, e
  // in una notte di Capodanno lo stesso posto veniva promesso due volte.
  const ieri = giornoPrima(iso);
  const delGiornoPrima = db.prepare(
    'SELECT id, ora, persone FROM prenotazioni WHERE data = ? AND stato IN ' + dentro(STATI_VIVI)
  ).all(ieri);

  return conta(delGiorno, 0) + conta(delGiornoPrima, 1440);
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
  const turni = turniDelGiorno(cfg, iso);
  if (!turni.length) return [];
  const oggi = comeData(adesso);
  const preavviso = opzioni.senzaPreavviso ? 0 : num(cfg.bot_preavviso_ore, 2) * 60;
  const adessoMin = adesso.getHours() * 60 + adesso.getMinutes();
  return turni.filter((t) => {
    // Un turno già cominciato non si propone mai, nemmeno spostando: si può
    // arrivare dieci minuti prima delle 20:00, non alle 20:30 per le 20:00.
    if (iso === oggi && inMinuti(t) < adessoMin) return false;
    if (iso === oggi && inMinuti(t) - adessoMin < preavviso) return false;
    return postiLiberi(db, cfg, iso, t, opzioni.escludiId) >= persone;
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
  // Pieno e «troppo tardi» sono due no diversi, e al cliente servono distinti:
  // sul primo può scegliere un altro orario, sul secondo un altro giorno.
  return { ora, pieno: postiLiberi(db, cfg, dati.data, ora, dati.id) < dati.persone };
}

// I prossimi giorni con almeno un turno libero, per proporre un menu.
function giorniDisponibili(db, cfg, persone, adesso, quanti = 5, opzioni = {}) {
  const trovati = [];
  const massimo = num(cfg.bot_max_giorni, 60);
  for (let i = 0; i <= massimo && trovati.length < quanti; i++) {
    const iso = comeData(piuGiorni(adesso, i));
    if (turniDisponibili(db, cfg, iso, persone, adesso, opzioni).length) trovati.push(iso);
  }
  return trovati;
}

// ---------------------------------------------------------------------------
//  I testi
// ---------------------------------------------------------------------------

function riempi(testo, valori) {
  const pieno = String(testo || '').replace(/\{(\w+)\}/g, (intero, chiave) => {
    const v = valori[chiave];
    return v === undefined || v === null ? intero : String(v);
  });
  // Un segnaposto lasciato vuoto (il nome dell'assistente, per esempio) lascia
  // dietro di sé uno spazio doppio o una virgola appesa. Sono i dettagli da
  // cui si capisce che dall'altra parte c'è una macchina, e costa due righe
  // evitarli: «Sono  l'assistente virtuale di» si nota subito.
  return pieno
    .split('\n')
    .map((riga) => riga.replace(/[ \t]{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trimEnd())
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

// ⚠️ «📝 Note:» da sola, senza niente dopo, sembra un guasto. Una riga che
// contiene SOLO segnaposto vuoti si toglie tutta. «Solo»: se sulla stessa riga
// ce n'è anche uno pieno la riga resta, sennò si porterebbe via del testo vero.
function senzaRigheVuote(testo, valori) {
  return String(testo || '').split('\n').filter((riga) => {
    const chiavi = (riga.match(/\{(\w+)\}/g) || []).map((x) => x.slice(1, -1));
    if (!chiavi.length) return true;
    return chiavi.some((k) => String(valori[k] == null ? '' : valori[k]).trim() !== '');
  }).join('\n');
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
  const liberi = postiLiberi(db, cfg, p.data, p.ora);
  // ⚠️ I posti che sta GIÀ tenendo non contano contro di lei — e la condizione
  // era scritta al rovescio: chi era ancora in attesa (quindi già contato fra
  // gli occupati) risultava senza posto, e chi era scaduto (quindi non contato)
  // veniva confermato sopra il tavolo di un altro. Esattamente il caso che
  // questa funzione esiste per impedire.
  const suoi = p.stato === 'attesa_pagamento' ? p.persone : 0;
  if (liberi + suoi < p.persone) {
    return { ok: false, motivo: 'niente posto', prenotazione: p };
  }
  db.prepare(
    "UPDATE prenotazioni SET stato = 'confermata', pagato_at = datetime('now','localtime'), "
    + 'pagata_da = ?, importo_dovuto = ?, annullata_at = NULL WHERE id = ?'
  ).run(String(da || 'mano'), quantoDavvero(p, incassato), id);
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
const PASSI_CHE_RIAPRONO = ['persone', 'giorno', 'ora', 'telefono', 'email'];

function riapreConUnSaluto(cfg, riga, testo, adesso = new Date()) {
  if (!riga || !PASSI_CHE_RIAPRONO.includes(riga.passo)) return false;
  const minuti = num(cfg.bot_riapre_minuti, 10);
  if (minuti <= 0) return false;            // 0 = spento
  const fermi = minutiFermi(riga, adesso);
  if (fermi === null || fermi < minuti) return false;
  return eSalutoStorto(testo);
}

// Cosa manca, detto a parole, per la frase del richiamo. Un «sei ancora lì?»
// che non dice a cosa costringe a scorrere indietro la chat.
const COSA_MANCA = {
  persone: 'per quante persone',
  giorno: 'per che giorno',
  ora: "l'orario",
  nome: 'il nome',
  telefono: 'il numero di telefono',
  note: 'se hai allergie o richieste particolari',
  email: "l'indirizzo email",
};
const PASSI_DA_RICHIAMARE = Object.keys(COSA_MANCA);

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
  }).map((r) => ({ ...r, cosa: COSA_MANCA[r.passo] || 'la tua prenotazione' }));
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
  db.prepare('UPDATE bot_conversazioni SET muto_fino = ? WHERE telefono = ?').run(fino, telefono);
}

function eMuto(db, telefono, adesso) {
  const r = db.prepare('SELECT muto_fino FROM bot_conversazioni WHERE telefono = ?').get(telefono);
  if (!r || !r.muto_fino) return false;
  return r.muto_fino > adesso.toLocaleString('sv-SE');
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
function elencoTurni(turni) {
  return turni.join('\n');
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
  for (const v of [riga.chat_id, riga.telefono, riga.telefono_contatto]) {
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
      parti.push(`chat_id IN (${seg})`, `telefono IN (${seg})`, `telefono_contatto IN (${seg})`);
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

  return {
    nome: [primo('nome'), primo('cognome')].filter(Boolean).join(' '),
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
    primaVolta: passate.length ? passate[passate.length - 1].data : '',
    ultimaVolta: passate.length ? passate[0].data : '',
    note,
    righe,
  };
}

// La ricerca, per quando non si ha una prenotazione davanti. Cerca fra nome,
// cognome, numero ed email, e raggruppa le righe della stessa persona: un
// elenco che ripete dieci volte lo stesso Rossi non serve a nessuno.
function cercaPersone(db, testo, massimo = 8) {
  const q = String(testo || '').trim();
  // Sotto le due lettere non si cerca: una lettera sola vuol dire «dammi mezzo
  // archivio», ed è il modo in cui un elenco di clienti esce da una finestra
  // in cui non doveva entrare.
  if (q.length < 2) return [];
  // ⚠️ «%» e «_» sono i jolly di LIKE, non lettere. Scrivendo «%%» — che sono
  // due caratteri, quindi passa il minimo di due — la ricerca restituiva
  // TUTTI: proprio il giro dell'archivio che il minimo doveva impedire. Si
  // spengono, e con loro la barra rovescia che li spegne.
  const senzaJolly = (t) => t.replace(/[\\%_]/g, (c) => '\\' + c);
  const come = `%${senzaJolly(q.toLowerCase())}%`;
  const soloCifre = q.replace(/\D/g, '');
  const righe = db.prepare(
    "SELECT * FROM prenotazioni WHERE lower(nome) LIKE ? ESCAPE '\\' OR lower(cognome) LIKE ? ESCAPE '\\' "
    + "OR lower(nome || ' ' || cognome) LIKE ? ESCAPE '\\' OR lower(email) LIKE ? ESCAPE '\\' "
    + (soloCifre.length >= 3 ? "OR telefono LIKE ? ESCAPE '\\' OR telefono_contatto LIKE ? ESCAPE '\\' " : '')
    + 'ORDER BY data DESC, id DESC LIMIT 300'
  ).all(...(soloCifre.length >= 3
    ? [come, come, come, come, `%${soloCifre}%`, `%${soloCifre}%`]
    : [come, come, come, come]));

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
  return gruppi.slice(0, massimo).map(({ righe: g }) => ({
    id: g[0].id,
    nome: [g[0].nome, g[0].cognome].filter(Boolean).join(' ') || '—',
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
    ultima: (g.find((r) => r.data < comeData(new Date()) && r.stato !== 'annullata') || {}).data || '',
    prossima: [...g].reverse().find((r) => r.data >= comeData(new Date()) && r.stato !== 'annullata')?.data || '',
  }));
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
function elencoDaScegliere(righe) {
  return righe.map((r, i) => `${i + 1}. ${dataBreve(r.data)} · ${r.ora} · `
    + `${r.persone} ${r.persone === 1 ? 'persona' : 'persone'}`).join('\n');
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

  const perTurno = [...somma(vive, (r) => r.ora).entries()]
    .map(([ora, v]) => ({ ora, ...v }))
    .sort((a, b) => (a.ora < b.ora ? -1 : 1));

  const perSettimana = somma(vive, (r) => new Date(r.data + 'T12:00:00').getDay());
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
  const perTurnoCfg = num(cfg.bot_coperti_turno, 0) - num(cfg.bot_coperti_liberi, 0);
  let possibili = 0;
  let apertiConta = 0;
  let pieniConta = 0;
  for (let i = 0; i < giorni; i++) {
    const iso = comeData(piuGiorni(new Date(dal + 'T12:00:00'), i));
    const turni = turniDelGiorno(cfg, iso);
    if (ePieno(db, iso)) pieniConta += 1;
    if (!turni.length || eBloccato(db, iso)) continue;
    apertiConta += 1;
    possibili += Math.max(perTurnoCfg, 0) * turni.length;
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

  return {
    dal, al, giorni,
    totale: {
      prenotazioni: vive.length,
      coperti,
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
      quota: possibili ? Math.round((coperti / possibili) * 100) : 0,
    },
    soldOut: pieniConta,
    clienti: { totali: clienti.size, diRitorno, nuovi: clienti.size - diRitorno },
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
    const liberi = postiLiberi(db, cfg, d.data, d.ora);
    const dopo = liberi - d.persone;
    risposte.push(
      `Controlla:\n\n`
      + `📅 ${dataItaliana(d.data)} alle ${d.ora}\n`
      + `👥 ${d.persone} ${d.persone === 1 ? 'coperto' : 'coperti'}\n`
      + `🙍 ${nomeInSala(d)}\n`
      + (d.telefono ? `📞 +${d.telefono}\n` : '📞 —\n')
      + (d.note ? `📝 ${d.note}\n` : '')
      + `\n${dopo >= 0
        ? `Dopo questa restano ${dopo} ${dopo === 1 ? 'coperto libero' : 'coperti liberi'} su quel turno.`
        : `⚠️ Su quel turno restano ${liberi < 0 ? 0 : liberi} coperti: la sfori di ${-dopo}.`}\n`
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
    const info = db.prepare(
      'INSERT INTO prenotazioni (telefono, nome, cognome, data, ora, persone, note, telefono_contatto, origine) '
      + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manuale')"
    ).run(dati.telefono || '', dati.nome || '', dati.cognome || '', dati.data, dati.ora,
          dati.persone, dati.note || '', dati.telefono || '');
    const p = db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(info.lastInsertRowid);
    esito.prenotazione = p;
    // Se quel cliente stava in lista per quel giorno, adesso ha un tavolo.
    esceDallaLista(db, p.telefono, p.data, p.id);

    const occupati = copertiOccupati(db, cfg, p.data, p.ora);
    salvaStato(db, chiave, 'sala_fatta', { ultima: p.id });
    risposte.push(
      `✅ Segnata: ${dataItaliana(p.data)} alle ${p.ora}, ${p.persone} ${p.persone === 1 ? 'coperto' : 'coperti'}, `
      + `${nomeInSala(p)}.\n`
      + `Ora ${p.ora} è a ${occupati}/${num(cfg.bot_coperti_turno, 0)}.`
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
    if (numero) parti.push(`   📞 ${numero}`);
    if (r.note) parti.push(`   📝 ${r.note}`);
  });

  // I totali per turno: è la riga che serve davvero prima di aprire, perché
  // dice quanti posti restano senza doverli contare a mente.
  const turni = turniDelGiorno(cfg, iso);
  const capienza = num(cfg.bot_coperti_turno, 40);
  const riepilogo = turni
    .map((o) => `${o} ${copertiOccupati(db, cfg, iso, o)}/${capienza}`)
    .join(' · ');

  parti.push('');
  parti.push(`Totale: ${coperti} ${coperti === 1 ? 'coperto' : 'coperti'} su ${righe.length} ${righe.length === 1 ? 'prenotazione' : 'prenotazioni'}.`);
  if (riepilogo) parti.push(riepilogo);
  return parti.join('\n');
}

function elaboraMessaggio(db, telefono, testo, adesso = new Date(), contesto = {}) {
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
  }
  const dati = stato.dati || {};
  const valori = {
    locale: cfg.bot_locale || 'noi',
    saluto: salutoOra(adesso),
    assistente: cfg.bot_assistente || '',
    apertura: cfg.bot_avvisi_da || '',
  };

  const di = (chiave, extra) => riempi(cfg[chiave], { ...valori, ...(extra || {}) });

  // Due volte che non ci si capisce bastano, su QUALSIASI domanda — non solo
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
    if (tentativi >= 2) {
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
    const guida = di('bot_t_ricominciamo');
    risposte.push(guida ? `${testoDaRipetere}\n\n${guida}` : testoDaRipetere);
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

  // --- «RICOMINCIA»: una via d'uscita che non chiama nessuno ---
  // Chi si e' incartato a meta' prenotazione, finora, poteva solo continuare a
  // sbagliare o chiedere un operatore. Ripartire da capo e' spesso quello che
  // vuole davvero, e non deve costare il disturbo di una persona.
  if (/^(ricomincia|ricominciamo|da capo|riparti|annulla tutto)\b/i.test(t)) {
    azzeraStato(db, telefono);
    risposte.push(di('bot_t_ricominciato'));
    return esito;
  }

  // --- Tetto di risposte ---
  const quante = contaRisposta(db, telefono, adesso);
  if (quante > num(cfg.bot_max_risposte, 20)) {
    if (quante === num(cfg.bot_max_risposte, 20) + 1) {
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
    // Chi sposta ha già un tavolo: l'anticipo minimo non lo riguarda, e la sua
    // riga non deve contare contro di lui nel cercare il posto nuovo.
    const opzioni = { escludiId: p.id, senzaPreavviso: true };
    const giorni = giorniDisponibili(db, cfg, p.persone, adesso, 5, opzioni);
    if (!giorni.length) {
      risposte.push(di('bot_t_completo', { data: 'i prossimi giorni' }));
      esito.passaAUmano = true;
      azzeraStato(db, telefono);
      return esito;
    }
    salvaStato(db, telefono, 'sposta_giorno', { id: p.id, persone: p.persone, giorni });
    risposte.push(`${di('bot_t_sposta_quale', {
      data: dataItaliana(p.data), ora: p.ora, persone: p.persone,
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

  if (stato.passo === 'sposta_scegli') {
    const scelta = sceltaFraCandidati(dati.candidati, t, db);
    if (scelta.errore) { risposte.push(scelta.errore); return esito; }
    if (!scelta.riga) { azzeraStato(db, telefono); risposte.push(FRASE_NON_PIU_ATTIVA); return esito; }
    return avviaSposta(scelta.riga);
  }

  if (stato.passo === 'sposta_giorno') {
    const iso = interpretaData(testo, adesso);
    if (!iso) {
      const buoni = giorniAncoraBuoni(dati.giorni, adesso);
      return nonCapito('sposta_giorno', dati, `${di('bot_t_giorno_no')}\n${elencoGiorni(
        buoni.length ? buoni : giorniDisponibili(db, cfg, dati.persone || 2, adesso))}`);
    }
    const opzioni = { escludiId: dati.id, senzaPreavviso: true };
    const turni = turniDisponibili(db, cfg, iso, dati.persone, adesso, opzioni);
    if (!turni.length) {
      const alternativi = giorniDisponibili(db, cfg, dati.persone, adesso, 5, opzioni);
      risposte.push(`${di(eChiuso(db, iso) || !turniDelGiorno(cfg, iso).length ? 'bot_t_chiuso' : 'bot_t_completo', { data: dataItaliana(iso) })}\n${elencoGiorni(alternativi)}`);
      salvaStato(db, telefono, 'sposta_giorno', { ...avanzato(dati), giorni: alternativi });
      return esito;
    }
    salvaStato(db, telefono, 'sposta_ora', { ...avanzato(dati), data: iso, turni });
    risposte.push(`${di('bot_t_ora', { data: dataItaliana(iso) })}\n${elencoTurni(turni)}`);
    return esito;
  }

  if (stato.passo === 'sposta_ora') {
    const ora = interpretaOra(testo, dati.turni || []);
    if (!ora) {
      const no = oraNonProposta(db, cfg, dati, testo);
      if (no) return rispondiOraNo(no, 'sposta_ora', dati, { escludiId: dati.id, senzaPreavviso: true });
      return nonCapito('sposta_ora', dati, `${di('bot_t_ora_no')}\n${elencoTurni(dati.turni || [])}`);
    }
    salvaStato(db, telefono, 'sposta_conferma', { ...avanzato(dati), ora });
    risposte.push(di('bot_t_sposta_conferma', {
      data: dataItaliana(dati.data), ora, persone: dati.persone,
    }));
    return esito;
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
    if (postiLiberi(db, cfg, dati.data, dati.ora, p.id) < p.persone) {
      risposte.push(di('bot_t_sposta_pieno', {
        data: dataItaliana(dati.data), ora: dati.ora,
        vecchiaData: dataItaliana(p.data), vecchiaOra: p.ora,
      }));
      azzeraStato(db, telefono);
      return esito;
    }
    // ⚠️ Il tavolo assegnato dalla sala vale per QUELLA serata: portato su un
    // altro giorno, il numero lì appartiene a qualcun altro, e la sera si
    // trovano due gruppi allo stesso tavolo. Qui nessuno in sala sta
    // guardando — è il cliente che sposta da solo — quindi si azzera, e
    // l'avviso al personale dice che ce n'è uno da riassegnare.
    db.prepare("UPDATE prenotazioni SET data = ?, ora = ?, tavolo = '' WHERE id = ?").run(dati.data, dati.ora, p.id);
    // Spostandosi può essere finito proprio sul giorno per cui era in lista.
    esceDallaLista(db, p.telefono, dati.data, p.id);
    // `prima` serve a chi legge l'avviso in sala: «spostata» senza sapere DA
    // dove non dice niente a chi ha il foglio del servizio in mano.
    esito.spostata = {
      prima: { data: p.data, ora: p.ora, tavolo: p.tavolo || '' },
      dopo: db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(p.id),
    };
    risposte.push(di('bot_t_spostata', {
      data: dataItaliana(dati.data), ora: dati.ora, persone: p.persone,
    }));
    azzeraStato(db, telefono);
    return esito;
  }

  const chiediConfermaAnnullo = (p) => {
    salvaStato(db, telefono, 'annulla_conferma', { id: p.id });
    risposte.push(di('bot_t_annulla_quale', {
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
      if (tentativi >= 2) {
        azzeraStato(db, telefono);
        esito.passaAUmano = true;
        return esito;
      }
      salvaStato(db, telefono, 'inizio', { tentativi });
      const tutte = prenotazioniFuture(db, telefono, adesso, 5, contesto.numero);
      const nome = [gia.nome, gia.cognome].filter(Boolean).join(' ');
      // Con più tavoli si dicono TUTTI. Mostrarne uno solo faceva credere che
      // gli altri non ci fossero: chi ne aveva prenotati due vedeva il primo e
      // pensava che il secondo non fosse mai stato registrato.
      if (tutte.length > 1) {
        risposte.push(conElenco(di('bot_t_gia_prenotate', { nome, quante: tutte.length }), tutte));
        return esito;
      }
      risposte.push(di('bot_t_gia_prenotato', {
        nome,
        data: dataItaliana(gia.data), ora: gia.ora, persone: gia.persone,
      }));
      return esito;
    };
    // «NUOVA» va guardata PRIMA del ricordino: chi la scrive il ricordino lo ha
    // già letto, e gli si sta rispondendo. Senza questa riga «nuova
    // prenotazione» ricadrebbe nel ricordino — la stessa frase, di nuovo.
    if (PAROLA_NUOVA.test(String(testo).trim())) {
      salvaStato(db, telefono, 'persone', {});
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

    const persone = interpretaPersone(testo);
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
      const sembraPrenotazione = !domandaSuAltro
        && (parlaDiPrenotare || /(vorrei|possibile)/.test(t) || eSalutoStorto(testo));
      if (!sembraPrenotazione) {
        // ⚠️ Qui prima si chiamava una persona SUBITO, al primo messaggio. Ma
        // il primo messaggio è quello scritto di fretta, con una lettera
        // storta o mezzo emoji: disturbare il responsabile di sala per un
        // «cioa» vuol dire che dopo tre giorni gli avvisi non li guarda più.
        // Una seconda occasione basta — ed è la stessa regola che vale su
        // tutte le altre domande («due volte non ci si capisce, poi passa a
        // una persona»): la prima domanda smette di essere l'eccezione severa.
        //
        // Il messaggio non dà la colpa a nessuno e apre le due strade: chi ha
        // sbagliato a scrivere risponde col numero, chi voleva chiedere altro
        // ha OPERATORE davanti agli occhi e non deve sperare di essere capito.
        //
        // Nel registro ci va lo stesso: è da lì che il ristoratore scopre cosa
        // gli scrivono davvero e cosa vale la pena mettere fra le risposte
        // pronte. Che il bot ora risponda non vuol dire che abbia capito.
        annotaNonCapita(db, testo);
        // ⚠️ Qui NON si chiama una persona, nemmeno per una domanda chiara: la
        // seconda occasione è una decisione presa apposta, e vale anche per
        // questa. Chiamare qualcuno alla prima riga vuol dire riempirgli il
        // telefono, e dopo tre giorni non guarda più nemmeno gli avvisi veri.
        // Al secondo messaggio ci si arriva comunque. Per le domande che
        // tornano — parcheggio, cane, carta — la strada giusta sono le risposte
        // pronte, che vengono guardate prima di tutto questo.
        // ⚠️ Ma se quel numero ha GIÀ un tavolo, «se vuoi prenotare dimmi per
        // quante persone» è la risposta sbagliata: chi ha già prenotato e
        // scrive storto si sente proporre una prenotazione che ha già fatto, e
        // il primo pensiero è «non mi ha trovato, allora rifaccio tutto» —
        // cioè un doppione, e una telefonata al locale per disfarlo.
        // Gli si ricorda il suo tavolo: è la cosa che stava cercando comunque,
        // e porta con sé le due parole per cambiarlo o disdirlo.
        // ⚠️ Il ricordino del tavolo serve a chi ha scritto STORTO: senza, si
        // sentirebbe proporre una prenotazione che ha già fatto e ne farebbe un
        // doppione. Ma a chi ha fatto una DOMANDA precisa è un non-sequitur:
        // ha chiesto del parcheggio e si sente rispondere «vuoi spostarla?».
        // A lui serve sapere come si ottiene una risposta, ed è quello che
        // «bot_t_primo_no» dice in fondo: scrivi OPERATORE.
        if (gia && !domandaSuAltro) return ricordaIlTavolo(true);
        salvaStato(db, telefono, 'persone', { tentativi: 1 });
        // Una domanda chiara si merita una risposta che parli della domanda.
        risposte.push(di(domandaSuAltro ? 'bot_t_domanda_no' : 'bot_t_primo_no'));
        return esito;
      }
      salvaStato(db, telefono, 'persone', {});
      // Il benvenuto è il PRIMO messaggio, e vale per chi arriva davvero la
      // prima volta. Chi ha già un tavolo da noi ci ha già parlato: gli si fa
      // la domanda e basta. (Resta un caso scoperto: chi ci scrisse mesi fa e
      // oggi non ha nessuna prenotazione attiva si risente il benvenuto. Per
      // chiuderlo servirebbe ricordarsi di chi si è già salutato, che è una
      // cosa in più da tenere in archivio — vedi il piano.)
      risposte.push(di(gia ? 'bot_t_quante' : 'bot_t_benvenuto'));
      return esito;
    }
    return passoPersone(persone);
  }

  if (stato.passo === 'persone') {
    const persone = interpretaPersone(testo);
    if (persone === null) {
      // Dopo il benvenuto il cliente può fare tutt'altro: «avete il
      // parcheggio?». Rispondergli «non ho capito il numero di persone»
      // sarebbe da sordi, e ripeterlo all'infinito lo farebbe andare via.
      const faq = cercaFaq(db, testo);
      if (faq) { risposte.push(riempi(faq, valori)); return esito; }
      if (eSaluto(testo)) { risposte.push(di('bot_t_persone_no')); return esito; }
      const tentativi = (dati.tentativi || 0) + 1;
      if (tentativi >= 2) {
        // Due volte che non ci si capisce bastano: da qui in poi insistere
        // peggiora soltanto. Passa a una persona.
        annotaNonCapita(db, testo);
        azzeraStato(db, telefono);
        esito.passaAUmano = true;
        return esito;
      }
      salvaStato(db, telefono, 'persone', { ...dati, tentativi });
      risposte.push(di('bot_t_persone_no'));
      return esito;
    }
    return passoPersone(persone);
  }

  function passoPersone(persone) {
    const max = num(cfg.bot_max_persone, 8);
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
    const giorni = giorniDisponibili(db, cfg, persone, adesso);
    if (!giorni.length) {
      risposte.push(di('bot_t_completo', { data: 'i prossimi giorni' }));
      esito.passaAUmano = true;
      azzeraStato(db, telefono);
      return esito;
    }
    salvaStato(db, telefono, 'giorno', { persone, giorni });
    risposte.push(`${di('bot_t_giorno')}\n${elencoGiorni(giorni)}`);
    return esito;
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
      : giorniDisponibili(db, cfg, dati.persone || 2, adesso);
    // Niente piu' scorciatoia «rispondi col numero della riga»: da quando le
    // date non sono piu' numerate, un «1» davanti a un elenco che contiene
    // «1 settembre» vuol dire quel giorno, non la prima riga.
    const iso = interpretaData(testo, adesso);
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
    const turni = turniDisponibili(db, cfg, iso, dati.persone, adesso);
    if (!turni.length) {
      const alternativi = giorniDisponibili(db, cfg, dati.persone, adesso);
      // Chiuso e pieno sono due cose diverse: in lista d'attesa si entra solo
      // per un giorno in cui il locale c'è e i posti no.
      const pieno = !(eChiuso(db, iso) || !turniDelGiorno(cfg, iso).length);
      risposte.push(`${di(pieno ? 'bot_t_completo' : 'bot_t_chiuso', { data: dataItaliana(iso) })}\n${elencoGiorni(alternativi)}${pieno ? propostaAttesa(iso, '') : ''}`);
      salvaStato(db, telefono, 'giorno', { ...dati, giorni: alternativi, ...(pieno && listaAttiva ? { attesaData: iso } : {}) });
      return esito;
    }
    salvaStato(db, telefono, 'ora', { ...avanzato(dati), data: iso, turni });
    risposte.push(`${di('bot_t_ora', { data: dataItaliana(iso) })}\n${elencoTurni(turni)}`);
    return esito;
  }

  if (stato.passo === 'ora') {
    // Un messaggio fa gli è stato detto che il suo orario era pieno, e gli è
    // stata proposta la lista: «sì» vuol dire quello, non un orario.
    if (dati.attesaOra && vuoleLaAttesa()) return mettiInLista({ ...dati, ora: dati.attesaOra });
    const ora = interpretaOra(testo, dati.turni || []);
    if (!ora) {
      // Prima di dire «non ho capito»: forse ha capito benissimo, e quell'ora
      // semplicemente non c'è più. Non conta come equivoco — perché non lo è.
      const no = oraNonProposta(db, cfg, dati, testo);
      if (no) return rispondiOraNo(no, 'ora', dati);
      return nonCapito('ora', dati, `${di('bot_t_ora_no')}\n${elencoTurni(dati.turni || [])}`);
    }
    // Ricontrollo: fra la proposta e la risposta può essersi riempito
    if (postiLiberi(db, cfg, dati.data, ora) < dati.persone) {
      const turni = turniDisponibili(db, cfg, dati.data, dati.persone, adesso);
      if (!turni.length) return tuttoPieno(dati, ora);
      salvaStato(db, telefono, 'ora', { ...dati, turni, ...(listaAttiva ? { attesaOra: ora } : {}) });
      risposte.push(`Quell'orario si è appena riempito. Restano:\n${elencoTurni(turni)}${propostaAttesa(dati.data, ora)}`);
      return esito;
    }
    return dopoLOra({ ...avanzato(dati), ora });
  }

  // Da qui in poi la strada è la stessa per chi ha scelto un orario libero e
  // per chi, dalla lista d'attesa, ha detto SÌ a un posto liberato: si passa
  // dalle stesse domande (nome, telefono, note, email) e dallo stesso
  // riepilogo. Una strada sola, un modo solo di sbagliare.
  function dopoLOra(d) {
    const { attesaOra, ...avanti } = d;
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
    if (interpretaData(testo, adesso)) {
      salvaStato(db, telefono, 'giorno', { persone: dati.persone, giorni: [] });
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
    if (!attesa || attesa.stato !== 'avvisata' || postiLiberi(db, cfg, dati.data, dati.ora) < dati.persone) {
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
    risposte.push(`${di(no.pieno ? 'bot_t_ora_piena' : 'bot_t_ora_tardi', {
      ora: no.ora, data: dataItaliana(d.data),
    })}\n${elencoTurni(turni)}${conAttesa ? propostaAttesa(d.data, no.ora) : ''}`);
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
      data: dataItaliana(d.data), ora: d.ora, persone: d.persone,
      nome: [d.nome, d.cognome].filter(Boolean).join(' ') || '—',
      cognome: d.cognome || '',
      telefono: d.telefono || '',
      note: d.note || '',
    };
    risposte.push(riempi(
      senzaRigheVuote(colTelefono(conEmail ? cfg.bot_t_email : cfg.bot_t_riepilogo, d.telefono), valoriRiepilogo),
      valoriRiepilogo,
    ));
    return esito;
  }

  if (stato.passo === 'email') {
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
    if (postiLiberi(db, cfg, d.data, d.ora) < d.persone) {
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
      + 'stato, importo_dovuto, importo_totale, pagamento_scade_at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(telefono, d.nome || '', d.cognome || '', d.data, d.ora, d.persone,
          d.note || '', recapito, d.email || '',
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
  segnaBasta,
  haDettoBasta,
  dividiNome,
  comeData,
  piuGiorni,
  dataItaliana,
  dataBreve,
  turniDelGiorno,
  turniValidi,
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
  eMuto,
  eOrarioAvvisi, qualcunoLegge, prossimaLettura,
  eSaluto,
  eSalutoStorto,
  distanzaParole,
  salutoOra,
  cercaFaq,
  annotaNonCapita,
  riempi,
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
  minutiFermi, PASSI_CHE_RIAPRONO, COSA_MANCA,
  prenotazioniDellaPersona, schedaPersona, cercaPersone,
  reportPrenotazioni, giorniFra, NOMI_SETTIMANA,
  interpretaGiorni,
  giornoBloccato, eBloccato, eChiuso, ePieno, giorniPieni, segnaPieno, togliPieno,
  inMinuti,
};
