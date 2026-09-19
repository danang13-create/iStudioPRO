const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const dns = require('dns').promises;
const express = require('express');
const Database = require('better-sqlite3');
const QRCode = require('qrcode');
const nodemailer = require('nodemailer');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { execFileSync } = require('child_process');

// ---------- Registro con data e ora ----------
// Va messo PRIMA di qualsiasi altra cosa, altrimenti le prime righe escono senza orario.
// Senza l'ora, dal registro non si capisce né quando è successo un guasto né ogni quanto
// si ripete: ricostruire a mano l'andamento di un invio da 1500 messaggi è stato impossibile.
// 'sv-SE' dà «2026-08-06 09:37:12» in ora LOCALE, lo stesso formato già usato altrove.
for (const livello of ['log', 'error', 'warn']) {
  const originale = console[livello].bind(console);
  console[livello] = (...args) => originale(`[${new Date().toLocaleString('sv-SE')}]`, ...args);
}

// ---------- iStudio non deve morire ----------
// Un errore imprevisto faceva terminare il processo. Il guaio non è tanto l'interruzione:
// è che morendo lascia acceso il browser interno di WhatsApp, che continua a tenersi il
// profilo in `.wwebjs_auth`. Da quel momento OGNI riavvio fallisce con «The browser is
// already running» e la piattaforma non riparte più finché quel processo non viene ucciso
// a mano. È successo davvero il 5 agosto 2026, in mezzo a un invio da ~1500 destinatari.
// Restare accesi e loggare è quindi molto meglio che uscire: vedi `ripristinaWhatsApp()`,
// che è la via d'uscita pulita quando il collegamento resta comunque rotto.
process.on('unhandledRejection', (err) => {
  console.error('Errore non gestito (iStudio resta accesa):', (err && err.message) || err);
});
process.on('uncaughtException', (err) => {
  // Unica eccezione: la porta occupata all'avvio. Lì uscire è giusto, perché altrimenti
  // resterebbe in piedi un secondo processo muto che non serve a nessuno.
  if (err && err.code === 'EADDRINUSE') {
    console.error(`La porta ${PORT} è già occupata: iStudio è probabilmente già avviata.`);
    process.exit(1);
  }
  console.error('Errore imprevisto (iStudio resta accesa):', (err && err.stack) || err);
});

// ⚠️ Number(), non il valore così com'è: da `process.env` arriva una STRINGA, e
// «3110» + 1 fa «31101» invece di 3111. La porta della sala qui sotto si
// ricava da questa, e con la stringa nasceva un numero di porta assurdo.
const PORT = Number(process.env.PORT) || 3100;
// Su hosting: DATA_DIR punta al disco persistente, ISTUDIO_PASSWORD protegge l'accesso
const DATA_DIR = process.env.DATA_DIR || __dirname;
const APP_PASSWORD = process.env.ISTUDIO_PASSWORD || '';
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Database ----------
const db = new Database(path.join(DATA_DIR, 'data.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    cognome TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    telefono TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL,
    total INTEGER NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'in_corso',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS campaign_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id),
    contact_id INTEGER,
    destinatario TEXT NOT NULL,
    telefono TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'in_attesa',
    error TEXT,
    sent_at TEXT
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  -- Richieste di cancellazione riconosciute nelle risposte WhatsApp.
  -- Non vengono mai applicate da sole: l'utente conferma (vedi NOTE-TECNICHE).
  -- ⚠️ Le sessioni di accesso stavano SOLO in memoria, e il biscotto diceva
  -- trenta giorni: a ogni riavvio il server se le dimenticava tutte. Un
  -- aggiornamento riavvia sempre, quindi ogni aggiornamento buttava fuori il
  -- tablet della sala — e la pagina della sala non se ne accorgeva: continuava
  -- a mostrare l'elenco di prima, fermo, senza dire niente. In sala vuol dire
  -- guardare le prenotazioni di ieri credendo che siano quelle di stasera.
  -- Qui restano, e un riavvio non si porta più via nessuno.
  CREATE TABLE IF NOT EXISTS sessioni (
    token TEXT PRIMARY KEY,
    dove TEXT NOT NULL,              -- 'piattaforma' oppure 'sala'
    scade_at INTEGER NOT NULL,
    versione TEXT                    -- con quale versione di iStudio si è entrati
  );
  CREATE TABLE IF NOT EXISTS optout_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_nome TEXT NOT NULL,
    testo TEXT NOT NULL,
    contact_id INTEGER,
    stato TEXT NOT NULL DEFAULT 'da_confermare',
    rilevato_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migrazioni per database creati con la versione precedente
try { db.exec("ALTER TABLE sessioni ADD COLUMN versione TEXT"); } catch {}
try { db.exec("ALTER TABLE campaigns ADD COLUMN channel TEXT NOT NULL DEFAULT 'whatsapp'"); } catch {}
try { db.exec("ALTER TABLE campaigns ADD COLUMN subject TEXT"); } catch {}
try { db.exec("ALTER TABLE campaigns ADD COLUMN alias TEXT"); } catch {}
try { db.exec("ALTER TABLE campaigns ADD COLUMN pause_reason TEXT"); } catch {}
try { db.exec("ALTER TABLE campaigns ADD COLUMN auto_resume INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE campaigns ADD COLUMN image_path TEXT"); } catch {}
try { db.exec("ALTER TABLE campaigns ADD COLUMN daily_limit INTEGER"); } catch {}
// Disiscritti: chi ha chiesto di non essere più contattato non deve MAI ricevere nulla.
try { db.exec("ALTER TABLE contacts ADD COLUMN opt_out INTEGER NOT NULL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE contacts ADD COLUMN opt_out_at TEXT"); } catch {}
try { db.exec("ALTER TABLE contacts ADD COLUMN opt_out_motivo TEXT"); } catch {}
try { db.exec("ALTER TABLE campaigns ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0"); } catch {}
// Provenienza e consenso: da dove arriva il contatto e se ha acconsentito (con data).
// I contatti già esistenti restano con consenso '' = "non indicato" (né sì né no):
// non vanno bloccati, solo segnalati.
try { db.exec("ALTER TABLE contacts ADD COLUMN provenienza TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE contacts ADD COLUMN consenso TEXT NOT NULL DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE contacts ADD COLUMN consenso_at TEXT"); } catch {}
try { db.exec("ALTER TABLE campaigns ADD COLUMN resume_after TEXT"); } catch {}

// Un invio non sopravvive al riavvio del server, ma ora è ripartibile: i destinatari
// non ancora serviti restano 'in_attesa' in campaign_messages, quindi invece di
// dichiarare l'invio morto lo mettiamo in pausa in attesa di un "Riprendi".
// auto_resume = 0: la ripresa dopo un riavvio la decide l'utente, non parte da sola.
const sospesi = db.prepare(`
  UPDATE campaigns SET status = 'in_pausa', auto_resume = 0,
    pause_reason = 'Invio interrotto dalla chiusura di iStudio. Premi Riprendi per continuare da dove si era fermato.'
  WHERE status IN ('in_corso', 'in_riposo')
`).run();
if (sospesi.changes) console.log('Invii sospesi dal riavvio precedente:', sospesi.changes);

// Invii realmente in esecuzione adesso (l'unico stato affidabile)
const campagneInCorso = new Set();
// Comandi vivi verso un invio in esecuzione: id -> { pausaRichiesta }
const controlloCampagne = new Map();

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : '';
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// ---------- Il guscio nuovo: colonna a sinistra invece delle schede in riga ----------
//
// ⚠️ È UNA MANOPOLA A TEMPO, non un'impostazione del prodotto. Adesso il guscio
// nuovo è ACCESO dappertutto, copie dei clienti comprese: la manopola non serve
// più a provarlo, serve a TORNARE INDIETRO se su una macchina vera qualcosa non
// va. È l'unica verifica che non si è potuta fare qui — il dito su un tablet
// vero — e finché non arriva quella, la via di ritorno resta.
//
// ⚠️ Una scelta fatta a mano VINCE sul valore di partenza, e resta: chi ha
// spento il guscio non se lo ritrova acceso al primo aggiornamento.
//
// ⚠️ QUANDO SI DECIDE CHE VA BENE si tolgono INSIEME la manopola e il guscio
// vecchio. Una prova pretende che spariscano tutti e due: una manopola
// «temporanea» lasciata lì è il modo in cui questo progetto si era già
// ritrovato la scheda delle frasi a metà.
function guscioNuovo() {
  const scelto = getSetting('ui_guscio');
  if (scelto === 'true') return true;
  if (scelto === 'false') return false;
  return true;                      // acceso per tutti: MASTER e copie dei clienti
}

// ---------- WhatsApp client ----------
const state = {
  status: 'inizializzazione', // inizializzazione | qr | connesso | disconnesso
  qr: null,
  me: null,
  // ⚠️ LA SECONDA STRADA PER COLLEGARSI: il codice di otto lettere, al posto
  // del QR. Serve a un caso solo ma vero — un telefono con la fotocamera
  // rotta, che il QR non può inquadrarlo in nessun modo. Normalmente non si usa.
  codice: null,           // il codice da battere sul telefono, es. 'ABCD-EFGH'
  codiceNumero: null,     // per quale numero è stato chiesto
};

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(DATA_DIR, '.wwebjs_auth') }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  },
});

client.on('qr', async (qr) => {
  state.status = 'qr';
  state.qr = await QRCode.toDataURL(qr, { width: 300 });
  console.log('QR code generato: scansionalo dalla pagina web');
});

// ⚠️ WhatsApp RIGENERA il codice da solo ogni tre minuti finché nessuno si
// collega: se si tenesse solo quello tornato dalla prima chiamata, dopo tre
// minuti la pagina mostrerebbe un codice morto — che non dà nessun errore,
// semplicemente non funziona. È lo stesso guasto del QR scaduto.
client.on('code', (codice) => {
  state.codice = String(codice || '');
  console.log('Codice di collegamento generato per', state.codiceNumero);
});

client.on('ready', () => {
  state.status = 'connesso';
  state.qr = null;
  state.codice = null;
  state.codiceNumero = null;
  state.me = client.info && client.info.wid ? client.info.wid.user : null;
  console.log('WhatsApp connesso come', state.me);
  // se un invio si era fermato per il collegamento caduto, riparte da solo
  setTimeout(() => riprendiInviiAutomatici(), 2000);
});

client.on('disconnected', (reason) => {
  state.status = 'disconnesso';
  state.me = null;
  console.log('WhatsApp disconnesso:', reason);
  // Prima si CHIUDE davvero, poi si riapre: vedi ripristinaWhatsApp().
  setTimeout(() => ripristinaWhatsApp('collegamento caduto'), 3000);
});

// ---------- Ripristino del collegamento WhatsApp ----------
// Il vecchio codice, quando WhatsApp cadeva, richiamava `client.initialize()` SENZA aver
// prima chiuso il browser rimasto aperto. whatsapp-web.js prova allora a re-iniettare le
// proprie funzioni in una pagina che le ha già, e lancia:
//     «Failed to add page binding with name onQRChangedEvent: window[...] already exists!»
// Quell'errore arrivava da una catena async non coperta dal `.catch()` qui sotto, quindi
// usciva come rifiuto non gestito e **faceva morire iStudio**, lasciando orfano il browser.
// La sequenza corretta è: chiudi (destroy) → assicurati che non resti nulla vivo → riapri.

// Chiude i browser rimasti orfani da un crash precedente. Sono processi che non
// appartengono più a nessuno ma continuano a tenersi il profilo in `.wwebjs_auth`:
// finché ci sono, `initialize()` fallisce con «The browser is already running».
// Il filtro è il percorso del profilo, quindi NON tocca il Chrome che l'utente usa
// per navigare, che ha un profilo diverso.
// Elenca i processi che tengono aperto il profilo. Il modo di chiederlo al sistema
// cambia col sistema operativo: `pgrep` non esiste su Windows, e senza questa distinzione
// lì la pulizia non avverrebbe mai (l'errore verrebbe ingoiato dal catch, in silenzio).
function processiSulProfilo(profilo) {
  if (process.platform === 'win32') {
    // PowerShell: unico modo affidabile di leggere la riga di comando di un processo.
    // -replace raddoppia gli apici singoli, così un percorso con l'apostrofo
    // (es. C:\Users\D'Angelo) non spezza la query.
    const filtro = profilo.replace(/'/g, "''");
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${filtro}*' } | Select-Object -ExpandProperty ProcessId`
    ], { encoding: 'utf8', windowsHide: true });
    return out.split('\n');
  }
  return execFileSync('pgrep', ['-f', profilo], { encoding: 'utf8' }).split('\n');
}

function chiudiBrowserOrfani() {
  const profilo = path.join(DATA_DIR, '.wwebjs_auth');
  let chiusi = 0;
  try {
    for (const riga of processiSulProfilo(profilo)) {
      const pid = Number(riga.trim());
      // Mai suicidarsi: il processo di iStudio non va ucciso qui.
      if (!pid || pid === process.pid) continue;
      try {
        if (process.platform === 'win32') {
          // Su Windows il Chromium ha processi figli: /T li porta via tutti insieme.
          execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
        } else {
          process.kill(pid, 'SIGKILL');
        }
        chiusi++;
      } catch { /* già morto */ }
    }
  } catch {
    // Nessun processo trovato: è il caso normale (pgrep esce con 1), non un errore.
  }
  if (chiusi) console.log(`Browser interni orfani chiusi: ${chiusi}`);
  return chiusi;
}

const attesa = (ms) => new Promise((r) => setTimeout(r, ms));

// Accende il browser. Se quello incluso non parte — succede su macOS datati, dove
// manca un componente di sistema — ripiega su un browser installato sul computer.
// Senza questo, su quei computer iStudio non riesce MAI a collegarsi a WhatsApp e
// nemmeno il pulsante «Ripristina» serve a niente.
async function avviaBrowser() {
  try {
    await client.initialize();
  } catch (err) {
    if (!nonRiesceAdAprireIlBrowser(err.message) || process.env.PUPPETEER_EXECUTABLE_PATH) throw err;

    // 1) un browser già installato sul computer
    let alternativo = browserDiSistema();
    // 2) altrimenti se ne scarica uno compatibile (Mac datati: vedi la funzione)
    if (!alternativo) alternativo = await scaricaBrowserCompatibile();
    if (!alternativo) {
      throw new Error('Il browser incluso non parte su questo computer e non riesco a ' +
        'procurarne un altro. Controlla la connessione a internet e riprova.');
    }
    console.log(`Il browser incluso non parte. Provo con: ${alternativo}`);
    client.options.puppeteer.executablePath = alternativo;
    await client.initialize();
    console.log('Riuscito: iStudio userà questo browser d\'ora in poi.');
  }
}

// Una sola operazione di ripristino alla volta: due in parallelo si ucciderebbero a vicenda
// il browser a metà avvio, che è esattamente il guaio da cui stiamo uscendo.
let ripristinoInCorso = false;

async function ripristinaWhatsApp(motivo) {
  if (ripristinoInCorso) {
    console.log(`Ripristino WhatsApp già in corso, ignoro la richiesta (${motivo}).`);
    return { ok: false, error: 'Un ripristino è già in corso, attendi qualche secondo.' };
  }
  ripristinoInCorso = true;
  state.status = 'inizializzazione';
  state.qr = null;
  state.codice = null;
  state.codiceNumero = null;
  state.me = null;
  console.log(`Ripristino collegamento WhatsApp (${motivo}): chiudo…`);
  try {
    // 1. Chiusura ordinata. Se il browser è già morto questo fallisce: non importa,
    //    l'obiettivo è solo non lasciarlo acceso.
    try { await client.destroy(); }
    catch (err) { console.log('Chiusura ordinata non riuscita (procedo comunque):', err.message); }
    // 2. Rete di sicurezza: qualunque browser sia rimasto appeso al profilo se ne va.
    chiudiBrowserOrfani();
    // 3. Un attimo di respiro: il profilo va rilasciato prima di riaprirlo.
    await attesa(2000);
    // 4. Riapertura pulita. Se il browser incluso non parte su questo computer,
    //    si ripiega su uno installato: altrimenti il pulsante «Ripristina»
    //    fallirebbe sempre, e il cliente non avrebbe nessuna via d'uscita.
    console.log(`Ripristino collegamento WhatsApp (${motivo}): riapro…`);
    await avviaBrowser();
    console.log(`Ripristino collegamento WhatsApp (${motivo}): riuscito.`);
    return { ok: true };
  } catch (err) {
    state.status = 'errore';
    console.error(`Ripristino collegamento WhatsApp (${motivo}) fallito:`, err.message);
    return { ok: false, error: err.message };
  } finally {
    ripristinoInCorso = false;
  }
}

// Avvio. Se il profilo risulta già occupato è quasi sempre un orfano di un crash
// precedente: lo si chiude e si riprova una volta sola, così iStudio riparte da sola
// invece di restare bloccata a ogni riavvio (il 5 agosto 2026 fallì 5 riavvii di fila).
// Su alcuni computer il browser che iStudio si porta dietro NON parte: su macOS
// datati manca un componente di sistema (`AVFAudio`) e l'errore è
// «Failed to launch the browser process». Non è recuperabile riprovando: quel
// browser non partirà mai. Però quasi tutti hanno un Chrome normale installato, e
// va benissimo lo stesso. Prima si risolveva scrivendo a mano un file col percorso:
// un passaggio che un cliente non farà mai. Adesso se lo cerca iStudio.
function browserDiSistema() {
  const candidati = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      ]
    : process.platform === 'linux'
    // ⚠️ Su Linux il ripiego non esisteva: qui si finiva nel ramo di macOS, a cercare
    // dei «.app» che su Ubuntu non ci sono e non ci saranno mai. La funzione tornava
    // sempre «nessun browser», in silenzio — cioè il piano B non c'era proprio, e
    // sarebbe saltato fuori solo il giorno in cui il browser incluso non parte, su
    // una macchina in un ristorante.
    ? [
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/snap/bin/chromium',          // su Ubuntu Chromium si installa come snap
        '/usr/bin/microsoft-edge',
      ]
    : [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ];
  return candidati.find((p) => p && fs.existsSync(p)) || null;
}

// Ultima risorsa per i computer dove il browser incluso non parte e non ce n'è nessun
// altro installato. Succede sui Mac con macOS datato (Catalina 10.15 e simili): le
// versioni recenti di Chrome non ci girano più, e l'ultima compatibile è la 128.
// Si scarica una volta sola (~150 MB) e resta lì per gli avvii successivi.
// Solo su Mac Intel: su Apple Silicon e su Windows il browser incluso funziona.
const VERSIONE_CHROME_COMPATIBILE = '128.0.6613.137';

async function scaricaBrowserCompatibile() {
  if (process.platform !== 'darwin') return null;
  const cartella = path.join(os.homedir(), '.cache', 'istudio-chrome');
  const eseguibile = path.join(cartella,
    'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
  if (fs.existsSync(eseguibile)) return eseguibile;

  const url = `https://storage.googleapis.com/chrome-for-testing-public/${VERSIONE_CHROME_COMPATIBILE}/mac-x64/chrome-mac-x64.zip`;
  console.log('Nessun browser utilizzabile su questo computer: ne scarico uno compatibile ' +
    '(~150 MB, una volta sola). Ci vorrà qualche minuto…');
  try {
    fs.mkdirSync(cartella, { recursive: true });
    const zip = path.join(cartella, 'chrome.zip');
    // -L segue i reindirizzamenti; il tempo massimo è alto perché il file è grosso
    execFileSync('curl', ['-fsSL', '--max-time', '900', url, '-o', zip], { stdio: 'ignore' });
    // ditto e non unzip: conserva i permessi e la struttura dell'applicazione,
    // senza i quali il browser non parte.
    execFileSync('ditto', ['-x', '-k', zip, cartella], { stdio: 'ignore' });
    fs.unlinkSync(zip);
    if (fs.existsSync(eseguibile)) {
      // macOS blocca ciò che arriva da internet finché non gli si toglie il marchio.
      try { execFileSync('xattr', ['-dr', 'com.apple.quarantine', cartella], { stdio: 'ignore' }); } catch {}
      console.log('Browser compatibile scaricato.');
      return eseguibile;
    }
    console.error('Il browser scaricato non è dove me lo aspettavo.');
  } catch (e) {
    console.error('Non sono riuscito a scaricare il browser compatibile:', e.message);
  }
  return null;
}

function nonRiesceAdAprireIlBrowser(messaggio) {
  return /Failed to launch the browser process|spawn .*ENOENT|Could not find (Chrome|browser)/i
    .test(messaggio || '');
}

// Avvio. `avviaBrowser()` gestisce già il ripiego su un browser di sistema; qui resta
// il solo caso del profilo occupato da un browser orfano di un crash precedente,
// che si chiude e si riprova una volta sola (il 5 agosto 2026 fallì 5 riavvii di fila).
avviaBrowser().catch(async (err) => {
  console.error('Errore inizializzazione WhatsApp:', err.message);
  if (/already running/i.test(err.message) && chiudiBrowserOrfani() > 0) {
    console.log('Riprovo l\'avvio di WhatsApp dopo aver chiuso il browser orfano…');
    await attesa(2000);
    try {
      await avviaBrowser();
      return;
    } catch (err2) {
      console.error('Anche il secondo tentativo è fallito:', err2.message);
    }
  }
  state.status = 'errore';
});

// ---------- Helpers ----------
function normalizePhone(raw) {
  let p = String(raw).replace(/[\s\-().]/g, '');
  if (p.startsWith('+')) p = p.slice(1);
  else if (p.startsWith('00')) p = p.slice(2);
  // Numeri italiani senza prefisso internazionale (es. 3401234567)
  if (/^3\d{8,9}$/.test(p)) p = '39' + p;
  return p;
}

// Come si SCRIVE un numero in rubrica.
//
// ⚠️ Finora ci finiva quello che capitava: «+393429872741» battuto a mano,
// «393245927803» preso da una prenotazione, «340 123 4567» arrivato da un CSV.
// Nessuno dei tre è sbagliato — si confrontano e si inviano tutti passando da
// `normalizePhone`, che il «+» lo toglie comunque — ma messi in colonna nella
// stessa tabella sembrano tre cose diverse, e chi ne aggiunge uno a mano non sa
// più quale sia il formato giusto.
//
// Il formato scelto è quello internazionale col «+»: è come lo scrive WhatsApp,
// ed è l'unico che si può comporre anche da fuori dall'Italia.
//
// ⚠️ Quello che NON somiglia a un numero si lascia esattamente com'è. In una
// rubrica vera può esserci scritto «chiamare in ufficio» o un interno di
// centralino: riscriverlo vorrebbe dire buttare via l'unica cosa che c'era.
function numeroInRubrica(valore) {
  const originale = String(valore || '').trim();
  const cifre = normalizePhone(originale);
  return /^\d{8,15}$/.test(cifre) ? '+' + cifre : originale;
}

function renderTemplate(message, contact) {
  return message
    .replace(/[\{\[]nome[\}\]]/gi, contact.nome || '')
    .replace(/[\{\[]cognome[\}\]]/gi, contact.cognome || '');
}

// ---- Verifica dell'indirizzo email prima dell'invio ----
// Attenzione: "partito" non è "arrivato". Qui possiamo intercettare solo:
//  - indirizzi scritti male (senza @, senza dominio…)
//  - domini che non esistono o non ricevono posta (es. test@test.test)
// NON è intercettabile la casella inesistente su un dominio vero (rimbalza dopo).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const mxCache = new Map(); // dominio -> true/false, per non ripetere la stessa ricerca DNS

async function dominioRicevePosta(dominio) {
  if (mxCache.has(dominio)) return mxCache.get(dominio);
  let ok = false;
  try {
    const mx = await dns.resolveMx(dominio);
    if (Array.isArray(mx) && mx.length > 0) ok = true;
  } catch {}
  if (!ok) {
    // alcuni domini ricevono posta sull'A record anche senza MX (RFC 5321)
    try {
      const a = await dns.resolve(dominio);
      if (Array.isArray(a) && a.length > 0) ok = true;
    } catch {}
  }
  mxCache.set(dominio, ok);
  return ok;
}

async function verificaEmail(email) {
  const e = String(email || '').trim();
  if (!EMAIL_RE.test(e)) throw new Error('Indirizzo email scritto male');
  const dominio = e.split('@')[1].toLowerCase();
  if (!await dominioRicevePosta(dominio)) {
    throw new Error('Il dominio dell\'email non esiste o non riceve posta');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Legge un'immagine inviata dal browser come "data:image/png;base64,...."
function leggiImmagine(dataUrl) {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl || '');
  return m ? { mime: m[1], base64: m[2] } : null;
}

function buildTransporter() {
  const host = getSetting('smtp_host');
  const port = Number(getSetting('smtp_port') || 587);
  const user = getSetting('smtp_user');
  const pass = getSetting('smtp_pass');
  if (!host || !user || !pass) return null;
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });
}

function emailHtml(text, conImmagine) {
  const esc = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
  // l'immagine viene mostrata dentro il messaggio (allegata come "cid")
  const img = conImmagine
    ? '<img src="cid:immagine-istudio" alt="" style="max-width:100%;height:auto;border-radius:8px;margin-bottom:16px">'
    : '';
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222;line-height:1.6;max-width:600px;margin:0 auto;padding:16px">${img}${esc}</div>`;
}

// ---------- Ritmo degli invii (anti-blocco) ----------
// Valori consigliati: sono la difesa principale contro il ban. L'utente può ritoccarli
// dalle Impostazioni; i default qui sotto restano quelli suggeriti. Tutti in secondi.
// Valori consigliati, e ricaduta quando una chiave manca. Alzati parecchio il 17 agosto
// 2026: si andava a 10-15 s con riposo ogni 50, adesso 50-60 s con riposo ogni 25.
// Il blocco del numero non arriva dalla velocità in sé ma dalle segnalazioni; andare
// piano però riduce l'impronta da automazione, ed è l'unica difesa che dipende da noi.
// Conseguenza da conoscere: 100 messaggi passano da ~25 minuti a **circa 1 ora e 50**.
// Con il tetto giornaliero che parte da 100, è una giornata di lavoro tranquilla.
const RITMO_DEFAULT = {
  wa_pausa_min: 50, wa_pausa_max: 60,     // pausa fra un messaggio WhatsApp e l'altro
  wa_riposo_ogni: 25,                     // ogni quanti messaggi si fa la riposata lunga
  wa_riposo_min: 180, wa_riposo_max: 300, // durata della riposata: 3-5 minuti (in secondi)
  email_pausa_min: 1, email_pausa_max: 3, // pausa fra un'email e l'altra (invariata: l'email non rischia il blocco)
};

// Quante email al giorno al massimo. Fisso, non scelto dall'utente: il numero dipende dal
// provider di posta, non da chi invia. 450 sta sotto il tetto di Gmail (~500/giorno) con un
// margine, perché in quel conto Google infila anche le email che mandi normalmente tu.
// Superarlo non ritarda le email: il provider le RIFIUTA, e nei casi peggiori blocca la
// casella per qualche ora.
// Modificabile dalle Impostazioni, ma solo fra valori previsti: un campo libero qui
// inviterebbe a scriverci 5000, e il risultato sarebbero email rifiutate in massa.
const TETTI_EMAIL_AMMESSI = [100, 200, 300, 400];
const TETTO_EMAIL_DEFAULT = 400;

function tettoEmailGiornaliero() {
  const v = parseInt(getSetting('tetto_email_giornaliero'), 10);
  return TETTI_EMAIL_AMMESSI.includes(v) ? v : TETTO_EMAIL_DEFAULT;
}

// Legge un valore di ritmo dalle impostazioni, con ricaduta sul default se assente o assurdo
function ritmoNum(key) {
  const v = parseFloat(getSetting('ritmo_' + key));
  return Number.isFinite(v) && v > 0 ? v : RITMO_DEFAULT[key];
}

// Interruttore "Disattiva pause": un flag a parte, non tocca i valori numerici salvati.
// Riaccendendolo tornano esattamente i valori di prima, senza bisogno di "Ripristina".
function pauseDisattivate() {
  return getSetting('ritmo_disattivato') === 'true';
}

// Ritmo effettivo in millisecondi, letto al momento (così un cambio in Impostazioni
// vale dal prossimo invio senza riavviare il server)
function ritmoInvii() {
  if (pauseDisattivate()) {
    return {
      waPausaMin: 0, waPausaMax: 0, waRiposoOgni: Number.MAX_SAFE_INTEGER,
      waRiposoMin: 0, waRiposoMax: 0, emailPausaMin: 0, emailPausaMax: 0,
    };
  }
  const min = (k) => Math.round(ritmoNum(k) * 1000);
  return {
    waPausaMin: min('wa_pausa_min'), waPausaMax: min('wa_pausa_max'),
    waRiposoOgni: Math.max(1, Math.round(ritmoNum('wa_riposo_ogni'))),
    waRiposoMin: min('wa_riposo_min'), waRiposoMax: min('wa_riposo_max'),
    emailPausaMin: min('email_pausa_min'), emailPausaMax: min('email_pausa_max'),
  };
}

// ---------- Allegati degli invii ----------
// L'immagine va salvata su disco: se il Mac si spegne a metà invio, alla ripresa
// deve essere ancora disponibile (in memoria sarebbe persa).
const ALLEGATI_DIR = path.join(DATA_DIR, 'allegati-invii');
fs.mkdirSync(ALLEGATI_DIR, { recursive: true });

function salvaImmagineCampagna(campaignId, immagine) {
  if (!immagine) return null;
  const file = path.join(ALLEGATI_DIR, `invio-${campaignId}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(immagine));
    db.prepare('UPDATE campaigns SET image_path = ? WHERE id = ?').run(file, campaignId);
    return file;
  } catch (err) {
    console.error('Impossibile salvare l\'allegato dell\'invio:', err.message);
    return null;
  }
}

function caricaImmagineCampagna(camp) {
  if (!camp || !camp.image_path) return null;
  try {
    return JSON.parse(fs.readFileSync(camp.image_path, 'utf8'));
  } catch {
    return null; // allegato sparito: l'invio prosegue col solo testo
  }
}

function eliminaImmagineCampagna(camp) {
  if (camp && camp.image_path) { try { fs.unlinkSync(camp.image_path); } catch {} }
}

// ---------- Motore degli invii ----------
// resumeAfter va sempre riscritto (null se non serve): un residuo di una pausa
// precedente farebbe ripartire l'invio da solo a sproposito.
function segnaStato(campaignId, status, motivo, autoResume, resumeAfter) {
  db.prepare('UPDATE campaigns SET status = ?, pause_reason = ?, auto_resume = ?, resume_after = ? WHERE id = ?')
    .run(status, motivo || null, autoResume ? 1 : 0, resumeAfter || null, campaignId);
}

// Quanti messaggi di questo invio sono già stati serviti OGGI (riusciti o falliti).
// 'localtime' è obbligatorio: SQLite ragiona in UTC e in Italia il giorno cambierebbe
// all'una o alle due di notte invece che a mezzanotte.
function serviteOggi(campaignId) {
  return db.prepare(`
    SELECT COUNT(*) n FROM campaign_messages
    WHERE campaign_id = ? AND sent_at IS NOT NULL
      AND date(sent_at, 'localtime') = date('now', 'localtime')
  `).get(campaignId).n;
}

// Domani alle 9:00 ora locale, in formato ISO. Non a mezzanotte: messaggi che
// arrivano nel cuore della notte infastidiscono e fanno guadagnare segnalazioni.
function domaniMattina() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d.toISOString();
}

// Destinatari non ancora serviti. Nome e cognome arrivano dalla rubrica quando il
// contatto esiste ancora; altrimenti si ripiega su quanto congelato al momento
// dell'invio, così una ripresa funziona anche se nel frattempo è stato cancellato.
// Distingue «il messaggio non è partito per colpa di QUESTO destinatario» (numero senza
// WhatsApp, email scritta male…) da «il collegamento è caduto sotto i piedi».
// Sono i secondi il problema: il messaggio d'errore arriva dal browser morto, non dal
// contatto. Il più frequente è «Attempted to use detached Frame», cioè la pagina di
// WhatsApp Web che non esiste più.
function erroreDiCollegamento(messaggio) {
  return /detached Frame|Session closed|Target closed|Protocol error|Execution context|browser (has )?disconnected|Connection closed|not opened/i
    .test(messaggio || '');
}

// Quante volte di fila il collegamento è caduto durante QUESTO invio, senza che nel
// frattempo sia partito neanche un messaggio. Serve a non entrare in un ciclo infinito:
// cade → pausa → ripristino → riconnesso → riprende → ricade… ogni pochi secondi.
// Sarebbe inutile e per giunta pericoloso, perché martellare il collegamento è esattamente
// il tipo di comportamento che fa guadagnare un blocco del numero.
// Il contatore si azzera appena un messaggio parte davvero: è la prova che si è ripreso.
const caduteConsecutive = new Map();
const MAX_CADUTE_CONSECUTIVE = 3;

function destinatariInAttesa(campaignId) {
  return db.prepare(`
    SELECT cm.contact_id AS id, cm.destinatario, cm.telefono AS recapito,
           c.nome AS nome_rubrica, c.cognome AS cognome_rubrica
    FROM campaign_messages cm
    LEFT JOIN contacts c ON c.id = cm.contact_id
    WHERE cm.campaign_id = ? AND cm.status = 'in_attesa'
    ORDER BY cm.id
  `).all(campaignId).map((r) => ({
    id: r.id,
    nome: r.nome_rubrica != null ? r.nome_rubrica : (r.destinatario || '').split(' ')[0] || '',
    cognome: r.cognome_rubrica != null ? r.cognome_rubrica : (r.destinatario || '').split(' ').slice(1).join(' '),
    telefono: r.recapito,
    email: r.recapito,
  }));
}

// Attesa spezzettata: se nel frattempo arriva un "Metti in pausa" non aspetta
// il minuto intero ma si ferma subito. Restituisce false se va interrotta.
async function attesaInterrompibile(campaignId, ms) {
  const scadenza = Date.now() + ms;
  while (Date.now() < scadenza) {
    const ctrl = controlloCampagne.get(campaignId);
    if (!ctrl || ctrl.pausaRichiesta) return false;
    await sleep(Math.min(1000, scadenza - Date.now()));
  }
  return true;
}

// Esegue (o riprende) un invio: serve solo i destinatari ancora 'in_attesa',
// quindi nessuno riceve il messaggio due volte.
async function runCampaign(campaignId, opzioni) {
  const ignoraTettoOggi = Boolean(opzioni && opzioni.ignoraTettoOggi);
  campaignId = Number(campaignId);
  if (campagneInCorso.has(campaignId)) return;
  const camp = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(campaignId);
  if (!camp) return;
  const viaEmail = (camp.channel || 'whatsapp') === 'email';

  campagneInCorso.add(campaignId);
  controlloCampagne.set(campaignId, { pausaRichiesta: false });
  segnaStato(campaignId, 'in_corso', null, 0);

  try {
    const immagine = caricaImmagineCampagna(camp);
    const updateMsg = db.prepare(
      "UPDATE campaign_messages SET status = ?, error = ?, sent_at = datetime('now') WHERE campaign_id = ? AND contact_id = ?"
    );
    const bump = db.prepare('UPDATE campaigns SET sent = sent + ?, failed = failed + ? WHERE id = ?');
    const bumpSaltati = db.prepare('UPDATE campaigns SET skipped = skipped + 1 WHERE id = ?');
    const eDisiscritto = db.prepare('SELECT opt_out FROM contacts WHERE id = ?');

    const transporter = viaEmail ? buildTransporter() : null;
    const fromName = viaEmail ? (getSetting('smtp_from_name') || '') : '';
    const fromAddr = viaEmail ? getSetting('smtp_user') : '';

    const ritmo = ritmoInvii(); // tempi anti-blocco, letti dalle Impostazioni
    const restanti = destinatariInAttesa(campaignId);
    let fatti = camp.sent + camp.failed; // conteggio complessivo, regge anche le riprese

    for (let i = 0; i < restanti.length; i++) {
      const contact = restanti[i];

      // Pausa chiesta dall'utente
      const ctrl = controlloCampagne.get(campaignId);
      if (!ctrl || ctrl.pausaRichiesta) {
        segnaStato(campaignId, 'in_pausa', 'Messo in pausa da te. Premi Riprendi quando vuoi continuare.', 0);
        return;
      }
      // WhatsApp caduto (linea internet, telefono scollegato...): pausa con ripresa automatica
      if (!viaEmail && state.status !== 'connesso') {
        segnaStato(campaignId, 'in_pausa',
          'WhatsApp si è scollegato durante l\'invio. Riparte da solo appena torna il collegamento.', 1);
        return;
      }
      // Tetto giornaliero raggiunto: si riprende domani mattina da soli.
      // Se l'utente ha forzato la ripresa, il tetto vale comunque dal giorno dopo.
      if (camp.daily_limit > 0 && !ignoraTettoOggi) {
        const oggi = serviteOggi(campaignId);
        if (oggi >= camp.daily_limit) {
          segnaStato(campaignId, 'in_pausa',
            `Raggiunto il tuo limite di ${camp.daily_limit} al giorno (${oggi} inviati oggi). Riprende da solo domani alle 9:00.`,
            0, domaniMattina());
          return;
        }
      }

      // Il contatto può aver chiesto di non essere più contattato DOPO l'avvio dell'invio
      // (o mentre era in pausa): si ricontrolla adesso, non solo alla partenza.
      const stato = eDisiscritto.get(contact.id);
      if (stato && stato.opt_out) {
        updateMsg.run('saltato', 'Ha chiesto di non ricevere più messaggi', campaignId, contact.id);
        bumpSaltati.run(campaignId);
        continue; // niente attesa: non abbiamo contattato nessuno
      }

      try {
        if (viaEmail) {
          if (!transporter) throw new Error('Email non configurata');
          if (!contact.email) throw new Error('Contatto senza email');
          await verificaEmail(contact.email); // scritta male o dominio inesistente → errore
          const body = renderTemplate(camp.message, contact);
          await transporter.sendMail({
            from: fromName ? `"${fromName}" <${fromAddr}>` : fromAddr,
            to: contact.email,
            subject: renderTemplate(camp.subject || '', contact),
            text: body,
            html: emailHtml(body, Boolean(immagine)),
            attachments: immagine ? [{
              filename: immagine.filename || 'immagine.png',
              content: Buffer.from(immagine.base64, 'base64'),
              cid: 'immagine-istudio',
            }] : undefined,
          });
        } else {
          const phone = normalizePhone(contact.telefono);
          const numberId = await client.getNumberId(phone);
          if (!numberId) throw new Error('Numero non registrato su WhatsApp');
          const testo = renderTemplate(camp.message, contact);
          if (immagine) {
            // immagine con il messaggio come didascalia
            const media = new MessageMedia(immagine.mime, immagine.base64, immagine.filename || 'immagine');
            await client.sendMessage(numberId._serialized, media, { caption: testo });
          } else {
            await client.sendMessage(numberId._serialized, testo);
          }
        }
        updateMsg.run('inviato', null, campaignId, contact.id);
        bump.run(1, 0, campaignId);
        caduteConsecutive.delete(campaignId); // è ripartito davvero: il conto riparte da zero
      } catch (err) {
        // Se è caduto il COLLEGAMENTO, il destinatario non c'entra niente: va lasciato
        // «in attesa» e riprovato. Marcarlo 'errore' sarebbe sbagliato due volte:
        //  1. la ripresa serve solo le righe 'in_attesa', quindi quella persona non
        //     riceverebbe MAI il messaggio, e nessuno se ne accorgerebbe;
        //  2. l'invio proseguirebbe bruciando allo stesso modo i contatti successivi.
        // Il 5 agosto 2026 è andata esattamente così: 12 dei 17 «non riusciti» erano
        // pagine morte, in tre raffiche consecutive.
        // ATTENZIONE: qui NON ci si può affidare a `state.status`, che in questi casi
        // resta 'connesso' a torto — l'evento 'disconnected' non scatta (nel registro
        // reale: 65 errori di pagina staccata e nemmeno una riga «WhatsApp disconnesso»).
        // È l'errore stesso il segnale che il collegamento non c'è più.
        if (!viaEmail && erroreDiCollegamento(err.message)) {
          const cadute = (caduteConsecutive.get(campaignId) || 0) + 1;
          caduteConsecutive.set(campaignId, cadute);
          console.error(`Invio ${campaignId}: collegamento caduto durante l'invio, tentativo ${cadute} ` +
            `(${err.message}). ${contact.nome} ${contact.cognome} resta in attesa e verrà riprovato.`);
          state.status = 'disconnesso'; // lo stato in memoria era rimasto indietro
          if (cadute >= MAX_CADUTE_CONSECUTIVE) {
            // Ci ha provato abbastanza: non è un intoppo di passaggio. Ci si ferma e si
            // chiama in causa l'utente, invece di continuare a riprovare all'infinito.
            caduteConsecutive.delete(campaignId);
            segnaStato(campaignId, 'in_pausa',
              `WhatsApp si è scollegato ${cadute} volte di fila e l'invio non riesce a proseguire. ` +
              'Vai in Impostazioni, premi «Ripristina collegamento WhatsApp», poi riprendi l\'invio con ▶️. ' +
              'Nessun destinatario è stato perso: chi manca è ancora in attesa.', 0);
            console.error(`Invio ${campaignId}: mi fermo dopo ${cadute} cadute di fila, serve un intervento.`);
            return;
          }
          segnaStato(campaignId, 'in_pausa',
            'WhatsApp si è scollegato durante l\'invio. Riparte da solo appena torna il collegamento.', 1);
          ripristinaWhatsApp('collegamento caduto durante un invio');
          return; // il destinatario resta 'in_attesa': nessuno viene perso
        }
        updateMsg.run('errore', err.message, campaignId, contact.id);
        bump.run(0, 1, campaignId);
      }

      fatti++;
      if (i === restanti.length - 1) break; // ultimo: nessuna attesa inutile

      if (viaEmail) {
        if (!await attesaInterrompibile(campaignId, ritmo.emailPausaMin + Math.random() * (ritmo.emailPausaMax - ritmo.emailPausaMin))) continue;
      } else if (fatti % ritmo.waRiposoOgni === 0) {
        // riposata lunga ogni tot messaggi
        const durata = Math.round(ritmo.waRiposoMin + Math.random() * (ritmo.waRiposoMax - ritmo.waRiposoMin));
        segnaStato(campaignId, 'in_riposo',
          `Riposo automatico dopo ${fatti} messaggi: riprende fra circa ${Math.round(durata / 60000) || 1} minuto.`, 0);
        const completata = await attesaInterrompibile(campaignId, durata);
        if (completata) segnaStato(campaignId, 'in_corso', null, 0);
        else continue; // la pausa verrà registrata dal controllo a inizio giro
      } else {
        if (!await attesaInterrompibile(campaignId, ritmo.waPausaMin + Math.random() * (ritmo.waPausaMax - ritmo.waPausaMin))) continue;
      }
    }

    segnaStato(campaignId, 'completata', null, 0);
  } catch (err) {
    console.error('Invio interrotto da un errore imprevisto:', err.message);
    segnaStato(campaignId, 'in_pausa', 'Interrotto da un errore: ' + err.message + ' — puoi riprendere da dove si era fermato.', 0);
  } finally {
    campagneInCorso.delete(campaignId);
    controlloCampagne.delete(campaignId);
  }
}

// Ripresa automatica: quando WhatsApp torna collegato riparte da sola solo ciò
// che si era fermato per colpa del collegamento (auto_resume = 1).
function riprendiInviiAutomatici() {
  const daRiprendere = db.prepare(
    "SELECT id FROM campaigns WHERE status = 'in_pausa' AND auto_resume = 1 AND channel = 'whatsapp'"
  ).all();
  for (const c of daRiprendere) {
    console.log('WhatsApp è tornato: riprendo l\'invio', c.id);
    runCampaign(c.id);
  }
}

// Riprese programmate (tetto giornaliero): ogni minuto si guarda se è arrivata l'ora.
// Se WhatsApp non è ancora collegato non si forza nulla: resume_after resta nel passato
// e il controllo riprova al giro dopo.
function controllaRiprese() {
  // ⚠️ Le pagine sono bloccate dall'abbonamento scaduto, ma un invio messo in
  // pausa per la notte riprendeva da solo la mattina dopo: il programma
  // risultava fermo e intanto mandava centinaia di messaggi. Bloccare la porta
  // e lasciare aperta la finestra non è bloccare.
  if (!abbonamentoAttivo()) return;
  const pronte = db.prepare(
    "SELECT * FROM campaigns WHERE status = 'in_pausa' AND resume_after IS NOT NULL AND resume_after <= ?"
  ).all(new Date().toISOString());
  for (const c of pronte) {
    if (campagneInCorso.has(c.id)) continue;
    const viaEmail = (c.channel || 'whatsapp') === 'email';
    if (!viaEmail && state.status !== 'connesso') continue;
    if (viaEmail && !buildTransporter()) continue;
    console.log('È l\'ora: riprendo l\'invio', c.id);
    runCampaign(c.id);
  }
}
setInterval(controllaRiprese, 60 * 1000);

// ---------- Abbonamento a seriale (solo sulle copie dei clienti) ----------
// Qui non c'è nessun server da tenere acceso e nessuna chiamata verso l'esterno: il
// permesso viaggia in un seriale firmato che l'amministratore genera sul proprio Mac
// e manda al cliente.
//
// Fino al 6 agosto 2026 c'era invece una «modalità licenza» che chiedeva il permesso a
// un server centrale a ogni avvio, ogni ora e a mezzanotte. È stata tolta del tutto: il
// server andava tenuto acceso e raggiungibile, ed era proprio quello l'ostacolo.
// Se serve rivederla, sta nella storia di git (commit «Modalita' licenza»).
//
// Si accende SOLO se nella cartella del programma c'è «copia-cliente.txt», che ci mette
// lo script di pubblicazione. Sul Mac di chi sviluppa non c'è, quindi iStudio funziona
// esattamente come sempre.
const modalitaAbbonamento = fs.existsSync(path.join(__dirname, 'copia-cliente.txt'));

// Numero di versione, mostrato in fondo a ogni pagina: serve a capire al volo quale copia
// si sta guardando. Letto a ogni richiesta e non una volta sola, perché l'aggiornamento
// automatico lo riscrive mentre iStudio è spenta e deve risultare quello nuovo al riavvio.
function versioneInstallata() {
  try { return fs.readFileSync(path.join(__dirname, 'VERSIONE.txt'), 'utf8').trim() || null; }
  catch { return null; }
}

// ------------------------------------------------------------------
//  «C'è una versione più nuova» — il cartello, non l'aggiornamento
// ------------------------------------------------------------------
//  L'aggiornamento vero lo fanno gli aggiornatori (Mac/ e Linux/), ognuno col
//  suo momento: il Mac al prossimo avvio, il mini-PC alle 5 del mattino. Qui
//  non si aggiorna niente: si guarda che numero è pubblicato e, se è più alto
//  di quello installato, LO SI DICE nella piattaforma.
//
//  ⚠️ Perché serve. Finora l'unico modo di sapere che era uscita una versione
//     era andare a guardare il magazzino, o lanciare un comando. Chi usa
//     iStudio non lo fa, quindi non lo sapeva: restava sulla versione vecchia
//     senza motivo, e per settimane. C'è già un cartello per «questa PAGINA è
//     vecchia rispetto al server acceso»; mancava quello per «questo
//     COMPUTER è vecchio rispetto a quello che è stato pubblicato».
//
//  Solo sulle copie dei clienti: il file «aggiornamenti-di-questo-mac.txt» dice
//  da quale deposito si aggiorna, e sul Mac di chi sviluppa non c'è.
function depositoAggiornamenti() {
  try {
    return fs.readFileSync(path.join(__dirname, 'aggiornamenti-di-questo-mac.txt'), 'utf8').trim() || null;
  } catch { return null; }
}

// Numerico campo per campo, come negli aggiornatori: «.56» di ieri è più
// vecchio di «.1» di oggi, e un confronto testuale direbbe il contrario.
function versionePiuRecente(a, b) {
  if (!a || !b || a === b) return false;
  const pezzi = (v) => String(v).split('.').map((n) => Number(n) || 0);
  const x = pezzi(a), y = pezzi(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  }
  return false;
}

// Quando arriverà da sola, senza che nessuno faccia niente. Sono i due momenti
// veri: «Avvia iStudio» sul Mac, il crontab delle 5 sul mini-PC.
const QUANDO_ARRIVA = process.platform === 'darwin'
  ? 'Si installa da sola al prossimo avvio di iStudio.'
  : 'Si installa da sola stanotte alle 5, a locale chiuso.';

let versionePubblicata = null;   // l'ultima vista nel magazzino, o null

async function guardaSeCePiuNuova() {
  const deposito = depositoAggiornamenti();
  if (!deposito) return;
  try {
    const r = await fetch(`https://raw.githubusercontent.com/${deposito}/main/VERSIONE.txt`, {
      headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return;
    const trovata = (await r.text()).trim();
    if (/^\d+(\.\d+){3}$/.test(trovata)) versionePubblicata = trovata;
  } catch {
    // Nessuna rete, GitHub giù: si tiene quello che si sapeva e non si disturba
    // nessuno. Un cartello mancante non ha mai rotto niente.
  }
}

// Cosa dire alla pagina: niente, se non c'è niente da dire.
function aggiornamentoDisponibile() {
  const qui = versioneInstallata();
  if (!versionePubblicata || !versionePiuRecente(versionePubblicata, qui)) return null;
  return { versione: versionePubblicata, quando: QUANDO_ARRIVA };
}

// Numero WhatsApp a cui il cliente scrive per rinnovare. Sta in un file perché possa
// cambiare senza toccare il programma; se manca, la schermata mostra un testo semplice
// invece del collegamento. Sul Mac di chi sviluppa non c'è: non deve scrivere a se stesso.
function numeroAssistenza() {
  try {
    const n = fs.readFileSync(path.join(__dirname, 'assistenza-whatsapp.txt'), 'utf8').replace(/\D/g, '');
    return n || null;
  } catch { return null; }
}

// Indirizzo email dell'assistenza, e da qui in poi la via principale per chiedere
// l'attivazione. **Ha la precedenza sul numero WhatsApp**, e non è un dettaglio:
// l'aggiornamento non cancella i file spariti dal pacchetto, quindi sui clienti già
// installati «assistenza-whatsapp.txt» resta lì per sempre. Senza una precedenza
// esplicita continuerebbero a scrivere su WhatsApp per sempre.
function emailAssistenza() {
  try {
    const e = fs.readFileSync(path.join(__dirname, 'assistenza-email.txt'), 'utf8').trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
  } catch { return null; }
}

// Alfabeto senza caratteri che si confondono a voce o a occhio: niente 0/O, 1/I/L.
// Il codice va letto al telefono, e «zero o lettera O?» è la domanda da evitare.
const ALFABETO_CODICE = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

function codiceInstallazione() {
  let codice = getSetting('abbonamento_codice');
  if (codice) return codice;
  const gruppo = () => Array.from(crypto.randomBytes(4))
    .map((b) => ALFABETO_CODICE[b % ALFABETO_CODICE.length]).join('');
  codice = `IST-${gruppo()}-${gruppo()}`;
  setSetting('abbonamento_codice', codice);
  return codice;
}

// Verifica un seriale: firma valida, intestato a QUESTA installazione, non scaduto.
// Restituisce sempre un oggetto con un motivo in italiano, così la schermata può
// spiegare cosa non va invece di dire soltanto «non valido».
function verificaSeriale(seriale) {
  const pulito = String(seriale || '').trim().replace(/\s+/g, '');
  if (!pulito) return { ok: false, motivo: 'Non hai inserito nessun seriale.' };

  let chiavePubblica;
  try {
    chiavePubblica = crypto.createPublicKey(
      fs.readFileSync(path.join(__dirname, 'chiave-seriali-pubblica.pem'))
    );
  } catch {
    return { ok: false, motivo: 'Manca la chiave di verifica: avvisa chi ti ha dato iStudio.' };
  }

  const punto = pulito.lastIndexOf('.');
  if (punto < 1) return { ok: false, motivo: 'Il seriale sembra incompleto: ricopialo tutto.' };
  let payload, firma;
  try {
    payload = Buffer.from(pulito.slice(0, punto), 'base64url').toString('utf8');
    firma = Buffer.from(pulito.slice(punto + 1), 'base64url');
  } catch {
    return { ok: false, motivo: 'Il seriale contiene caratteri strani: ricopialo tutto.' };
  }

  let valido = false;
  try { valido = crypto.verify(null, Buffer.from(payload), chiavePubblica, firma); } catch { valido = false; }
  if (!valido) return { ok: false, motivo: 'Questo seriale non è valido.' };

  // Il terzo campo, se c'è, elenca le funzioni comprese (es. «bot»).
  // Sta IN FONDO di proposito: le installazioni non ancora aggiornate leggono
  // solo i primi due pezzi e ignorano questo, quindi un seriale nuovo continua
  // a funzionare anche su una copia vecchia. Messo prima della data,
  // romperebbe ogni installazione non aggiornata.
  const [codice, scadenza, funzioniGrezze] = payload.split('|');
  const funzioni = String(funzioniGrezze || '').split(',').map((f) => f.trim().toLowerCase()).filter(Boolean);
  if (codice !== codiceInstallazione()) {
    return { ok: false, motivo: 'Questo seriale è di un\'altra installazione: chiedine uno per il tuo codice.' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(scadenza || '')) {
    return { ok: false, motivo: 'Il seriale è malformato.' };
  }
  // Data LOCALE come ovunque nel progetto: con l'ora UTC il giorno cambierebbe di notte.
  const oggi = new Date().toLocaleDateString('sv-SE');
  if (scadenza < oggi) {
    return { ok: false, scaduto: true, scadenza, motivo: `Questo seriale è scaduto il ${scadenza.split('-').reverse().join('/')}.` };
  }
  return { ok: true, scadenza, funzioni };
}

const abbonamento = { valido: false, scadenza: null, giorniRimasti: null, funzioni: [] };

function ricalcolaAbbonamento() {
  if (!modalitaAbbonamento) { abbonamento.valido = true; return; }
  const esito = verificaSeriale(getSetting('abbonamento_seriale'));
  abbonamento.valido = esito.ok;
  abbonamento.funzioni = esito.funzioni || [];
  abbonamento.scadenza = esito.scadenza || null;
  abbonamento.giorniRimasti = esito.ok
    ? Math.round((new Date(esito.scadenza + 'T23:59:59') - Date.now()) / 86400000)
    : null;
  return esito;
}

if (modalitaAbbonamento) {
  ricalcolaAbbonamento();
  console.log(`Abbonamento: installazione ${codiceInstallazione()}, ` +
    (abbonamento.valido ? `attivo fino al ${abbonamento.scadenza}` : 'da attivare'));
  // Il seriale scade a una data, quindi basta ricontrollare al cambio di giorno.
  // Stesso schema di controllaRiprese(): un giro al minuto, azione solo se cambia la data.
  let giornoAbbonamento = new Date().toLocaleDateString('sv-SE');
  setInterval(() => {
    const oggi = new Date().toLocaleDateString('sv-SE');
    if (oggi === giornoAbbonamento) return;
    giornoAbbonamento = oggi;
    ricalcolaAbbonamento();
  }, 60 * 1000);
}

// Pagina mostrata finché l'abbonamento non è attivo. Serve a due situazioni — mai
// attivato e scaduto — e la differenza la scopre il browser da /api/abbonamento/stato.
const abbonamentoPage = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>iStudio — Attivazione</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='26'>%F0%9F%92%AC</text></svg>">
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}
.box{background:#fff;border:1px solid #e0e4e8;border-radius:14px;padding:34px;width:440px;max-width:100%}
h1{font-size:1.3rem;color:#128c7e;margin:0 0 6px;text-align:center}
p{color:#667781;font-size:.92rem;margin:0 0 16px;line-height:1.6}
.codice{background:#f0f2f5;border:2px dashed #c9d1d8;border-radius:10px;padding:18px;text-align:center;margin:18px 0}
.codice b{display:block;font-size:1.7rem;letter-spacing:2px;color:#111b21;font-family:ui-monospace,Menlo,monospace}
.codice span{font-size:.8rem;color:#667781}
textarea{width:100%;padding:11px;border:1px solid #e0e4e8;border-radius:8px;font-size:.85rem;box-sizing:border-box;font-family:ui-monospace,Menlo,monospace;resize:vertical;min-height:78px}
button{width:100%;padding:12px;background:#128c7e;color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer;font-family:inherit;margin-top:10px}
button:hover{background:#128c7e}button:disabled{background:#a8d5bd;cursor:default}
.err{color:#ea4335;font-size:.87rem;min-height:1.2em;margin-top:10px;text-align:center}
.ok{color:#1c7c4b;font-size:.95rem;text-align:center;line-height:1.6}
.avviso{background:#fff8e6;border:1px solid #f0c36d;border-radius:10px;padding:12px;font-size:.87rem;color:#7a5b12;margin-bottom:16px}
.versione{text-align:center;color:#8696a0;font-size:.75rem;margin-top:18px;letter-spacing:.3px}
.scelta{display:flex;gap:8px;align-items:center;margin-bottom:4px}
.scelta select{flex:0 0 auto;padding:11px;border:1px solid #e0e4e8;border-radius:8px;font-size:.95rem;font-family:inherit;background:#fff}
.scelta button{margin-top:0;flex:1}
.oppure{text-align:center;color:#8696a0;font-size:.8rem;margin:20px 0 14px;position:relative}
.oppure::before,.oppure::after{content:'';position:absolute;top:50%;width:36%;height:1px;background:#e0e4e8}
.oppure::before{left:0}.oppure::after{right:0}
</style></head>
<body><div class="box">
<h1>iStudio</h1>
<div id="corpo"><p style="text-align:center">Un attimo…</p></div>
<div class="versione" id="versione"></div>
</div>
<script>
const corpo = document.getElementById('corpo');
async function mostra() {
  const s = await (await fetch('/api/abbonamento/stato')).json();
  if (s.valido) { location.reload(); return; }
  const scaduto = Boolean(s.scadenza);
  // Con il numero dell'assistenza il codice non va dettato né ricopiato: parte dentro
  // il messaggio. È il passaggio in cui si sbaglia — una lettera storta e il seriale
  // non vale. Senza quel numero resta la richiesta a voce, come prima.
  const contatto = s.assistenzaEmail || s.assistenza;
  const richiesta = contatto
    ? '<div class="scelta">' +
      '<select id="mesi"><option value="1">1 mese</option><option value="3">3 mesi</option>' +
      '<option value="6">6 mesi</option><option value="12" selected>12 mesi</option></select>' +
      '<button id="btn-chiedi">' + (scaduto ? 'Richiedi il rinnovo' : 'Richiedi attivazione') + '</button>' +
      '</div><p style="font-size:.83rem;margin:6px 0 0">' +
      (s.assistenzaEmail
        ? 'Si apre l\\'email già scritta, con dentro tutto: devi solo inviarla.'
        : 'Si apre WhatsApp con il messaggio già pronto, codice compreso: devi solo premere invio.') +
      '</p><div class="oppure">poi, quando ricevi il seriale</div>'
    : '<p>Comunica questo codice a chi ti ha fornito iStudio, poi incolla qui sotto il seriale che ricevi:</p>';
  corpo.innerHTML =
    (scaduto ? '<div class="avviso">Il tuo abbonamento è scaduto il <b>' +
       s.scadenza.split('-').reverse().join('/') + '</b>. I tuoi contatti e la cronologia sono al sicuro: ' +
       'appena inserisci il seriale nuovo trovi tutto come lo avevi lasciato.</div>' : '') +
    '<p>Per ' + (scaduto ? 'riattivare' : 'attivare') + ' iStudio serve un <b>seriale</b>.</p>' +
    '<div class="codice"><b>' + s.codice + '</b><span>il tuo codice installazione</span></div>' +
    richiesta +
    '<textarea id="ser" placeholder="Incolla qui il seriale"></textarea>' +
    '<button id="btn">Attiva iStudio</button><div class="err" id="err"></div>';
  document.getElementById('btn').addEventListener('click', attiva);
  const bc = document.getElementById('btn-chiedi');
  if (bc) bc.addEventListener('click', () => {
    const m = Number(document.getElementById('mesi').value || 12);
    // L'email deve bastare da sola: chi la riceve emette il seriale senza dover
    // chiedere altro. Il codice installazione è il dato indispensabile — il seriale
    // viene firmato SU QUEL CODICE e non funziona altrove — quindi va scritto dal
    // programma, mai ricopiato a mano: una lettera storta e il seriale è inservibile.
    const righe = ['Ciao! Vorrei ' + (scaduto ? 'rinnovare' : 'attivare') + ' iStudio.', '',
      'Durata richiesta: ' + (m === 1 ? '1 mese' : m + ' mesi'),
      'Codice installazione: ' + s.codice];
    if (s.scadenza) righe.push('Scaduto il: ' + s.scadenza.split('-').reverse().join('/'));
    if (s.versione) righe.push('Versione installata: ' + s.versione);
    righe.push('', 'Grazie!');
    if (s.assistenzaEmail) {
      const ogg = (scaduto ? 'Rinnovo' : 'Attivazione') + ' iStudio — ' + s.codice;
      const testo = righe.join('\\n');
      // Si prova PRIMA la posta del computer: è la strada giusta e rispetta il programma
      // che l'utente ha scelto, qualunque sia. Ma «mailto:» può non fare NIENTE, in
      // silenzio e senza errori — succede quando il gestore delle email è il browser e
      // dentro non c'è nessuna webmail registrata. Capitato davvero il 7 agosto 2026 su
      // un Mac con Chrome come gestore e Mail mai configurata: il pulsante sembrava rotto.
      // Non esiste un modo pulito per sapere se «mailto:» ha funzionato. Il segnale
      // pratico è il fuoco: se si apre qualcosa, questa finestra lo perde. Se dopo un
      // secondo e mezzo siamo ancora qui, non si è aperto niente e si passa a Gmail sul
      // browser, che una finestra di composizione la apre di sicuro.
      let postaAperta = false;
      const perdutoIlFuoco = () => { postaAperta = true; };
      window.addEventListener('blur', perdutoIlFuoco, { once: true });
      location.href = 'mailto:' + s.assistenzaEmail +
        '?subject=' + encodeURIComponent(ogg) + '&body=' + encodeURIComponent(testo);
      setTimeout(() => {
        window.removeEventListener('blur', perdutoIlFuoco);
        // Si guarda SOLO se la finestra ha perso il fuoco, cioè se qualcosa si è
        // davvero aperto. Non si controlla anche document.hasFocus(): in caso di
        // dubbio quel controllo faceva uscire senza fare niente, che è precisamente
        // il guasto da riparare. Meglio sbagliare aprendo una scheda di troppo — si
        // chiude — che lasciare un pulsante muto, dove l'utente non sa cosa fare.
        if (postaAperta) return;
        window.open('https://mail.google.com/mail/?view=cm&fs=1' +
          '&to=' + encodeURIComponent(s.assistenzaEmail) +
          '&su=' + encodeURIComponent(ogg) +
          '&body=' + encodeURIComponent(testo), '_blank', 'noopener');
      }, 1500);
    } else {
      window.open('https://wa.me/' + s.assistenza + '?text=' + encodeURIComponent(righe.join('\\n')),
                  '_blank', 'noopener');
    }
  });
  if (s.versione) document.getElementById('versione').textContent = 'iStudio — versione ' + s.versione;
  document.getElementById('ser').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) attiva();
  });
}
async function attiva() {
  const btn = document.getElementById('btn'), err = document.getElementById('err');
  err.textContent = ''; btn.disabled = true; btn.textContent = 'Controllo…';
  try {
    const r = await fetch('/api/abbonamento/attiva', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seriale: document.getElementById('ser').value }),
    });
    const d = await r.json();
    if (r.ok) {
      corpo.innerHTML = '<p class="ok">✅ iStudio è attiva fino al <b>' +
        d.scadenza.split('-').reverse().join('/') + '</b>.<br>Sto aprendo la piattaforma…</p>';
      setTimeout(() => location.reload(), 1600);
      return;
    }
    err.textContent = d.error || 'Seriale non valido';
  } catch { err.textContent = 'Qualcosa non ha funzionato, riprova.'; }
  btn.disabled = false; btn.textContent = 'Attiva iStudio';
}
mostra();
</script></body></html>`;

// ---------- Autenticazione (attiva solo se ISTUDIO_PASSWORD è impostata) ----------
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 giorni

// ------------------------------------------------------------------
//  Le sessioni, che devono sopravvivere a un riavvio
// ------------------------------------------------------------------
//  ⚠️ Stavano solo in una Map, mentre il biscotto prometteva trenta giorni. Un
//  aggiornamento riavvia sempre iStudio, quindi ogni aggiornamento buttava
//  fuori tutti — e il tablet della sala non se ne accorgeva nemmeno: le sue
//  richieste tornavano 401, la pagina le ingoiava in silenzio e continuava a
//  mostrare l'elenco di prima. Fermo. Senza dirlo a nessuno.
//  La Map resta come cassetto veloce; la verità sta nell'archivio.
const sessions = new Map();          // piattaforma: token -> scadenza
const sessioniSala = new Map();      // sala:        token -> scadenza

function ricordaSessione(dove, token, scadenza) {
  (dove === 'sala' ? sessioniSala : sessions).set(token, scadenza);
  try {
    db.prepare('INSERT INTO sessioni (token, dove, scade_at, versione) VALUES (?, ?, ?, ?) '
      + 'ON CONFLICT(token) DO UPDATE SET scade_at = excluded.scade_at, versione = excluded.versione')
      .run(token, dove, scadenza, versioneInstallata());
  } catch {}
}

function scordaSessione(dove, token) {
  (dove === 'sala' ? sessioniSala : sessions).delete(token);
  try { db.prepare('DELETE FROM sessioni WHERE token = ?').run(token); } catch {}
}

// All'accensione si rilegge chi era già entrato, e si butta via:
//  - chi è scaduto — sennò in tre anni la tabella diventa un elenco di token morti;
//  - chi era entrato con una VERSIONE DIVERSA da quella che sta partendo adesso.
//
// ⚠️ La seconda regola è voluta, ed è una scelta: **a ogni aggiornamento si
// esce, e si rientra sulla versione nuova.** Un riavvio qualunque (corrente
// che salta, macchina riavviata, servizio ripartito) non butta fuori nessuno,
// perché il numero di versione è lo stesso; un aggiornamento sì, perché quel
// numero cambia. Così nessuno può restare su una pagina vecchia senza
// accorgersene: la sessione non c'è più, e l'unico modo di andare avanti è
// ricaricare — che è esattamente quello che serve.
//
// Il prezzo, dichiarato: la mattina dopo un aggiornamento notturno il tablet
// della sala e la piattaforma chiedono di nuovo la password. La pagina della
// sala non lo fa di soppiatto — lo scrive, e torna al cancello solo quando non
// sta portando via niente a nessuno (vedi «sessioneFinita» in public-sala).
const VERSIONE_DI_ADESSO = versioneInstallata();
try {
  db.prepare('DELETE FROM sessioni WHERE scade_at < ?').run(Date.now());
  db.prepare('DELETE FROM sessioni WHERE versione IS NULL OR versione <> ?').run(VERSIONE_DI_ADESSO);
  for (const r of db.prepare('SELECT token, dove, scade_at FROM sessioni').all()) {
    (r.dove === 'sala' ? sessioniSala : sessions).set(r.token, Number(r.scade_at));
  }
} catch {}

function getSessionToken(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/(?:^|;\s*)istudio_session=([a-f0-9]+)/);
  return match ? match[1] : null;
}

function isAuthed(req) {
  if (!APP_PASSWORD) return true;
  const token = getSessionToken(req);
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry || expiry < Date.now()) { scordaSessione('piattaforma', token); return false; }
  return true;
}

const loginPage = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>iStudio — Accesso</title>\n<link rel="icon" href="/icona.svg" type="image/svg+xml">
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#fff;border:1px solid #e0e4e8;border-radius:14px;padding:34px;width:320px;text-align:center}
h1{font-size:1.3rem;color:#128c7e;margin:0 0 6px}p{color:#667781;font-size:.9rem;margin:0 0 18px}
input{width:100%;padding:11px;border:1px solid #e0e4e8;border-radius:8px;font-size:1rem;box-sizing:border-box;margin-bottom:12px}
button{width:100%;padding:11px;background:#128c7e;color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer}
button:hover{background:#128c7e}.err{color:#ea4335;font-size:.85rem;min-height:1.2em;margin-top:10px}</style></head>
<body><form class="box" id="f"><h1>iStudio</h1><p>Inserisci la password per accedere</p>
<input type="password" id="p" placeholder="Password" autofocus>
<button type="submit">Entra</button><div class="err" id="e"></div></form>
<script>document.getElementById('f').addEventListener('submit',async(ev)=>{ev.preventDefault();
const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('p').value})});
if(r.ok){location.reload();return;}let d={};try{d=await r.json();}catch{}document.getElementById('e').textContent=d.error||'Password errata';});</script></body></html>`;

// ---------- API ----------
const app = express();
app.use(express.json({ limit: '25mb' })); // limite alto per le immagini allegate

// ===== Abbonamento a seriale: nessun server da contattare, tutto in locale =====
if (modalitaAbbonamento) {
  // Queste due restano SEMPRE aperte, anche a iStudio bloccata: sono l'unico modo
  // che il cliente ha per attivarsi.
  app.get('/api/abbonamento/stato', (req, res) => {
    res.json({
      codice: codiceInstallazione(),
      valido: abbonamento.valido,
      scadenza: abbonamento.scadenza,
      giorniRimasti: abbonamento.giorniRimasti,
      // Cosa comprende: il cliente lo deve poter leggere, e l'amministratore al
      // telefono deve poterglielo far leggere — «hai il bot?» non deve
      // richiedere di aprire il seriale.
      funzioni: abbonamento.funzioni,
      assistenza: numeroAssistenza(),
      assistenzaEmail: emailAssistenza(),
      versione: versioneInstallata(),
    });
  });

  app.post('/api/abbonamento/attiva', (req, res) => {
    const esito = verificaSeriale(req.body && req.body.seriale);
    if (!esito.ok) return res.status(400).json({ error: esito.motivo });
    setSetting('abbonamento_seriale', String(req.body.seriale).trim().replace(/\s+/g, ''));
    ricalcolaAbbonamento();
    console.log(`Abbonamento attivato fino al ${abbonamento.scadenza}`);
    res.json({ ok: true, scadenza: abbonamento.scadenza });
  });

  // Il cancello. Sotto sta la pagina dove si incolla il seriale.
  app.use((req, res, next) => {
    if (req.path.startsWith('/api/abbonamento/')) return next();
    if (abbonamento.valido) return next();
    if (req.path.startsWith('/api/')) {
      return res.status(403).json({ error: 'Abbonamento non attivo', abbonamento: false });
    }
    res.send(abbonamentoPage);
  });
}


// ⚠️ L'icona sta PRIMA del controllo della password: dopo, il browser che la
// chiede si vedrebbe rispondere con l'HTML della pagina d'accesso, e nella
// scheda resterebbe il quadratino vuoto proprio quando si sta entrando.
// Non è un dato riservato: è il logo.
app.get('/icona.svg', (req, res) => res.sendFile(path.join(__dirname, 'public', 'comune', 'icona.svg')));

app.post('/api/login', (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true });
  const tentativo = Buffer.from(String(req.body.password || '').trim());
  const attesa = Buffer.from(String(APP_PASSWORD).trim());
  const valida = tentativo.length === attesa.length && crypto.timingSafeEqual(tentativo, attesa);
  if (!valida) return res.status(401).json({ error: 'Password errata' });
  const token = crypto.randomBytes(32).toString('hex');
  ricordaSessione('piattaforma', token, Date.now() + SESSION_TTL);
  res.setHeader('Set-Cookie',
    `istudio_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}`);
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Accesso non autorizzato' });
  res.send(loginPage);
});

// ⚠️ La pagina non si mette in cache, e porta dentro la versione con cui è
// stata servita.
//
// Il guasto visto: dopo un aggiornamento il browser continuava a usare la
// pagina vecchia contro il server nuovo. Il risultato era un «undefined» in
// mezzo ai conti — e il piede della pagina, che la versione la chiede al
// SERVER, mostrava tranquillamente quella nuova. Cioè la pagina diceva di
// essere aggiornata mentre non lo era: il modo migliore per far cercare il
// guasto dalla parte sbagliata.
//
// Il caso peggiore non è nemmeno il browser: è il tablet della sala, con la
// pagina aperta da martedì. Lì non c'è nessun ricaricamento che la salvi, e
// serve che sia la pagina ad accorgersene e a dirlo.
const paginePronte = new Map();
function paginaConVersione(percorso) {
  const versione = versioneInstallata() || 'ignota';
  const chiave = `${percorso}@${versione}`;
  if (!paginePronte.has(chiave)) {
    // Una volta per versione: il file non cambia sotto i piedi, l'aggiornamento
    // riavvia il programma.
    paginePronte.set(chiave, fs.readFileSync(percorso, 'utf8').split('__VERSIONE__').join(versione));
  }
  return paginePronte.get(chiave);
}

function serviPagina(percorso) {
  return (req, res) => {
    // `no-cache` e non `no-store`: il browser può tenersela, ma deve chiedere
    // ogni volta se è cambiata. Costa un 304 e vale un aggiornamento che arriva.
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    res.type('html').send(paginaConVersione(percorso));
  };
}

for (const via of ['/', '/index.html']) {
  app.get(via, serviPagina(path.join(__dirname, 'public', 'index.html')));
}

// Gli stessi file condivisi dalle due pagine: se restano in cache mentre la
// pagina è nuova, si ottiene la stessa mescolanza al contrario.
app.use('/comune', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
//  Il guardiano del collegamento
// ---------------------------------------------------------------------------
//  ⚠️ NON si aggancia all'evento «disconnected», e il motivo sta scritto più
//  su, a proposito degli invii: in un registro vero c'erano 65 errori di pagina
//  staccata e NEMMENO UNA riga «WhatsApp disconnesso». Quell'evento non scatta
//  quasi mai. Qui si guarda `state.status`, che è l'unico posto dove tutte e
//  quattro le strade — l'evento, l'errore durante un invio, il logout, il
//  ripristino — vanno a finire. Un guardiano solo, e nessuna strada nuova che
//  domani si dimentica di avvisare.
//
//  L'email va bene proprio perché WhatsApp è giù: la posta non c'entra niente
//  col telefono, e resta l'unica via che funziona quando l'altra è caduta.
let eraCollegato = null;          // null = non si è ancora visto niente
let acceso = Date.now();
let dettoCheNonParte = false;

async function avvisaCollegamento(oggetto, testo) {
  const dove = indirizzoAvvisi();
  if (!dove) return false;
  const transporter = buildTransporter();
  if (!transporter) {
    // ⚠️ Un avviso che non parte perché la posta non è configurata va DETTO,
    // una volta: sennò si resta convinti di essere protetti da una rete che
    // non c'è. È lo stesso errore dei promemoria che tacevano.
    if (!dettoCheNonParte) {
      dettoCheNonParte = true;
      console.error('Avvisi: WhatsApp è cambiato di stato ma la posta non è configurata: nessuna email è partita.');
      annota('errore', 'avviso via email non partito: la posta non è configurata');
    }
    return false;
  }
  try {
    await transporter.sendMail({
      from: getSetting('smtp_user'),
      to: dove,
      subject: oggetto,
      text: testo,
    });
    return true;
  } catch (e) {
    console.error('Avvisi: email non riuscita:', e.message);
    return false;
  }
}

// Ogni minuto. Manda un'email SOLO quando lo stato CAMBIA: una ogni caduta,
// non una al minuto finché dura — sennò diventa il rumore che si smette di
// leggere, che è il guasto che si voleva curare.
async function guardaIlCollegamento() {
  if (!botDisponibile()) return;
  const collegato = state.status === 'connesso';
  const quando = new Date().toLocaleString('it-IT');
  const chi = bot.leggi(db, 'bot_locale') || getSetting('smtp_from_name') || 'iStudio';

  if (eraCollegato === null) {
    // ⚠️ All'accensione non si grida: WhatsApp parte sempre «in
    // inizializzazione», e un'email a ogni riavvio (che è a ogni aggiornamento)
    // si smette di leggere in tre giorni. Ma se dopo dieci minuti non è ancora
    // collegato, quello NON è l'avvio: è un mini-PC ripartito e rimasto a
    // metà, ed è il caso silenzioso che costa una serata.
    if (collegato) { eraCollegato = true; return; }
    if (Date.now() - acceso < 10 * 60 * 1000) return;
    eraCollegato = false;
    await avvisaCollegamento(`⚠️ ${chi}: WhatsApp non si è collegato`,
      `Il programma è ripartito ${new Date(acceso).toLocaleString('it-IT')} e dopo dieci minuti `
      + `WhatsApp non risulta ancora collegato (stato: ${state.status}).\n\n`
      + 'Finché resta così il bot non risponde ai clienti, non partono i promemoria e gli invii restano fermi.\n\n'
      + 'Si riattacca dalla Dashboard di iStudio, scansionando il QR code.');
    return;
  }

  if (eraCollegato && !collegato) {
    eraCollegato = false;
    annota('errore', `WhatsApp si è scollegato (stato: ${state.status})`);
    await avvisaCollegamento(`⚠️ ${chi}: WhatsApp si è scollegato`,
      `WhatsApp si è scollegato il ${quando} (stato: ${state.status}).\n\n`
      + 'Finché resta così il bot non risponde ai clienti, non partono i promemoria e gli invii restano fermi.\n\n'
      + 'Si riattacca dalla Dashboard di iStudio, scansionando il QR code.');
    return;
  }

  if (!eraCollegato && collegato) {
    eraCollegato = true;
    annota('collegato', 'WhatsApp è tornato collegato');
    await avvisaCollegamento(`✅ ${chi}: WhatsApp è tornato collegato`,
      `WhatsApp è di nuovo collegato dal ${quando}. Il bot ha ripreso a rispondere.`);
  }
}

// ⚠️ Il giro si registra insieme agli altri, molto più in basso: qui
// «botDisponibile» non esiste ancora (è una const definita dopo), e iStudio
// partiva senza il guardiano — restando muta proprio quando serviva.

// ---------------------------------------------------------------------------
//  Collegarsi col NUMERO invece che col QR
// ---------------------------------------------------------------------------
//  ⚠️ Serve a un caso solo, ma vero: un telefono con la fotocamera rotta. Il
//  QR non può inquadrarlo in nessun modo, e finora quella copia restava
//  scollegata e basta. Normalmente non si usa: la strada è il QR.
//
//  Come funziona per chi la usa: si scrive il numero del ristorante, WhatsApp
//  manda una notifica a quel telefono e dà otto lettere da battere in
//  «Dispositivi collegati → Collega con numero di telefono».
//
//  ⚠️ Vale ESATTAMENTE quanto il QR: chi ottiene quel codice collega il
//  proprio telefono come bot del locale. Stessi paletti, non di meno.
function codiceDiCollegamento() {
  return { codice: state.codice, numero: state.codiceNumero, stato: state.status };
}

async function chiediCodiceCollegamento(numeroGrezzo, chi) {
  if (!botDisponibile()) return { ok: false, error: 'Il motore del bot non è caricato.' };
  // ⚠️ A WhatsApp già collegato NON si chiede niente: non servirebbe, e
  //    sarebbe solo un modo di staccare per sbaglio una linea che funziona.
  if (state.status === 'connesso') {
    return { ok: false, error: 'WhatsApp è già collegato: non serve nessun codice.' };
  }
  // ⚠️ E nemmeno durante l'avvio: la pagina di WhatsApp non è ancora in piedi,
  //    e la richiesta morirebbe con un errore che non vuol dire niente a chi lo legge.
  if (state.status === 'inizializzazione') {
    return { ok: false, error: 'WhatsApp si sta ancora avviando: riprova fra qualche secondo.' };
  }
  const numero = normalizePhone(numeroGrezzo);
  // WhatsApp vuole il numero internazionale, sole cifre. Sotto le otto cifre
  // non è un numero: è un errore di battitura, e vale la pena dirlo subito.
  if (!/^\d{8,15}$/.test(numero)) {
    return { ok: false, error: 'Numero non valido. Scrivilo col prefisso del Paese, per esempio +39 340 1234567.' };
  }
  try {
    state.codiceNumero = numero;
    state.codice = null;
    const codice = await client.requestPairingCode(numero, true);
    // La libreria lo torna subito; l'evento «code» lo rinfresca ogni tre minuti.
    if (codice) state.codice = String(codice);
    annota('collegamento', `chiesto il codice di collegamento per +${numero}${chi ? ' (' + chi + ')' : ''}`);
    return { ok: true, codice: state.codice, numero };
  } catch (e) {
    state.codice = null;
    state.codiceNumero = null;
    console.error('Codice di collegamento non riuscito:', e.message);
    return { ok: false, error: 'WhatsApp non ha dato il codice: ' + e.message };
  }
}

async function annullaCodiceCollegamento() {
  state.codice = null;
  state.codiceNumero = null;
  // ⚠️ Torna al QR sul serio, non solo nella pagina: finché WhatsApp resta in
  //    modo «codice» il QR non si rigenera, e chi chiude la finestra si
  //    ritroverebbe un quadrato fermo che non funziona più.
  try {
    if (typeof client.cancelPairingCode === 'function') await client.cancelPairingCode();
    return { ok: true };
  } catch (e) {
    console.error('Annullamento del codice non riuscito:', e.message);
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
//  Le notifiche
// ---------------------------------------------------------------------------
//  ⚠️ Non una tabella nuova: le cose da sapere ci sono GIÀ in archivio, sparse
//  in cinque posti diversi, e il guasto è che nessuno le guarda tutte insieme.
//  Un cliente che aspetta da un'ora sta in `bot_richieste`, una frase che il
//  bot non ha capito in `bot_non_capite`, un invio fallito in
//  `campaign_messages`: per accorgersene bisognava aprire tre schede e sapere
//  cosa cercare. Qui si contano, e basta.
//
//  Una tabella di notifiche sarebbe stata una seconda verità da tenere
//  allineata alla prima — e quando due verità divergono, quella che si guarda
//  è sempre la sbagliata.
function notifiche() {
  const lista = [];
  const adesso = new Date();
  const quandoDa = (t) => {
    if (!t) return '';
    const d = new Date(String(t).replace(' ', 'T'));
    if (Number.isNaN(d.getTime())) return '';
    const min = Math.round((adesso - d) / 60000);
    if (min < 60) return `${Math.max(1, min)} min fa`;
    const ore = Math.round(min / 60);
    if (ore < 24) return `${ore} ${ore === 1 ? 'ora' : 'ore'} fa`;
    const gg = Math.round(ore / 24);
    return `${gg} ${gg === 1 ? 'giorno' : 'giorni'} fa`;
  };

  // ⚠️ Per prima, sempre: se WhatsApp è staccato non funziona NIENTE — né il
  // bot, né i promemoria, né gli invii. Tutte le altre righe qui sotto sono
  // conseguenze di questa, e metterle allo stesso livello fa perdere tempo
  // dietro ai sintomi.
  if (botDisponibile() && state.status !== 'connesso') {
    lista.push({
      tipo: 'whatsapp', urgenza: 'alta', scheda: 'dashboard',
      titolo: 'WhatsApp non è collegato',
      dettaglio: state.status === 'qr'
        ? 'C\'è un QR code da scansionare: fino ad allora il bot non risponde a nessuno.'
        : 'Il bot non risponde ai clienti e non partono promemoria né invii.',
    });
  }

  if (botDisponibile()) {
    // Clienti che aspettano una risposta da una persona.
    const attese = db.prepare(
      "SELECT codice, nome, telefono, testo, avvisata_at, creata_at FROM bot_richieste "
      + "WHERE stato = 'in_attesa' ORDER BY id").all();
    for (const r of attese) {
      lista.push({
        tipo: 'attesa', urgenza: 'alta', scheda: 'prenotazioni',
        titolo: `${r.nome || r.telefono} aspetta una risposta`,
        dettaglio: `${r.codice} · «${String(r.testo || '').slice(0, 90)}»`,
        quando: quandoDa(r.creata_at),
      });
    }
    // Frasi che il bot non ha capito: ognuna è una risposta pronta che manca.
    const nonCapite = db.prepare(
      'SELECT testo, volte, ultima_at FROM bot_non_capite WHERE risolta = 0 ORDER BY volte DESC, id DESC LIMIT 20').all();
    for (const r of nonCapite) {
      lista.push({
        tipo: 'frase', urgenza: 'bassa', scheda: 'prenotazioni', sotto: 'frasi',
        titolo: `Non ho capito: «${String(r.testo || '').slice(0, 70)}»`,
        dettaglio: r.volte > 1
          ? `Chiesto ${r.volte} volte. Se ci metti una risposta pronta, il bot risponde da solo.`
          : 'Se ci metti una risposta pronta, il bot risponde da solo.',
        quando: quandoDa(r.ultima_at),
      });
    }
  }

  // Invii fermi o con messaggi non partiti. Si raggruppa per campagna: venti
  // righe uguali dicono la stessa cosa venti volte.
  const invii = db.prepare(
    // ⚠️ `created_at` degli invii è in UTC (le altre tabelle sono in ora
    // locale): senza convertirlo, un invio di adesso risultava fatto due ore fa.
    "SELECT c.id, c.message, c.subject, c.status, c.pause_reason, c.channel, "
    + "datetime(c.created_at, 'localtime') AS created_at, "
    + "(SELECT COUNT(*) FROM campaign_messages m WHERE m.campaign_id = c.id AND m.status = 'errore') AS falliti "
    // ⚠️ Nessun filtro sullo stato: gli stati sono sei e crescono
    // ('in_pausa', 'in_corso', 'in_riposo', 'completata'…). Un elenco scritto
    // qui invecchia in silenzio — è già successo con 'completato', che non
    // esiste. Si guarda quello che conta: in pausa, oppure con dei falliti.
    + "FROM campaigns c WHERE c.created_at >= datetime('now','-7 days') ORDER BY c.id DESC LIMIT 30").all();
  for (const c of invii) {
    const nome = String(c.subject || c.message || '').replace(/\s+/g, ' ').trim().slice(0, 60) || `invio ${c.id}`;
    if (c.status === 'in_pausa') {
      lista.push({
        tipo: 'invio', urgenza: 'alta', scheda: 'storico',
        titolo: `Invio in pausa: «${nome}»`,
        dettaglio: String(c.pause_reason || 'In pausa.').slice(0, 160),
        quando: quandoDa(c.created_at),
      });
    } else if (c.falliti) {
      lista.push({
        tipo: 'invio', urgenza: 'media', scheda: 'storico',
        titolo: `${c.falliti} ${c.falliti === 1 ? 'messaggio non partito' : 'messaggi non partiti'}: «${nome}»`,
        dettaglio: 'Dalla cronologia puoi riprovare solo quelli non riusciti.',
        quando: quandoDa(c.created_at),
      });
    }
  }

  // Chi ha chiesto di non ricevere più niente e nessuno ha ancora sistemato.
  const stop = db.prepare(
    "SELECT COUNT(*) n FROM optout_requests WHERE stato = 'da_confermare'").get().n;
  if (stop) {
    lista.push({
      tipo: 'stop', urgenza: 'media', scheda: 'anagrafiche',
      titolo: `${stop} ${stop === 1 ? 'persona ha chiesto' : 'persone hanno chiesto'} di non ricevere più messaggi`,
      dettaglio: 'Finché non li togli dagli invii continuano a ricevere.',
    });
  }

  const peso = { alta: 0, media: 1, bassa: 2 };
  lista.sort((a, b) => peso[a.urgenza] - peso[b.urgenza]);
  return lista;
}

app.get('/api/notifiche', (req, res) => {
  const lista = notifiche();
  res.json({ lista, quante: lista.length, urgenti: lista.filter((n) => n.urgenza === 'alta').length });
});

// Il codice di collegamento, dalla piattaforma.
app.post('/api/whatsapp/codice', async (req, res) => {
  const r = await chiediCodiceCollegamento(req.body && req.body.numero, 'piattaforma');
  res.status(r.ok ? 200 : 400).json(r);
});
app.post('/api/whatsapp/codice/annulla', async (req, res) => {
  res.json(await annullaCodiceCollegamento());
});

app.get('/api/status', (req, res) => {
  // L'abbonamento viaggia qui perché questa rotta è già interrogata di continuo:
  // così l'avviso di scadenza compare da qualunque scheda, non solo dalla Dashboard.
  // Sulle copie senza abbonamento il campo non c'è proprio e il frontend lo ignora.
  const abb = modalitaAbbonamento
    ? { scadenza: abbonamento.scadenza, giorniRimasti: abbonamento.giorniRimasti }
    : null;
  // La scritta accanto al nome, in alto a sinistra. Distingue a colpo d'occhio la copia
  // di lavoro dell'autore da quella venduta ai clienti: le due girano sullo stesso Mac
  // (3100 e 3200) e sono identiche a vedersi, quindi una conferma visiva evita di fare
  // una prova sulla copia sbagliata. Lo decide lo stesso file che accende l'abbonamento.
  const edizione = modalitaAbbonamento ? 'PRO' : 'MASTER';
  // Il tetto delle email viaggia di qui perché la pagina lo usa per la stima dei tempi.
  // Mandarlo invece di riscriverlo nel frontend evita di avere lo stesso numero in due
  // posti: è già successo col ritmo delle pause, e la stima aveva cominciato a mentire.
  res.json({ ...state, authEnabled: Boolean(APP_PASSWORD), abbonamento: abb, edizione,
             guscio: guscioNuovo(),
             tettoEmail: tettoEmailGiornaliero(), versione: versioneInstallata(),
             aggiornamento: aggiornamentoDisponibile(),
             // Il nome del locale, per l'intestazione: le copie di prova e quella
             // vera sono identiche a vedersi, e questa è l'unica riga che dice di
             // chi è la pagina che si ha davanti.
             locale: botDisponibile() ? String(bot.leggi(db, 'bot_locale') || '').trim() : '' });
});

// Uscita dalla piattaforma (chiude la sessione di accesso, solo con password attiva)
app.post('/api/app-logout', (req, res) => {
  const token = getSessionToken(req);
  // Anche dall'archivio, sennò «Esci» chiuderebbe la sessione solo fino al
  // prossimo riavvio e poi si rientrerebbe da soli.
  if (token) scordaSessione('piattaforma', token);
  res.setHeader('Set-Cookie', 'istudio_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.post('/api/logout', async (req, res) => {
  try {
    await client.logout();
    state.status = 'disconnesso';
    state.me = null;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ripristino forzato del collegamento WhatsApp («Ripristina collegamento» in Impostazioni).
// Serve quando il collegamento resta rotto e prima l'unica via d'uscita era spegnere e
// riaccendere iStudio — che però non bastava, perché non chiudeva il browser orfano.
// NON cancella la sessione salvata: se il collegamento è ancora buono si riprende senza QR;
// se non lo è, ricompare il QR. Per scollegarsi davvero c'è «Scollega WhatsApp».
app.post('/api/whatsapp/ripristina', async (req, res) => {
  const esito = await ripristinaWhatsApp('richiesto dalle Impostazioni');
  if (esito.ok) res.json({ ok: true });
  else res.status(409).json({ error: esito.error });
});

// Anagrafiche
app.get('/api/contacts', (req, res) => {
  const rows = db.prepare('SELECT * FROM contacts ORDER BY nome COLLATE NOCASE, cognome COLLATE NOCASE').all();
  res.json(rows);
});

// Gli omonimi sono ammessi, ma telefono ed email devono essere unici.
// `escludiId` serve in modifica, per non confrontare la scheda con se stessa.
function trovaDuplicato(telefono, email, escludiId) {
  const tuttiContatti = db.prepare('SELECT * FROM contacts').all();
  const telNuovo = normalizePhone(telefono);
  const mailNuova = (email || '').trim().toLowerCase();

  for (const c of tuttiContatti) {
    if (escludiId && String(c.id) === String(escludiId)) continue;
    if (telNuovo && normalizePhone(c.telefono) === telNuovo) {
      return { campo: 'telefono', contatto: c };
    }
    if (mailNuova && (c.email || '').trim().toLowerCase() === mailNuova) {
      return { campo: 'email', contatto: c };
    }
  }
  return null;
}

function messaggioDuplicato(dup) {
  const nomeCompleto = `${dup.contatto.nome} ${dup.contatto.cognome}`.trim();
  return dup.campo === 'telefono'
    ? `Questo numero di telefono è già in rubrica, intestato a ${nomeCompleto}.`
    : `Questo indirizzo email è già in rubrica, intestato a ${nomeCompleto}.`;
}

// Consenso a due stati: 'no' solo se scritto esplicitamente, altrimenti 'si'.
// Il consenso è la STESSA cosa del «non contattare»: consenso 'no' = opt_out.
function consensoNegato(v) {
  return /^(no|n|0|false)$/i.test(String(v || '').trim());
}

app.post('/api/contacts', (req, res) => {
  const { nome, cognome, email, telefono } = req.body;
  if (!nome || !telefono) {
    return res.status(400).json({ error: 'Nome e telefono sono obbligatori' });
  }
  const dup = trovaDuplicato(telefono, email, null);
  if (dup) return res.status(409).json({ error: messaggioDuplicato(dup), duplicato: dup.campo });

  const negato = consensoNegato(req.body.consenso); // di base il consenso c'è
  const info = db
    .prepare('INSERT INTO contacts (nome, cognome, email, telefono, opt_out, opt_out_at, opt_out_motivo) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(nome.trim(), (cognome || '').trim(), (email || '').trim(), numeroInRubrica(telefono),
      negato ? 1 : 0, negato ? new Date().toISOString() : null, negato ? 'Consenso: No' : null);
  res.json(db.prepare('SELECT * FROM contacts WHERE id = ?').get(info.lastInsertRowid));
});

app.put('/api/contacts/:id', (req, res) => {
  const { nome, cognome, email, telefono } = req.body;
  if (!nome || !telefono) {
    return res.status(400).json({ error: 'Nome e telefono sono obbligatori' });
  }
  const dup = trovaDuplicato(telefono, email, req.params.id);
  if (dup) return res.status(409).json({ error: messaggioDuplicato(dup), duplicato: dup.campo });

  const prima = db.prepare('SELECT opt_out, opt_out_at, opt_out_motivo FROM contacts WHERE id = ?').get(req.params.id) || {};
  const negato = consensoNegato(req.body.consenso);
  // se era già escluso (es. per una richiesta STOP) e resta "No", si conserva motivo e data
  const opt_out_at = negato ? (prima.opt_out ? prima.opt_out_at : new Date().toISOString()) : null;
  const opt_out_motivo = negato ? (prima.opt_out && prima.opt_out_motivo ? prima.opt_out_motivo : 'Consenso: No') : null;
  db.prepare('UPDATE contacts SET nome = ?, cognome = ?, email = ?, telefono = ?, opt_out = ?, opt_out_at = ?, opt_out_motivo = ? WHERE id = ?').run(
    nome.trim(), (cognome || '').trim(), (email || '').trim(), numeroInRubrica(telefono),
    negato ? 1 : 0, opt_out_at, opt_out_motivo, req.params.id
  );
  res.json(db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id));
});

// «Non contattare»: si contrassegna il contatto invece di cancellarlo, perché
// cancellarlo lo farebbe rientrare alla prima importazione CSV. Il segno deve restare.
app.post('/api/contacts/:id/opt-out', (req, res) => {
  const contatto = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id);
  if (!contatto) return res.status(404).json({ error: 'Contatto non trovato' });
  const attivo = Boolean(req.body && req.body.attivo);
  const motivo = (req.body && req.body.motivo) || (attivo ? 'Segnato a mano' : null);
  db.prepare('UPDATE contacts SET opt_out = ?, opt_out_at = ?, opt_out_motivo = ? WHERE id = ?')
    .run(attivo ? 1 : 0, attivo ? new Date().toISOString() : null, attivo ? motivo : null, req.params.id);
  res.json(db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id));
});

// ---------- Richieste di cancellazione da confermare ----------
app.get('/api/optout-requests', (req, res) => {
  const righe = db.prepare(`
    SELECT r.*, c.nome AS c_nome, c.cognome AS c_cognome, c.telefono AS c_telefono, c.opt_out AS c_opt_out
    FROM optout_requests r
    LEFT JOIN contacts c ON c.id = r.contact_id
    WHERE r.stato = 'da_confermare'
    ORDER BY r.id DESC
  `).all();
  res.json(righe);
});

// Controllo a richiesta (il controllo automatico gira comunque ogni 10 minuti)
app.post('/api/optout-requests/scan', async (req, res) => {
  if (state.status !== 'connesso') return res.status(409).json({ error: 'WhatsApp non è connesso' });
  if (!chatAbilitata()) return res.status(403).json({ error: 'La lettura delle chat è disattivata dalle Impostazioni' });
  try {
    const nuove = await controllaRichiesteCancellazione();
    res.json({ ok: true, nuove: nuove || 0 });
  } catch (err) {
    res.status(500).json({ error: 'Controllo non riuscito: ' + err.message });
  }
});

// Conferma: il contatto viene escluso da ogni invio futuro.
// contactId può arrivare dal frontend quando l'abbinamento automatico non c'è riuscito.
app.post('/api/optout-requests/:id/confirm', (req, res) => {
  const richiesta = db.prepare('SELECT * FROM optout_requests WHERE id = ?').get(req.params.id);
  if (!richiesta) return res.status(404).json({ error: 'Richiesta non trovata' });
  const contactId = (req.body && req.body.contactId) || richiesta.contact_id;
  if (!contactId) {
    return res.status(400).json({ error: 'Indica a quale contatto della rubrica corrisponde' });
  }
  const contatto = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId);
  if (!contatto) return res.status(404).json({ error: 'Contatto non trovato in rubrica' });

  const motivo = `Ha chiesto la cancellazione su WhatsApp: «${richiesta.testo}»`;
  db.prepare('UPDATE contacts SET opt_out = 1, opt_out_at = ?, opt_out_motivo = ? WHERE id = ?')
    .run(new Date().toISOString(), motivo, contactId);
  db.prepare("UPDATE optout_requests SET stato = 'confermata', contact_id = ? WHERE id = ?")
    .run(contactId, req.params.id);
  res.json({ ok: true, contatto: db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId) });
});

app.post('/api/optout-requests/:id/ignore', (req, res) => {
  const richiesta = db.prepare('SELECT * FROM optout_requests WHERE id = ?').get(req.params.id);
  if (!richiesta) return res.status(404).json({ error: 'Richiesta non trovata' });
  db.prepare("UPDATE optout_requests SET stato = 'ignorata' WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.delete('/api/contacts/:id', (req, res) => {
  db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Svuota completamente la rubrica (azione irreversibile)
app.delete('/api/contacts', (req, res) => {
  if (campagneInCorso.size > 0) {
    return res.status(409).json({ error: 'C\'è un invio in corso: attendi che finisca prima di svuotare la rubrica.' });
  }
  const quanti = db.prepare('SELECT COUNT(*) n FROM contacts').get().n;
  db.prepare('DELETE FROM contacts').run();
  res.json({ ok: true, eliminati: quanti });
});

// Importazione contatti (array inviato dal browser dopo la lettura del CSV)
app.post('/api/contacts/import', (req, res) => {
  const { contacts } = req.body;
  if (!Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: 'Nessun contatto da importare' });
  }
  const existing = db.prepare('SELECT telefono, email FROM contacts').all();
  const phoneSet = new Set(existing.map((r) => normalizePhone(r.telefono)));
  const emailSet = new Set(existing.map((r) => r.email.toLowerCase()).filter(Boolean));
  const insert = db.prepare(
    'INSERT INTO contacts (nome, cognome, email, telefono, opt_out, opt_out_at, opt_out_motivo) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  const vero = (v) => /^(si|sì|s|yes|y|1|true|x)$/i.test(String(v || '').trim());

  let importati = 0, saltati = 0, invalidi = 0;
  const importAll = db.transaction((rows) => {
    for (const r of rows) {
      const nome = String(r.nome || '').trim();
      const cognome = String(r.cognome || '').trim();
      const email = String(r.email || '').trim();
      const telefono = String(r.telefono || '').trim();
      if (!nome || !telefono) { invalidi++; continue; }
      const phoneKey = normalizePhone(telefono);
      if (phoneSet.has(phoneKey) || (email && emailSet.has(email.toLowerCase()))) { saltati++; continue; }
      // consenso 'no' nel CSV = non contattare, come la colonna non_contattare
      const escluso = vero(r.non_contattare) || consensoNegato(r.consenso);
      insert.run(nome, cognome, email, numeroInRubrica(telefono),
        escluso ? 1 : 0,
        escluso ? new Date().toISOString() : null,
        escluso ? 'Importato dal CSV' : null);
      phoneSet.add(phoneKey);
      if (email) emailSet.add(email.toLowerCase());
      importati++;
    }
  });
  importAll(contacts);
  res.json({ importati, saltati, invalidi });
});

// Esportazione contatti in CSV
app.get('/api/contacts/export', (req, res) => {
  const rows = db.prepare('SELECT nome, cognome, email, telefono, opt_out FROM contacts ORDER BY nome COLLATE NOCASE, cognome COLLATE NOCASE').all();
  const quote = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  // La colonna del consenso (= non contattare) viaggia col CSV: un backup che la perde
  // farebbe rientrare negli invii chi aveva consenso "No".
  const csv = ['nome;cognome;email;telefono;non_contattare']
    .concat(rows.map((r) => [r.nome, r.cognome, r.email, r.telefono, r.opt_out ? 'si' : ''].map(quote).join(';')))
    .join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="contatti.csv"');
  res.send('﻿' + csv); // BOM per aprire correttamente gli accenti in Excel
});

// Invio broadcast
// Tetto giornaliero: numero intero positivo, oppure null (nessun limite)
function leggiTetto(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

app.post('/api/send', (req, res) => {
  const { message, contactIds, alias, image, imageName, dailyLimit } = req.body;
  if (!message || !Array.isArray(contactIds) || contactIds.length === 0) {
    return res.status(400).json({ error: 'Messaggio e almeno un destinatario sono obbligatori' });
  }
  let immagine = null;
  if (image) {
    immagine = leggiImmagine(image);
    if (!immagine) return res.status(400).json({ error: 'Formato immagine non valido' });
    immagine.filename = imageName || 'immagine.png';
  }
  if (state.status !== 'connesso') {
    return res.status(409).json({ error: 'WhatsApp non è connesso: scansiona prima il QR code' });
  }
  const placeholders = contactIds.map(() => '?').join(',');
  // I disiscritti non entrano proprio nell'invio
  const contacts = db.prepare(`SELECT * FROM contacts WHERE id IN (${placeholders}) AND opt_out = 0`).all(...contactIds);
  const esclusi = contactIds.length - contacts.length;
  if (contacts.length === 0) {
    return res.status(400).json({
      error: esclusi
        ? 'Tutti i contatti selezionati hanno chiesto di non ricevere più messaggi.'
        : 'Nessun contatto valido selezionato',
    });
  }

  const info = db.prepare('INSERT INTO campaigns (message, total, alias, daily_limit) VALUES (?, ?, ?, ?)')
    .run(message, contacts.length, (alias || '').trim() || null, leggiTetto(dailyLimit));
  const campaignId = info.lastInsertRowid;
  const insertMsg = db.prepare(
    'INSERT INTO campaign_messages (campaign_id, contact_id, destinatario, telefono) VALUES (?, ?, ?, ?)'
  );
  for (const c of contacts) {
    insertMsg.run(campaignId, c.id, `${c.nome} ${c.cognome}`.trim(), c.telefono);
  }
  salvaImmagineCampagna(campaignId, immagine);

  runCampaign(campaignId); // parte in background
  res.json({ campaignId, total: contacts.length, esclusi });
});

// Impostazioni email (la password resta solo nel database locale e non viene mai rimandata al browser)
app.get('/api/email/settings', (req, res) => {
  res.json({
    host: getSetting('smtp_host'),
    port: getSetting('smtp_port') || '587',
    user: getSetting('smtp_user'),
    from_name: getSetting('smtp_from_name'),
    hasPassword: Boolean(getSetting('smtp_pass')),
    verified: getSetting('smtp_verified') === 'true',
    avvisi_email: indirizzoAvvisi(),
  });
});

// ⚠️ L'indirizzo a cui arrivano gli avvisi tecnici — per adesso solo WhatsApp
// che si scollega. Ha un valore di fabbrica, quello dell'assistenza: su una
// copia appena installata nessuno lo imposterebbe mai, e sarebbe proprio quella
// a restare muta il giorno in cui si scollega. Si cambia dalla pagina; scritto
// vuoto, gli avvisi non partono più.
const EMAIL_AVVISI_DI_FABBRICA = 'angellottidaniele@gmail.com';
function indirizzoAvvisi() {
  // ⚠️ Si guarda la RIGA, non `getSetting`: quella per una chiave che non
  // c'è restituisce '' — identico a «scritto vuoto apposta». Con `getSetting`
  // l'indirizzo di fabbrica non entrava in vigore mai, su nessuna copia nuova,
  // e gli avvisi non sarebbero partiti proprio dove servivano di più.
  const riga = db.prepare('SELECT value FROM settings WHERE key = ?').get('avvisi_email');
  return riga ? String(riga.value).trim() : EMAIL_AVVISI_DI_FABBRICA;
}

app.post('/api/email/settings', (req, res) => {
  const { host, port, user, pass, from_name } = req.body;
  if (!host || !user) return res.status(400).json({ error: 'Server SMTP e indirizzo email sono obbligatori' });
  setSetting('smtp_host', String(host).trim());
  setSetting('smtp_port', String(port || '587').trim());
  setSetting('smtp_user', String(user).trim());
  setSetting('smtp_from_name', String(from_name || '').trim());
  if (pass) {
    // Google mostra la password per le app con gli spazi ("abcd efgh ijkl mnop"),
    // ma vanno tolti: altrimenti l'accesso viene rifiutato.
    setSetting('smtp_pass', String(pass).replace(/\s+/g, ''));
  }
  setSetting('smtp_verified', 'false'); // le credenziali sono cambiate: va riprovata
  // Può essere vuoto di proposito: vuol dire «non avvisarmi».
  if (typeof req.body.avvisi_email === 'string') {
    setSetting('avvisi_email', String(req.body.avvisi_email).trim());
  }
  res.json({ ok: true });
});

app.post('/api/email/test', async (req, res) => {
  const transporter = buildTransporter();
  if (!transporter) return res.status(400).json({ error: 'Configura prima server, email e password' });
  try {
    await transporter.verify();
    setSetting('smtp_verified', 'true');
    res.json({ ok: true });
  } catch (err) {
    setSetting('smtp_verified', 'false');
    let msg = err.message || '';
    if (/invalid login|badcredentials|535/i.test(msg)) {
      msg = 'credenziali rifiutate. Con Gmail serve una «password per le app» (16 caratteri), ' +
            'non la password normale del tuo account: creala su myaccount.google.com → Sicurezza → ' +
            'Verifica in due passaggi → Password per le app.';
    } else if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) {
      msg = 'server SMTP non raggiungibile: controlla il nome del server.';
    } else if (/ETIMEDOUT|ECONNREFUSED/i.test(msg)) {
      msg = 'connessione rifiutata: controlla la porta (di solito 587).';
    }
    res.status(400).json({ error: 'Connessione fallita — ' + msg });
  }
});

// Invio newsletter email
app.post('/api/email/send', (req, res) => {
  const { subject, message, contactIds, alias, image, imageName, dailyLimit } = req.body;
  if (!subject || !message || !Array.isArray(contactIds) || contactIds.length === 0) {
    return res.status(400).json({ error: 'Oggetto, messaggio e almeno un destinatario sono obbligatori' });
  }
  let immagine = null;
  if (image) {
    immagine = leggiImmagine(image);
    if (!immagine) return res.status(400).json({ error: 'Formato immagine non valido' });
    immagine.filename = imageName || 'immagine.png';
  }
  if (!buildTransporter()) {
    return res.status(409).json({ error: 'Email non configurata: salva prima le impostazioni SMTP' });
  }
  const placeholders = contactIds.map(() => '?').join(',');
  const contacts = db
    .prepare(`SELECT * FROM contacts WHERE id IN (${placeholders}) AND email != '' AND opt_out = 0`)
    .all(...contactIds);
  const esclusi = contactIds.length - contacts.length;
  if (contacts.length === 0) {
    return res.status(400).json({ error: 'Nessuno dei contatti selezionati ha un indirizzo email, o hanno tutti chiesto di non essere più contattati' });
  }

  // Il tetto delle newsletter NON si sceglie invio per invio come su WhatsApp: vale quello
  // impostato una volta sola nelle Impostazioni. Il numero dipende dal provider di posta,
  // non da cosa serve in questo momento, quindi non ha senso richiederlo ogni volta.
  // Si ignora di proposito quello che arriva dal browser: la regola deve valere anche se
  // la pagina viene scavalcata.
  const info = db
    .prepare("INSERT INTO campaigns (message, subject, channel, total, alias, daily_limit) VALUES (?, ?, 'email', ?, ?, ?)")
    .run(message, subject, contacts.length, (alias || '').trim() || null, tettoEmailGiornaliero());
  const campaignId = info.lastInsertRowid;
  const insertMsg = db.prepare(
    'INSERT INTO campaign_messages (campaign_id, contact_id, destinatario, telefono) VALUES (?, ?, ?, ?)'
  );
  for (const c of contacts) {
    insertMsg.run(campaignId, c.id, `${c.nome} ${c.cognome}`.trim(), c.email);
  }
  salvaImmagineCampagna(campaignId, immagine);

  runCampaign(campaignId); // parte in background
  res.json({ campaignId, total: contacts.length, esclusi });
});

// ---------- Chat WhatsApp ----------
function anteprimaMessaggio(m) {
  if (!m) return '';
  if (m.type === 'chat') return m.body;
  const tipi = {
    image: '📷 Foto', video: '🎬 Video', audio: '🎵 Audio', ptt: '🎤 Vocale',
    document: '📄 Documento', sticker: '🩵 Sticker', location: '📍 Posizione',
    vcard: '👤 Contatto', revoked: '🚫 Messaggio eliminato',
  };
  return tipi[m.type] || '📎 Allegato';
}

// Le conversazioni vengono lette DIRETTAMENTE dalla pagina di WhatsApp Web (il DOM),
// come le vedi tu nel browser. Questo evita gli errori dello "Store" interno della libreria
// quando WhatsApp aggiorna la sua pagina web.
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// Legge l'elenco delle conversazioni dalla colonna di sinistra
async function leggiListaChat() {
  return client.pupPage.evaluate(() => {
    // anche nelle anteprime le emoji sono <img alt="😀">
    const estraiAnteprima = (el) => {
      let out = '';
      const percorri = (node) => {
        for (const c of node.childNodes) {
          const tag = (c.nodeName || '').toLowerCase();
          if (tag === 'svg' || tag === 'title') continue; // salta le icone (spunte ecc.)
          if (c.nodeType === 3) out += c.nodeValue;
          else if (tag === 'img') out += c.getAttribute('alt') || '';
          else percorri(c);
        }
      };
      percorri(el);
      return out.replace(/\s+/g, ' ').trim();
    };
    const rows = [...document.querySelectorAll('#pane-side [role="row"]')];
    return rows.map((row) => {
      const t = row.querySelector('span[title]');
      const nome = t ? t.getAttribute('title') : '';
      const img = row.querySelector('img');
      const avatar = img ? img.getAttribute('src') : null;
      const timeEl = row.querySelector('[data-testid="cell-frame-primary-detail"]');
      const ora = timeEl ? timeEl.innerText.trim() : '';
      const secEl = row.querySelector('[data-testid="cell-frame-secondary"]');
      let ultimoTesto = secEl ? estraiAnteprima(secEl) : '';
      let ultimoMio = false;
      if (ultimoTesto.startsWith('Tu:')) { ultimoMio = true; ultimoTesto = ultimoTesto.slice(3).trim(); }
      // Contatore messaggi non letti: solo il vero badge (aria-label "N messaggi non letti").
      // Attenzione: l'avviso dei messaggi effimeri contiene "messaggi non saranno..." e
      // farebbe leggere per errore il numero di giorni.
      let nonLetti = 0;
      const badge = row.querySelector('[aria-label*="non lett"], [aria-label*="unread"]');
      if (badge) {
        const testoBadge = (badge.innerText || '').trim();
        if (/^\d+$/.test(testoBadge)) {
          nonLetti = parseInt(testoBadge, 10);           // il badge mostra solo il numero
        } else {
          const m = (badge.getAttribute('aria-label') || '').match(/^\s*(\d+)\s/); // "3 messaggi non letti"
          if (m) nonLetti = parseInt(m[1], 10);
        }
      }
      const gruppo = !!row.querySelector('[data-icon="default-group"], [data-icon="group"]');
      return { nome, ora, ultimoTesto, ultimoMio, nonLetti, gruppo, avatar };
    }).filter((c) => c.nome);
  });
}

// Le operazioni che pilotano WhatsApp Web (aprire chat, leggere pannelli, inviare)
// devono essere eseguite UNA ALLA VOLTA: altrimenti l'aggiornamento automatico della
// lista cambia conversazione mentre un'altra operazione è a metà.
let codaWhatsApp = Promise.resolve();
function inCoda(operazione) {
  const risultato = codaWhatsApp.then(operazione, operazione);
  codaWhatsApp = risultato.then(() => {}, () => {});
  return risultato;
}

// ---------- Riconoscimento delle richieste di cancellazione ----------
// Solo richieste ESPLICITE: un «basta» dentro una conversazione normale vuol dire
// tutt'altro, e una proposta sbagliata fa perdere fiducia in tutto il meccanismo.
const FRASI_CANCELLAZIONE = [
  /(^|\W)stop(\W|$)/i,
  /cancell(a|ate)mi/i,
  /cancellat[ea]?\s+(il\s+mio|i\s+miei)/i,
  /rimuov(imi|etemi)/i,
  /togli(mi|etemi)/i,
  /disiscriv(imi|etemi)|disiscrizione/i,
  /non\s+(mi\s+)?(scriv|mandat?|invia|inviate|contattat?)\w*\s*(pi[uù])/i,
  /non\s+voglio\s+pi[uù]\s+(ricevere|messaggi|nulla|niente)/i,
  /non\s+(mi\s+)?interessa\s+pi[uù]/i,
  /unsubscribe|remove\s+me/i,
];

function sembraCancellazione(testo) {
  const t = String(testo || '').trim();
  if (!t || t.length > 200) return false; // i messaggi lunghi non sono richieste secche
  return FRASI_CANCELLAZIONE.some((r) => r.test(t));
}

// Confronto nomi indifferente a maiuscole, accenti e spazi doppi
function normalizzaNome(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

// Cerca in rubrica il contatto corrispondente al nome della chat.
// Restituisce l'id SOLO se la corrispondenza è unica: con gli omonimi (che in
// rubrica sono ammessi) è meglio non sapere che indovinare.
function contattoDalNomeChat(nomeChat) {
  const cercato = normalizzaNome(nomeChat);
  if (!cercato) return null;
  const candidati = db.prepare('SELECT id, nome, cognome FROM contacts').all().filter((c) => {
    const dir = normalizzaNome(`${c.nome} ${c.cognome}`);
    const inv = normalizzaNome(`${c.cognome} ${c.nome}`);
    return dir === cercato || inv === cercato;
  });
  return candidati.length === 1 ? candidati[0].id : null;
}

// Guarda l'elenco delle conversazioni e annota chi sembra aver chiesto la cancellazione.
// Legge soltanto (nessun click): è la parte meno fragile del ponte col DOM di WhatsApp.
async function controllaRichiesteCancellazione() {
  if (state.status !== 'connesso' || !chatAbilitata()) return;
  let chats;
  try {
    chats = await leggiListaChat();
  } catch (err) {
    console.error('Controllo cancellazioni non riuscito:', err.message);
    return;
  }
  const giaIgnorata = db.prepare("SELECT 1 FROM optout_requests WHERE chat_nome = ? AND testo = ? AND stato = 'ignorata'");
  const giaPendente = db.prepare("SELECT 1 FROM optout_requests WHERE chat_nome = ? AND testo = ? AND stato = 'da_confermare'");
  const eBloccato = db.prepare('SELECT opt_out FROM contacts WHERE id = ?');
  const inserisci = db.prepare(
    'INSERT INTO optout_requests (chat_nome, testo, contact_id) VALUES (?, ?, ?)'
  );
  let nuove = 0;
  for (const c of chats || []) {
    if (c.gruppo) continue;      // in un gruppo «stop» non riguarda un singolo destinatario
    if (c.ultimoMio) continue;   // l'ultimo messaggio l'abbiamo scritto noi
    if (!sembraCancellazione(c.ultimoTesto)) continue;
    // "Ignora" significa "non disturbarmi più per questo messaggio"
    if (giaIgnorata.get(c.nome, c.ultimoTesto)) continue;
    // è già in cima alla Rubrica in attesa di una tua decisione: niente doppione
    if (giaPendente.get(c.nome, c.ultimoTesto)) continue;
    const contactId = contattoDalNomeChat(c.nome);
    // se il contatto è già bloccato non c'è nulla da fare; ma se l'hai sbloccato
    // e riscrive, l'avviso deve ricomparire (qui non entriamo in questo "continue")
    if (contactId) {
      const b = eBloccato.get(contactId);
      if (b && b.opt_out) continue;
    }
    inserisci.run(c.nome, c.ultimoTesto, contactId);
    nuove++;
  }
  if (nuove) console.log('Richieste di cancellazione da confermare:', nuove);
  return nuove;
}
setInterval(() => { controllaRichiesteCancellazione(); }, 10 * 60 * 1000);

// Apre una conversazione cliccandola nella lista (per nome). Ritorna il nome effettivo aperto.
async function apriChatPerNome(nome) {
  const aperta = await client.pupPage.evaluate((nome) => {
    const rows = [...document.querySelectorAll('#pane-side [role="row"]')];
    const row = rows.find((r) => {
      const t = r.querySelector('span[title]');
      return t && t.getAttribute('title') === nome;
    });
    if (!row) return false;
    const target = row.querySelector('[data-testid="cell-frame-title"]') || row.querySelector('span[title]');
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
    }
    return true;
  }, nome);
  if (!aperta) return null;
  await sleepMs(900);
  return nome;
}

// Legge i messaggi della conversazione aperta
async function leggiMessaggiAperti() {
  return client.pupPage.evaluate(() => {
    const main = document.querySelector('#main');
    if (!main) return null;

    // Estrae il testo mantenendo le EMOJI (che WhatsApp rende come <img alt="😀">)
    // e contando gli a-capo solo dai <br>, per non moltiplicare le righe vuote.
    const estraiTesto = (el) => {
      let out = '';
      const percorri = (node) => {
        for (const c of node.childNodes) {
          const tag = (c.nodeName || '').toLowerCase();
          if (tag === 'svg' || tag === 'title') continue;                 // icone: da ignorare
          if (c.nodeType === 3) out += c.nodeValue;                       // testo
          else if (tag === 'img') out += c.getAttribute('alt') || '';     // emoji
          else if (tag === 'br') out += '\n';                             // a capo
          else percorri(c);
        }
      };
      percorri(el);
      return out
        .replace(/ /g, ' ')      // spazi unificatori
        .replace(/[ \t]+\n/g, '\n')   // spazi a fine riga
        .replace(/\n{3,}/g, '\n\n')   // max una riga vuota di seguito
        .trim();
    };

    const mainRect = main.getBoundingClientRect();
    const nodes = [...main.querySelectorAll('div[data-id]')];
    return nodes.map((n) => {
      const bubble = n.querySelector('[data-testid="msg-container"]') || n;
      const rect = bubble.getBoundingClientRect();
      const centro = (rect.left + rect.right) / 2 - mainRect.left;
      let mio = centro > mainRect.width / 2; // le bolle in uscita stanno a destra
      if (n.querySelector('[data-icon="tail-out"], [data-icon="msg-dblcheck"], [data-icon="msg-check"]')) mio = true;
      if (n.querySelector('[data-icon="tail-in"]')) mio = false;
      const t = n.querySelector('span.selectable-text, span.copyable-text span[dir], .copyable-text span')
             || n.querySelector('.copyable-text');
      let testo = t ? estraiTesto(t) : '';
      if (!testo) {
        if (n.querySelector('[data-icon="audio-play"], audio, [aria-label*="ocale"]')) testo = '🎤 Vocale/Audio';
        else if (n.querySelector('img[src^="blob"], [data-icon="media-play"], [aria-label*="oto"]')) testo = '📷 Media';
        else if (n.querySelector('[data-icon="document"], [aria-label*="ocumento"]')) testo = '📄 Documento';
      }

      // Data, ora e mittente da "data-pre-plain-text" = "[19:52, 20/07/2026] Mittente: "
      const cop = n.querySelector('.copyable-text');
      const pre = cop ? (cop.getAttribute('data-pre-plain-text') || '') : '';
      const m = pre.match(/\[(\d{1,2}:\d{2}),\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\]\s*(.*?):\s*$/);
      const ora = m ? m[1] : '';
      const data = m ? m[2] : '';
      const mittente = m ? m[3] : null;

      // Stato di consegna (spunte) dei messaggi in uscita
      // ATTENZIONE: il nome dell'icona (svg title) è sempre "wds-ic-read" anche quando il
      // messaggio è solo consegnato. Lo stato vero sta SOLO nell'aria-label localizzata.
      let stato = null;
      const meta = n.querySelector('[data-testid="msg-meta"]');
      if (meta) {
        const ariaEl = meta.querySelector('[aria-label]');
        const aria = (ariaEl ? ariaEl.getAttribute('aria-label') : '').toLowerCase().trim();
        if (aria) {
          if (/consegn|deliver/.test(aria)) stato = 'consegnato';
          else if (/letto|read/.test(aria)) stato = 'letto';
          else if (/inviat|sent/.test(aria)) stato = 'inviato';
          else if (/attesa|pending|orolog|clock/.test(aria)) stato = 'attesa';
        }
      }

      return { testo, mio, ora, data, mittente, stato };
    }).filter((m) => m.testo);
  });
}

// Invia un messaggio nella conversazione aperta scrivendo nel campo, come faresti a mano
async function inviaNellaChatAperta(nome, testo) {
  // verifica che il campo di scrittura sia quello della persona giusta
  const box = await client.pupPage.evaluate(() => {
    const b = document.querySelector('#main footer div[contenteditable="true"]');
    return b ? (b.getAttribute('aria-label') || '') : null;
  });
  if (box === null) throw new Error('Conversazione non aperta');
  await client.pupPage.evaluate(() => {
    const b = document.querySelector('#main footer div[contenteditable="true"]');
    b.focus();
  });
  // inserisce il testo generando i giusti eventi che WhatsApp ascolta
  await client.pupPage.evaluate((t) => {
    document.execCommand('insertText', false, t);
  }, testo);
  await sleepMs(200);
  await client.pupPage.keyboard.press('Enter');
  return true;
}

// Funzioni attivabili
function chatAbilitata() {
  return getSetting('chat_enabled') !== 'false'; // default: attiva
}

app.get('/api/features', (req, res) => {
  res.json({ chatEnabled: chatAbilitata() });
});

app.post('/api/features', (req, res) => {
  if (typeof req.body.chatEnabled === 'boolean') {
    setSetting('chat_enabled', req.body.chatEnabled ? 'true' : 'false');
  }
  res.json({ chatEnabled: chatAbilitata() });
});

// ---------- Ritmo degli invii (Impostazioni) ----------
// Restituisce i valori attuali (in secondi) e quelli consigliati, così l'interfaccia
// può mostrare l'avviso quando ci si allontana dai valori sicuri.
const RITMO_CAMPI = [
  'wa_pausa_min', 'wa_pausa_max', 'wa_riposo_ogni', 'wa_riposo_min', 'wa_riposo_max',
  'email_pausa_min', 'email_pausa_max',
];

app.get('/api/ritmo', (req, res) => {
  const attuale = {};
  for (const k of RITMO_CAMPI) attuale[k] = ritmoNum(k);
  // Il tetto giornaliero delle email viaggia qui accanto perché sta nella stessa scheda,
  // ma NON è un valore di ritmo: non entra in RITMO_CAMPI, non è una durata e ha una sua
  // validazione a elenco chiuso.
  res.json({ attuale, consigliato: RITMO_DEFAULT, disattivato: pauseDisattivate(),
             tettoEmail: tettoEmailGiornaliero(), tettiEmailAmmessi: TETTI_EMAIL_AMMESSI,
             tettoEmailConsigliato: TETTO_EMAIL_DEFAULT });
});

// Accendere e spegnere il guscio nuovo. Una rotta sua e non dentro alle
// impostazioni del bot: è roba della piattaforma, e il bot può non esserci.
app.post('/api/ui/guscio', (req, res) => {
  const acceso = (req.body || {}).acceso === true;
  setSetting('ui_guscio', acceso ? 'true' : 'false');
  res.json({ ok: true, guscio: acceso });
});

app.post('/api/ritmo', (req, res) => {
  const b = req.body || {};

  // Richiesta di sola accensione/spegnimento dell'interruttore: non tocca i valori numerici,
  // così riaccendendolo tornano esattamente quelli di prima.
  if (typeof b.disattivato === 'boolean' && Object.keys(b).length === 1) {
    setSetting('ritmo_disattivato', b.disattivato ? 'true' : 'false');
    const attuale = {};
    for (const k of RITMO_CAMPI) attuale[k] = ritmoNum(k);
    return res.json({ ok: true, attuale, disattivato: b.disattivato });
  }

  // se il body è vuoto (o "reset") si torna ai valori consigliati
  if (b.reset) {
    for (const k of RITMO_CAMPI) db.prepare('DELETE FROM settings WHERE key = ?').run('ritmo_' + k);
    db.prepare('DELETE FROM settings WHERE key = ?').run('tetto_email_giornaliero');
    const attuale = {};
    for (const k of RITMO_CAMPI) attuale[k] = ritmoNum(k);
    return res.json({ ok: true, attuale, disattivato: pauseDisattivate(), tettoEmail: tettoEmailGiornaliero() });
  }
  for (const k of RITMO_CAMPI) {
    const v = parseFloat(b[k]);
    if (!Number.isFinite(v) || v <= 0) {
      return res.status(400).json({ error: `Valore non valido per ${k}` });
    }
  }
  // coerenza min ≤ max: se invertiti li riordino invece di rifiutare
  const fix = (minK, maxK) => {
    let lo = parseFloat(b[minK]), hi = parseFloat(b[maxK]);
    if (lo > hi) [lo, hi] = [hi, lo];
    setSetting('ritmo_' + minK, String(lo));
    setSetting('ritmo_' + maxK, String(hi));
  };
  fix('wa_pausa_min', 'wa_pausa_max');
  fix('wa_riposo_min', 'wa_riposo_max');
  fix('email_pausa_min', 'email_pausa_max');
  setSetting('ritmo_wa_riposo_ogni', String(Math.max(1, Math.round(parseFloat(b.wa_riposo_ogni)))));
  // Tetto email: si accetta solo se è uno dei valori previsti. Un valore fuori elenco non
  // viene "aggiustato" ma ignorato — meglio tenere quello di prima che salvarne uno a caso.
  if (b.tettoEmail !== undefined) {
    const te = parseInt(b.tettoEmail, 10);
    if (!TETTI_EMAIL_AMMESSI.includes(te)) {
      return res.status(400).json({ error: 'Tetto giornaliero email non valido' });
    }
    setSetting('tetto_email_giornaliero', String(te));
  }
  const attuale = {};
  for (const k of RITMO_CAMPI) attuale[k] = ritmoNum(k);
  res.json({ ok: true, attuale, disattivato: pauseDisattivate(), tettoEmail: tettoEmailGiornaliero() });
});

app.get('/api/chats', async (req, res) => {
  if (!chatAbilitata()) return res.status(403).json({ error: 'La chat è disattivata dalle Impostazioni' });
  if (state.status !== 'connesso') return res.status(409).json({ error: 'WhatsApp non è connesso' });
  try {
    const chats = await leggiListaChat();
    res.json(chats.slice(0, 30));
  } catch (err) {
    res.status(500).json({ error: 'Impossibile leggere le chat: ' + err.message });
  }
});

// Ricava il numero di telefono di una conversazione, aprendo la scheda informazioni
app.post('/api/chat/telefono', async (req, res) => {
  if (!chatAbilitata()) return res.status(403).json({ error: 'La chat è disattivata dalle Impostazioni' });
  if (state.status !== 'connesso') return res.status(409).json({ error: 'WhatsApp non è connesso' });
  const { nome, giaAperta } = req.body;
  if (!nome) return res.status(400).json({ error: 'Chat non indicata' });

  // se la conversazione è già intitolata con il numero, non serve aprire nulla
  if (/^\+?[\d\s().-]{8,}$/.test(nome)) {
    return res.json({ nome, telefono: nome.trim() });
  }

  // Prima strada, e la più affidabile: il numero imparato da un messaggio
  // ricevuto. Sugli account WhatsApp Business il pannello informazioni il
  // numero non lo mostra affatto, quindi senza questo non ci sarebbe modo di
  // arrivarci — era il limite dichiarato «non risolvibile» in NOTE-TECNICHE.
  try {
    const visto = db.prepare('SELECT telefono FROM numeri_visti WHERE nome = ?').get(nome);
    if (visto && visto.telefono) {
      return res.json({ nome, telefono: '+' + visto.telefono, fonte: 'messaggio ricevuto' });
    }
  } catch { /* la tabella può non esserci: si prosegue col pannello */ }

  let nomeRiferimento = nome; // nome della conversazione effettivamente letta

  try {
    const telefono = await inCoda(async () => {
    // Legge lo stato del pannello laterale destro (informazioni contatto)
    const leggiPannello = (rif) => client.pupPage.evaluate((nomeChat) => {
      const paneSide = document.querySelector('#pane-side');
      const main = document.querySelector('#main');
      const cand = [...document.querySelectorAll('div,section,aside')].filter((e) => {
        // né dentro la lista chat / conversazione…
        if (e.closest('#pane-side') || e.closest('#main')) return false;
        // …né un contenitore che le racchiude (altrimenti si leggono i numeri della lista!)
        if (paneSide && e.contains(paneSide)) return false;
        if (main && e.contains(main)) return false;
        const r = e.getBoundingClientRect();
        return r.width > 250 && r.height > 300 && (e.innerText || '').trim().length > 0;
      });
      cand.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
      const panel = cand[0];
      if (!panel) return { aperto: false };
      const testo = panel.innerText || '';
      return {
        aperto: true,
        corrisponde: testo.includes(nomeChat),
        numeri: [...new Set(testo.match(/\+\d[\d ]{7,}\d/g) || [])],
      };
    }, rif);

    // Il punto cliccabile dell'intestazione cambia da contatto a contatto:
    // provo in ordine finché il pannello non si apre.
    const clickIntestazione = (variante = 0) => client.pupPage.evaluate((v) => {
      const h = document.querySelector('#main header');
      if (!h) return false;
      const candidati = [
        h.querySelector('span[title]'),   // è proprio il "clicca qui per info contatto"
        h.querySelector('[role="button"]'),
        h.querySelector('img'),
        h.querySelector('div'),
        h,
      ].filter(Boolean);
      const t = candidati[v % candidati.length];
      if (!t) return false;
      const r = t.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      for (const ty of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        t.dispatchEvent(new MouseEvent(ty, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
      }
      return true;
    }, variante);

      // 1) Se la conversazione è già aperta dall'utente uso il nome che compare
      //    nell'intestazione: WhatsApp tiene nel documento solo le chat visibili
      //    nell'elenco, quindi ricercarle per nome può fallire senza motivo.
      // ATTENZIONE: in #main header l'attributo title è "clicca qui per info contatto",
      // NON il nome. Il nome della conversazione è la prima riga del testo.
      const nomeIntestazione = () => client.pupPage.evaluate(() => {
        const h = document.querySelector('#main header');
        if (!h) return null;
        const righe = (h.innerText || '').split('\n').map((r) => r.trim()).filter(Boolean);
        return righe[0] || null;
      });

      const titoloAperto = await nomeIntestazione();
      if (giaAperta && titoloAperto) {
        nomeRiferimento = titoloAperto;      // è questa la conversazione da leggere
      } else {
        const aperta = await apriChatPerNome(nome);
        if (!aperta) return 'CHAT_ASSENTE';
        await sleepMs(600);
        nomeRiferimento = (await nomeIntestazione()) || nome;
      }

      // 2) il pannello resta "appiccicato" al contatto precedente: se è aperto lo chiude
      //    (il click sull'intestazione fa da interruttore), poi lo riapre pulito.
      let trovato = null;
      for (let variante = 0; variante < 4 && !trovato; variante++) {
        // se è rimasto aperto il pannello di un altro contatto, lo chiude
        if ((await leggiPannello(nomeRiferimento)).aperto) {
          await clickIntestazione(variante);
          for (let i = 0; i < 5 && (await leggiPannello(nomeRiferimento)).aperto; i++) await sleepMs(300);
        }
        await clickIntestazione(variante);           // apre quello della chat corrente
        for (let i = 0; i < 6; i++) {
          await sleepMs(400);
          const p = await leggiPannello(nomeRiferimento);
          if (p.aperto && p.corrisponde && p.numeri.length === 1) { trovato = p.numeri[0]; break; }
        }
      }

      await client.pupPage.keyboard.press('Escape'); // richiude il pannello
      await sleepMs(400);
      return trovato;
    });

    if (telefono === 'CHAT_ASSENTE') return res.status(404).json({ error: 'Conversazione non trovata nella lista' });
    if (!telefono) return res.status(404).json({ error: 'Numero non trovato per questa conversazione' });
    res.json({ nome: nomeRiferimento, telefono });
  } catch (err) {
    res.status(500).json({ error: 'Impossibile leggere il numero: ' + err.message });
  }
});

app.post('/api/chat/messages', async (req, res) => {
  if (!chatAbilitata()) return res.status(403).json({ error: 'La chat è disattivata dalle Impostazioni' });
  if (state.status !== 'connesso') return res.status(409).json({ error: 'WhatsApp non è connesso' });
  const { nome } = req.body;
  if (!nome) return res.status(400).json({ error: 'Chat non indicata' });
  try {
    const esito = await inCoda(async () => {
      const aperta = await apriChatPerNome(nome);
      if (!aperta) return null;
      return await leggiMessaggiAperti();
    });
    if (esito === null) return res.status(404).json({ error: 'Conversazione non trovata nella lista' });
    res.json({ nome, messaggi: esito || [] });
  } catch (err) {
    res.status(500).json({ error: 'Impossibile leggere i messaggi: ' + err.message });
  }
});

app.post('/api/chat/send', async (req, res) => {
  if (!chatAbilitata()) return res.status(403).json({ error: 'La chat è disattivata dalle Impostazioni' });
  if (state.status !== 'connesso') return res.status(409).json({ error: 'WhatsApp non è connesso' });
  const { nome, message } = req.body;
  if (!nome || !message || !message.trim()) return res.status(400).json({ error: 'Chat e messaggio obbligatori' });
  try {
    const aperta = await apriChatPerNome(nome);
    if (!aperta) return res.status(404).json({ error: 'Conversazione non trovata nella lista' });
    await inviaNellaChatAperta(nome, message.trim());
    await sleepMs(600);
    const messaggi = await leggiMessaggiAperti();
    res.json({ ok: true, messaggi: messaggi || [] });
  } catch (err) {
    res.status(500).json({ error: 'Invio non riuscito: ' + err.message });
  }
});

// Invio di un'immagine nella chat aperta (allegato)
app.post('/api/chat/send-image', async (req, res) => {
  if (!chatAbilitata()) return res.status(403).json({ error: 'La chat è disattivata dalle Impostazioni' });
  if (state.status !== 'connesso') return res.status(409).json({ error: 'WhatsApp non è connesso' });
  const { nome, dataUrl, filename, caption } = req.body;
  if (!nome || !dataUrl) return res.status(400).json({ error: 'Chat e immagine obbligatorie' });

  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return res.status(400).json({ error: 'Formato immagine non valido' });

  const estensione = (filename && path.extname(filename)) || '.' + m[1].split('/')[1].replace('jpeg', 'jpg');
  const tmpFile = path.join(os.tmpdir(), 'istudio-' + Date.now() + estensione);

  try {
    fs.writeFileSync(tmpFile, Buffer.from(m[2], 'base64'));

    const aperta = await apriChatPerNome(nome);
    if (!aperta) return res.status(404).json({ error: 'Conversazione non trovata nella lista' });

    // 1. apre il menu allegati di WhatsApp (pulsante "+")
    const menuAperto = await client.pupPage.evaluate(() => {
      const ic = document.querySelector('#main footer [data-icon="plus-rounded"]');
      const b = ic && (ic.closest('button') || ic.closest('[role="button"]') || ic.parentElement);
      if (!b) return false;
      b.click();
      return true;
    });
    if (!menuAperto) throw new Error('Pulsante allegati di WhatsApp non trovato');
    await sleepMs(1200);

    // 2. clicca "Foto e video" intercettando la finestra di selezione file
    const [fileChooser] = await Promise.all([
      client.pupPage.waitForFileChooser({ timeout: 12000 }),
      client.pupPage.evaluate(() => {
        const voce = [...document.querySelectorAll('li, [role="button"], [role="menuitem"]')]
          .find((e) => (e.innerText || '').trim() === 'Foto e video');
        if (voce) voce.click();
      }),
    ]);
    await fileChooser.accept([tmpFile]);

    // 3. attende il pannello di anteprima (immagine caricata + campo didascalia)
    await client.pupPage
      .waitForFunction(() => {
        const composer = document.querySelector('#main footer div[contenteditable="true"]');
        const box = [...document.querySelectorAll('div[contenteditable="true"]')].find((b) => b !== composer);
        return !!box && document.querySelectorAll('img[src^="blob:"]').length > 0;
      }, { timeout: 15000 })
      .catch(() => { throw new Error('Anteprima immagine non comparsa: immagine non inviata'); });
    await sleepMs(800);

    // 4. didascalia nel campo dell'ANTEPRIMA (non in quello normale della chat!)
    const scrittaNellAnteprima = await client.pupPage.evaluate((t) => {
      const composer = document.querySelector('#main footer div[contenteditable="true"]');
      const box = [...document.querySelectorAll('div[contenteditable="true"]')].find((b) => b !== composer);
      if (!box) return false;
      box.focus();
      if (t) document.execCommand('insertText', false, t);
      return true;
    }, (caption || '').trim());
    if (!scrittaNellAnteprima) throw new Error('Campo didascalia non trovato: immagine non inviata');
    await sleepMs(400);

    // 5. invia dall'anteprima
    await client.pupPage.keyboard.press('Enter');
    await sleepMs(3500);

    const messaggi = await leggiMessaggiAperti();
    res.json({ ok: true, messaggi: messaggi || [] });
  } catch (err) {
    res.status(500).json({ error: 'Invio immagine non riuscito: ' + err.message });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
});

// Dashboard: panoramica riassuntiva di tutta la piattaforma
app.get('/api/dashboard', (req, res) => {
  // I disiscritti restano in rubrica ma non sono "raggiungibili": contarli fra i
  // raggiungibili darebbe all'utente un numero che non corrisponde a quanti partiranno.
  const contattiTot = db.prepare('SELECT COUNT(*) n FROM contacts').get().n;
  const disiscritti = db.prepare('SELECT COUNT(*) n FROM contacts WHERE opt_out = 1').get().n;
  const contattiEmail = db.prepare("SELECT COUNT(*) n FROM contacts WHERE email != '' AND opt_out = 0").get().n;
  const campagneTot = db.prepare('SELECT COUNT(*) n FROM campaigns').get().n;
  const perCanale = db.prepare(`
    SELECT channel,
           COUNT(*) AS campagne,
           COALESCE(SUM(sent), 0) AS inviati,
           COALESCE(SUM(failed), 0) AS errori
    FROM campaigns GROUP BY channel
  `).all();
  const wa = perCanale.find((r) => r.channel === 'whatsapp') || { campagne: 0, inviati: 0, errori: 0 };
  const email = perCanale.find((r) => r.channel === 'email') || { campagne: 0, inviati: 0, errori: 0 };
  const recenti = db.prepare(`
    SELECT id, channel, subject, alias, message, sent, failed, total, status, created_at
    FROM campaigns ORDER BY id DESC LIMIT 6
  `).all();

  res.json({
    whatsapp: { status: state.status, me: state.me },
    email: {
      configurata: Boolean(getSetting('smtp_user') && getSetting('smtp_pass')),
      verificata: getSetting('smtp_verified') === 'true',
    },
    chat: { attiva: chatAbilitata() },
    contatti: {
      totale: contattiTot,
      disiscritti,
      raggiungibiliWa: contattiTot - disiscritti,
      conEmail: contattiEmail,
      senzaEmail: contattiTot - disiscritti - contattiEmail,
    },
    invii: {
      campagne: campagneTot,
      inviatiTotali: wa.inviati + email.inviati,
      erroriTotali: wa.errori + email.errori,
      whatsapp: { campagne: wa.campagne, inviati: wa.inviati, errori: wa.errori },
      email: { campagne: email.campagne, inviati: email.inviati, errori: email.errori },
    },
    recenti,
  });
});

// Cronologia
app.get('/api/campaigns', (req, res) => {
  res.json(db.prepare('SELECT * FROM campaigns ORDER BY id DESC LIMIT 50').all());
});

// Svuota completamente la cronologia degli invii (azione irreversibile)
app.delete('/api/campaigns', (req, res) => {
  if (campagneInCorso.size > 0) {
    return res.status(409).json({ error: 'C\'è un invio in corso: attendi che finisca prima di svuotare la cronologia.' });
  }
  const quanti = db.prepare('SELECT COUNT(*) n FROM campaigns').get().n;
  for (const c of db.prepare('SELECT image_path FROM campaigns').all()) eliminaImmagineCampagna(c);
  db.prepare('DELETE FROM campaign_messages').run();
  db.prepare('DELETE FROM campaigns').run();
  res.json({ ok: true, eliminati: quanti });
});

// Ripristino totale: riporta iStudio come appena installata (azione irreversibile).
// Cancella contatti, cronologia, allegati, richieste di cancellazione, TUTTE le
// impostazioni (email, ritmo, chat) e scollega WhatsApp.
app.post('/api/reset-totale', async (req, res) => {
  if (campagneInCorso.size > 0) {
    return res.status(409).json({ error: 'C\'è un invio in corso: fermalo o attendi che finisca prima di azzerare tutto.' });
  }
  try {
    // cronologia + allegati + richieste di cancellazione
    for (const c of db.prepare('SELECT image_path FROM campaigns').all()) eliminaImmagineCampagna(c);
    db.prepare('DELETE FROM campaign_messages').run();
    db.prepare('DELETE FROM campaigns').run();
    db.prepare('DELETE FROM optout_requests').run();
    // rubrica
    db.prepare('DELETE FROM contacts').run();
    // tutte le impostazioni (email, ritmo, chat...) → tornano ai valori di fabbrica
    db.prepare('DELETE FROM settings').run();
    // WhatsApp: scollega e cancella la sessione (poi riparte il QR)
    try { await client.logout(); } catch (e) { console.error('Logout WhatsApp nel reset:', e.message); }
    state.status = 'disconnesso';
    state.me = null;
    res.json({ ok: true });
  } catch (err) {
    console.error('Reset totale non riuscito:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/campaigns/:id', (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Invio non trovato' });
  if (campagneInCorso.has(Number(req.params.id))) {
    return res.status(409).json({ error: 'Questo invio è ancora in corso: mettilo in pausa oppure attendi che finisca' });
  }
  eliminaImmagineCampagna(campaign);
  db.prepare('DELETE FROM campaign_messages WHERE campaign_id = ?').run(req.params.id);
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Mette in pausa un invio in esecuzione: si ferma dopo il messaggio corrente,
// senza aspettare la fine dell'attesa fra un destinatario e l'altro.
app.post('/api/campaigns/:id/pause', (req, res) => {
  const id = Number(req.params.id);
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  if (!campaign) return res.status(404).json({ error: 'Invio non trovato' });
  const ctrl = controlloCampagne.get(id);
  if (!ctrl) return res.status(409).json({ error: 'Questo invio non è in esecuzione' });
  ctrl.pausaRichiesta = true;
  res.json({ ok: true });
});

// Riprende un invio fermo: riparte dai soli destinatari ancora non serviti.
app.post('/api/campaigns/:id/resume', (req, res) => {
  const id = Number(req.params.id);
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  if (!campaign) return res.status(404).json({ error: 'Invio non trovato' });
  if (campagneInCorso.has(id)) return res.status(409).json({ error: 'Questo invio è già in esecuzione' });
  const restanti = db.prepare(
    "SELECT COUNT(*) n FROM campaign_messages WHERE campaign_id = ? AND status = 'in_attesa'"
  ).get(id).n;
  if (!restanti) {
    segnaStato(id, 'completata', null, 0);
    return res.status(409).json({ error: 'Non ci sono destinatari rimasti: l\'invio è già completo' });
  }
  const viaEmail = (campaign.channel || 'whatsapp') === 'email';
  if (!viaEmail && state.status !== 'connesso') {
    return res.status(409).json({ error: 'WhatsApp non è collegato: collegalo dalle Impostazioni e riprova' });
  }
  if (viaEmail && !buildTransporter()) {
    return res.status(409).json({ error: 'Email non configurata: controlla le Impostazioni' });
  }
  // Il tetto di oggi è già stato raggiunto: non riparto di nascosto, chiedo conferma.
  // Se l'utente insiste, per oggi il tetto viene ignorato (da domani torna valido).
  const forza = Boolean(req.body && req.body.forza);
  if (campaign.daily_limit > 0 && !forza) {
    const oggi = serviteOggi(id);
    if (oggi >= campaign.daily_limit) {
      return res.status(409).json({
        error: `Oggi hai già inviato ${oggi} messaggi, cioè il limite che avevi impostato (${campaign.daily_limit}). Riprenderà da solo domani alle 9:00.`,
        tettoRaggiunto: true, oggi, limite: campaign.daily_limit,
      });
    }
  }
  runCampaign(id, { ignoraTettoOggi: forza }); // riparte in background
  res.json({ ok: true, restanti });
});

// Rimette in coda chi risulta «non riuscito» ma per un problema di COLLEGAMENTO, non suo.
// Serve a rimediare agli invii fatti con le versioni precedenti di iStudio, che marchiavano
// come errore definitivo anche le pagine morte: quelle persone non sarebbero mai state
// riprovate, perché la ripresa serve solo le righe 'in_attesa'.
// Non tocca gli errori veri (numero senza WhatsApp, email scritta male): quelli restano.
app.post('/api/campaigns/:id/riprova-collegamento', (req, res) => {
  const id = Number(req.params.id);
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id);
  if (!campaign) return res.status(404).json({ error: 'Invio non trovato' });
  if (campagneInCorso.has(id)) {
    return res.status(409).json({ error: 'Questo invio è in esecuzione: mettilo in pausa prima di rimettere in coda i falliti.' });
  }

  const falliti = db.prepare("SELECT id, error FROM campaign_messages WHERE campaign_id = ? AND status = 'errore'").all(id);
  const daRiprovare = falliti.filter((m) => erroreDiCollegamento(m.error));
  if (!daRiprovare.length) {
    return res.status(409).json({ error: 'Non ci sono destinatari falliti per un problema di collegamento.' });
  }

  const rimetti = db.prepare("UPDATE campaign_messages SET status = 'in_attesa', error = NULL, sent_at = NULL WHERE id = ?");
  const applica = db.transaction((righe) => {
    for (const r of righe) rimetti.run(r.id);
    // `failed` va scalato, altrimenti i conteggi non tornano più con le righe vere.
    db.prepare('UPDATE campaigns SET failed = MAX(0, failed - ?) WHERE id = ?').run(righe.length, id);
    // Un invio dato per «completata» deve tornare riprendibile, o il ▶️ non compare.
    if (campaign.status === 'completata') {
      db.prepare("UPDATE campaigns SET status = 'in_pausa', pause_reason = ?, auto_resume = 0 WHERE id = ?")
        .run(`${righe.length} destinatari rimessi in coda: erano falliti per un problema di collegamento. Premi ▶️ per inviarglielo.`, id);
    }
  });
  applica(daRiprovare);

  console.log(`Invio ${id}: ${daRiprovare.length} destinatari rimessi in attesa (errori di collegamento).`);
  res.json({ ok: true, rimessi: daRiprovare.length });
});

app.get('/api/campaigns/:id', (req, res) => {
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Campagna non trovata' });
  campaign.messages = db
    .prepare('SELECT * FROM campaign_messages WHERE campaign_id = ? ORDER BY id')
    .all(req.params.id);
  campaign.restanti = campaign.messages.filter((m) => m.status === 'in_attesa').length;
  // Quanti «non riusciti» sono in realtà colpa del collegamento e si possono rimettere in coda.
  // Il conto lo fa il server con la STESSA funzione usata durante l'invio: una copia della
  // regola nel frontend prima o poi si disallineerebbe.
  campaign.riprovabili = campaign.messages
    .filter((m) => m.status === 'errore' && erroreDiCollegamento(m.error)).length;
  res.json(campaign);
});

// ===========================================================================
//  BOT PRENOTAZIONI
// ===========================================================================
//  Il motore sta in `bot-prenotazioni.js`. Qui c'è solo il ponte verso
//  WhatsApp e le API della pagina.
//
//  Il `require` è dentro un try: se quel file mancasse (un aggiornamento a
//  metà, un pacchetto incompleto) iStudio deve continuare a mandare messaggi
//  e newsletter come sempre. Un errore di caricamento all'avvio spegnerebbe
//  la piattaforma di TUTTI i clienti per una funzione che magari non usano.
let bot = null;
try {
  bot = require('./bot-prenotazioni.js');
  bot.preparaDatabase(db);
  console.log('Bot prenotazioni: motore caricato');
} catch (e) {
  console.error('Bot prenotazioni non disponibile:', e.message);
  bot = null;
}

const botDisponibile = () => bot !== null;

// Sulla copia di lavoro (MASTER) il bot c'è sempre. Sulle copie dei clienti
// si accende solo se il seriale porta la funzione «bot»: e' cosi' che diventa
// una cosa da vendere invece che un regalo a tutti alla prima pubblicazione.
const botPermesso = () => !modalitaAbbonamento || abbonamento.funzioni.includes('bot');
// Con l'abbonamento scaduto il bot si ferma, come le pagine. Prima si fermavano
// solo quelle: il bot continuava a rispondere ai clienti e a prendere
// prenotazioni, cioè proprio la cosa che si vende.
const abbonamentoAttivo = () => !modalitaAbbonamento || abbonamento.valido;
// ⚠️ La LICENZA da sola: motore caricato, bot compreso nel seriale, abbonamento
// non scaduto — senza l'interruttore quotidiano del ristoratore. È il cancello
// dei lavori sui soldi: chi ha appena pagato va confermato anche se stasera il
// bot è spento; ma su una copia che il bot non lo ha, o è scaduta, non si crea
// nessun collegamento e non si scrive a nessuno. Fino a qui i tre lavori del
// pagamento guardavano solo «motore caricato», e su un cliente che al rinnovo
// aveva perso il bot continuavano a mandare messaggi: la porta bloccata e la
// finestra aperta.
const botConcesso = () => botDisponibile() && botPermesso() && abbonamentoAttivo();
const botAcceso = () => botConcesso() && bot.boolDi(bot.leggi(db, 'bot_attivo'));

// I numeri del personale: ricevono gli avvisi e sono SEMPRE esclusi dal
// percorso di prenotazione. Se il responsabile scrive al locale, il bot non
// deve chiedergli per quante persone vuole un tavolo.
function personale() {
  if (!botDisponibile()) return [];
  return db.prepare('SELECT * FROM bot_personale').all()
    .map((p) => ({ ...p, telefono: normalizePhone(p.telefono) }));
}
function eDelPersonale(telefono) {
  return personale().some((p) => telefono && p.telefono === telefono);
}

// Trova la persona del personale che sta scrivendo. Si riconosce dal numero
// oppure dall'indirizzo della chat, imparato la prima volta: con gli indirizzi
// `@lid` il numero può non arrivare mai, e senza questa seconda strada il
// responsabile resterebbe per sempre un cliente qualunque agli occhi del bot.
function personaCheScrive(telefono, chatId) {
  const elenco = personale();
  const perIndirizzo = elenco.find((p) => p.chat_id && p.chat_id === chatId);
  if (perIndirizzo) return perIndirizzo;
  const perNumero = elenco.find((p) => telefono && p.telefono === telefono);
  if (perNumero && chatId && perNumero.chat_id !== chatId) {
    db.prepare('UPDATE bot_personale SET chat_id = ? WHERE id = ?').run(chatId, perNumero.id);
    annota('personale', `${perNumero.nome}: imparato l'indirizzo della sua chat`);
  }
  return perNumero || null;
}

// Riconoscere i propri messaggi. Serve alla PRESA IN CARICO: un messaggio
// uscito dal numero del locale che il bot non ha mandato lui vuol dire che una
// persona sta rispondendo a mano, e allora il bot deve tacere.
//
// ⚠️ L'id da solo NON basta, ed è costato una mattinata. WhatsApp annuncia il
// messaggio in uscita PRIMA che `sendMessage()` restituisca il suo id: per
// qualche istante il bot non riconosce come propria la risposta che sta
// mandando in quel momento, si scambia per una persona e si zittisce da solo
// per sei ore. Dal registro sembrava che qualcuno avesse risposto a mano.
//
// Quindi si segna il testo PRIMA di inviarlo, e lo si riconosce anche da
// quello. Le tracce scadono da sole: servono per pochi secondi.
const mieiMessaggi = new Set();
const testiInviati = [];
function segnaCheStoInviando(chatId, testo) {
  testiInviati.push({ chatId: String(chatId), testo: String(testo), quando: Date.now() });
  while (testiInviati.length > 60) testiInviati.shift();
}
function loHoMandatoIo(chatId, testo, id) {
  if (id && mieiMessaggi.has(id)) return true;
  const adesso = Date.now();
  const i = testiInviati.findIndex((t) =>
    adesso - t.quando < 60000 && t.chatId === String(chatId) && t.testo === String(testo));
  if (i === -1) return false;
  testiInviati.splice(i, 1);
  return true;
}

// ---------- Che cosa è questa conversazione ----------
// WhatsApp identifica le chat con un indirizzo, non con un numero, e i formati
// sono cambiati nel tempo: alle chat singole di sempre (`@c.us`) si sono
// aggiunte quelle con identificativo collegato (`@lid`). Il primo controllo
// scritto qui conosceva solo `@c.us` e scambiava per gruppo ogni conversazione
// normale in formato nuovo — il bot riceveva i messaggi e li buttava.
//
// La garanzia importante resta: si risponde SOLO alle conversazioni fra due
// persone. Gruppi, stati, liste broadcast e canali non ricevono mai niente.
function tipoChat(id) {
  const x = String(id || '');
  if (x.endsWith('@g.us')) return 'gruppo';
  if (x.endsWith('@broadcast')) return 'stato';
  if (x.endsWith('@newsletter')) return 'canale';
  if (x.endsWith('@c.us') || x.endsWith('@lid')) return 'privata';
  return 'sconosciuto';
}

// Il numero leggibile del mittente, quando si riesce a saperlo. Con gli
// indirizzi `@lid` il numero non sta nell'indirizzo: WhatsApp lo mette (a
// volte) in un campo a parte. Se non c'è, meglio tenersi l'indirizzo che
// inventare un numero sbagliato — finirebbe stampato su una prenotazione.
// Le cifre dentro un indirizzo `@lid` NON sono un numero di telefono: sono un
// identificativo interno di WhatsApp, e assomigliano abbastanza a un numero da
// passare per tale. E' successo davvero: in tabella e' comparso
// «📞 +120839039090895», e il responsabile di sala non veniva piu' riconosciuto
// perche' il confronto col suo numero vero non tornava mai.
function eIdentificativoInterno(cifre, chatId) {
  const daLid = String(chatId || '').includes('@lid')
    ? String(chatId).replace(/@.*$/, '').replace(/\D/g, '')
    : '';
  if (daLid && cifre === daLid) return true;
  // I numeri di telefono nel mondo arrivano a 15 cifre col prefisso, ma quelli
  // veri che passano di qui ne hanno 10-13. Sopra le 14 e' quasi certamente un
  // identificativo, e nel dubbio si preferisce non avere il numero che averne
  // uno inventato.
  return cifre.length > 14;
}

function numeroPlausibile(cifre, chatId) {
  return cifre.length >= 8 && cifre.length <= 14 && !eIdentificativoInterno(cifre, chatId);
}

// ⚠️ La stessa persona può comparire in archivio con PIÙ indirizzi: WhatsApp
// usa `@lid` per le chat nuove e `@c.us` per quelle di sempre, e chi risponde
// a mano dal telefono del locale fa scattare il silenzio sull'indirizzo che ha
// in mano lui, che non è per forza quello da cui il cliente scrive.
//
// Da qui un guaio visto in prova: «LIBERA R1» rispondeva ✅ ma il bot restava
// muto. Aveva liberato UN indirizzo — quello scritto nella richiesta — mentre
// il silenzio stava su un altro indirizzo della stessa persona. Il comando
// diceva di aver fatto una cosa che non aveva fatto, ed è il tipo di bugia
// peggiore: chi lo usa non ha modo di accorgersene.
//
// Quindi: quando si tocca il silenzio di una conversazione, si toccano TUTTI
// gli indirizzi con cui quella conversazione può comparire.
function formeDelNumero(valore) {
  const s = String(valore || '').trim();
  if (!s) return [];
  const forme = new Set([s]);
  const cifre = s.replace(/@.*$/, '').replace(/\D/g, '');
  // Un identificativo interno di WhatsApp non è un numero: dai suoi zeri e uni
  // non si ricava nessun «@c.us», e provarci accosterebbe due persone diverse.
  if (numeroPlausibile(cifre, s)) {
    forme.add(cifre);
    forme.add(cifre + '@c.us');
  }
  return [...forme];
}

function chiaviStessaConversazione(...valori) {
  const chiavi = new Set();
  for (const v of valori) for (const f of formeDelNumero(v)) chiavi.add(f);
  // Le richieste tengono insieme le due facce della stessa conversazione
  // (l'indirizzo della chat e il numero): è l'unico posto dove un `@lid` e un
  // numero risultano essere la stessa persona, e va letto invece che indovinato.
  for (const r of db.prepare('SELECT telefono, chat_id FROM bot_richieste').all()) {
    if (chiavi.has(String(r.chat_id || '')) || chiavi.has(String(r.telefono || ''))) {
      for (const f of formeDelNumero(r.chat_id)) chiavi.add(f);
      for (const f of formeDelNumero(r.telefono)) chiavi.add(f);
    }
  }
  chiavi.delete('');
  return [...chiavi];
}

// Toglie il silenzio su tutti gli indirizzi di quella conversazione e dice
// QUANTE ne ha davvero liberate: zero è un'informazione, non un dettaglio.
function ridaiLaParola(...valori) {
  let cambiate = 0;
  for (const chiave of chiaviStessaConversazione(...valori)) {
    cambiate += db.prepare(
      'UPDATE bot_conversazioni SET muto_fino = NULL WHERE telefono = ? AND muto_fino IS NOT NULL'
    ).run(chiave).changes;
  }
  return cambiate;
}

// «Ti risponde una persona»: per chi risponde dal telefono del locale, o dalla
// scheda Chat. Lì nessuno scrive un codice e nessuno si presenta: lo fa il bot
// per lui, UNA volta per presa in carico, subito DOPO la sua prima risposta —
// non prima, perché quando il bot se ne accorge la risposta è già partita.
// Mai a chi ha scritto STOP. Con la frase vuota il passaggio non si nota.
async function annunciaLaPersona(chatId, telefono, ore) {
  if (!botDisponibile()) return false;
  const cfg = bot.config(db);
  const testo = bot.riempi(cfg.bot_t_ingresso_locale || '', { locale: cfg.bot_locale || 'noi' });
  if (!testo.trim()) return false;
  // Già detto in questa presa in carico — da qui, o col codice R: un cliente
  // che se lo sente dire due volte pensa che ci siano due persone.
  const chiavi = chiaviStessaConversazione(chatId, telefono);
  if (chiavi.some((k) => bot.personaAnnunciata(db, k, ore, new Date()))) return false;
  if (bot.haDettoBasta(db, chatId, telefono)) return false;
  for (const k of chiavi) bot.segnaPersona(db, k, new Date());
  try {
    await rispondiConRitmo(chatId, testo);
    return true;
  } catch (e) {
    console.error('Bot: annuncio della persona non partito:', e.message);
    return false;
  }
}

// Quando il bot viene riattivato DALLA PIATTAFORMA — «Riattiva il bot» o
// «Sblocca» — al cliente si dice che la persona ha finito, come su LIBERA, e
// con gli stessi paletti: solo negli orari in cui qualcuno legge, mai a chi
// ha scritto STOP, e solo se un silenzio c'era davvero. Mai sulle scadenze
// automatiche: quelle restano mute (arriverebbe di notte, su una cosa già
// dimenticata). Con la frase vuota non si dice niente.
async function salutaIlRitorno(chiave) {
  if (!botDisponibile()) return false;
  const chiavi = chiaviStessaConversazione(chiave);
  for (const k of chiavi) bot.scordaPersona(db, k);
  const cfg = bot.config(db);
  const testo = bot.riempi(cfg.bot_t_uscita_locale || '',
    { locale: cfg.bot_locale || 'noi', assistente: cfg.bot_assistente || '' });
  if (!testo.trim()) return false;
  if (!bot.eOrarioAvvisi(cfg, new Date())) return false;
  const cifre = String(chiave).replace(/@.*$/, '').replace(/\D/g, '');
  if (bot.haDettoBasta(db, chiave, numeroPlausibile(cifre, chiave) ? cifre : '')) return false;
  try {
    await inviaBot(chiave, testo);
    return true;
  } catch (e) {
    console.error('Bot: saluto di ritorno non riuscito:', e.message);
    return false;
  }
}

// Chi è questa conversazione, per mostrarla nell'elenco di quelle su cui il
// bot tace — senza questo si vedrebbe solo un indirizzo tecnico illeggibile
// («98071434281145@lid»), e non si capirebbe MAI di chi si tratta.
//
// Si cerca prima fra le prenotazioni (è il posto con più probabilità di avere
// un nome vero, essendo scritto dal cliente stesso), poi fra i nomi imparati
// dalla rubrica di WhatsApp. Se non si trova niente, meglio dirlo che
// inventare: è lo stesso principio già seguito per i numeri.
function identitaPerChiave(chiave) {
  const daPrenotazione = db.prepare(
    'SELECT nome, cognome FROM prenotazioni WHERE chat_id = ? OR telefono = ? ORDER BY id DESC LIMIT 1'
  ).get(chiave, chiave);
  const cifre = String(chiave).replace(/@.*$/, '').replace(/\D/g, '');
  const numero = numeroPlausibile(cifre, chiave) ? cifre : '';
  if (daPrenotazione) {
    const nome = [daPrenotazione.nome, daPrenotazione.cognome].filter(Boolean).join(' ');
    if (nome) return { nome, telefono: numero };
  }
  if (numero) {
    const daRubrica = db.prepare('SELECT nome FROM numeri_visti WHERE telefono = ?').get(numero);
    if (daRubrica) return { nome: daRubrica.nome, telefono: numero };
  }
  return { nome: '', telefono: numero };
}

function numeroLeggibile(msg, chatId) {
  const dati = (msg && msg._data) || {};
  // `senderPn` è il numero vero che WhatsApp allega alle chat in formato `@lid`
  const candidati = [dati.senderPn, dati.notifyNumber, msg && msg.author, chatId];
  for (const c of candidati) {
    const testo = String(c || '');
    if (!testo || testo.includes('@lid')) continue;   // mai dall'indirizzo interno
    const soloCifre = testo.replace(/@.*$/, '').replace(/\D/g, '');
    if (!numeroPlausibile(soloCifre, chatId)) continue;
    if (testo.includes('@c.us') || !testo.includes('@')) return soloCifre;
  }
  return '';
}

// Il numero vero del mittente. `numeroLeggibile()` lo ricava dall'indirizzo
// quando c'è; con gli indirizzi `@lid` non c'è affatto, e allora lo si chiede
// a WhatsApp — è l'unico modo di sapere chi sta scrivendo.
//
// Senza questo, due cose si rompevano insieme: il responsabile di sala non
// veniva riconosciuto come tale (e il bot gli chiedeva per quante persone
// voleva prenotare), e nella tabella delle prenotazioni al posto del numero
// del cliente compariva l'indirizzo interno di WhatsApp.
async function numeroDelMittente(msg, chatId) {
  const diretto = numeroLeggibile(msg, chatId);
  if (diretto) return diretto;
  try {
    const contatto = await msg.getContact();
    // `number` è il numero di telefono; `id.user` invece è l'identificativo, e
    // vale solo quando l'indirizzo è del tipo `c.us`. Prenderlo sempre è
    // esattamente l'errore che ha prodotto «+120839039090895».
    const candidati = [
      contatto && contatto.number,
      contatto && contatto.id && contatto.id.server === 'c.us' ? contatto.id.user : '',
    ];
    for (const c of candidati) {
      const pulito = String(c || '').replace(/\D/g, '');
      if (numeroPlausibile(pulito, chatId)) return pulito;
    }
  } catch (e) {
    // Non è un guasto: si continua senza numero, che è meglio che inventarlo.
    annota('avviso', `non riesco a leggere il numero di ${chatId}: ${e.message}`);
  }
  return '';
}

// Ricorda il numero di chi scrive, associato al nome con cui compare nella
// lista chat. È la fonte più affidabile che ci sia: il numero arriva insieme
// al messaggio, senza dover interrogare pagine che cambiano.
async function imparaNumero(msg, chatId) {
  if (!botDisponibile()) return '';
  try {
    const nome = (msg._data && msg._data.notifyName) || '';
    if (!nome) return '';
    const gia = db.prepare('SELECT telefono FROM numeri_visti WHERE nome = ?').get(nome);
    if (gia && gia.telefono) return gia.telefono;
    const numero = await numeroDelMittente(msg, chatId);
    if (!numero) return '';
    db.prepare("INSERT INTO numeri_visti (nome, telefono) VALUES (?, ?) "
      + "ON CONFLICT(nome) DO UPDATE SET telefono = excluded.telefono, visto_at = datetime('now','localtime')")
      .run(nome, numero);
    return numero;
  } catch { return ''; }
}

// Risponde DENTRO la conversazione da cui è arrivato il messaggio, usando
// l'indirizzo così com'è. È l'unico modo che funziona sia con `@c.us` sia con
// `@lid`: cercare di risalire al numero e poi ricomporre l'indirizzo fallisce
// proprio nei casi nuovi.
async function inviaAChat(chatId, testo) {
  if (state.status !== 'connesso') throw new Error('WhatsApp non collegato');
  return inCoda(async () => {
    segnaCheStoInviando(chatId, testo);
    const inviato = await client.sendMessage(chatId, testo);
    if (inviato && inviato.id && inviato.id._serialized) mieiMessaggi.add(inviato.id._serialized);
    return inviato;
  });
}

// «Sta scrivendo…»: il puntino che WhatsApp mostra in cima alla chat.
//
// ⚠️ NON è un messaggio — è uno stato della conversazione. Non entra nella coda
// degli invii, non conta per WhatsApp come traffico, e non costa niente a
// nessuno. È la differenza con un messaggio «attendi», che finirebbe nella
// stessa fila della risposta e arriverebbe quando la risposta sarebbe già
// arrivata: con dieci clienti insieme, il decimo lo riceverebbe al secondo 15,
// cioè esattamente quando avrebbe già avuto la risposta.
//
// Se fallisce non importa: è un ornamento, non un messaggio. Mai fermare una
// risposta perché non si è riusciti ad accendere un puntino.
async function staScrivendo(chatId) {
  try { const c = await client.getChatById(chatId); await c.sendStateTyping(); } catch {}
}
async function hoFinitoDiScrivere(chatId) {
  try { const c = await client.getChatById(chatId); await c.clearState(); } catch {}
}

let ultimoInvioChat = 0;
async function rispondiConRitmo(chatId, testo) {
  const minimo = pauseDisattivate() ? 0 : 1500;
  const passati = Date.now() - ultimoInvioChat;
  if (passati < minimo) await sleep(minimo - passati);
  ultimoInvioChat = Date.now();
  return inviaAChat(chatId, testo);
}

// Invio singolo. Passa da `inCoda` come tutto il resto che tocca WhatsApp
// Web: due operazioni insieme si pestano i piedi.
async function inviaBot(telefono, testo) {
  if (state.status !== 'connesso') throw new Error('WhatsApp non collegato');
  // Se è già un indirizzo di chat si usa così com'è: cercare di ricavarne un
  // numero e poi ricomporlo è proprio il giro che si rompe con gli `@lid`.
  if (String(telefono).includes('@')) return inviaAChat(telefono, testo);
  return inCoda(async () => {
    const numberId = await client.getNumberId(normalizePhone(telefono));
    if (!numberId) throw new Error('Numero non registrato su WhatsApp');
    segnaCheStoInviando(numberId._serialized, testo);
    const inviato = await client.sendMessage(numberId._serialized, testo);
    if (inviato && inviato.id && inviato.id._serialized) mieiMessaggi.add(inviato.id._serialized);
    return inviato;
  });
}

// Le risposte del bot NON partono a raffica: passano dalle stesse pause
// studiate per le campagne. Un numero che risponde a venti persone in venti
// secondi somiglia a un centralino automatico, ed è così che si finisce
// bloccati proprio mentre il locale ne ha bisogno.
let ultimoInvioBot = 0;
async function inviaConRitmo(telefono, testo) {
  const minimo = pauseDisattivate() ? 0 : 1500;
  const passati = Date.now() - ultimoInvioBot;
  if (passati < minimo) await sleep(minimo - passati);
  ultimoInvioBot = Date.now();
  return inviaBot(telefono, testo);
}

// ---------- Registro del bot ----------
// Le ultime cose successe, con il MOTIVO quando il bot ha deciso di tacere.
// Serve a rispondere all'unica domanda che si fa davvero quando qualcosa non
// va: «perché non ha risposto?». Senza questo si tira a indovinare fra dieci
// cause possibili, tutte invisibili. Sta in memoria e basta: sono briciole
// per capire l'ultima mezz'ora, non uno storico da conservare.
const registroBot = [];
function annota(evento, dettaglio) {
  registroBot.unshift({
    ora: new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    evento, dettaglio: String(dettaglio || '').slice(0, 160),
  });
  if (registroBot.length > 60) registroBot.pop();
  // Finisce anche nel registro tecnico (~/Library/Logs/istudio.log sul Mac):
  // quello resta anche dopo un riavvio, e si può leggere a distanza mentre
  // qualcun altro fa le prove col telefono.
  console.log(`Bot [${evento}] ${dettaglio || ''}`);
}

// ---------------------------------------------------------------------------
//  I lavori automatici che si fermano
// ---------------------------------------------------------------------------
//  ⚠️ IL GUASTO. Promemoria, recensioni, lista d'attesa e risposte arretrate
//  cominciavano tutti con la stessa riga — «se WhatsApp non è collegato,
//  torna» — e non scrivevano NIENTE da nessuna parte. Un mini-PC con WhatsApp
//  staccato smetteva di ricordare i tavoli e nel registro non restava una
//  riga: zero messaggi, zero errori, zero tracce. Chi guardava vedeva le
//  impostazioni accese e credeva che stesse funzionando.
//
//  E non è un danno che si recupera: il promemoria di una serata lo si manda
//  il giorno prima o mai più.
// ⚠️ DUE cancelli, e vanno tenuti distinti. Questo qui è quello che ferma
// TUTTO, su qualunque strada: il motore che non c'è, l'abbonamento che non
// comprende il bot, il bot spento dal ristorante. Sono decisioni, non guasti
// passeggeri, e non si aggirano.
function motivoPerCuiNonSiFaNiente() {
  if (!botDisponibile()) return 'il motore del bot non è caricato';
  if (!botConcesso()) return "il bot non è compreso in questo abbonamento, o l'abbonamento è scaduto";
  if (!bot.boolDi(bot.leggi(db, 'bot_attivo'))) return 'il bot è spento';
  return '';
}

// Questo invece è il cancello di WHATSAPP: comprende quello qui sopra e ci
// aggiunge lo stato della linea. Chi manda un messaggio in chat passa di qui.
// ⚠️ Chi manda un'EMAIL no: la posta non c'entra niente col telefono, e
// resta l'unica via che funziona quando l'altra è caduta — lo stesso
// ragionamento dell'avviso di scollegamento.
function motivoPerCuiNonSiManda() {
  const sempre = motivoPerCuiNonSiFaNiente();
  if (sempre) return sempre;
  // ⚠️ L'avvio NON è un guasto. Nei primi secondi dopo un riavvio WhatsApp è
  // sempre «in inizializzazione»: dirlo vorrebbe dire un falso allarme nel
  // registro a ogni accensione, e un registro che grida al lupo non lo legge
  // più nessuno. Ferma i lavori, ma in silenzio.
  if (state.status === 'inizializzazione') return 'avvio';
  if (state.status !== 'connesso') return 'WhatsApp non è collegato';
  return '';
}

// Si dice UNA VOLTA, non ogni minuto: sessanta righe uguali all'ora
// cancellerebbero dal registro tutto il resto.
let motivoGiaDetto = '';
function lavoriFermi(motivo) {
  if (motivo === 'avvio' || motivo === motivoGiaDetto) return;
  motivoGiaDetto = motivo;
  annota('fermi', `i lavori automatici non partono: ${motivo}. `
    + "Promemoria, recensioni, lista d'attesa e risposte arretrate restano indietro");
}
function lavoriRipartiti() {
  if (!motivoGiaDetto) return;
  motivoGiaDetto = '';
  annota('fermi', 'i lavori automatici sono ripartiti');
}

// ⚠️ E i giri automatici avevano tutti «.catch(() => {})»: se uno scoppiava,
// l'errore spariva per sempre, ogni minuto, in silenzio. Questo lo scrive —
// una volta sola, che è quello che serve per capire.
const giroFallito = (quale) => (e) => {
  const m = String((e && e.message) || e);
  console.error(`Bot [${quale}]`, m);
  if (motivoGiaDetto === m) return;
  motivoGiaDetto = m;
  annota('errore', `${quale}: il giro automatico è scoppiato (${m})`);
};

function giaVisto(id) {
  if (!id) return false;
  const esiste = db.prepare('SELECT id FROM bot_visti WHERE id = ?').get(id);
  if (esiste) return true;
  db.prepare('INSERT OR IGNORE INTO bot_visti (id) VALUES (?)').run(id);
  return false;
}

// Codici brevi per le richieste passate a una persona. Stesso alfabeto senza
// caratteri ambigui dei codici di installazione: vanno letti di fretta, in
// sala, su uno schermo piccolo.
// ⚠️ Il codice non si riusa appena si libera. Prima si ripartiva sempre da R1
// e si prendeva il primo numero non occupato: chiusa R2, il cliente successivo
// diventava R2 anche lui. Su un telefono si risponde scorrendo indietro fino
// all'avviso che si è visto — e quella risposta sarebbe partita **a un altro
// cliente**, con il responsabile convinto di aver risposto al primo.
//
// Quindi si riparte dal numero più alto usato negli ultimi due giorni, più
// uno: dentro un servizio un codice non torna mai. Si ricomincia da R1 solo
// dopo due giorni di silenzio (o dopo R999), quando l'avviso vecchio è sepolto
// sotto altri messaggi e nessuno ci risponderebbe più.
function nuovoCodice() {
  // ⚠️ «non chiusa»: una conversazione a cui si è già risposto è ancora VIVA
  // finché non arriva LIBERA. Contando solo le «in attesa», il suo codice
  // risultava libero e poteva essere dato a un altro cliente — e la risposta del
  // responsabile sarebbe partita alla persona sbagliata.
  const aperti = new Set(db.prepare("SELECT codice FROM bot_richieste WHERE stato != 'chiusa'")
    .all().map((r) => r.codice));
  const recenti = db.prepare(
    "SELECT codice FROM bot_richieste WHERE creata_at >= datetime('now','localtime','-2 days')"
  ).all().map((r) => parseInt(String(r.codice).replace(/\D/g, ''), 10)).filter(Number.isFinite);
  const massimo = recenti.length ? Math.max(...recenti) : 0;

  for (let n = 0; n < 999; n++) {
    const numero = ((massimo + n) % 999) + 1;   // …997, 998, 999, poi di nuovo 1
    const c = 'R' + numero;
    if (!aperti.has(c)) return c;
  }
  // Mille conversazioni aperte insieme non succede, ma se succedesse meglio un
  // codice strano che uno già in uso da qualcun altro.
  return 'R' + Date.now().toString().slice(-4);
}

// ---------------------------------------------------------------------------
//  La conversazione agganciata a chi la sta seguendo
// ---------------------------------------------------------------------------
//  Chi ha risposto a R1 continua a scrivere NORMALMENTE, senza rimettere il
//  codice davanti a ogni riga: tutto quello che scrive arriva a quel cliente,
//  fino a LIBERA. In servizio, ricordarsi un codice a ogni messaggio non lo fa
//  nessuno — e infatti succedeva di scrivere la risposta senza codice, sentirsi
//  dire «serve il codice», e riscriverla.
//
//  ⚠️ QUESTO È IL PUNTO PERICOLOSO DEL PROGRAMMA, e va tenuto a mente ogni volta
//  che si tocca: con l'aggancio attivo, un pensiero buttato lì nella chat parte
//  DAVVERO al cliente. È esattamente il rischio che il codice obbligatorio
//  evitava. Si accetta solo perché tutte queste cose sono vere insieme:
//    • l'aggancio lo crea la persona, rispondendo — non nasce da solo;
//    • le viene detto a chiare lettere quando comincia, e come finirlo;
//    • ogni messaggio inoltrato ha la sua conferma: non c'è dubbio su dove è andato;
//    • scade da solo dopo mezz'ora di silenzio;
//    • i COMANDI restano comandi, sempre (vedi dove sta l'inoltro: in fondo).
const AGGANCIO_MINUTI = 30;

function agganciaConversazione(rich, persona, adesso = new Date()) {
  db.prepare('UPDATE bot_richieste SET presa_da = ?, presa_at = ? WHERE id = ?')
    .run(persona.chat_id || persona.telefono, adesso.toLocaleString('sv-SE'), rich.id);
}

// Questa riga è seguita da qualcuno, adesso? Stessa regola di scadenza di
// «conversazioneAgganciata», letta dall'altro lato: dalla conversazione invece
// che dalla persona.
function aggancioVivo(rich, adesso = new Date()) {
  if (!rich || !rich.presa_da || !rich.presa_at) return false;
  const quando = new Date(String(rich.presa_at).replace(' ', 'T'));
  if (Number.isNaN(quando.getTime())) return false;
  return (adesso - quando) / 60000 < AGGANCIO_MINUTI;
}

// La conversazione che questa persona sta seguendo adesso, se c'è.
// ⚠️ L'aggancio SCADE. Chi si dimentica LIBERA e torna il giorno dopo a scrivere
// «ok» non deve vederselo arrivare al cliente di ieri.
function conversazioneAgganciata(persona, adesso = new Date()) {
  const chiave = persona.chat_id || persona.telefono;
  if (!chiave) return null;
  const rich = db.prepare(
    "SELECT * FROM bot_richieste WHERE presa_da = ? AND stato != 'chiusa' ORDER BY id DESC LIMIT 1"
  ).get(chiave);
  if (!rich || !rich.presa_at) return null;
  const quando = new Date(String(rich.presa_at).replace(' ', 'T'));
  if (Number.isNaN(quando.getTime())) return null;
  if ((adesso - quando) / 60000 >= AGGANCIO_MINUTI) return null;
  return rich;
}

// ⚠️ Una conversazione «risposta» non è viva per sempre. Da quando il codice
// resta fino a LIBERA, le righe in stato «risposta» contano come aperte — ma
// LIBERA non lo scrive quasi nessuno, quindi senza questo ogni cliente a cui si
// è mai risposto resterebbe «vivo» per sempre. Due danni, misurati con una
// prova: dopo 999 risposte nuovoCodice() sputa «R6078», che nessun comando
// riconosce; e «serve il codice» proporrebbe di copiare «R997 …» — una
// conversazione di dieci giorni fa, cioè la risposta al cliente SBAGLIATO.
// La finestra giusta è quella del silenzio: passate quelle ore il bot
// risponde di nuovo lui, e la conversazione a mano è finita comunque.
function chiudiConversazioniFinite() {
  const ore = Math.max(1, bot.num(bot.leggi(db, 'bot_silenzio_ore'), 6));
  return db.prepare(
    "UPDATE bot_richieste SET stato = 'chiusa', presa_da = NULL WHERE stato = 'risposta' "
    + `AND (risposta_at IS NULL OR risposta_at < datetime('now','localtime','-${ore} hours'))`
  ).run().changes;
}

// Passa una conversazione a una persona: avvisa il cliente e il personale.
async function passaAUnaPersona(chatId, telefono, nomeChat, testo, opzioni = {}) {
  const cfg = bot.config(db);
  const aperto = bot.eOrarioAvvisi(cfg, new Date());

  // Se quella conversazione è già in mano a qualcuno si tiene lo STESSO
  // codice: cambiarlo a ogni messaggio riempirebbe il telefono del
  // responsabile di codici diversi per la stessa persona, e a quel punto non
  // saprebbe più a chi sta rispondendo.
  // ⚠️ «non chiusa», NON «in attesa». Appena il responsabile rispondeva, quella
  // riga passava a «risposta» e il messaggio successivo dello stesso cliente
  // non la trovava più: si apriva un codice NUOVO, e così a ogni giro — R1, R2,
  // R3 per la stessa persona. Tre danni, tutti visti leggendo il codice:
  //   • la risposta non parte: scrivi «R1 arriviamo» quando ormai è R3 e ti
  //     senti dire «non ho nessuna richiesta col codice R1». Tu credi di aver
  //     risposto, il cliente aspetta;
  //   • «LIBERA R1» chiude R1 e lascia aperte R2 e R3;
  //   • il codice si poteva RIUSARE su un altro cliente (vedi nuovoCodice), e
  //     la risposta finiva alla persona sbagliata. Questo è il peggiore.
  // Il codice adesso è della conversazione, e muore solo con LIBERA.
  const aperta = db.prepare(
    "SELECT * FROM bot_richieste WHERE chat_id = ? AND stato != 'chiusa' ORDER BY id DESC LIMIT 1"
  ).get(chatId);
  const codice = aperta ? aperta.codice : nuovoCodice();
  if (aperta) {
    // Torna «in attesa»: c'è una domanda nuova senza risposta. Senza questo, chi
    // ha già risposto una volta non potrebbe più rispondere con quel codice.
    db.prepare("UPDATE bot_richieste SET testo = ?, stato = 'in_attesa' WHERE id = ?")
      .run(String(testo || '').slice(0, 500), aperta.id);
  } else {
    db.prepare('INSERT INTO bot_richieste (codice, telefono, chat_id, nome, testo) VALUES (?, ?, ?, ?, ?)')
      .run(codice, telefono || chatId, chatId, nomeChat || '', String(testo || '').slice(0, 500));
  }

  // Al cliente si dice «ti risponde una persona» UNA volta sola. Ripeterlo a
  // ogni messaggio mentre aspetta è il modo migliore per farlo sentire preso
  // in giro da una macchina.
  if (!opzioni.silenzioso) {
    try {
      await rispondiConRitmo(chatId, cfg[aperto ? 'bot_t_nonho_aperto' : 'bot_t_nonho_chiuso']);
    } catch (e) { console.error('Bot: non riesco a rispondere al cliente:', e.message); }
  }

  // ⚠️ Se qualcuno la sta seguendo, il messaggio gli arriva COME IN UNA CHAT:
  // «💬 Angela: sì, ti leggo bene» — e basta. Prima arrivava ogni volta il
  // blocco intero, con «per rispondere: R8 + la tua risposta» sotto: un
  // secondo dopo che il bot gli aveva detto «scrivi normalmente». Contraddirsi
  // a ogni riga è il modo più rapido per far smettere di fidarsi. Va SOLO a chi
  // la segue, non a tutti i responsabili — la conversazione è sua. E la
  // risposta del cliente tiene vivo l'aggancio: una chat che va avanti non deve
  // spegnersi a metà perché il conto dei trenta minuti guardava solo un lato.
  if (aperta && aggancioVivo(aperta, new Date())) {
    db.prepare('UPDATE bot_richieste SET presa_at = ? WHERE id = ?')
      .run(new Date().toLocaleString('sv-SE'), aperta.id);
    const chi = nomeChat || aperta.nome || (telefono ? '+' + telefono : codice);
    try {
      await inviaConRitmo(aperta.presa_da, `💬 ${chi}: ${String(testo || '').slice(0, 500)}`);
      annota('inoltrato', `${codice}: la risposta del cliente va a chi lo sta seguendo`);
    } catch (e) { console.error('Bot: inoltro al responsabile non riuscito:', e.message); }
    return;
  }

  if (!aperto) return;   // fuori orario l'avviso resta in coda: nessuno lo guarderebbe
  const avviso =
    `${aperta ? '💬 Continua la conversazione' : '🔔 Cliente in attesa'} — codice ${codice}\n\n` +
    `Da: ${nomeChat || telefono || 'sconosciuto'}${telefono ? ' (+' + telefono + ')' : ''}\n` +
    `Ha scritto: «${String(testo || '').slice(0, 300)}»\n` +
    `Ricevuto: ${new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}\n\n` +
    // ⚠️ Due righe, non sei. Questo avviso si legge in mezzo al servizio, col
    // telefono in una mano: l'esempio («R1 Certo, la aspettiamo!») insegna la
    // prima volta e le altre venti è roba da scorrere. La forma del comando si
    // vede lo stesso, ed è tutto quello che serve ricordare.
    `👉 Per rispondere: ${codice} + la tua risposta\n` +
    `⚠️ Per attivare il bot scrivi: LIBERA ${codice}`;
  // Solo a chi ha il compito di rispondere ai clienti. Chi vuole soltanto
  // sapere le prenotazioni non deve essere svegliato da ogni domanda: sono
  // due mestieri diversi, e confonderli fa smettere di guardare gli avvisi.
  const responsabili = personale().filter((p) => p.gestisce && p.canale !== 'email');
  if (!responsabili.length) {
    annota('avviso', 'nessun responsabile configurato: la richiesta resta in attesa e nessuno lo sa');
  }
  for (const p of responsabili) {
    try {
      // ⚠️ A chi sta GIÀ seguendo un altro cliente va detto chiaro: le sue
      // righe senza codice vanno a quello, non a questo. È il momento in cui
      // si risponde al cliente sbagliato, e va disinnescato qui, nell'avviso.
      const altra = conversazioneAgganciata(p, new Date());
      const nota = altra && altra.codice !== codice
        ? `\n\n✍️ Stai seguendo ${altra.codice} (${altra.nome || 'cliente'}): quello che scrivi senza codice `
          + `va a ${altra.nome ? altra.nome.split(' ')[0] : 'quel cliente'}. Per rispondere qui: ${codice} + la tua risposta.`
        : '';
      await inviaConRitmo(p.chat_id || p.telefono, avviso + nota);
      db.prepare("UPDATE bot_richieste SET avvisata_at = datetime('now','localtime') WHERE codice = ? AND stato = 'in_attesa'").run(codice);
    } catch (e) { console.error('Bot: avviso al personale non riuscito:', e.message); }
  }
}

// I messaggi che arrivano DAL personale. Due casi: la risposta a un cliente
// (col codice) e l'appello di fine serata.
// I comandi del responsabile, scritti UNA volta sola. Questa lista è insieme
// quello che il bot stampa e quello che le prove confrontano coi rami veri di
// messaggioDelPersonale: una parola che finisce qui senza esistere davvero è
// la bugia peggiore che possa fare un aiuto — chi la legge la prova, non
// funziona, e da lì in poi non si fida più nemmeno del resto.
//
// ⚠️ Fuori di proposito: l'appello di fine serata («TUTTI OK» e i numeri di
// chi non si è presentato). Il ramo che lo legge esiste, ma niente apre mai
// l'appello: finché non lo apre qualcosa, scriverlo qui vorrebbe dire
// insegnare un comando che non risponde.
const COMANDI_SALA = [
  {
    titolo: '📖 Vedere le prenotazioni',
    righe: [
      { parola: 'PRENOTAZIONI', spiega: 'quelle di stasera' },
      { parola: 'PRENOTAZIONI DOMANI', spiega: 'un altro giorno — va bene anche «PRENOTAZIONI sabato»' },
      { parola: 'LISTA', spiega: 'tutte quante, da oggi in avanti' },
    ],
  },
  {
    titolo: '✍️ Prenderne una tu',
    righe: [
      { parola: 'NUOVA', spiega: 'te la chiedo passo per passo' },
      { parola: 'CANCELLA PRENOTAZIONE Rossi', spiega: 'la disdice e avvisa il cliente' },
    ],
  },
  {
    titolo: '🚫 Quando è tutto pieno',
    righe: [
      { parola: 'SOLD OUT sabato', spiega: 'quel giorno il bot risponde «non c\'è più posto» — vanno bene anche «oggi», «3 settembre», «2 3 4 settembre»' },
      { parola: 'SOLD OUT NO sabato', spiega: 'ci ripensi e il bot ricomincia a prendere prenotazioni' },
      { parola: 'SOLD OUT', spiega: 'quali giorni sono segnati adesso' },
    ],
  },
  {
    titolo: '💬 Un cliente che aspetta te',
    righe: [
      { parola: 'R1 il tavolo è libero alle 21',
        spiega: 'la tua risposta arriva al cliente del codice R1 — e da lì in poi gli scrivi normalmente, senza rimettere il codice davanti' },
      { parola: 'LIBERA R1', spiega: 'hai finito: da lì in poi gli risponde di nuovo il bot' },
    ],
  },
];

// La stampa dei comandi. In fondo, quando ce ne sono, chi sta aspettando
// davvero: un elenco di comandi che dice anche «adesso c'è R2 in attesa» si
// legge una volta e si usa subito, invece di doverselo ricordare.
function stampaComandi(db) {
  const pezzi = COMANDI_SALA.map((g) =>
    g.titolo + '\n' + g.righe.map((r) => `▸ ${r.parola}\n   ${r.spiega}`).join('\n'));
  const attese = db.prepare(
    "SELECT codice, nome FROM bot_richieste WHERE stato = 'in_attesa' ORDER BY id").all();
  if (attese.length) {
    pezzi.push('⏳ In attesa adesso\n'
      + attese.map((r) => `▸ ${r.codice} — ${r.nome || 'cliente senza nome'}`).join('\n'));
  }
  // ⚠️ Chi sta seguendo cosa, e SOPRATTUTTO che quello che scrive sta uscendo.
  // È la riga che conta quando si scrive di fretta: senza, uno non sa se il
  // prossimo messaggio finisce al cliente o resta qui.
  const seguite = db.prepare(
    "SELECT codice, nome, risposta_da FROM bot_richieste WHERE presa_da IS NOT NULL AND stato != 'chiusa' ORDER BY id"
  ).all();
  if (seguite.length) {
    pezzi.push('✍️ Seguite a mano adesso (quello che scrivono arriva al cliente)\n'
      + seguite.map((r) => `▸ ${r.codice} — ${r.nome || 'cliente senza nome'}`
        + (r.risposta_da ? ` · ${r.risposta_da}` : '')).join('\n')
      + '\nPer chiudere: LIBERA <codice>');
  }
  return '📋 *I comandi che capisco*\n\n' + pezzi.join('\n\n')
    + '\n\nScrivi COMANDI quando vuoi rivederli.';
}

// L'elenco di un giorno, chiesto in due modi diversi («PRENOTAZIONI sabato»
// oppure «DOMANI» da solo) che finiscono nello stesso posto. Scritto una volta
// sola perché i due rami stanno in punti diversi del dialogo: se si sdoppia,
// si sdoppia anche il modo di sbagliare.
async function mandaElenco(persona, parolaGiorno) {
  const adesso = new Date();
  const giorno = bot.interpretaData(parolaGiorno, adesso) || bot.comeData(adesso);
  annota('elenco', `${persona.nome} chiede le prenotazioni del ${giorno}`);
  await inviaConRitmo(persona.chat_id || persona.telefono,
    bot.elencoPrenotazioni(db, bot.config(db), giorno, adesso));
}

async function messaggioDelPersonale(persona, testo, msg) {
  const t = String(testo || '').trim();

  // «R7 la risposta» → inoltra al cliente dal numero del ristorante.
  // Il codice è OBBLIGATORIO anche con una sola richiesta in attesa: senza,
  // basta un pensiero scritto di getto nella stessa chat («questo rompe,
  // digli di no») e parte dritto al cliente, senza modo di richiamarlo.
  const conCodice = t.match(/^([Rr]\d{1,3})\s+([\s\S]+)$/);
  if (conCodice) {
    const codice = conCodice[1].toUpperCase();
    const risposta = conCodice[2].trim();
    const rich = db.prepare("SELECT * FROM bot_richieste WHERE codice = ? AND stato != 'chiusa' ORDER BY id DESC LIMIT 1").get(codice);
    if (!rich) {
      await inviaConRitmo(persona.chat_id || persona.telefono, `Non ho nessuna richiesta in attesa col codice ${codice}.`);
      return;
    }
    const cfg = bot.config(db);
    // La presentazione dice chi scrive, e si manda SOLO la prima volta: dalla
    // seconda in poi il cliente sa già con chi sta parlando, e rivederselo a
    // ogni riga fa sembrare che dall'altra parte non ci sia nessuno.
    const giaSua = rich.presa_da === (persona.chat_id || persona.telefono);
    const presentazione = giaSua
      ? '' : bot.riempi(cfg.bot_t_prefisso_umano, { nome: persona.nome, locale: cfg.bot_locale });
    // ⚠️ DUE messaggi, non uno solo con la presentazione incollata sopra.
    // Attaccata con un «a capo» sembrava che l'operatore avesse scritto tutto
    // insieme — «Sei in contatto con Daniele del team VERO Omakase. / ciao» in
    // una bolla sola — e la sua prima parola si perdeva dentro un cartello del
    // programma. Su WhatsApp la bolla è l'unità di lettura: l'annuncio è del
    // sistema, la risposta è della persona, e sono due cose diverse.
    if (presentazione) {
      // Conta come annuncio fatto anche per la strada del telefono del locale:
      // se poi risponde da lì, il cliente non si sente presentare due persone.
      for (const k of chiaviStessaConversazione(rich.chat_id, rich.telefono)) bot.segnaPersona(db, k, new Date());
      // ⚠️ Se l'annuncio non parte, la risposta deve partire LO STESSO: è
      // quella che il cliente sta aspettando. Perdere il contenuto per colpa
      // della cornice sarebbe il baratto sbagliato.
      try {
        await rispondiConRitmo(rich.chat_id || rich.telefono, presentazione);
      } catch (e) {
        console.error('Bot: la presentazione non è partita:', e.message);
        annota('avviso', `${codice}: presentazione non partita, la risposta parte comunque`);
      }
    }
    // Si risponde all'INDIRIZZO della conversazione, non a un numero
    // ricomposto: è l'unico modo che funziona con tutti i formati di WhatsApp.
    await rispondiConRitmo(rich.chat_id || rich.telefono, risposta);
    db.prepare("UPDATE bot_richieste SET stato = 'risposta', risposta = ?, risposta_at = datetime('now','localtime'), risposta_da = ? WHERE id = ?")
      .run(risposta, persona.nome, rich.id);
    // Chi ha risposto ha preso in carico la conversazione: il bot tace.
    bot.zittisci(db, rich.chat_id || rich.telefono, bot.num(cfg.bot_silenzio_ore, 6), new Date());
    // Da qui in poi quella conversazione è sua: può scrivere senza codice.
    agganciaConversazione(rich, persona);
    await inviaConRitmo(persona.chat_id || persona.telefono,
      `✅ Inviato a ${rich.nome || rich.telefono}`
      // ⚠️ Si dice la PRIMA volta, non a ogni risposta: ripeterlo a ogni riga
      // diventa rumore e si smette di leggerlo proprio quando conta.
      + (giaSua ? '' : `\n\nDa ora scrivi pure normalmente: quello che scrivi arriva a `
        + `${rich.nome || 'questo cliente'}, senza rimettere ${rich.codice} davanti.\n`
        + `Quando hai finito: LIBERA ${rich.codice}.`));
    return;
  }

  // «LIBERA R7» ridà la conversazione al bot. Senza, l'unico modo di far
  // riprendere il bot sarebbe aspettare le ore di silenzio — e il responsabile
  // resterebbe legato a quella chat anche quando ha finito.
  const libera = t.match(/^libera\s*([Rr]\d{1,3})?$/i);
  if (libera) {
    const codice = libera[1] ? libera[1].toUpperCase() : null;
    // ⚠️ «LIBERA» da solo libera la conversazione che QUESTA persona sta
    // seguendo. Prima prendeva l'ultima in attesa, chiunque la stesse seguendo:
    // con due responsabili al lavoro si liberava il cliente di un altro.
    const rich = codice
      ? db.prepare("SELECT * FROM bot_richieste WHERE codice = ? AND stato != 'chiusa' ORDER BY id DESC LIMIT 1").get(codice)
      : (conversazioneAgganciata(persona, new Date())
         || db.prepare("SELECT * FROM bot_richieste WHERE stato != 'chiusa' ORDER BY id DESC LIMIT 1").get());
    if (!rich) {
      await inviaConRitmo(persona.chat_id || persona.telefono, 'Non trovo nessuna conversazione da liberare.');
      return;
    }
    const liberate = ridaiLaParola(rich.chat_id, rich.telefono);
    db.prepare("UPDATE bot_richieste SET stato = 'chiusa' WHERE id = ?").run(rich.id);
    // ⚠️ Il cliente non riceveva NIENTE: stava parlando con una persona e al
    // messaggio dopo gli rispondeva di nuovo il bot, senza che nessuno gli
    // avesse detto che quella persona era andata via. Quattro paletti, e sono
    // la parte che conta più del messaggio:
    //  1. il nome è di chi ha RISPOSTO, non di chi scrive LIBERA: sono due
    //     persone diverse più spesso di quanto sembri — Marco chiude la
    //     conversazione che ha seguito Giulia, e il cliente ha parlato con lei;
    //  2. se nessuno ha mai risposto non si manda niente: LIBERA si può
    //     scrivere anche su una conversazione mai presa in carico, e dire
    //     «Giulia ti saluta» a chi non ha mai parlato con Giulia è peggio del
    //     silenzio;
    //  3. solo negli orari in cui qualcuno legge: un LIBERA fatto la mattina
    //     dopo non deve svegliare il cliente su una conversazione di ieri sera;
    //  4. mai a chi ha scritto STOP.
    // ⚠️ E SOLO qui, mai sulle chiusure automatiche (le ore di silenzio,
    // chiudiConversazioniFinite): lì il messaggio arriverebbe ore dopo, di
    // notte, per una conversazione che il cliente ha già dimenticato.
    const dovePuntare = rich.chat_id || rich.telefono;
    for (const k of chiaviStessaConversazione(rich.chat_id, rich.telefono)) bot.scordaPersona(db, k);
    const cfgLibera = bot.config(db);
    if (rich.risposta_da && bot.eOrarioAvvisi(cfgLibera, new Date())
        && !bot.haDettoBasta(db, dovePuntare, rich.telefono)) {
      try {
        await rispondiConRitmo(dovePuntare, bot.riempi(cfgLibera.bot_t_umano_finito, {
          nome: rich.risposta_da, locale: cfgLibera.bot_locale || 'noi',
          assistente: cfgLibera.bot_assistente || '',
        }));
      } catch (e) { console.error('Bot: saluto di chiusura non riuscito:', e.message); }
    }
    // ⚠️ Se non c'era nessun silenzio da togliere va DETTO. Il ✅ secco faceva
    // credere che fosse tutto a posto anche quando non era stato liberato
    // niente, e chi lo leggeva aspettava un bot che non sarebbe tornato.
    annota('liberata', `${rich.codice}: la conversazione torna al bot`
      + (liberate ? '' : ' (non c\'era nessun silenzio attivo)'));
    await inviaConRitmo(persona.chat_id || persona.telefono,
      `✅ ${rich.codice} torna al bot: da ora risponde di nuovo lui a ${rich.nome || 'quel cliente'}.`
      + (liberate ? '' : '\n\n(non c\'era nessun silenzio da togliere: il bot rispondeva già)'));
    return;
  }

  // «NUOVA» — la prenotazione presa al telefono, chiesta passo per passo.
  //
  // Sta DOPO il codice R e LIBERA di proposito: un cliente che aspetta una
  // risposta non deve restare in attesa perché il responsabile è a metà di una
  // prenotazione. Quelle due parole passano sempre.
  // ⚠️ I comandi che si LEGGONO soltanto passano sempre, anche se una
  // prenotazione dettata è rimasta a metà: chiedere l'elenco non tocca niente,
  // e rispondere «non ho capito il numero» a chi scrive LISTA è il modo per
  // far credere che il bot sia morto. Quello che era in sospeso resta dov'era:
  // dopo l'elenco si può riprendere da dove si era interrotti.
  //
  // «COMANDI» — l'elenco di quello che si può scrivere. Anche questo si legge
  // soltanto, e deve arrivare SEMPRE: è la parola a cui si aggrappa chi non
  // ricorda le altre, e se restasse impigliata in una prenotazione lasciata a
  // metà non servirebbe proprio nel momento in cui serve.
  //
  // Da sola sulla riga: «aiuto non capisco» è una frase, non un comando.
  if (/^(comandi|aiuto|help|\?)\s*$/i.test(t)) {
    annota('comandi', `${persona.nome} chiede l'elenco dei comandi`);
    await inviaConRitmo(persona.chat_id || persona.telefono, stampaComandi(db));
    return;
  }

  // «SOLD OUT» — i giorni in cui il locale è pieno e il bot non deve prendere
  // altro. Sta qui sopra insieme agli altri comandi che passano sempre: è
  // proprio la sera in cui si riempie tutto che si scrive di fretta, ed è la
  // sera in cui una prenotazione lasciata a metà è più probabile.
  //
  // Tre forme: da solo dice quali giorni sono segnati; con dei giorni li
  // segna; con NO (o TOGLI) davanti li libera.
  const soldOut = t.match(/^(?:sold\s*out|pieno|completo)\b\s*([\s\S]*)$/i);
  if (soldOut) {
    const resto = soldOut[1].trim();
    const togliere = /^(?:no|togli|toglie|libera|annulla)\b/i.test(resto);
    const giorniScritti = togliere ? resto.replace(/^\S+\s*/, '') : resto;
    const oggi = bot.comeData(new Date());
    // ⚠️ I giorni passati si scartano: segnare pieno ieri non serve a nessuno,
    // e quasi sempre vuol dire che è stata letta male una data.
    const giorni = bot.interpretaGiorni(giorniScritti, new Date()).filter((g) => g >= oggi);

    if (!giorniScritti) {
      const segnati = bot.giorniPieni(db, new Date());
      annota('sold out', `${persona.nome} chiede i giorni pieni`);
      await inviaConRitmo(persona.chat_id || persona.telefono, segnati.length
        ? `🚫 Giorni segnati pieni:\n${segnati.map((g) => `▸ ${bot.dataItaliana(g)}`).join('\n')}`
          + '\n\nPer liberarne uno: SOLD OUT NO ' + bot.dataItaliana(segnati[0]).split(' ').slice(1).join(' ')
        : 'Nessun giorno segnato pieno.\n\nPer segnarne uno: SOLD OUT sabato 3 settembre');
      return;
    }
    if (!giorni.length) {
      // Dire QUALI parole si capiscono vale più che dire «non ho capito»: chi
      // ha scritto una data nel passato non ha sbagliato a scriverla.
      await inviaConRitmo(persona.chat_id || persona.telefono,
        'Non ho riconosciuto nessun giorno futuro.\n\n'
        + 'Puoi scrivere: SOLD OUT oggi · domani · sabato · 3 settembre · 2 3 4 settembre');
      return;
    }
    const fatti = [];
    for (const g of giorni) {
      if (togliere) { if (bot.togliPieno(db, g)) fatti.push(g); }
      else { bot.segnaPieno(db, g); fatti.push(g); }
    }
    const elenco = (togliere ? fatti : giorni).map((g) => `▸ ${bot.dataItaliana(g)}`).join('\n');
    annota('sold out', `${persona.nome}: ${togliere ? 'liberati' : 'pieni'} ${giorni.join(', ')}`);
    if (togliere && !fatti.length) {
      // ⚠️ Un ✅ che non ha tolto niente è la bugia peggiore: chi lo legge
      // crede che il bot da domani prenda prenotazioni, e non le prende.
      await inviaConRitmo(persona.chat_id || persona.telefono,
        'Quei giorni non erano segnati pieni: non ho cambiato niente.');
      return;
    }
    await inviaConRitmo(persona.chat_id || persona.telefono, togliere
      ? `✅ Torno a prendere prenotazioni per:\n${elenco}`
      : `🚫 Segnati pieni:\n${elenco}\n\nDa ora il bot risponde «non c'è più posto» per questi giorni.`);
    return;
  }

  // «LISTA» sta prima di «PRENOTAZIONI» perché è più specifico: chi scrive
  // LISTA vuole la veduta d'insieme, non la serata.
  if (/^(lista|elenco)\b/i.test(t)) {
    annota('lista', `${persona.nome} chiede tutte le prenotazioni`);
    await inviaConRitmo(persona.chat_id || persona.telefono,
      bot.elencoTutte(db, bot.config(db), new Date()));
    return;
  }

  // «PRENOTAZIONI» — la serata, e «PRENOTAZIONI sabato» un giorno preciso.
  // Passa sempre anche questo: si legge soltanto. Sale sopra al cancello con
  // la sola parola esplicita, che nessuna domanda della sala si aspetta come
  // risposta.
  const chiedeSerata = t.match(/^(prenotazioni|prenotazione)\b\s*([\s\S]*)$/i);
  if (chiedeSerata) {
    await mandaElenco(persona, chiedeSerata[2].trim() || chiedeSerata[1]);
    return;
  }

  const chiaveSala = 'sala:' + (persona.chat_id || persona.telefono);
  // ⚠️ «CANCELLA PRENOTAZIONE» dev'essere qui accanto ad «ANNULLA»: la parola
  // nuova era stata aggiunta dentro al motore, ma questa riga — che è il
  // cancello per entrarci — conosceva solo la vecchia. Il comando esisteva e
  // non arrivava mai a destinazione: la prova stava sul motore, il guasto sul
  // cancello.
  if (/^(nuova|aggiungi|prenota)\b/i.test(t) || /^(annulla|cancella)\s+prenotazione\b/i.test(t)
      || bot.salaInCorso(db, chiaveSala)) {
    const esito = bot.elaboraMessaggioSala(db, chiaveSala, t, new Date());
    for (const r of esito.risposte) await inviaConRitmo(persona.chat_id || persona.telefono, r);
    if (esito.prenotazione) {
      const p = esito.prenotazione;
      annota('admin', `${persona.nome}: ${p.data} ${p.ora}, ${p.persone} pers., ${bot.nomeInSala(p)}`);
      // Chi l'ha appena scritta non deve sentirselo ripetere: nella stessa
      // chat ha già letto «✅ Segnata». Chi altro riceve gli avvisi, invece,
      // qui non lo saprebbe mai — la prenotazione non è passata dal bot.
      await avvisaPrenotazione(p, 'nuova', { esclude: persona.chat_id || persona.telefono });
    }
    if (esito.avvisa) {
      const p = esito.avvisa;
      const cfg = bot.config(db);
      try {
        await inviaConRitmo(p.telefono, bot.riempi(cfg.bot_t_manuale, {
          locale: cfg.bot_locale, assistente: cfg.bot_assistente,
          nome: [p.nome, p.cognome].filter(Boolean).join(' '),
          data: bot.dataItaliana(p.data), ora: p.ora, persone: p.persone,
        }));
        await inviaConRitmo(persona.chat_id || persona.telefono, `✅ Conferma mandata a +${p.telefono}.`);
      } catch (e) {
        // Il motivo vero serve a chi è in sala: «non è su WhatsApp» si risolve
        // con una telefonata, «non collegato» no.
        annota('errore', `conferma a mano non partita: ${e.message}`);
        await inviaConRitmo(persona.chat_id || persona.telefono,
          `Non sono riuscito a mandare la conferma a +${p.telefono}: ${e.message}.\nLa prenotazione resta segnata.`);
      }
    }
    // «ANNULLA PRENOTAZIONE Rossi» — qui, a differenza di AVVISA per NUOVA,
    // il cliente va avvisato SEMPRE e non è una scelta: è la sua prenotazione
    // che sparisce, non una a cui non aveva mai dato il numero.
    if (esito.annullata) {
      const p = esito.annullata;
      annota('annullata admin', `${persona.nome}: ${p.data} ${p.ora}, ${bot.nomeInSala(p)}`);
      await chiudiIlPagamento(p);
      // L'indirizzo della chat, se c'è, funziona sempre; il solo numero
      // digitato da una prenotazione presa a mano no sempre — ma è comunque
      // quello che si prova.
      const destinatario = p.chat_id || p.telefono;
      if (!destinatario) {
        await inviaConRitmo(persona.chat_id || persona.telefono,
          'Non ho un numero per avvisare il cliente: annullata, ma dovrai dirglielo tu.');
      } else {
        const cfg = bot.config(db);
        try {
          await inviaConRitmo(destinatario, bot.riempi(cfg.bot_t_annullata_locale, {
            locale: cfg.bot_locale, assistente: cfg.bot_assistente,
            nome: [p.nome, p.cognome].filter(Boolean).join(' '),
            data: bot.dataItaliana(p.data), ora: p.ora, persone: p.persone,
          }));
          await inviaConRitmo(persona.chat_id || persona.telefono, 'Il cliente è stato avvisato.');
        } catch (e) {
          annota('errore', `avviso di annullamento non partito: ${e.message}`);
          await inviaConRitmo(persona.chat_id || persona.telefono,
            `Annullata, ma non sono riuscito ad avvisare il cliente: ${e.message}.`);
        }
      }
      // Chi altro riceve gli avvisi lo deve sapere comunque — è lo stesso
      // meccanismo già usato quando è il cliente a disdire da sé.
      await avvisaPrenotazione(p, 'annullata', { esclude: persona.chat_id || persona.telefono });
    }
    if (esito.gestito) return;
  }

  // «OGGI», «STASERA», «DOMANI» da soli — l'elenco della serata chiesto come
  // viene naturale scriverlo. Va cercato PRIMA dell'appello: là un nome si
  // riconosce per pezzi contenuti nel messaggio, e una prenotazione a nome
  // «Zio» dentro «prenotazioni» farebbe segnare assente chi c'era.
  //
  // ⚠️ Queste tre parole restano QUI, sotto al cancello della sala, e non
  // salgono insieme a «PRENOTAZIONI»: mentre si detta una prenotazione sono
  // la risposta alla domanda «per che giorno?», e leggerle come una richiesta
  // di elenco vorrebbe dire mandare una lista a chi stava scrivendo la data.
  const chiedeElenco = t.match(/^(oggi|stasera|domani)\b\s*([\s\S]*)$/i);
  if (chiedeElenco) {
    await mandaElenco(persona, chiedeElenco[2].trim() || chiedeElenco[1]);
    return;
  }

  // L'appello: «TUTTI OK» oppure i numeri di chi non si è presentato.
  // Qui il codice NON serve, e non è un'incoerenza: il codice serve solo
  // quando il messaggio esce dall'edificio. Una risposta sbagliata all'appello
  // resta fra il bot e il responsabile.
  const inAppello = db.prepare("SELECT value FROM settings WHERE key = 'bot_appello_aperto'").get();
  if (inAppello && inAppello.value) {
    const esito = rispondiAppello(inAppello.value, t);
    if (esito) { await inviaConRitmo(persona.chat_id || persona.telefono, esito); return; }
  }

  // ⚠️ DA QUI IN GIÙ si esce dall'edificio: quello che arriva qui va al CLIENTE.
  // Sta in fondo di proposito — dopo COMANDI, PRENOTAZIONI, LISTA, SOLD OUT,
  // NUOVA, CANCELLA, LIBERA, R<n> e l'appello. È il motivo per cui quei comandi
  // continuano a funzionare anche con una conversazione agganciata: spostare
  // questo blocco più su vorrebbe dire mandare «PRENOTAZIONI» al cliente.
  const seguita = conversazioneAgganciata(persona, new Date());
  if (seguita) {
    // Nessun prefisso: qui la conversazione è già sua da prima, il cliente sa
    // con chi sta parlando. Vedi il commento sul prefisso qui sopra.
    await rispondiConRitmo(seguita.chat_id || seguita.telefono, t);
    db.prepare("UPDATE bot_richieste SET stato = 'risposta', risposta = ?, risposta_at = datetime('now','localtime'), risposta_da = ?, presa_at = ? WHERE id = ?")
      .run(t, persona.nome, new Date().toLocaleString('sv-SE'), seguita.id);
    bot.zittisci(db, seguita.chat_id || seguita.telefono,
      bot.num(bot.leggi(db, 'bot_silenzio_ore'), 6), new Date());
    annota('risposto a mano', `${persona.nome} → ${seguita.codice} (${seguita.nome || 'cliente'})`);
    // ⚠️ La conferma c'è SEMPRE, a ogni messaggio. Senza, non c'è modo di sapere
    // se quel messaggio è uscito o è rimasto qui — ed è la sola cosa che rende
    // accettabile l'inoltro senza codice.
    // ⚠️ La conferma c'è SEMPRE, ma la sua forma dipende da quante
    // conversazioni sono aperte. Con UNA sola, il nome a ogni riga è rumore: la
    // conferma è una REAZIONE ✅ sul messaggio appena scritto — lo stesso
    // segno delle spunte, e nessuna riga in più nella chat. Con più di una,
    // invece, il nome è l'unica cosa che dice a CHI è andata: «→ Angela» resta,
    // perché è lì che si sbaglia cliente. Se la reazione non riesce (versione
    // vecchia di WhatsApp, messaggio non reagibile) si torna alla riga.
    const altreAperte = db.prepare(
      "SELECT COUNT(*) n FROM bot_richieste WHERE stato != 'chiusa' AND id != ?").get(seguita.id).n;
    let confermato = false;
    if (!altreAperte && msg && typeof msg.react === 'function') {
      try { await msg.react('✅'); confermato = true; } catch (e) { console.error('Bot: reazione non riuscita:', e.message); }
    }
    if (!confermato) {
      await inviaConRitmo(persona.chat_id || persona.telefono, `→ ${seguita.nome || seguita.codice}`);
    }
    return;
  }

  // Nessuna conversazione agganciata. ⚠️ Il messaggio NON parte al cliente, ed è
  // voluto: basterebbe un pensiero scritto di getto («questo rompe, digli di
  // no») per mandarlo a un cliente senza modo di richiamarlo. Ma la risposta che
  // ha appena scritto non si butta via: gliela si riscrive pronta col codice
  // davanti, così è un copia-incolla invece che da riscrivere.
  const aperte = db.prepare(
    "SELECT codice, nome FROM bot_richieste WHERE stato != 'chiusa' ORDER BY id DESC LIMIT 5").all();
  if (aperte.length === 1) {
    const una = aperte[0];
    await inviaConRitmo(persona.chat_id || persona.telefono,
      `Per farlo arrivare al cliente serve il codice. Ce n'è una sola: ${una.codice} — `
      + `${una.nome || 'cliente senza nome'}.\n\nCopia e manda questo:\n\n${una.codice} ${t}`
      + '\n\n(oppure rispondi direttamente nella sua chat: il bot si fa da parte da solo)');
  } else if (aperte.length) {
    await inviaConRitmo(persona.chat_id || persona.telefono,
      'Per farlo arrivare al cliente serve il codice davanti. Aperte adesso:\n'
      + aperte.map((r) => `▸ ${r.codice} — ${r.nome || 'cliente senza nome'}`).join('\n')
      + `\n\nPer esempio:\n\n${aperte[0].codice} ${t}`);
  } else {
    await inviaConRitmo(persona.chat_id || persona.telefono,
      'Non ho conversazioni in attesa in questo momento.\n\n'
      + 'Scrivi PRENOTAZIONI per vedere quelle di stasera, o COMANDI per l\'elenco completo.');
  }
}

// Interpreta la risposta all'appello. Restituisce il messaggio di conferma,
// oppure null se non è una risposta all'appello.
function rispondiAppello(giorno, testo) {
  const righe = db.prepare(
    "SELECT * FROM prenotazioni WHERE data = ? AND stato = 'confermata' ORDER BY ora, id"
  ).all(giorno);
  if (!righe.length) return null;
  const t = bot.normalizza(testo);
  let assenti = [];

  if (/^(tutti ok|tutti|ok|tutto ok|tutti presenti)$/.test(t)) {
    assenti = [];
  } else if (/^[\d\s,.]+$/.test(t)) {
    const numeri = t.split(/[\s,.]+/).filter(Boolean).map(Number);
    if (numeri.some((n) => n < 1 || n > righe.length)) {
      return `Quei numeri non sono nell'elenco: vanno da 1 a ${righe.length}.`;
    }
    assenti = numeri.map((n) => righe[n - 1]);
  } else {
    // Un nome. Se la corrispondenza non è UNA sola, si richiede invece di
    // indovinare: segnare presente il cliente sbagliato significa poi mandare
    // una richiesta di recensione a chi non è mai venuto.
    const cercato = bot.normalizza(testo).replace(/non\s*(e|è)\s*venut[oa]|assente|mancava/g, '').trim();
    const trovati = righe.filter((r) => bot.normalizza(r.nome) && cercato.includes(bot.normalizza(r.nome)));
    if (trovati.length === 1) assenti = trovati;
    else if (trovati.length > 1) return 'Ci sono due prenotazioni con quel nome: rispondi col numero della riga.';
    else return null;   // non è una risposta all'appello
  }

  for (const r of righe) {
    const assente = assenti.some((a) => a.id === r.id);
    // ⚠️ Chi non si è presentato finisce fra le CANCELLATE. Gli stati sono
    // tre, e il locale ha scelto così — ma è bene sapere cosa si perde: un
    // tavolo disdetto per tempo e uno rimasto vuoto tutta la sera diventano la
    // stessa cosa, e il secondo è quello che costa. Per contarli servirebbe di
    // nuovo uno stato suo.
    db.prepare('UPDATE prenotazioni SET stato = ? WHERE id = ?')
      .run(assente ? 'annullata' : 'presentata', r.id);
  }
  db.prepare("DELETE FROM settings WHERE key = 'bot_appello_aperto'").run();
  const nomi = assenti.map((a) => bot.nomeInSala(a) !== 'senza nome' ? bot.nomeInSala(a) : a.telefono).join(', ');
  return assenti.length
    ? `✅ Segnate: ${righe.length - assenti.length} concluse, ${assenti.length} cancellate (${nomi}).`
    : `✅ Segnate tutte concluse (${righe.length}). Buon riposo!`;
}

// ---------- L'ascolto ----------
if (botDisponibile()) {
  // Avvisa CHI LAVORA NEL LOCALE che il bot è fermo per l'abbonamento. Ai
  // clienti non si dice niente: non è affar loro, e una frase sul pagamento
  // scritta a chi voleva un tavolo fa una figura pessima al ristorante.
  const avvisatiScadenza = new Map();        // indirizzo -> quando
  async function avvisaSalaAbbonamento(chiave, msg) {
    try {
      const telefono = await numeroDelMittente(msg, chiave);
      const persona = personaCheScrive(telefono, chiave);
      if (!persona) return;                  // è un cliente: silenzio
      // Una volta all'ora, non a ogni messaggio: altrimenti diventa lui il
      // disturbo, e chi lo riceve smette di leggerlo.
      const ultima = avvisatiScadenza.get(chiave) || 0;
      if (Date.now() - ultima < 60 * 60 * 1000) return;
      avvisatiScadenza.set(chiave, Date.now());
      const quando = abbonamento.scadenza ? ` il ${abbonamento.scadenza.split('-').reverse().join('/')}` : '';
      await inviaConRitmo(chiave,
        `⚠️ Il bot è fermo: l'abbonamento a iStudio è scaduto${quando}.\n`
        + 'I clienti che scrivono non ricevono risposta e le prenotazioni non vengono prese. '
        + 'Avvisa chi si occupa del rinnovo.');
      annota('abbonamento', `avvisato ${persona.nome}: bot fermo per abbonamento scaduto`);
    } catch { /* se non si riesce ad avvisare, pazienza: il bot resta fermo */ }
  }

  client.on('message', async (msg) => {
    try {
      const da = String(msg.from || '');
      const anteprima = (typeof msg.body === 'string' ? msg.body : '').slice(0, 60);
      // Ogni scarto viene ANNOTATO col suo motivo: è l'unica cosa che
      // trasforma «il bot non risponde» in una risposta.
      // Prima di ogni altra cosa, e ANCHE a bot spento: si impara il numero di
      // chi scrive. Serve alla Chat per «Aggiungi in rubrica», ed è
      // indipendente dal bot — non c'è motivo di perdere questa informazione
      // solo perché il bot è spento.
      if (tipoChat(da) === 'privata' && !msg.fromMe) await imparaNumero(msg, da);

      if (!botAcceso()) {
        // ⚠️ Il silenzio verso i clienti è voluto, quello verso il locale no:
        // chi lavora in sala resterebbe a chiedersi perché tutto tace, e
        // penserebbe a un guasto invece che a un abbonamento da rinnovare.
        if (!abbonamentoAttivo()) await avvisaSalaAbbonamento(da, msg);
        return annota('ignorato',
          abbonamentoAttivo() ? `bot spento — «${anteprima}»` : `abbonamento scaduto — «${anteprima}»`);
      }
      if (state.status !== 'connesso') return annota('ignorato', 'WhatsApp non collegato');
      // Solo conversazioni fra due persone. L'indirizzo viene stampato nel
      // registro: quando WhatsApp cambierà di nuovo formato — e succederà —
      // si vedrà subito quale, invece di indovinare perché il bot tace.
      const tipo = tipoChat(da);
      if (tipo !== 'privata') return annota('ignorato', `non è una chat singola (${tipo}: ${da})`);
      if (msg.fromMe || msg.isStatus) return annota('ignorato', 'messaggio mio');
      const testo = typeof msg.body === 'string' ? msg.body : '';
      if (!testo.trim()) return annota('ignorato', 'niente testo (foto, vocale o adesivo)');
      const idMsg = msg.id && msg.id._serialized;
      if (giaVisto(idMsg)) return annota('ignorato', 'già risposto a questo messaggio');

      // La conversazione si riconosce dall'INDIRIZZO, non dal numero: è l'unica
      // cosa che c'è sempre e che funziona con tutti i formati.
      const chatId = da;
      const telefono = await numeroDelMittente(msg, da);
      const mio = state.me ? normalizePhone(state.me) : null;
      // Scrivere al proprio numero non è una prova valida: WhatsApp non
      // permette una conversazione con se stessi. Serve un secondo telefono.
      if (mio && telefono && telefono === mio) {
        return annota('ignorato', 'arriva dal numero del locale: serve un altro telefono per provare');
      }

      annota('ricevuto', `${telefono ? '+' + telefono : da}: «${anteprima}»`);

      // Qualcuno sta collegando il proprio telefono? Si guarda PRIMA di ogni
      // altra cosa: chi scrive il codice non è un cliente che prenota.
      const collegata = db.prepare(
        "SELECT * FROM bot_personale WHERE codice_collegamento != '' AND UPPER(?) LIKE '%' || codice_collegamento || '%'"
      ).get(testo.trim());
      if (collegata) {
        db.prepare("UPDATE bot_personale SET chat_id = ?, codice_collegamento = '', collegato_at = datetime('now','localtime') WHERE id = ?")
          .run(chatId, collegata.id);
        annota('collegato', `${collegata.nome} ha collegato il suo telefono`);
        await rispondiConRitmo(chatId,
          `✅ Collegato, ${collegata.nome}.\n\n`
          + (collegata.gestisce
            ? 'Da ora ricevi qui le richieste che non riesco a gestire, e puoi rispondere ai clienti col codice.'
            : 'Da ora ricevi qui gli avvisi delle prenotazioni.')
          + '\n\nQuando vuoi, scrivimi PRENOTAZIONI e ti mando l\'elenco di stasera.');
        return;
      }

      const persona = personaCheScrive(telefono, chatId);
      if (persona) {
        annota('personale', `${persona.nome} — non è un cliente, non gli chiedo di prenotare`);
        await messaggioDelPersonale(persona, testo, msg);
        return;
      }

      // Conversazione in mano a una persona. Il bot non risponde — giusto —
      // ma i messaggi NON devono cadere nel vuoto: finora il cliente scriveva
      // e non lo leggeva più nessuno. Ora ogni messaggio arriva al
      // responsabile, con lo stesso codice di prima.
      if (bot.eMuto(db, chatId, new Date())) {
        annota('inoltrato', 'la conversazione è di una persona: passo il messaggio a lei');
        await passaAUnaPersona(chatId, telefono, (msg._data && msg._data.notifyName) || '', testo,
          { silenzioso: true });
        return;
      }

      const nomeChat = (msg._data && msg._data.notifyName) || '';

      // ⚠️ «STOP» prima di tutto il resto. Il bot manda anche messaggi che il
      // cliente non ha chiesto — la richiesta di recensione — e lì gli scrive
      // che può fermarli così. Se poi scrivesse STOP e il bot rispondesse «non
      // ho capito», sarebbe una promessa tradita nel punto peggiore: quello in
      // cui uno sta già chiedendo di essere lasciato in pace.
      if (sembraCancellazione(testo)) {
        await fermaTutto(chatId, telefono, nomeChat);
        return;
      }

      // ⚠️ Si accende PRIMA di pensare, non prima di rispondere: fra i due c'è
      // la coda degli invii, e con dieci clienti insieme il decimo aspetta una
      // quindicina di secondi. È quella l'attesa che va mostrata.
      await staScrivendo(chatId);
      const esito = bot.elaboraMessaggio(db, chatId, testo, new Date(), { numero: telefono });
      for (const r of esito.risposte) await rispondiConRitmo(chatId, r);
      // Una prenotazione che aspetta il pagamento: il messaggio è già scritto,
      // manca solo l'indirizzo dove pagare — e quello lo sa solo Stripe.
      if (esito.daPagare) await mandaIlPagamento(chatId, esito);
      // Senza pagamento la prenotazione nasce confermata: il riepilogo parte
      // subito. Con il pagamento acceso l'ha già mandato `mandaIlPagamento`,
      // col link dentro — qui si finirebbe per mandarne due.
      else if (esito.prenotazione) await mandaEmailPrenotazione(esito.prenotazione);
      await hoFinitoDiScrivere(chatId);
      if (esito.risposte.length) annota('risposto', esito.risposte[0].split('\n')[0]);
      if (esito.passaAUmano) {
        // ⚠️ Se il bot ha GIÀ risposto qualcosa, al cliente non si dice una
        // seconda volta «ti passo a una persona»: arrivavano due messaggi di
        // fila che dicevano la stessa cosa con parole diverse, ed è il modo
        // più rapido per far sembrare il bot rotto. Succede ogni volta che il
        // bot parla E passa la mano insieme: OPERATORE, il tavolo troppo
        // grande, il turno riempito mentre confermava, il tetto di risposte.
        // L'avviso al responsabile parte lo stesso: quello che cambia è solo
        // quante volte il CLIENTE se lo sente ripetere.
        const giaDetto = esito.risposte.length > 0;
        annota('a una persona', giaDetto
          ? 'il bot ha risposto e ha avvisato il locale'
          : 'il bot non ha capito e ha avvisato il locale');
        await passaAUnaPersona(chatId, telefono, nomeChat, testo, { silenzioso: giaDetto });
      }
      if (esito.prenotazione) {
        // La riga nasce con l'indirizzo della chat come «telefono»: qui viene
        // rimessa a posto col numero vero, se si è riusciti a saperlo, e
        // l'indirizzo va nella sua colonna per le risposte future.
        db.prepare('UPDATE prenotazioni SET chat_id = ?, telefono = ? WHERE id = ?')
          .run(chatId, telefono || chatId, esito.prenotazione.id);
        esito.prenotazione = db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(esito.prenotazione.id);
        annota('prenotato', `${esito.prenotazione.data} ${esito.prenotazione.ora}, ${esito.prenotazione.persone} pers.`);
        await avvisaPrenotazione(esito.prenotazione, 'nuova');
      }
      if (esito.annullata) {
        annota('annullata', `${esito.annullata.data} ${esito.annullata.ora}`);
        await avvisaPrenotazione(esito.annullata, 'annullata');
        // Il collegamento per pagare, se c'era, non deve restare pagabile.
        await chiudiIlPagamento(esito.annullata);
      }
      if (esito.attesa) {
        annota('lista d\'attesa', `${bot.nomeInSala(esito.attesa)} in lista per ${esito.attesa.data}`
          + `${esito.attesa.ora ? ' alle ' + esito.attesa.ora : ''}, ${esito.attesa.persone} pers.`);
      }
      if (esito.spostata) {
        const { prima, dopo } = esito.spostata;
        annota('spostata', `da ${prima.data} ${prima.ora} a ${dopo.data} ${dopo.ora}`);
        await avvisaPrenotazione(dopo, 'spostata', { prima });
      }
    } catch (err) {
      annota('errore', (err && err.message) || String(err));
      console.error('Bot: errore su un messaggio in arrivo:', (err && err.message) || err);
    }
  });

  // Presa in carico automatica: se dal numero del locale esce un messaggio che
  // non ha mandato il bot, vuol dire che una persona sta rispondendo a mano.
  // Il bot tace su quella conversazione, senza che nessuno debba ricordarsi un
  // comando: durante il servizio non se lo ricorda nessuno.
  client.on('message_create', async (msg) => {
    try {
      if (!botAcceso() || !msg.fromMe) return;
      const a = String(msg.to || '');
      if (tipoChat(a) !== 'privata') return;
      const id = msg.id && msg.id._serialized;
      if (loHoMandatoIo(a, msg.body, id)) return;
      const telefono = numeroLeggibile(msg, a);
      if (telefono && eDelPersonale(telefono)) return;
      const ore = bot.num(bot.leggi(db, 'bot_silenzio_ore'), 6);
      // Su tutti gli indirizzi di quella persona, non solo su quello che ha in
      // mano il telefono del locale: altrimenti si zittisce un indirizzo e il
      // cliente continua a parlare col bot dall'altro — e chi ha risposto a
      // mano si ritrova il bot che gli parla sopra.
      for (const chiave of chiaviStessaConversazione(a, telefono)) {
        bot.zittisci(db, chiave, ore, new Date());
      }
      annota('presa in carico', `hai risposto a mano: il bot tace per ${ore} ore su ${telefono ? '+' + telefono : a}`);
      // E al cliente si dice che adesso gli risponde una persona — una volta.
      await annunciaLaPersona(a, telefono, ore);
    } catch { /* la presa in carico non deve mai far cadere niente */ }
  });
}

// Avvisa il personale di una prenotazione nuova o annullata — arrivi dal
// cliente via bot, dal pannello della pagina o dettata a voce con NUOVA: chi
// ha scelto di ricevere gli avvisi li vuole SEMPRE, non solo quando a scrivere
// al bot è stato il cliente.
// Un annullamento per stasera è più urgente di una prenotazione nuova: è un
// tavolo da rivendere entro poche ore.
//
// `opzioni.esclude` è l'indirizzo di chi ha appena creato la prenotazione: se
// è lui stesso un responsabile (caso tipico di NUOVA), non deve sentirselo
// ripetere due volte nella stessa chat dove l'ha appena scritta lui.
async function avvisaPrenotazione(p, tipo, opzioni = {}) {
  if (!botDisponibile() || !p) return;
  const oggi = bot.comeData(new Date());
  // Uno spostamento che tocca oggi è urgente quanto un annullamento: cambia il
  // servizio di stasera, e va saputo anche da chi non vuole gli avvisi di tutto.
  const urgente = (tipo === 'annullata' && p.data === oggi)
    || (tipo === 'spostata' && (p.data === oggi || (opzioni.prima && opzioni.prima.data === oggi)));
  // «(admin)» e non «(a mano)»: chi lavora in sala deve capire che quella
  // riga l'ha scritta chi tiene la piattaforma, non il cliente da WhatsApp.
  const aMano = p.origine === 'manuale' ? ' (admin)' : '';
  // ⚠️ Il cognome PRIMA del nome, e prima di tutto il cognome ci sia: qui
  // veniva scritto solo `p.nome`, quindi di «Daniele Angellotti» arrivava
  // «Daniele» — il pezzo che in sala non serve a niente, perché una
  // prenotazione è «il tavolo Angellotti».
  const nome = bot.nomeInSala(p);
  // ⚠️ Prima CHI, poi quanti, poi quando. La riga cominciava dalla data, ma su
  // un foglio del servizio non si cerca per data — quella la sai già, è
  // stasera: si cerca «il tavolo Angellotti». Col nome in fondo bisognava
  // leggere tutta la riga per sapere se riguardava te, venti volte a sera.
  const chi = `${nome !== 'senza nome' ? nome : (p.telefono || 'senza nome')} (${p.persone})`;
  // ⚠️ Niente «OGGI» davanti alla data: «da OGGI mercoledì 26 agosto» in
  // italiano si legge «a partire da oggi», che è un'altra cosa — la data c'è
  // scritta per esteso e chi legge sa benissimo che giorno è.
  //
  // Quello che «OGGI» serviva a fare resta, ma dove conta davvero: `urgente`
  // qui sotto decide CHI riceve l'avviso, e una disdetta di stasera arriva a
  // tutti comunque siano impostati gli avvisi. Quella parte non si tocca.
  const quando = (r) => `${bot.dataItaliana(r.data)} ${r.ora}`;
  let testo;
  if (tipo === 'annullata') {
    // «Cancellata», come nella piattaforma e nella pagina della sala: gli stati
    // sono Confermata, Conclusa, Cancellata. Un avviso che dice «Annullata» per
    // una riga che a video si chiama «Cancellata» sono due parole per la stessa
    // cosa, e chi legge si chiede se siano due cose diverse.
    testo = `❌ Cancellata: ${chi}, ${quando(p)}`;
  } else if (tipo === 'spostata') {
    // Il DA DOVE non è un dettaglio: chi ha il foglio del servizio in mano deve
    // sapere quale riga cancellare, non solo dove aggiungerla.
    const prima = opzioni.prima ? quando(opzioni.prima) : '?';
    // Il tavolo che aveva non vale più sulla nuova data (il bot lo azzera
    // quando è il cliente a spostare): chi legge deve sapere che ce n'è uno
    // da riassegnare, non scoprirlo la sera con due gruppi allo stesso tavolo.
    const daRiassegnare = opzioni.prima && opzioni.prima.tavolo && !p.tavolo
      ? ` · tavolo ${opzioni.prima.tavolo} da riassegnare` : '';
    testo = `🔄 Spostata: ${chi}, da ${prima} a ${quando(p)}${daRiassegnare}`;
  } else {
    testo = `🆕 Prenotazione${aMano}: ${chi}, ${quando(p)}`;
  }
  for (const persona of personale()) {
    const indirizzo = persona.chat_id || persona.telefono;
    if (opzioni.esclude && indirizzo === opzioni.esclude) continue;
    const vuole = persona.riceve === 'immediato'
      // Chi ha scelto «solo gli annullamenti» vuole sapere quando un tavolo si
      // libera: uno spostamento libera il posto di prima, quindi lo riguarda.
      || (persona.riceve === 'annullamenti' && (tipo === 'annullata' || tipo === 'spostata'))
      || urgente;   // l'annullamento di oggi lo sanno tutti, comunque sia impostato
    if (!vuole || persona.canale === 'email') continue;
    try { await inviaConRitmo(indirizzo, testo); } catch (e) { console.error('Bot:', e.message); }
  }
}

// ---------- Le richieste rimaste in coda fuori orario ----------
// Di notte non si avvisa nessuno: una notifica alle 3 non la guarda nessuno e
// insegna a silenziare il telefono. Ma la richiesta non deve restare lì per
// sempre — al cliente abbiamo promesso che qualcuno risponde all'apertura, e
// quella promessa va mantenuta da sola, senza che nessuno si ricordi di
// andare a guardare.
async function consegnaArretrate() {
  const perche = motivoPerCuiNonSiManda();
  if (perche) { lavoriFermi(perche); return; }
  lavoriRipartiti();
  const cfg = bot.config(db);
  if (!bot.eOrarioAvvisi(cfg, new Date())) return;
  const arretrate = db.prepare(
    "SELECT * FROM bot_richieste WHERE stato = 'in_attesa' AND avvisata_at IS NULL ORDER BY id"
  ).all();
  if (!arretrate.length) return;

  const responsabili = personale().filter((p) => p.gestisce && p.canale !== 'email');
  if (!responsabili.length) return;

  const righe = arretrate.map((r) =>
    `• ${r.codice} — ${r.nome || r.telefono}: «${String(r.testo).slice(0, 90)}»`).join('\n');
  const avviso = arretrate.length === 1
    ? `🌅 Buongiorno! È rimasta una richiesta di stanotte:\n\n${righe}\n\n`
      + `Rispondi con «${arretrate[0].codice} la tua risposta».`
    : `🌅 Buongiorno! Sono rimaste ${arretrate.length} richieste da stanotte:\n\n${righe}\n\n`
      + 'Rispondi con «codice la tua risposta», per esempio «R1 Certo, la aspettiamo».';

  for (const p of responsabili) {
    try { await inviaConRitmo(p.chat_id || p.telefono, avviso); } catch (e) { console.error('Bot:', e.message); }
  }
  const segna = db.prepare("UPDATE bot_richieste SET avvisata_at = datetime('now','localtime') WHERE id = ?");
  for (const r of arretrate) segna.run(r.id);
  annota('arretrate', `consegnate ${arretrate.length} richieste rimaste dalla notte`);
}

// Un giro al minuto, come già fa `controllaRiprese()` per gli invii: costa
// niente e non richiede di indovinare in anticipo quando serve guardare.
if (botDisponibile()) {
  setInterval(() => { consegnaArretrate().catch(giroFallito('arretrate')); }, 60 * 1000);
}

// Chi chiede di non ricevere più messaggi va escluso SUBITO, non «appena
// qualcuno se ne accorge»: la scansione delle chat gira ogni dieci minuti e
// chiede conferma, che va bene per un messaggio scritto chissà quando in una
// chat qualunque — ma non per una risposta diretta a noi.
async function fermaTutto(chiave, telefono, nomeChat) {
  const numero = normalizePhone(telefono || chiave);
  const contatto = numero
    ? db.prepare('SELECT * FROM contacts').all().find((c) => normalizePhone(c.telefono) === numero)
    : null;

  if (contatto && !contatto.opt_out) {
    db.prepare("UPDATE contacts SET opt_out = 1, opt_out_at = ?, opt_out_motivo = 'Ha scritto STOP in chat' WHERE id = ?")
      .run(new Date().toISOString(), contatto.id);
  }
  // ⚠️ E soprattutto: si segna il «basta» in un posto che NON dipende dalla
  // rubrica. La maggior parte di chi prenota su WhatsApp in rubrica non c'è —
  // ci finisce solo se il locale ce lo mette a mano — e fidandosi del solo
  // segno in rubrica gli si continuava a scrivere DOPO avergli risposto «non
  // ti scriveremo più». È la promessa peggiore da tradire, perché è quella
  // fatta a chi stava già chiedendo di essere lasciato in pace.
  bot.segnaBasta(db, chiave, numero);

  // Resta traccia anche se in rubrica non c'è nessuno: così il locale lo vede
  // e sa perché quel numero non riceve più niente.
  db.prepare("INSERT INTO optout_requests (chat_nome, testo, contact_id, stato) VALUES (?, ?, ?, 'confermata')")
    .run(nomeChat || String(chiave), 'STOP ricevuto in chat', contatto ? contatto.id : null);

  annota('stop', `${nomeChat || chiave} ha chiesto di non ricevere più messaggi`);
  await rispondiConRitmo(chiave,
    'Va bene: non ti scriveremo più.\n'
    + 'Se un giorno vuoi prenotare, puoi comunque scriverci tu quando ti fa comodo.');
}

// ---------- Il promemoria del giorno prima ----------
// È il messaggio che taglia i no-show, ed è per questo che va fatto bene: un
// tavolo che non si presenta è una serata persa per due, e il cliente quasi
// mai lo fa apposta — se ne dimentica.
//
// ⚠️ Fino a oggi qui non c'era NIENTE. C'erano la frase, la colonna in
// archivio e due impostazioni con scritto «attivo: true», e nessuno che
// mandasse un messaggio. Un'impostazione accesa che non fa niente è la bugia
// più difficile da scoprire: non dà errore, non lascia traccia, e chi la legge
// smette di controllare.
//
// ⚠️ Differenza importante dalla recensione: quella è una comunicazione
// COMMERCIALE, questa no. Il promemoria riguarda un tavolo che il cliente ha
// prenotato lui, ed è la stessa cosa che farebbe una telefonata del locale.
// Quindi chi si è tolto dagli INVII (l'opt-out della rubrica, che riguarda le
// newsletter) il promemoria lo riceve lo stesso: sono due consensi diversi, e
// confonderli vorrebbe dire far perdere il tavolo a chi non voleva la
// pubblicità. Chi ha scritto STOP a QUESTO bot, invece, no: a lui è stato
// promesso che non gli si scrive più.
// `conEmail` dice se in questo momento un'email di promemoria può davvero
// partire. Se non può, quel canale non conta come «ancora da fare»: sennò ogni
// prenotazione già avvisata su WhatsApp resterebbe candidata per sempre, e il
// giro del minuto la ripescherebbe all'infinito senza mai combinare niente.
function promemoriaDaMandare(cfg, adesso, conEmail = false) {
  if (!bot.boolDi(cfg.bot_promemoria_attivo)) return [];

  // Non prima dell'ora scelta. Un promemoria alle 7 del mattino non lo legge
  // nessuno, e alle 23 arriva quando la giornata è già finita.
  const ora = adesso.getHours() * 60 + adesso.getMinutes();
  if (ora < bot.inMinuti(cfg.bot_promemoria_ora || '12:00')) return [];

  // Quanto prima. Uno è il giorno prima; zero è lo stesso giorno, che per un
  // locale a pranzo ha senso quanto il giorno prima per uno che fa solo cena.
  const giorni = Math.min(Math.max(bot.num(cfg.bot_promemoria_giorni, 1), 0), 7);
  // ⚠️ I giorni si contano con «piuGiorni», che sposta la DATA. Con
  // «adesso + giorni × 86400000» si spostano i MILLISECONDI, e nelle due notti
  // all'anno in cui l'orologio cambia quel conto scivola di un'ora: con l'ora
  // del promemoria dopo le 23 si salta un giorno intero, e quei tavoli non
  // vengono ricordati a nessuno. Due volte l'anno, senza lasciare traccia.
  const oggiStr = bot.comeData(adesso);
  const quando = bot.comeData(bot.piuGiorni(adesso, giorni));
  // ⚠️ Non a chi ha appena prenotato. Chi scrive alle 18 per domani sera si
  // vedeva arrivare «ti ricordiamo la tua prenotazione» un minuto dopo averla
  // fatta: non è un promemoria, è un bot che non si accorge di aver appena
  // parlato con quella persona. Tre ore bastano a togliere l'assurdo senza
  // togliere il promemoria a chi ha prenotato stamattina.
  const nonAppena = new Date(adesso.getTime() - 3 * 3600000)
    .toLocaleString('sv-SE').replace('T', ' ');
  // ⚠️ Non si guarda più SOLO il giorno esatto. Se WhatsApp era scollegato nel
  // giorno in cui il promemoria andava mandato, prima quel tavolo era perso per
  // sempre: il giorno dopo non era nemmeno più candidato, e nessuno lo sapeva.
  // Adesso si prende tutta la finestra da oggi al giorno giusto, e più sotto si
  // decide chi è nei tempi e chi è da recuperare.
  // ⚠️ «Ancora da fare» vuol dire: manca WhatsApp, OPPURE manca l'email a chi
  // l'indirizzo ce l'ha. Con una condizione sola su `promemoria_at`, un invio
  // WhatsApp riuscito faceva sparire la riga e l'email non partiva mai.
  const daFare = conEmail
    ? "(promemoria_at IS NULL OR (COALESCE(email, '') <> '' AND promemoria_email_at IS NULL))"
    : 'promemoria_at IS NULL';
  const righe = db.prepare(
    "SELECT * FROM prenotazioni WHERE data >= ? AND data <= ? AND stato = 'confermata' "
    + `AND ${daFare} AND creata_at <= ? ORDER BY data, ora, id`
  ).all(oggiStr, quando, nonAppena);
  if (!righe.length) return [];

  // ⚠️ Con «lo stesso giorno» il promemoria rischia di arrivare quando il
  // tavolo è già cominciato — o dieci minuti prima, che è peggio di niente:
  // il cliente è già in macchina. Sotto l'ora di anticipo non si manda.
  const ANTICIPO_MINIMO = 60;
  // ⚠️ Un promemoria recuperato ha bisogno di più aria di uno puntuale: arriva
  // quando il cliente si sta già preparando. Sotto le due ore non serve più a
  // niente — chi doveva ricordarsene se n'è ricordato — e somiglia solo a un
  // messaggio partito per sbaglio.
  const ANTICIPO_RECUPERO = 120;
  const adessoMin = adesso.getHours() * 60 + adesso.getMinutes();

  const scelte = [];
  const gia = new Set();
  for (const r of righe) {
    // Il giorno in cui quel promemoria SAREBBE dovuto partire.
    const dovuto = bot.comeData(bot.piuGiorni(new Date(r.data + 'T12:00:00'), -giorni));
    const inRitardo = dovuto < oggiStr;
    if (inRitardo) {
      // ⚠️ Si recupera solo quello che è stato DAVVERO saltato: la prenotazione
      // doveva esistere già il giorno in cui il promemoria andava mandato. Chi
      // prenota stamattina per stasera non ha «perso» nessun promemoria — non
      // gliene spettava uno — e ricevere «ti ricordiamo la tua prenotazione»
      // tre ore dopo averla fatta è la cosa da cui questo codice si guarda già.
      if (String(r.creata_at || '').slice(0, 10) > dovuto) continue;
      if (r.data === oggiStr && bot.inMinuti(r.ora) - adessoMin < ANTICIPO_RECUPERO) continue;
      r.inRitardo = true;
    } else if (giorni === 0 && bot.inMinuti(r.ora) - adessoMin < ANTICIPO_MINIMO) continue;
    // Senza NESSUN recapito non si manda niente: è una prenotazione presa al
    // banco senza niente. Non è un guasto, ma va detto — vedi mandaPromemoria.
    // ⚠️ L'email conta come recapito: chi ha lasciato solo l'indirizzo è
    // raggiungibile eccome, e prima veniva scartato qui senza che nessuno lo
    // sapesse.
    const haEmail = conEmail && String(r.email || '').trim() !== '';
    if (!r.chat_id && !r.telefono && !r.telefono_contatto && !haEmail) continue;
    if (bot.haDettoBasta(db, r.chat_id || r.telefono, r.telefono_contatto || r.telefono)) continue;
    // Lo stesso numero alla stessa ora dello stesso giorno è una prenotazione
    // doppia, non due tavoli: un messaggio solo. Due tavoli a ore diverse — o
    // in giorni diversi — sono due cose diverse, e ognuna ha il suo da ricordare.
    // ⚠️ Il GIORNO nella chiave è arrivato con il recupero dei promemoria in
    // ritardo. Finché si guardava una data sola era superfluo; adesso la
    // finestra copre più giorni, e senza il giorno la cena di domani dello
    // stesso cliente veniva scambiata per un doppione di quella di stasera —
    // e il suo promemoria non partiva. Trovato da una prova, non da un cliente.
    // ⚠️ Chi ha lasciato solo l'email non ha un numero da normalizzare: senza
    // il ripiego sull'indirizzo, due clienti diversi allo stesso turno avevano
    // la stessa chiave («@data@ora») e il secondo spariva.
    const recapito = normalizePhone(r.telefono_contatto || r.telefono || r.chat_id)
      || String(r.email || '').trim().toLowerCase();
    const chiave = `${recapito}@${r.data}@${r.ora}`;
    if (gia.has(chiave)) continue;
    gia.add(chiave);
    scelte.push(r);
  }
  return scelte;
}

// L'email che ricorda il tavolo. Stesso testo di WhatsApp — è la stessa cosa
// da dire — dentro la stessa cornice dell'email di riepilogo, così chi ha messo
// il logo e il modello se li ritrova anche qui senza fare niente.
// Torna `true` se è partita, `'lascia perdere'` se non partirà MAI (indirizzo
// scritto male), `false` se magari più tardi sì.
// ⚠️ La distinzione non è pedanteria: questo gira ogni minuto. Un indirizzo
// scritto male non diventerà buono da solo, e senza «lascia perdere» quella
// riga sarebbe stata ripescata sessanta volte all'ora, per sempre, senza che
// partisse niente e senza che nessuno lo sapesse.
async function emailDiPromemoria(cfg, p, testo) {
  const dove = String(p.email || '').trim();
  if (!dove) return 'lascia perdere';
  if (!EMAIL_RE.test(dove)) {
    annota('errore', `promemoria: l'email di ${bot.nomeInSala(p)} è scritta male (${dove})`);
    return 'lascia perdere';
  }
  const transporter = buildTransporter();
  if (!transporter) return false;
  const valori = {
    nome: p.nome || '', cognome: p.cognome || '',
    data: bot.dataItaliana(p.data), ora: p.ora || '', persone: p.persone,
    locale: cfg.bot_locale || '',
  };
  const oggetto = bot.riempi(cfg.bot_t_promemoria_oggetto, valori).replace(/\n/g, ' ').trim()
    || 'Promemoria della tua prenotazione';
  const logo = leggiImmagine(cfg.bot_email_logo);
  await transporter.sendMail({
    from: (getSetting('smtp_from_name') || cfg.bot_locale)
      ? `"${getSetting('smtp_from_name') || cfg.bot_locale}" <${getSetting('smtp_user')}>`
      : getSetting('smtp_user'),
    to: dove,
    subject: oggetto,
    text: testo,
    html: corpoEmailRiepilogo(cfg, valori, testo, !!logo),
    attachments: logo
      ? [{ filename: 'logo.png', content: Buffer.from(logo.base64, 'base64'), cid: 'logo-istudio' }]
      : undefined,
  });
  return true;
}

async function mandaPromemoria(adesso = new Date()) {
  // ⚠️ Il cancello di WhatsApp non ferma più TUTTO. Quello che ferma tutto
  // è l'altro — motore, abbonamento, bot spento — e si guarda per primo.
  const mai = motivoPerCuiNonSiFaNiente();
  if (mai) { lavoriFermi(mai); return 0; }
  const perche = motivoPerCuiNonSiManda();
  const whatsappVa = !perche;
  if (perche) lavoriFermi(perche); else lavoriRipartiti();

  const cfg = bot.config(db);
  // L'email di promemoria segue l'interruttore delle email di prenotazione: è
  // lo stesso canale, e due interruttori per la stessa cosa si contraddicono.
  const emailVa = bot.boolDi(cfg.bot_email_attiva) && Boolean(buildTransporter());
  // ⚠️ Se tutte e due le strade sono chiuse non si fa un giro a vuoto: senza
  // questo, a WhatsApp scollegato e email spenta il programma avrebbe riletto
  // ogni prenotazione ogni minuto per non mandare niente.
  if (!whatsappVa && !emailVa) return 0;
  const scelte = promemoriaDaMandare(cfg, adesso, emailVa);
  if (!scelte.length) return 0;

  // ⚠️ Niente tetto giornaliero, al contrario della recensione. Là il tetto
  // protegge da un'impronta di spam; qui ogni messaggio è atteso da chi lo
  // riceve, e saltarne uno vuol dire un tavolo vuoto. Il ritmo lo mette
  // inviaConRitmo, che è dove deve stare.
  const segna = db.prepare("UPDATE prenotazioni SET promemoria_at = datetime('now','localtime') WHERE id = ?");
  const segnaEmail = db.prepare("UPDATE prenotazioni SET promemoria_email_at = datetime('now','localtime') WHERE id = ?");
  let mandati = 0;
  let falliti = 0;
  let recuperati = 0;
  let perEmail = 0;
  let emailFallite = 0;
  for (const r of scelte) {
    const testo = bot.riempi(cfg.bot_t_promemoria, {
      nome: r.nome || '', cognome: r.cognome || '',
      locale: cfg.bot_locale || 'noi', assistente: cfg.bot_assistente || '',
      data: bot.dataItaliana(r.data), ora: r.ora, persone: r.persone,
    });
    // ⚠️ WhatsApp: si guarda anche `telefono_contatto`. Il filtro più su
    // teneva buona una prenotazione che aveva SOLO quello, e poi qui si
    // spediva a `chat_id || telefono` — cioè a una stringa vuota. Il
    // promemoria risultava «non partito» e nessuno capiva perché: il numero
    // c'era, scritto in un'altra colonna.
    const aChi = r.chat_id || r.telefono || r.telefono_contatto;
    if (whatsappVa && !r.promemoria_at && aChi) {
      try {
        await inviaConRitmo(aChi, testo);
        // Si segna solo DOPO l'invio riuscito: segnarlo prima vorrebbe dire
        // perdere per sempre il promemoria di chi non l'ha mai ricevuto.
        segna.run(r.id);
        mandati++;
        if (r.inRitardo) recuperati++;
      } catch (e) { falliti++; console.error('Bot:', e.message); }
    }
    // ⚠️ E l'email, che è una strada a parte: ha la sua colonna e i suoi
    // guasti. Va anche a chi ha già ricevuto WhatsApp — è la scelta fatta, la
    // stessa dell'email di riepilogo — e parte pure a linea caduta.
    if (emailVa && !r.promemoria_email_at && String(r.email || '').trim()) {
      try {
        const esito = await emailDiPromemoria(cfg, r, testo);
        // Si segna anche il «lascia perdere»: non è partita e non partirà, e
        // lasciarla in sospeso vorrebbe dire riprovarla ogni minuto per sempre.
        if (esito) segnaEmail.run(r.id);
        if (esito === true) perEmail++;
      } catch (e) { emailFallite++; console.error('Bot: promemoria via email:', e.message); }
    }
  }
  // ⚠️ Quelli che non sono partiti vanno DETTI. Un promemoria che non arriva è
  // esattamente il tavolo che poi non si presenta, e il locale deve poter
  // decidere se fare una telefonata.
  if (mandati) {
    const giorni = Math.min(Math.max(bot.num(bot.config(db).bot_promemoria_giorni, 1), 0), 7);
    const per = giorni === 0 ? 'oggi' : giorni === 1 ? 'domani' : `fra ${giorni} giorni`;
    annota('promemoria', `ricordato il tavolo a ${mandati} client${mandati === 1 ? 'e' : 'i'} per ${per}`);
  }
  // ⚠️ I recuperati si dicono a parte: non sono una buona notizia, sono la
  // prova che qualcosa era rimasto fermo. Chi legge il registro deve poter
  // risalire al periodo in cui il bot non ha lavorato.
  if (recuperati) {
    annota('promemoria', `${recuperati} in ritardo, recuperat${recuperati === 1 ? 'o' : 'i'} adesso: `
      + 'quel giorno il promemoria non era partito');
  }
  if (falliti) annota('errore', `${falliti} promemoria non partiti: quei tavoli non sono stati avvisati`);
  if (perEmail) annota('promemoria', `e ${perEmail} anche via email`);
  // ⚠️ Un'email di promemoria che non parte va detta come le altre. È il
  // guasto più silenzioso di tutti: su WhatsApp il messaggio non arriva e
  // qualcuno se ne accorge, di una casella che rifiuta non si accorge nessuno.
  if (emailFallite) {
    annota('errore', `${emailFallite} promemoria via email non partiti: `
      + 'quei clienti non sono stati avvisati per posta');
  }
  return mandati + perEmail;
}

if (botDisponibile()) {
  setInterval(() => { mandaPromemoria().catch(giroFallito('promemoria')); }, 60 * 1000);
}

// ---------- Il cliente che aspetta ancora ----------
// ⚠️ L'avviso al responsabile partiva UNA volta sola. Chi alle 20:30 di sabato
// ha le mani occupate non se lo vede più ricordare, e quel cliente — a cui il
// bot ha appena promesso una risposta — può non riceverla mai. La colonna
// «sollecitata_at» era in archivio dal primo giorno e non la usava nessuno:
// era prevista esattamente per questo.
//
// Una volta sola per richiesta: il secondo sollecito diventa il rumore che fa
// smettere di guardare gli avvisi, cioè il guasto che si voleva curare.
async function sollecitaChiAspetta(adesso = new Date()) {
  const perche = motivoPerCuiNonSiManda();
  if (perche) { lavoriFermi(perche); return 0; }
  lavoriRipartiti();
  const cfg = bot.config(db);
  const minuti = bot.num(cfg.bot_sollecito_minuti, 20);
  if (minuti <= 0) return 0;
  // Nessuno sta leggendo: sollecitare una sala vuota non serve, e il ritardo
  // lo si è già detto al cliente («ti risponde domani dalle 09:00»).
  if (!bot.qualcunoLegge(db, cfg, adesso)) return 0;

  const righe = db.prepare(
    "SELECT * FROM bot_richieste WHERE stato = 'in_attesa' AND avvisata_at IS NOT NULL "
    + `AND sollecitata_at IS NULL AND avvisata_at < datetime('now','localtime','-${minuti} minutes') ORDER BY id`
  ).all();
  if (!righe.length) return 0;

  const segna = db.prepare("UPDATE bot_richieste SET sollecitata_at = datetime('now','localtime') WHERE id = ?");
  let mandati = 0;
  for (const r of righe) {
    const da = new Date(String(r.avvisata_at).replace(' ', 'T'));
    const quanti = Number.isNaN(da.getTime()) ? minuti : Math.round((adesso - da) / 60000);
    const testo = `⏰ ${r.codice} — ${r.nome || r.telefono} aspetta da ${quanti} minuti e non ha ancora risposta.\n\n`
      + `Ha scritto: «${String(r.testo || '').slice(0, 200)}»\n\n`
      + `👉 Per rispondere: ${r.codice} + la tua risposta`;
    // ⚠️ Se qualcuno la sta già seguendo, il sollecito va SOLO a lui: svegliare
    // tutta la squadra per una conversazione che ha già un padrone è il modo
    // di far rispondere in due allo stesso cliente.
    const a = aggancioVivo(r, adesso) ? [{ chat_id: r.presa_da }]
      : personale().filter((x) => x.gestisce && x.canale !== 'email');
    for (const p of a) {
      try { await inviaConRitmo(p.chat_id || p.telefono, testo); } catch (e) { console.error('Bot:', e.message); }
    }
    segna.run(r.id);
    mandati++;
  }
  annota('sollecito', `ricordat${mandati === 1 ? 'a 1 richiesta' : 'e ' + mandati + ' richieste'} senza risposta`);
  return mandati;
}

if (botDisponibile()) {
  setInterval(() => { sollecitaChiAspetta().catch(giroFallito('sollecito')); }, 60 * 1000);
}

// Il guardiano del collegamento (scritto molto più su, insieme alle notifiche).
if (botDisponibile()) {
  setInterval(() => { guardaIlCollegamento().catch(giroFallito('collegamento')); }, 60 * 1000);
}

// ---------- «Sei ancora lì?» ----------
// ⚠️ È l'unico dei due meccanismi che RECUPERA prenotazioni. Chi si ferma a
// metà quasi mai ha cambiato idea: si è distratto, e la conversazione resta lì
// finché non scade. Una domanda sola, con dentro cosa manca, riporta indietro
// gente che altrimenti non tornava — e un tavolo vale molto più del messaggio.
//
// Tutti i paletti stanno nel motore (`daRichiamare`): mai di notte, mai a chi è
// in mano a una persona, mai a chi ha scritto STOP, una volta sola per
// conversazione. Qui si manda e basta, perché questo è l'unico posto che sa se
// WhatsApp è collegato.
async function richiamaLasciateAMeta(adesso = new Date()) {
  const perche = motivoPerCuiNonSiManda();
  if (perche) { lavoriFermi(perche); return 0; }
  lavoriRipartiti();
  const cfg = bot.config(db);
  let mandati = 0;
  let falliti = 0;
  for (const r of bot.daRichiamare(db, cfg, adesso)) {
    const testo = bot.riempi(cfg.bot_t_richiamo, {
      cosa: r.cosa, locale: cfg.bot_locale || 'noi', assistente: cfg.bot_assistente || '',
    });
    try {
      await inviaConRitmo(r.telefono, testo);
      // Si segna solo DOPO: segnarlo prima vorrebbe dire non richiamare mai
      // più qualcuno a cui il messaggio non è nemmeno arrivato.
      bot.segnaRichiamata(db, r.telefono, adesso);
      mandati++;
    } catch (e) { falliti++; console.error('Bot:', e.message); }
  }
  // Richiamato e ancora zitto: si lascia andare. Non è un'amnesia a sorpresa —
  // a quella persona il bot ha già chiesto «sei ancora lì?».
  let lasciate = 0;
  for (const r of bot.daLasciareAndare(db, cfg, adesso)) {
    bot.lasciaAndare(db, r.telefono, adesso);
    lasciate++;
  }
  if (mandati) annota('richiamo', `chiesto «sei ancora lì?» a ${mandati} ${mandati === 1 ? 'persona' : 'persone'}`);
  if (falliti) annota('errore', `${falliti} richiam${falliti === 1 ? 'o' : 'i'} non partiti`);
  if (lasciate) annota('richiamo', `${lasciate} conversazion${lasciate === 1 ? 'e lasciata' : 'i lasciate'} andare: nessuna risposta dopo il richiamo`);
  return mandati;
}

if (botDisponibile()) {
  setInterval(() => { richiamaLasciateAMeta().catch(giroFallito('richiamo')); }, 60 * 1000);
}

// ---------------------------------------------------------------------------
//  Stripe
// ---------------------------------------------------------------------------
//
//  ⚠️ Nessuna libreria in più. L'API di Stripe è HTTPS normale con il corpo
//  scritto come un modulo: quaranta righe qui valgono una dipendenza in meno da
//  installare e aggiornare sul mini-PC di ogni ristorante.
//
//  ⚠️ E soprattutto: si CHIEDE a Stripe, non si aspetta che chiami lui. Il
//  mini-PC sta dietro il router del ristorante, senza porte aperte: un webhook
//  non arriverebbe mai. Chiedere ha anche un vantaggio che il webhook non ha —
//  se la macchina è spenta mentre il cliente paga, il webhook si perde, mentre
//  la domanda alla riaccensione trova comunque «pagato».

const STRIPE_BASE = process.env.ISTUDIO_STRIPE_BASE || 'https://api.stripe.com';

// Il corpo come lo vuole Stripe: chiavi annidate scritte con le parentesi
// quadre, «line_items[0][price_data][unit_amount]=12000».
function comeModulo(oggetto, prefisso = '') {
  const pezzi = [];
  for (const [k, v] of Object.entries(oggetto)) {
    if (v === undefined || v === null) continue;
    const nome = prefisso ? `${prefisso}[${k}]` : k;
    if (typeof v === 'object') pezzi.push(comeModulo(v, nome));
    else pezzi.push(`${encodeURIComponent(nome)}=${encodeURIComponent(String(v))}`);
  }
  return pezzi.filter(Boolean).join('&');
}

// ⚠️ Il tempo massimo è tassativo. Senza, una linea che non risponde lascia la
// richiesta appesa e con lei il cliente, che ha appena finito di prenotare e
// resta a guardare la chat.
const STRIPE_ATTESA = 15000;

// Quanto ci mette Stripe a rispondere SU QUESTA LINEA.
//
// ⚠️ Non è curiosità: da questo numero dipende se il cliente aspetta mezzo
// secondo o cinque dopo aver scritto la sua email. Sulla fibra di un ufficio è
// una cosa, sulla linea di un ristorante può esserne un'altra — e finora era
// una stima, non un dato. Qui si misura, e si scrive nella Diagnostica.
//
// Si tengono gli ultimi venti e basta: serve a rispondere a «com'è andata
// stasera», non a fare uno storico.
const tempiStripe = [];
function segnaTempoStripe(millesimi, riuscito) {
  tempiStripe.push({ ms: millesimi, ok: riuscito, quando: Date.now() });
  if (tempiStripe.length > 20) tempiStripe.shift();
}
function comeVaStripe() {
  if (!tempiStripe.length) return null;
  const ok = tempiStripe.filter((t) => t.ok);
  const media = ok.length ? Math.round(ok.reduce((a, t) => a + t.ms, 0) / ok.length) : null;
  return {
    misure: tempiStripe.length,
    media,
    peggiore: ok.length ? Math.max(...ok.map((t) => t.ms)) : null,
    falliti: tempiStripe.length - ok.length,
    ultima: tempiStripe[tempiStripe.length - 1],
  };
}

// `idempotenza` è la chiave con cui Stripe riconosce una richiesta già
// ricevuta: se la nostra linea cade DOPO che Stripe ha creato il pagamento ma
// prima di risponderci, il tentativo successivo con la stessa chiave riavrà
// quel pagamento invece di crearne un secondo. Senza, un cliente poteva
// ritrovarsi due collegamenti — e due addebiti possibili — per un tavolo.
function stripeChiedi(cfg, metodo, percorso, corpo, idempotenza) {
  const chiave = String(cfg.bot_pagamento_chiave || '').trim();
  if (!chiave) return Promise.resolve({ ok: false, errore: 'Manca la chiave di Stripe' });
  const dati = corpo ? comeModulo(corpo) : '';
  const u = new URL(STRIPE_BASE + percorso);
  const modulo = u.protocol === 'http:' ? require('http') : require('https');
  const partito = Date.now();
  return new Promise((risolviGrezzo) => {
    // Il cronometro si ferma comunque vada: un errore che ci mette dieci
    // secondi è un'informazione quanto una risposta riuscita.
    const risolvi = (esito) => { segnaTempoStripe(Date.now() - partito, !!esito.ok); risolviGrezzo(esito); };
    const req = modulo.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search, method: metodo,
      headers: {
        Authorization: 'Bearer ' + chiave,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(dati),
        ...(idempotenza ? { 'Idempotency-Key': String(idempotenza) } : {}),
      },
    }, (res) => {
      let testo = '';
      res.on('data', (c) => { testo += c; });
      res.on('end', () => {
        let d = null;
        try { d = JSON.parse(testo); } catch { d = null; }
        if (res.statusCode >= 200 && res.statusCode < 300) return risolvi({ ok: true, dati: d });
        // ⚠️ Il messaggio di Stripe si riporta così com'è: dice cose precise
        // («No such price», «Invalid API Key»), e riscriverlo con parole nostre
        // vorrebbe dire far indovinare chi legge.
        risolvi({ ok: false, stato: res.statusCode, errore: (d && d.error && d.error.message) || `Stripe ha risposto ${res.statusCode}` });
      });
    });
    req.on('error', (e) => risolvi({ ok: false, errore: e.message }));
    req.setTimeout(STRIPE_ATTESA, () => { req.destroy(new Error('Stripe non risponde')); });
    if (dati) req.write(dati);
    req.end();
  });
}

// «Chi sono?»: serve a provare la chiave nel momento in cui la si salva,
// invece di scoprirla sbagliata col primo cliente vero.
async function stripeChiSono(cfg) {
  const r = await stripeChiedi(cfg, 'GET', '/v1/account');
  if (!r.ok) return r;
  const a = r.dati || {};
  return { ok: true, nome: a.business_profile && a.business_profile.name ? a.business_profile.name : (a.email || a.id || 'conto Stripe') };
}

// Da «2026-09-05 12:30:00» ai secondi che vuole Stripe. Torna `null` — non
// NaN — quando la data non c'è o non si legge: `comeModulo` i valori nulli li
// lascia fuori dal corpo, mentre un NaN lo scriverebbe così com'è e la
// richiesta verrebbe rifiutata tutta.
function orarioUnix(quando) {
  if (!quando) return null;
  const t = new Date(String(quando).replace(' ', 'T')).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

// Il pagamento di UNA prenotazione: un indirizzo suo, con dentro l'importo
// giusto e un riferimento che punta a quella riga. Non è un link generico —
// è così che si sa CHI ha pagato.
async function stripeCreaPagamento(cfg, p) {
  // ⚠️ La scadenza può NON esserci: col pagamento facoltativo la prenotazione
  // nasce confermata e `pagamento_scade_at` resta vuoto. Scritto com'era —
  // `new Date(String(null))` — quel vuoto diventava NaN, e a Stripe partiva
  // «expires_at=NaN»: risposta 400, collegamento mai creato, cioè il pagamento
  // facoltativo che non funzionava affatto. Un finto Stripe che diceva sempre
  // sì l'aveva nascosto; adesso il finto rifiuta come quello vero.
  //
  // Senza scadenza il campo non si manda proprio, e Stripe usa la sua
  // (ventiquattro ore): un collegamento che dura un giorno è esattamente quello
  // che serve a un acconto che non blocca niente.
  const scade = orarioUnix(p.pagamento_scade_at);
  const ritorno = String(cfg.bot_pagamento_ritorno || '').trim();
  // La chiave cambia con la scadenza: Stripe rifiuta la stessa chiave con un
  // corpo diverso, e la scadenza è l'unica cosa che può cambiare fra un
  // tentativo e l'altro (vedi riprovaICollegamenti).
  const idempotenza = `pren-${p.id}-${scade || 'senza'}-${p.importo_dovuto}`;
  const r = await stripeChiedi(cfg, 'POST', '/v1/checkout/sessions', {
    mode: 'payment',
    // Il riferimento alla prenotazione, che è quello che si guarda quando si
    // chiede l'elenco dei pagamenti.
    client_reference_id: `pren-${p.id}`,
    metadata: { prenotazione: String(p.id) },
    expires_at: scade,
    success_url: ritorno,
    cancel_url: ritorno,
    line_items: {
      0: {
        quantity: 1,
        price_data: {
          currency: 'eur',
          unit_amount: p.importo_dovuto,
          product_data: {
            name: `Prenotazione da ${cfg.bot_locale || 'noi'} — ${bot.dataItaliana(p.data)} ${p.ora}`,
            description: `${p.persone} ${p.persone === 1 ? 'persona' : 'persone'}`,
          },
        },
      },
    },
  }, idempotenza);
  if (!r.ok) return r;
  return { ok: true, id: r.dati.id, link: r.dati.url };
}

// I pagamenti recenti, in UNA domanda sola.
//
// ⚠️ Non una per prenotazione: con dieci in attesa sarebbero dieci domande ogni
// quindici secondi, e il traffico crescerebbe col numero di clienti proprio la
// sera in cui ce ne sono di più. Così invece resta una, sempre.
// ⚠️ Stripe risponde cento alla volta, e dice «has_more» se ce ne sono altre.
// Prima si leggeva solo la prima pagina: su un conto Stripe che il ristorante
// usa anche per altro — il negozio online, i buoni regalo — il pagamento di
// una prenotazione poteva essere il centunesimo, e non veniva visto MAI. La
// prenotazione scadeva, il posto tornava libero, e al cliente arrivava «non ti
// è stato addebitato niente» con l'addebito fatto.
//
// Dieci pagine al massimo — mille pagamenti in un giorno — non per risparmio
// ma per non restare in un giro senza fine se Stripe rispondesse sempre
// «has_more»: a quel punto è meglio un elenco parziale e un giro dopo.
async function stripePagamentiRecenti(cfg, daQuando) {
  const dopo = Math.floor(daQuando.getTime() / 1000);
  const sessioni = [];
  let ultimo = '';
  for (let pagina = 0; pagina < 10; pagina++) {
    const r = await stripeChiedi(cfg, 'GET',
      `/v1/checkout/sessions?limit=100&created%5Bgte%5D=${dopo}`
      + (ultimo ? `&starting_after=${encodeURIComponent(ultimo)}` : ''));
    if (!r.ok) return r;
    const pezzo = (r.dati && r.dati.data) || [];
    sessioni.push(...pezzo);
    if (!(r.dati && r.dati.has_more) || !pezzo.length) break;
    ultimo = pezzo[pezzo.length - 1].id;
  }
  return { ok: true, sessioni };
}

// ---------- I posti tenuti da chi non ha pagato ----------
//
// Ogni minuto si guarda chi ha finito il tempo. Il posto torna libero, e
// soprattutto la persona VIENE AVVISATA: liberare un tavolo senza dirlo a chi
// credeva di averlo è il modo più rapido di ritrovarselo alla porta.
//
// ⚠️ Il posto si libera comunque, anche se il messaggio non parte (WhatsApp
// scollegato, numero irraggiungibile). Il contrario — tenere il tavolo fermo
// perché non siamo riusciti ad avvisare — lascerebbe il locale mezzo vuoto per
// un guasto nostro.
// ⚠️ Un minuto di grazia prima di liberare un posto scaduto, e non è un
// dettaglio: chi paga all'ultimo istante viene visto dal giro seguente — che
// passa ogni quindici secondi — e senza questa attesa il tavolo gli veniva
// tolto NEL FRATTEMPO, con un messaggio che diceva «non ti è stato addebitato
// niente» mentre l'addebito c'era stato. Poi il pagamento arrivava, la
// prenotazione tornava confermata, e il cliente si ritrovava due messaggi che
// si contraddicono — il primo dei quali era una bugia sui soldi.
//
// Dopo la scadenza Stripe rifiuta il pagamento, quindi nessun incasso può
// arrivare più tardi: aspettare un minuto basta e non lascia niente in sospeso.
const GRAZIA_SCADENZA = 60 * 1000;

async function chiudiPagamentiScaduti(adesso = new Date()) {
  if (!botConcesso()) return 0;
  // Prima si guarda chi ha pagato, poi si libera: nell'ordine inverso si
  // toglie il tavolo a qualcuno che ha appena pagato.
  try { await guardaChiHaPagato(); } catch {}
  const scadute = bot.liberaScadute(db, new Date(adesso.getTime() - GRAZIA_SCADENZA));
  if (!scadute.length) return 0;
  const cfg = bot.config(db);
  annota('pagamento', `${scadute.length} ${scadute.length === 1 ? 'prenotazione scaduta' : 'prenotazioni scadute'}: posti liberati`);
  for (const p of scadute) {
    try {
      await inviaAlCliente(p, bot.riempi(cfg.bot_t_pagamento_scaduto, {
        nome: p.nome || '', cognome: p.cognome || '',
        data: bot.dataItaliana(p.data), ora: p.ora, persone: p.persone,
        locale: cfg.bot_locale || 'noi',
      }));
    } catch (e) {
      // Non è un guasto da fermare tutto: il posto è già libero, ed è quello
      // che conta per il locale. Ma va scritto, perché quella persona non sa
      // di aver perso il tavolo.
      annota('errore', `scaduta la ${p.id} ma non sono riuscito ad avvisare il cliente: ${e.message}`);
    }
  }
  return scadute.length;
}

// Il collegamento di una prenotazione che NON ESISTE PIÙ non deve restare
// pagabile. Prima restava: il cliente scriveva CANCELLA, il tavolo tornava
// libero, e il link nella chat — o nell'email — continuava a incassare. Un
// cliente distratto pagava un tavolo che non c'era, e il locale si ritrovava
// un rimborso da fare senza sapere nemmeno di cosa.
//
// Se Stripe risponde che la sessione non è più «aperta», vuol dire che è già
// stata pagata o è già scaduta da sé: in tutti e due i casi non c'è niente da
// chiudere, e il pagamento eventualmente arrivato lo vede `guardaChiHaPagato`.
async function chiudiIlPagamento(p) {
  if (!p || !p.pagamento_id || p.pagato_at) return { ok: true, niente: true };
  const cfg = bot.config(db);
  const r = await stripeChiedi(cfg, 'POST',
    `/v1/checkout/sessions/${encodeURIComponent(p.pagamento_id)}/expire`);
  if (!r.ok) annota('errore', `annullata la ${p.id} ma non sono riuscito a chiudere il collegamento per pagare: ${r.errore}`);
  return r;
}

// Il messaggio col collegamento, ricostruito dalla riga in archivio. Serve
// quando il collegamento arriva in ritardo: il testo che il motore aveva
// preparato al momento della prenotazione non c'è più.
function testoDelCollegamento(cfg, p, link) {
  const resto = p.importo_totale - p.importo_dovuto;
  return bot.riempi(cfg.bot_t_pagamento, {
    data: bot.dataItaliana(p.data), ora: p.ora, persone: p.persone,
    nome: p.nome || '', cognome: p.cognome || '',
    importo: bot.euro(p.importo_dovuto),
    resto: resto > 0 ? `Il resto — ${bot.euro(resto)} — si salda al ristorante.\n` : '',
    scadenza: bot.oreEMinuti(p.pagamento_scade_at),
  }).split('{link}').join(link);
}

// ⚠️ Quando Stripe non risponde, il bot scrive «te lo mando appena è pronto»
// — e fino a qui nessuno lo mandava mai. La prenotazione restava in attesa
// senza un collegamento, per mezz'ora, e poi scadeva: al cliente arrivava
// «il tempo per pagare è scaduto» per un pagamento che non ha mai potuto
// fare. Una promessa scritta dal bot e mantenuta da nessuno.
//
// Ogni minuto si riprova con chi è rimasto senza. Solo le prenotazioni nate da
// più di un minuto e mezzo: una appena nata potrebbe avere il primo tentativo
// ancora in corso, e due tentativi insieme sono due messaggi al cliente.
//
// Stripe vuole almeno mezz'ora di vita per un pagamento: se alla prenotazione
// ne resta meno — o la scadenza è già passata — la scadenza si sposta a
// mezz'ora da adesso. Il ritardo è nostro, non del cliente, e il messaggio
// dice l'ora nuova.
const ATTESA_PRIMA_DI_RIPROVARE = 90 * 1000;
async function riprovaICollegamenti(adesso = new Date()) {
  if (!botConcesso()) return 0;
  const cfg = bot.config(db);
  if (!bot.boolDi(cfg.bot_pagamento_attivo)) return 0;
  const senza = db.prepare(
    "SELECT * FROM prenotazioni WHERE stato = 'attesa_pagamento' AND pagamento_id = '' "
    + "AND (pagato_at IS NULL OR pagato_at = '') AND creata_at <= ?"
  ).all(bot.comeOrario(new Date(adesso.getTime() - ATTESA_PRIMA_DI_RIPROVARE)));
  let mandati = 0;
  for (const p of senza) {
    const minimo = new Date(adesso.getTime() + bot.MINUTI_MINIMI * 60000);
    const scadeA = p.pagamento_scade_at ? new Date(String(p.pagamento_scade_at).replace(' ', 'T')) : null;
    if (!scadeA || Number.isNaN(scadeA.getTime()) || scadeA < minimo) {
      p.pagamento_scade_at = bot.comeOrario(minimo);
      db.prepare('UPDATE prenotazioni SET pagamento_scade_at = ? WHERE id = ?').run(p.pagamento_scade_at, p.id);
    }
    const r = await stripeCreaPagamento(cfg, p);
    if (!r.ok) {
      // Un errore per giro e basta: se Stripe è giù, dirlo ogni minuto per
      // ogni prenotazione coprirebbe tutto il resto del registro.
      if (!riprovaICollegamenti.zitto) {
        annota('errore', `ancora niente collegamento per la ${p.id}: ${r.errore}`);
        riprovaICollegamenti.zitto = true;
      }
      continue;
    }
    riprovaICollegamenti.zitto = false;
    db.prepare('UPDATE prenotazioni SET pagamento_id = ? WHERE id = ?').run(r.id, p.id);
    try {
      await inviaAlCliente(p, testoDelCollegamento(cfg, p, r.link));
      mandati++;
      annota('pagamento', `collegamento per pagare mandato in ritardo per la ${p.id}`);
    } catch (e) {
      annota('errore', `collegamento creato per la ${p.id} ma il messaggio non è partito: ${e.message}`);
    }
    await mandaEmailPrenotazione(p, r.link);
  }
  return mandati;
}

// I due lavori del minuto, nell'ordine che conta: PRIMA si riprova a dare il
// collegamento a chi non l'ha mai avuto, POI si liberano i posti scaduti.
// Nell'ordine inverso, la scadenza porterebbe via un tavolo a chi stava per
// ricevere — adesso — il modo di pagarlo.
// ---------- La lista d'attesa ----------
//
// Chi trova pieno lascia il nome; qui, ogni minuto, si guarda se per qualcuno
// si è liberato un posto e glielo si scrive. Decide il bot (una persona alla
// volta per giornata, in ordine di arrivo, con un tempo per rispondere): qui si
// manda soltanto, perché solo qui si sa se WhatsApp è collegato. Un invio che
// non parte rimette la persona in coda: non deve perdere il posto per un
// guasto nostro.
async function avvisaLaListaDAttesa(adesso = new Date()) {
  const perche = motivoPerCuiNonSiManda();
  if (perche) { lavoriFermi(perche); return 0; }
  lavoriRipartiti();
  const cfg = bot.config(db);

  // Prima si fa la pulizia — chi non ha risposto in tempo torna in coda — e
  // poi si decide a chi proporre i posti. Nessuna delle due manda niente: qui
  // si sa chi avvisare, e si scrive in un ordine scelto apposta.
  const scaduti = bot.scadenzeDellaAttesa(db, cfg, adesso);
  const proposte = bot.chiDaAvvisareInAttesa(db, cfg, adesso);

  // ⚠️ A chi ha finito il tempo si scrive PRIMA che il posto vada a un altro:
  // scoprirlo dopo — o non scoprirlo affatto — è il modo peggiore.
  // ⚠️ Ma NON a chi, in questo stesso giro, si è visto riproporre il posto:
  // capita quando in coda non c'è nessun altro, e si ritroverebbe due messaggi
  // di fila, «è andato a un altro» e «si è liberato un posto». Non ha perso
  // niente: non gli si dice che ha perso qualcosa.
  const riproposti = new Set(proposte.map((x) => x.telefono));
  for (const r of scaduti) {
    if (riproposti.has(r.telefono)) continue;
    const quando = r.ora ? `delle ${r.ora} ${bot.dataItaliana(r.data)}` : bot.dataItaliana(r.data);
    try {
      await rispondiConRitmo(r.telefono, bot.riempi(cfg.bot_t_attesa_scaduta, {
        locale: cfg.bot_locale || 'noi', assistente: cfg.bot_assistente || '',
        nome: r.nome || '', cognome: r.cognome || '',
        quando, data: bot.dataItaliana(r.data), ora: r.ora || '', persone: r.persone,
      }));
      annota('lista d\'attesa', `tempo scaduto per ${bot.nomeInSala(r)}: torna in coda`);
    } catch (e) {
      // Il messaggio è una cortesia: se non parte, la persona resta comunque
      // in coda (lo ha già fatto il bot) e il giro non si ferma qui.
      annota('errore', `lista d'attesa: non riesco ad avvisare ${bot.nomeInSala(r)}: ${e.message}`);
    }
  }

  let mandate = 0;
  for (const r of proposte) {
    const quando = `per ${bot.dataItaliana(r.data)} alle ${r.ora}`;
    const testo = bot.riempi(cfg.bot_t_attesa_libero, {
      locale: cfg.bot_locale || 'noi', assistente: cfg.bot_assistente || '',
      nome: r.nome || '', cognome: r.cognome || '',
      quando, data: bot.dataItaliana(r.data), ora: r.ora, persone: r.persone, minuti: r.minuti,
    });
    try {
      await rispondiConRitmo(r.telefono, testo);
      mandate++;
      annota('lista d\'attesa', `proposto un posto ${quando} a ${bot.nomeInSala(r)} (${r.persone} pers.)`);
    } catch (e) {
      bot.rimettiInAttesa(db, r.id, adesso);
      annota('errore', `lista d'attesa: non riesco a scrivere a ${bot.nomeInSala(r)}: ${e.message}`);
    }
  }
  return mandate;
}

async function giroDelMinuto() {
  try { await riprovaICollegamenti(); } catch {}
  await chiudiPagamentiScaduti();
  // Per ultima, di proposito: un pagamento scaduto ha appena liberato dei
  // posti, e chi è in lista li deve vedere in questo stesso giro, non fra
  // un minuto.
  try { await avvisaLaListaDAttesa(); } catch (e) { annota('errore', `lista d'attesa: ${e.message}`); }
  // Le conversazioni a mano finite da ore: qui l'ordine non conta.
  try { chiudiConversazioniFinite(); } catch (e) { console.error('Bot:', e.message); }
}

if (botDisponibile()) {
  try { chiudiConversazioniFinite(); } catch (e) { console.error('Bot:', e.message); }
  setInterval(() => { giroDelMinuto().catch(giroFallito('giro del minuto')); }, 60 * 1000);
}

// ---------- «C'è una versione più nuova» ----------
// Ogni ora, e una volta poco dopo l'accensione. Il primo controllo aspetta
// venti secondi per non rallentare l'avvio, che è il momento in cui la
// macchina ha altro da fare.
// ⚠️ Era ogni SEI ore, «tanto le versioni escono qualche volta al mese». Poi
// in un giorno ne sono uscite ventinove, e chi aveva appena pubblicato guardava
// il mini-PC e non vedeva niente: il cartello poteva arrivare sei ore dopo. La
// richiesta è un file di 43 byte, e una volta all'ora non è rumore per nessuno.
// L'installazione vera resta alle 5 del mattino: questo è solo il cartello.
if (depositoAggiornamenti()) {
  const controlloFallito = (e) => console.error('Aggiornamenti:', (e && e.message) || e);
  setTimeout(() => { guardaSeCePiuNuova().catch(controlloFallito); }, 20 * 1000).unref?.();
  setInterval(() => { guardaSeCePiuNuova().catch(controlloFallito); }, 60 * 60 * 1000);
}

// ---------- L'email di riepilogo ----------
//
// Parte due volte per la stessa prenotazione: quando nasce e quando viene
// pagata. Il testo è UNO SOLO — il riepilogo non cambia — e l'unica cosa che
// cambia è il pezzo dei soldi, che se lo scrive `bot.bloccoPagamento`. Con due
// testi separati, chi ne corregge uno lascia l'altro indietro e il cliente
// riceve due email che si somigliano ma non dicono le stesse cose.
//
// ⚠️ Non lancia MAI. L'email è un di più: la prenotazione è già scritta in
// archivio e il cliente ha già avuto il messaggio su WhatsApp. Se la posta non
// parte si annota — così il locale lo vede nel registro — ma non si rimette in
// discussione niente. Il valore di ritorno dice com'è andata a chi lo vuole
// sapere (il simulatore), e nessun altro è obbligato a guardarlo.
// Un testo qualunque, reso innocuo dentro l'HTML.
function htmlSicuro(t) {
  return String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Da testo a HTML: scappato, a capo con <br>, e i collegamenti cliccabili.
// ⚠️ Il collegamento si fa DOPO aver scappato: nell'indirizzo un «&» deve
// diventare «&amp;» anche dentro href, ed è così che vuole l'HTML.
function testoInHtml(t) {
  return htmlSicuro(t)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#128c7e">$1</a>')
    .replace(/\n/g, '<br>');
}

// L'email di riepilogo in HTML: il modello del locale se c'è, sennò quello
// incorporato — logo in testa, nome del locale, il testo, una riga in fondo.
//
// ⚠️ I valori del cliente entrano SEMPRE scappati, in tutti e due i casi. Un
// cliente che si chiama «<b>Mario</b>» non deve poter cambiare la grafica
// dell'email, e una nota con un «<» non deve mangiarsi il resto. Nel modello
// del locale i segnaposto sono gli stessi del testo, più «{logo}» (l'immagine,
// o niente) e «{testo}» (tutto il testo dell'email già riempito, così un
// modello può limitarsi a metterci una cornice intorno).
function corpoEmailRiepilogo(cfg, valori, testo, conLogo) {
  const logoHtml = conLogo
    ? '<img src="cid:logo-istudio" alt="' + htmlSicuro(cfg.bot_locale || '') + '" style="max-width:220px;max-height:120px;height:auto;display:block;margin:0 auto 18px">'
    : '';
  const modello = String(cfg.bot_email_html || '').trim();
  if (modello) {
    // ⚠️ I BLOCCHI CONDIZIONALI: «{?note} … {/note}» compare solo se quel
    // segnaposto ha qualcosa dentro. Senza, un modello fatto a riquadri mostra
    // un riquadro «quello che ci hai scritto» VUOTO a ogni prenotazione senza
    // note — cioè quasi tutte — e uno «da pagare» vuoto quando non c'è niente
    // da pagare. Con un modello a testo libero non si notava; con un modello
    // disegnato si nota subito.
    // Si risolvono PRIMA dei segnaposto normali: quello che resta dentro a un
    // blocco tenuto viene riempito dopo, come tutto il resto.
    const pieno = (chiave) => {
      if (chiave === 'logo') return !!conLogo;
      if (chiave === 'testo') return String(testo || '').trim() !== '';
      return String(valori[chiave] == null ? '' : valori[chiave]).trim() !== '';
    };
    return modello.replace(/\{\?(\w+)\}([\s\S]*?)\{\/\1\}/g,
      (intero, chiave, dentro) => (pieno(chiave) ? dentro : '')
    ).replace(/\{(\w+)\}/g, (intero, chiave) => {
      if (chiave === 'logo') return logoHtml;
      if (chiave === 'testo') return testoInHtml(testo);
      if (chiave === 'pagamento') return testoInHtml(valori.pagamento || '');
      if (valori[chiave] === undefined || valori[chiave] === null) return intero;
      return testoInHtml(String(valori[chiave]));
    });
  }
  return '<div style="background:#f0f2f5;padding:24px 12px;font-family:Arial,Helvetica,sans-serif">'
    + '<div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #e0e4e8;border-radius:12px;padding:28px 26px;color:#222;font-size:15px;line-height:1.6">'
    + logoHtml
    + (cfg.bot_locale ? '<div style="text-align:center;font-size:18px;font-weight:700;color:#128c7e;margin-bottom:18px">' + htmlSicuro(cfg.bot_locale) + '</div>' : '')
    + testoInHtml(testo)
    + '</div>'
    + '<div style="max-width:600px;margin:12px auto 0;text-align:center;font-size:12px;color:#667781">'
    + 'Questa email riguarda la tua prenotazione' + (cfg.bot_locale ? ' da ' + htmlSicuro(cfg.bot_locale) : '') + '.</div>'
    + '</div>';
}

// Tutto quello che serve per spedire l'email di una prenotazione, in un posto
// solo: la usa chi spedisce davvero e la usano l'anteprima e la prova — così
// quello che vedi prima è esattamente quello che parte dopo.
function composizioneEmail(cfg, p, link) {
  const valori = {
    nome: p.nome || '',
    cognome: p.cognome || '',
    data: bot.dataItaliana(p.data),
    ora: p.ora || '',
    persone: p.persone,
    telefono: p.telefono_contatto || '',
    note: p.note ? `📝 ${p.note}\n` : '',
    pagamento: bot.bloccoPagamento(p, link),
    locale: cfg.bot_locale || '',
  };
  const oggetto = bot.riempi(cfg.bot_email_oggetto, valori).replace(/\n/g, ' ').trim()
    || 'La tua prenotazione';
  const testo = bot.riempi(cfg.bot_email_testo, valori);
  const logo = leggiImmagine(cfg.bot_email_logo);
  return {
    oggetto, testo,
    html: corpoEmailRiepilogo(cfg, valori, testo, !!logo),
    allegati: logo ? [{ filename: 'logo.png', content: Buffer.from(logo.base64, 'base64'), cid: 'logo-istudio' }] : undefined,
  };
}

async function mandaEmailPrenotazione(p, link) {
  const cfg = bot.config(db);
  if (!bot.boolDi(cfg.bot_email_attiva)) return { ok: false, motivo: 'spenta' };
  const dove = String((p && p.email) || '').trim();
  if (!dove) return { ok: false, motivo: 'niente indirizzo' };
  if (!EMAIL_RE.test(dove)) {
    annota('errore', `email di ${bot.nomeInSala(p)} scritta male: ${dove}`);
    return { ok: false, motivo: 'indirizzo scritto male' };
  }
  // ⚠️ Un'email che chiede soldi e non dice DOVE pagarli è peggio di nessuna
  // email: il cliente legge «il tavolo non è ancora tuo, paga adesso» e non ha
  // niente su cui premere. Succede quando Stripe non risponde, e il posto di
  // questo controllo è QUI e non nei quattro punti che la chiamano: uno dei
  // quattro se ne dimenticherebbe. (È già successo: nel simulatore.)
  // ⚠️ La domanda è «c'è un importo NON ancora versato?», non «in che stato è».
  // Col pagamento facoltativo la prenotazione è confermata e l'acconto è
  // ancora da versare: guardando lo stato, questa email sarebbe partita con
  // l'invito a lasciare un acconto e nessun posto dove lasciarlo.
  if (p.importo_dovuto && !p.pagato_at && !link) {
    return { ok: false, motivo: 'manca il collegamento per pagare' };
  }
  const transporter = buildTransporter();
  if (!transporter) {
    // ⚠️ Questo NON è un caso raro da ignorare: è il ristorante che ha acceso
    // l'email senza aver mai configurato la posta. Va detto, altrimenti resta
    // un interruttore acceso che non fa niente.
    annota('errore', 'email di riepilogo accesa, ma la posta non è configurata (Impostazioni → Email)');
    return { ok: false, motivo: 'posta non configurata' };
  }
  const { oggetto, testo, html, allegati } = composizioneEmail(cfg, p, link);
  const nomeMittente = getSetting('smtp_from_name') || cfg.bot_locale || '';
  const indirizzoMittente = getSetting('smtp_user');
  try {
    await transporter.sendMail({
      from: nomeMittente ? `"${nomeMittente}" <${indirizzoMittente}>` : indirizzoMittente,
      to: dove,
      subject: oggetto,
      text: testo,
      html,
      attachments: allegati,
    });
    annota('email', `riepilogo mandato a ${dove}`);
    return { ok: true, a: dove };
  } catch (e) {
    annota('errore', `l'email di riepilogo a ${dove} non è partita: ${e.message}`);
    return { ok: false, motivo: e.message };
  }
}

// Il messaggio con dentro il link, e il link viene creato adesso.
//
// ⚠️ «Sta scrivendo…» si accende PRIMA di chiamare Stripe: è uno stato della
// chat, non un messaggio, quindi non entra in nessuna coda e non costa niente a
// nessuno. Un messaggio «attendi» invece finirebbe nella stessa fila del link e
// arriverebbe quando il link sarebbe già arrivato.
async function mandaIlPagamento(chatId, esito) {
  const cfg = bot.config(db);
  const p = db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(esito.daPagare.id);
  if (!p) return;
  await staScrivendo(chatId);
  const r = await stripeCreaPagamento(cfg, p);
  if (!r.ok) {
    // ⚠️ Il posto NON si libera: la richiesta è valida, è il collegamento che
    // manca. Si dice al cliente che sta arrivando, e si avvisa il locale —
    // perché quella prenotazione, da sola, non si sbloccherà.
    annota('errore', `non riesco a creare il pagamento per la ${p.id}: ${r.errore}`);
    try {
      // ⚠️ Col pagamento FACOLTATIVO il tavolo è già prenotato, e il cliente
      // deve saperlo: «sto preparando il collegamento» gli farebbe credere di
      // essere ancora in sospeso per una caparra che poteva non versare. Un
      // guasto nostro non deve peggiorare la sua prenotazione.
      await rispondiConRitmo(chatId, esito.daPagare.ripiego
        || bot.riempi(cfg.bot_t_pagamento_lento, {
          nome: p.nome || '', data: bot.dataItaliana(p.data), ora: p.ora, persone: p.persone,
        }));
    } catch {}
    return;
  }
  db.prepare('UPDATE prenotazioni SET pagamento_id = ? WHERE id = ?').run(r.id, p.id);
  await rispondiConRitmo(chatId, String(esito.daPagare.testo).split('{link}').join(r.link));
  // ⚠️ L'email parte DOPO il messaggio, e col link dentro. Prima non si poteva:
  // il link non esisteva ancora, e un'email che dice «paga qui» senza il dove
  // è peggio di nessuna email.
  await mandaEmailPrenotazione(p, r.link);
}

// Cosa si scrive al cliente quando il pagamento risulta arrivato.
//
// ⚠️ Sono due notizie diverse. Col pagamento obbligatorio è «adesso il tavolo è
// tuo», ed è la notizia. Col facoltativo il tavolo era già suo da mezz'ora, e
// riannunciarglielo gli fa credere che prima non lo fosse — cioè che la caparra
// servisse davvero. Lì la notizia è solo «grazie, ricevuto».
//
// Sta in UNA funzione perché le strade che ci arrivano sono due — Stripe e la
// spunta a mano — e con la scelta scritta in tutte e due, una delle due prima o
// poi resta indietro.
function testoDelPagamento(cfg, p, eraGiaConfermata) {
  const valori = {
    nome: p.nome || '', cognome: p.cognome || '',
    data: bot.dataItaliana(p.data), ora: p.ora, persone: p.persone,
    importo: bot.euro(p.importo_dovuto), locale: cfg.bot_locale || 'noi',
    resto: p.importo_totale > p.importo_dovuto
      ? `Il resto — ${bot.euro(p.importo_totale - p.importo_dovuto)} — si salda al ristorante.\n` : '',
  };
  return bot.riempi(eraGiaConfermata ? cfg.bot_t_caparra_ricevuta : cfg.bot_t_pagata, valori);
}

// ---------- Chi ha pagato? ----------
//
// Ogni quindici secondi, e SOLO se c'è qualcosa in attesa: a locale tranquillo
// non si chiede niente a nessuno.
let controlloInCorso = false;
async function guardaChiHaPagato() {
  if (!botConcesso() || controlloInCorso) return 0;
  const cfg = bot.config(db);
  if (!bot.boolDi(cfg.bot_pagamento_attivo)) return 0;
  // ⚠️ Non solo le «in attesa». Col pagamento FACOLTATIVO la prenotazione nasce
  // confermata e la caparra arriva dopo: cercando per stato, quel versamento
  // non lo si sarebbe visto mai — incassato su Stripe e invisibile in sala.
  // La domanda giusta non è «in che stato è» ma «ha un pagamento aperto che
  // non risulta ancora versato».
  const daControllare = db.prepare(
    'SELECT * FROM prenotazioni WHERE pagamento_id <> \'\' '
    + "AND (pagato_at IS NULL OR pagato_at = '') AND stato IN " + bot.dentro(bot.STATI_VIVI)
  ).all();
  if (!daControllare.length) return 0;

  controlloInCorso = true;
  try {
    // Si guarda indietro di un giorno: più della finestra massima che Stripe
    // consente (24 ore), così nessun pagamento può restare fuori dall'elenco.
    const r = await stripePagamentiRecenti(cfg, new Date(Date.now() - 25 * 3600 * 1000));
    if (!r.ok) {
      // ⚠️ Non è un guasto da gridare a ogni giro: se la linea è giù, questo
      // messaggio comparirebbe quattro volte al minuto e coprirebbe tutto il
      // resto. Si annota il primo e basta.
      if (!guardaChiHaPagato.zitto) {
        annota('errore', `non riesco a chiedere a Stripe: ${r.errore}`);
        guardaChiHaPagato.zitto = true;
      }
      return 0;
    }
    guardaChiHaPagato.zitto = false;
    const pagate = new Map();
    for (const sess of r.sessioni) {
      if (sess.payment_status !== 'paid') continue;
      pagate.set(String(sess.id), sess);
    }
    // ⚠️ DUE passate, non una. Prima si segnano pagate tutte — è sincrono,
    // costa millisecondi — e solo dopo si scrivono i messaggi, che fra uno e
    // l'altro aspettano il ritmo degli invii. Con una passata sola, dieci
    // clienti che pagavano insieme venivano segnati uno ogni secondo e mezzo:
    // il decimo risultava pagato tredici secondi dopo il primo, e con trenta
    // sarebbero stati quarantacinque. La registrazione di un incasso non deve
    // stare in coda dietro al messaggio di chi ha pagato prima — e se il
    // programma cade a metà, gli incassi sono già scritti tutti.
    const confermate = [];
    for (const p of daControllare) {
      const sess = pagate.get(String(p.pagamento_id));
      if (!sess) continue;
      // ⚠️ L'importo che scriviamo è quello che Stripe dice di aver incassato,
      // non quello che avevamo chiesto: fra la creazione del collegamento e il
      // pagamento può essere cambiato il prezzo nelle impostazioni, o le
      // persone della prenotazione. La riga in sala deve dire quello che è
      // entrato davvero.
      const esito = bot.segnaPagata(db, cfg, p.id, 'stripe', new Date(), sess.amount_total);
      if (!esito.ok) {
        // ⚠️ Il caso che fa arrabbiare: ha pagato, ma nel frattempo il posto è
        // stato dato a un altro. Non si conferma di nascosto e non si decide da
        // soli cosa fare dei soldi: lo si scrive, e lo vede il locale.
        annota('errore', `${bot.nomeInSala(p)} ha PAGATO ${bot.euro(p.importo_dovuto)} ma su quel turno non c'è più posto: da decidere`);
        continue;
      }
      confermate.push(esito);
    }
    for (const esito of confermate) {
      const q = esito.prenotazione;
      try {
        await inviaAlCliente(q, testoDelPagamento(cfg, q, esito.eraGiaConfermata));
      } catch (e) {
        annota('errore', `pagata la ${q.id} ma il messaggio al cliente non è partito: ${e.message}`);
      }
      // Il secondo riepilogo: stesso testo, ma adesso dice «pagamento
      // ricevuto» invece di «il tavolo NON è ancora prenotato». È l'email che
      // il cliente terrà — quella di prima parlava di una cosa da fare.
      await mandaEmailPrenotazione(q);
    }
    if (confermate.length) annota('pagamento', `${confermate.length} ${confermate.length === 1 ? 'pagamento ricevuto' : 'pagamenti ricevuti'}`);
    return confermate.length;
  } finally { controlloInCorso = false; }
}

if (botDisponibile()) {
  setInterval(() => { guardaChiHaPagato().catch(giroFallito('pagamenti')); }, 15 * 1000);
}

// ---------- La richiesta di recensione ----------
// Parte qualche giorno dopo la visita, e SOLO verso chi risulta venuto davvero.
// Chiederla a chi ha annullato o non si è presentato è il modo più rapido di
// trasformare un cliente tiepido in un cliente arrabbiato.
//
// ⚠️ Il collegamento va a TUTTI, senza filtri. Mandarlo solo a chi si è detto
// contento è «review gating»: le regole di Google lo vietano espressamente, e
// la sanzione ricade sulla scheda del ristorante, non su di noi. Chi ha avuto
// un problema ha comunque una via privata, scritta nello stesso messaggio.
function recensioniDaMandare(cfg, adesso) {
  if (!bot.boolDi(cfg.bot_recensione_attiva)) return [];
  const link = String(cfg.bot_recensione_link || '').trim();
  if (!link) return [];                       // senza collegamento non c'è niente da mandare

  // Non prima dell'ora scelta: un messaggio del genere alle 7 del mattino, o
  // alle 22, si legge come un disturbo qualunque cosa dica.
  const ora = adesso.getHours() * 60 + adesso.getMinutes();
  if (ora < bot.inMinuti(cfg.bot_recensione_ora || '11:00')) return [];

  const giorni = Math.max(bot.num(cfg.bot_recensione_giorni, 2), 1);
  const quando = bot.comeData(new Date(adesso.getTime() - giorni * 86400000));

  // ⚠️ «Massimo AL GIORNO», non «per giro». Questa funzione viene richiamata
  // ogni minuto: contando solo quelle di adesso, con il tetto a 20 ne partivano
  // 20 al minuto finché non finivano — 50 messaggi in tre minuti al posto di
  // 20 in un giorno. Cioè esattamente l'impronta di spam che il tetto doveva
  // evitare, con dentro tutte lo stesso collegamento.
  const oggi = bot.comeData(adesso);
  const giaOggi = db.prepare(
    'SELECT COUNT(*) n FROM prenotazioni WHERE recensione_at IS NOT NULL AND substr(recensione_at, 1, 10) = ?'
  ).get(oggi).n;
  const massimo = Math.max(bot.num(cfg.bot_recensione_max, 20), 1) - giaOggi;
  if (massimo <= 0) return [];

  // Solo «presentata»: chi non è venuto non ha niente da recensire.
  const righe = db.prepare(
    "SELECT * FROM prenotazioni WHERE data = ? AND stato = 'presentata' AND recensione_at IS NULL "
    + 'ORDER BY ora, id'
  ).all(quando);
  if (!righe.length) return [];

  // ⚠️ UNA SOLA, per persona, per sempre. Una recensione la si lascia una volta:
  // richiederla di nuovo — anche a distanza di mesi — non porta una seconda
  // recensione, porta un cliente infastidito. Chi viene ogni venerdì deve
  // riceverla la prima volta e mai più.
  const giaChiesta = new Set();
  for (const r of db.prepare('SELECT telefono, telefono_contatto FROM prenotazioni '
    + 'WHERE recensione_at IS NOT NULL').all()) {
    // Si guarda per NUMERO, non per riga: la stessa persona può aver prenotato
    // una volta da WhatsApp e una volta a mano, con due chiavi diverse.
    for (const x of [r.telefono_contatto, r.telefono]) {
      const n = normalizePhone(x || '');
      if (n) giaChiesta.add(n);
    }
  }

  // Un messaggio di questo tipo è una comunicazione commerciale: chi ha chiesto
  // di non ricevere più niente non lo riceve, punto.
  const bloccati = new Set(db.prepare('SELECT telefono FROM contacts WHERE opt_out = 1').all()
    .map((c) => normalizePhone(c.telefono)).filter(Boolean));

  const scelte = [];
  for (const r of righe) {
    if (scelte.length >= massimo) break;
    const suo = normalizePhone(r.telefono_contatto || r.telefono);
    const chat = normalizePhone(r.telefono || '');
    if (suo && bloccati.has(suo)) continue;
    // ⚠️ E chi ha scritto STOP, che quasi mai è in rubrica: senza questa riga
    // gli si scriveva lo stesso, dopo avergli promesso il contrario.
    if (bot.haDettoBasta(db, r.chat_id || r.telefono, r.telefono_contatto || r.telefono)) continue;
    // Due prenotazioni della stessa persona nella stessa serata (capita: due
    // tavoli, due gruppi) non devono diventare due messaggi.
    if ((suo && giaChiesta.has(suo)) || (chat && giaChiesta.has(chat))) continue;
    if (suo) giaChiesta.add(suo);
    if (chat) giaChiesta.add(chat);
    scelte.push(r);
  }
  return scelte;
}

async function mandaRecensioni(adesso = new Date()) {
  const perche = motivoPerCuiNonSiManda();
  if (perche) { lavoriFermi(perche); return 0; }
  lavoriRipartiti();
  const cfg = bot.config(db);
  const scelte = recensioniDaMandare(cfg, adesso);
  if (!scelte.length) return 0;

  const segna = db.prepare("UPDATE prenotazioni SET recensione_at = datetime('now','localtime') WHERE id = ?");
  let mandate = 0;
  for (const r of scelte) {
    const testo = bot.riempi(cfg.bot_t_recensione, {
      nome: r.nome || '', cognome: r.cognome || '',
      locale: cfg.bot_locale || 'noi',
      link: String(cfg.bot_recensione_link || '').trim(),
    });
    try {
      // Passa dalla stessa coda col ritmo degli altri invii: venti messaggi
      // identici sparati di fila sono l'impronta classica dello spam, e il
      // numero del ristorante rischia il blocco.
      await inviaConRitmo(r.chat_id || r.telefono, testo);
      // Si segna solo DOPO l'invio riuscito: segnarla prima vorrebbe dire
      // perdere per sempre la richiesta di chi non l'ha mai ricevuta.
      segna.run(r.id);
      mandate++;
    } catch (e) { console.error('Bot:', e.message); }
  }
  if (mandate) annota('recensione', `chieste ${mandate} recensioni a chi è venuto`);
  return mandate;
}

if (botDisponibile()) {
  setInterval(() => { mandaRecensioni().catch(giroFallito('recensioni')); }, 60 * 1000);
}

// ---------- API della pagina ----------
app.get('/api/bot/stato', (req, res) => {
  if (!botDisponibile()) return res.json({ disponibile: false });
  if (!botPermesso()) {
    return res.json({
      disponibile: true, permesso: false,
      assistenza: numeroAssistenza(), assistenzaEmail: emailAssistenza(),
      codice: codiceInstallazione(),
    });
  }
  const oggi = bot.comeData(new Date());
  const righe = db.prepare("SELECT * FROM prenotazioni WHERE data = ? AND stato != 'annullata' ORDER BY ora, id").all(oggi);
  res.json({
    disponibile: true,
    attivo: botAcceso(),
    collegato: state.status === 'connesso',
    oggi,
    coperti: righe.reduce((s, r) => s + r.persone, 0),
    prenotazioni: righe.length,
    inAttesa: db.prepare("SELECT COUNT(*) n FROM bot_richieste WHERE stato = 'in_attesa'").get().n,
    nonCapite: db.prepare('SELECT COUNT(*) n FROM bot_non_capite WHERE risolta = 0').get().n,
    // Serve alla pagina per dire, accanto all'interruttore dell'email, se la
    // posta è davvero pronta: l'interruttore da solo non lo sa.
    posta: Boolean(getSetting('smtp_user') && getSetting('smtp_pass')),
  });
});

// Perché il bot non risponde. Ogni riga è una condizione che DEVE essere
// verde: elencarle tutte è molto meglio che lasciare indovinare quale delle
// dieci cause possibili sia quella vera.
app.get('/api/bot/registro', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const cfg = bot.config(db);
  const turni = String(cfg.bot_turni_cena).split(',').filter(Boolean).length
    + String(cfg.bot_turni_pranzo).split(',').filter(Boolean).length;
  const controlli = [
    { voce: 'Motore del bot caricato', ok: true },
    { voce: 'Bot acceso', ok: botAcceso(), aiuto: 'Accendi l\'interruttore qui sopra.' },
    { voce: 'WhatsApp collegato', ok: state.status === 'connesso', aiuto: 'Vai in Dashboard e scansiona il QR code.' },
    { voce: 'Nome del locale impostato', ok: !!cfg.bot_locale, aiuto: 'Serve per i messaggi: lo scrivi nelle impostazioni qui sotto.' },
    { voce: 'Almeno un turno impostato', ok: turni > 0, aiuto: 'Senza turni il bot non ha niente da proporre.' },
    { voce: 'Coperti per turno impostati', ok: bot.num(cfg.bot_coperti_turno, 0) > 0, aiuto: 'Con zero coperti risulta sempre pieno.' },
    { voce: 'Almeno un giorno di apertura', ok: String(cfg.bot_giorni).split(',').filter(Boolean).length > 0, aiuto: 'Spunta i giorni in cui siete aperti.' },
    { voce: 'Qualcuno riceve gli avvisi', ok: personale().length > 0, aiuto: 'Senza, quando il bot non capisce nessuno viene avvisato.' },
  ];
  // Le voci del pagamento compaiono SOLO se il pagamento è acceso: un elenco di
  // controlli pieno di righe che non riguardano questo locale si smette di
  // leggere, ed è proprio quando smetti di leggerlo che ti serve.
  if (bot.boolDi(cfg.bot_pagamento_attivo)) {
    const k = bot.chiaveStripe(cfg);
    controlli.push(
      { voce: 'Chiave di Stripe presente', ok: k.presente && k.forma,
        aiuto: 'Senza, il cliente resta in attesa di pagamento senza modo di pagare.' },
      // ⚠️ Questa è verde quando NON è di prova: un locale lasciato in modo
      // prova incasserebbe pagamenti che non esistono, e se ne accorgerebbe
      // dall'estratto conto.
      { voce: 'Chiave vera, non di prova', ok: k.presente && !k.prova,
        aiuto: 'Con la chiave di prova i pagamenti NON sono veri: il ristorante non incassa niente.' },
      { voce: 'Indirizzo di ritorno impostato', ok: /^https?:\/\/.+/i.test(String(cfg.bot_pagamento_ritorno || '')),
        aiuto: 'Stripe lo richiede: è la pagina dove torna il cliente dopo aver pagato.' },
    );
  }
  // ⚠️ L'email accesa senza la posta configurata è il guasto più silenzioso di
  // tutti: l'interruttore è verde, la prenotazione si scrive, il cliente non
  // riceve niente e nessuno se ne accorge. Qui si vede.
  if (bot.boolDi(cfg.bot_email_attiva)) {
    controlli.push(
      { voce: 'Posta configurata (per l\'email di riepilogo)',
        ok: Boolean(getSetting('smtp_user') && getSetting('smtp_pass')),
        aiuto: 'L\'email di riepilogo è accesa ma la posta non è impostata: vai in Impostazioni → Email.' },
      { voce: 'Testo dell\'email scritto', ok: String(cfg.bot_email_testo || '').trim().length > 0,
        aiuto: 'Senza testo partirebbe un\'email vuota.' },
    );
  }
  res.json({
    controlli,
    tuttoOk: controlli.every((c) => c.ok),
    // Misurato, non stimato: vedi `comeVaStripe`.
    stripe: comeVaStripe(),
    registro: registroBot,
    mio: state.me ? normalizePhone(state.me) : null,
    // I numeri del personale non possono prenotare: e' voluto, ma e' anche
    // la trappola in cui si cade provando — ci si mette come responsabile per
    // ricevere gli avvisi e poi si prova a prenotare dallo stesso telefono.
    personale: personale().map((p) => ({ nome: p.nome, telefono: p.telefono })),
    // Le conversazioni su cui il bot tace perché una persona ha risposto a
    // mano — o dopo LIBERA senza codice, o per la parola OPERATORE. È giusto
    // che sia così, ma va potuto vedere e disfare una per una: prima l'unico
    // modo era «Azzera le prove», che però azzera TUTTO, comprese le
    // conversazioni a metà di chi sta prenotando davvero in quel momento.
    zittite: db.prepare(
      "SELECT COUNT(*) n FROM bot_conversazioni WHERE muto_fino IS NOT NULL AND muto_fino > ?"
    ).get(new Date().toLocaleString('sv-SE')).n,
    silenziate: db.prepare(
      "SELECT telefono AS chiave, muto_fino AS finoA FROM bot_conversazioni "
      + "WHERE muto_fino IS NOT NULL AND muto_fino > ? ORDER BY muto_fino"
    ).all(new Date().toLocaleString('sv-SE')).map((r) => ({ ...r, ...identitaPerChiave(r.chiave) })),
  });
});

// ---------------------------------------------------------------------------
//  Sbloccare una conversazione ferma
// ---------------------------------------------------------------------------
//  Il tasto «Riattiva il bot» qui sotto toglie UNA cosa sola: il silenzio da
//  presa in carico. Ma una conversazione può restare ferma per almeno quattro
//  motivi diversi, e gli altri tre non si vedevano da nessuna parte e non si
//  potevano togliere in nessun modo — l'unica via era «Azzera le prove», che
//  azzera anche le conversazioni di chi sta prenotando in quel momento.
//
//  Chi prova il bot ci finisce dentro di continuo, e da fuori sono tutti
//  uguali: si scrive al bot e non risponde nessuno. Senza sapere PERCHÉ, si
//  resta a fissare una chat muta.
function diagnosiConversazione(chi) {
  const chiavi = chiaviStessaConversazione(chi);
  const adesso = new Date().toLocaleString('sv-SE');
  const cfg = bot.config(db);
  const blocchi = [];

  const righe = chiavi.length
    ? db.prepare(`SELECT * FROM bot_conversazioni WHERE telefono IN (${chiavi.map(() => '?').join(',')})`).all(...chiavi)
    : [];

  const muta = righe.find((r) => r.muto_fino && r.muto_fino > adesso);
  if (muta) {
    blocchi.push({
      tipo: 'silenzio',
      testo: 'Qualcuno ha risposto a mano, o il cliente ha chiesto un operatore: il bot tace.',
      fino: muta.muto_fino,
    });
  }

  const tetto = bot.num(cfg.bot_max_risposte, 20);
  const oggi = new Date().toLocaleDateString('sv-SE');
  const piena = righe.find((r) => r.giorno_risposte === oggi && r.risposte_oggi > tetto);
  if (piena) {
    blocchi.push({
      tipo: 'tetto',
      testo: `Ha già ricevuto ${piena.risposte_oggi} risposte oggi, oltre il tetto di ${tetto}: `
        + 'il bot si è fermato per non fare ping-pong all\'infinito. Si riapre da solo domani.',
    });
  }

  // Il numero, per il registro degli STOP: quello si guarda anche per cifre,
  // perché chi scrive STOP quasi mai è in rubrica con lo stesso indirizzo.
  const cifre = String(chi).replace(/@.*$/, '').replace(/\D/g, '');
  const numero = numeroPlausibile(cifre, chi) ? cifre : '';
  if (chiavi.some((k) => bot.haDettoBasta(db, k, numero))) {
    blocchi.push({
      tipo: 'stop',
      testo: 'Ha scritto STOP: ha chiesto di non ricevere più messaggi. '
        + 'Si toglie solo se è stato lui a chiedere di riattivarli.',
    });
  }

  const attesa = chiavi.length
    ? db.prepare(
      "SELECT * FROM bot_richieste WHERE stato = 'in_attesa' AND "
      + `(chat_id IN (${chiavi.map(() => '?').join(',')}) OR telefono IN (${chiavi.map(() => '?').join(',')})) `
      + 'ORDER BY id DESC LIMIT 1'
    ).get(...chiavi, ...chiavi)
    : null;
  if (attesa) {
    blocchi.push({
      tipo: 'richiesta',
      testo: `È in mano a una persona col codice ${attesa.codice}: finché resta aperta, `
        + 'chi risponde è il locale, non il bot.',
    });
  }

  const aMeta = righe.find((r) => r.passo && r.passo !== 'inizio');
  return {
    trovata: righe.length > 0 || !!attesa,
    chiavi,
    identita: identitaPerChiave(chiavi[0] || chi),
    blocchi,
    aMeta: aMeta ? aMeta.passo : '',
  };
}

// Quello che si vede prima di premere: nessuno deve sbloccare alla cieca.
app.get('/api/bot/conversazione', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const chi = String((req.query && req.query.chi) || '').trim();
  if (!chi) return res.status(400).json({ error: 'Manca il numero o l\'indirizzo da cercare' });
  res.json(diagnosiConversazione(chi));
});

// E il comando che li toglie tutti insieme, su TUTTI gli indirizzi di quella
// persona. Lo STOP resta fuori se non lo si chiede apposta: quello non è un
// inceppamento, è una persona che ha chiesto di essere lasciata in pace, e
// rimetterla in lista con un tasto sarebbe la cosa peggiore che questa pagina
// possa fare.
app.post('/api/bot/conversazione/sblocca', async (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const chi = String((req.body && req.body.chi) || '').trim();
  if (!chi) return res.status(400).json({ error: 'Manca il numero o l\'indirizzo da sbloccare' });
  const ancheStop = !!(req.body && req.body.ancheStop);
  const prima = diagnosiConversazione(chi);
  const chiavi = prima.chiavi;
  const fatto = [];

  if (ridaiLaParola(chi)) {
    fatto.push('tolto il silenzio');
    // Stessa cosa di «Riattiva il bot»: la persona ha finito, e al cliente si dice.
    if (await salutaIlRitorno(chi)) fatto.push('detto al cliente che la persona ha finito');
  }

  let azzerate = 0;
  for (const k of chiavi) {
    azzerate += db.prepare('UPDATE bot_conversazioni SET risposte_oggi = 0 WHERE telefono = ? AND risposte_oggi > 0')
      .run(k).changes;
  }
  if (azzerate) fatto.push('azzerato il conto delle risposte di oggi');

  let chiuse = 0;
  for (const k of chiavi) {
    chiuse += db.prepare("UPDATE bot_richieste SET stato = 'chiusa' WHERE stato = 'in_attesa' AND (chat_id = ? OR telefono = ?)")
      .run(k, k).changes;
  }
  if (chiuse) fatto.push(`chiusa ${chiuse === 1 ? 'la richiesta aperta' : chiuse + ' richieste aperte'}`);

  let ripartite = 0;
  for (const k of chiavi) {
    ripartite += db.prepare("UPDATE bot_conversazioni SET passo = 'inizio', dati = '{}' WHERE telefono = ? AND passo != 'inizio'")
      .run(k).changes;
  }
  if (ripartite) fatto.push('la conversazione riparte da capo');

  let stop = 0;
  if (ancheStop) {
    const cifre = String(chi).replace(/@.*$/, '').replace(/\D/g, '');
    const numero = numeroPlausibile(cifre, chi) ? cifre : '';
    for (const k of chiavi) {
      stop += db.prepare('DELETE FROM bot_stop WHERE chiave = ?').run(k).changes;
    }
    if (numero) stop += db.prepare('DELETE FROM bot_stop WHERE numero = ?').run(numero).changes;
    if (stop) fatto.push('tolto lo STOP');
  }

  const nome = prima.identita.nome || chi;
  if (fatto.length) annota('sbloccata', `${nome}: ${fatto.join(', ')}`);
  res.json({ ok: true, fatto, dopo: diagnosiConversazione(chi) });
});

// Ridà la parola al bot su UNA conversazione, invece che su tutte come fa
// «Azzera le prove». È la differenza fra «questo cliente ha già ripreso a
// scrivere a un umano e va bene così» e «tutti gli altri, che nel frattempo
// stavano prenotando tranquilli, restano dove erano».
app.post('/api/bot/silenziate/riattiva', async (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const chiave = String((req.body && req.body.chiave) || '');
  if (!chiave) return res.status(400).json({ error: 'Manca la conversazione da riattivare' });
  const cambiate = ridaiLaParola(chiave);
  // Al cliente si dice che la persona ha finito — solo se un silenzio c'era:
  // riattivare un bot che rispondeva già non è un'uscita di nessuno.
  const salutato = cambiate ? await salutaIlRitorno(chiave) : false;
  if (cambiate) {
    annota('riattivata', `il bot torna a rispondere su ${identitaPerChiave(chiave).nome || chiave}`
      + (salutato ? ' (al cliente si è detto che la persona ha finito)' : ''));
  }
  res.json({ ok: true, cambiate, salutato });
});

// Rimette il bot come appena installato. Durante le prove ci si incastra di
// continuo — una conversazione a metà, un silenzio da presa in carico, un
// messaggio già visto — e senza un modo di ripartire puliti si perde più tempo
// a capire in che stato si è che a provare la cosa vera.
//
// Le prenotazioni si cancellano SOLO se richiesto esplicitamente: sono l'unica
// cosa qui dentro che, un domani, sarà lavoro vero di qualcuno.
app.post('/api/bot/azzera-prove', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const anche = !!(req.body && req.body.anchePrenotazioni);
  const fatto = {
    conversazioni: db.prepare("UPDATE bot_conversazioni SET passo = 'inizio', dati = '{}', muto_fino = NULL, risposte_oggi = 0, giorno_risposte = NULL").run().changes,
    silenzi: 0,
    visti: db.prepare('DELETE FROM bot_visti').run().changes,
    richieste: db.prepare("DELETE FROM bot_richieste WHERE stato = 'in_attesa'").run().changes,
    prenotazioni: 0,
  };
  if (anche) fatto.prenotazioni = db.prepare('DELETE FROM prenotazioni').run().changes;
  registroBot.length = 0;
  annota('azzerato', `stato ripulito${anche ? `, cancellate ${fatto.prenotazioni} prenotazioni` : ' (prenotazioni lasciate)'}`);
  res.json({ ok: true, ...fatto });
});

// ---- Il report di un periodo ----
// Il conto su cui poi qualcuno decide quanti camerieri chiamare sabato. Il
// calcolo sta nel motore, dove si può provare senza far finta di essere un
// browser: qui c'è solo il periodo da leggere.
function periodoChiesto(req) {
  const oggi = bot.comeData(new Date());
  const dal = dataVera(String(req.query.dal || '')) ? req.query.dal : '';
  const al = dataVera(String(req.query.al || '')) ? req.query.al : '';
  if (!dal || !al) return { errore: 'Serve un periodo: due date come 2026-09-01.' };
  // ⚠️ Al contrario non è un errore da rifiutare, è un dito scivolato: si
  // raddrizza. Rispondere «date sbagliate» a chi ha scelto due giorni giusti
  // nell'ordine sbagliato è il modo di far credere che il report sia rotto.
  const [a, b] = dal <= al ? [dal, al] : [al, dal];
  // Un periodo lunghissimo non si rifiuta — un archivio di dieci anni è una
  // domanda legittima — ma si limita: oltre, la pagina si siede.
  if (bot.giorniFra(a, b) > 3700) return { errore: 'Il periodo è troppo lungo: al massimo dieci anni.' };
  return { dal: a, al: b, oggi };
}

app.get('/api/bot/report', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const p = periodoChiesto(req);
  if (p.errore) return res.status(400).json({ error: p.errore });
  res.json(bot.reportPrenotazioni(db, bot.config(db), p.dal, p.al));
});

// ⚠️ Una cella che comincia per «=», «+», «-» o «@» viene eseguita come
// formula da Excel e da Fogli Google appena si apre il file. Una nota scritta
// da un cliente finisce dritta in un foglio che poi apre il commercialista:
// davanti ci va un apice, che rende la cella un testo e basta.
function cellaCsv(valore) {
  let t = String(valore == null ? '' : valore);
  if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return '"' + t.replace(/"/g, '""') + '"';
}

app.get('/api/bot/report/csv', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const p = periodoChiesto(req);
  if (p.errore) return res.status(400).json({ error: p.errore });
  const righe = db.prepare(
    'SELECT * FROM prenotazioni WHERE data >= ? AND data <= ? ORDER BY data, ora, id'
  ).all(p.dal, p.al);
  const colonne = ['Data', 'Ora', 'Persone', 'Nome', 'Cognome', 'Telefono', 'Email', 'Note', 'Stato', 'Origine'];
  const corpo = righe.map((r) => [
    r.data, r.ora, r.persone, r.nome, r.cognome,
    // L'indirizzo interno di WhatsApp non è un numero e non deve finire in un
    // foglio come se lo fosse: chi lo legge proverebbe a chiamarlo.
    String(r.telefono_contatto || r.telefono || '').includes('@') ? '' : (r.telefono_contatto || r.telefono),
    r.email, r.note, r.stato, r.origine === 'manuale' ? 'presa a mano' : 'bot',
  ].map(cellaCsv).join(';'));
  // Il punto e virgola e il BOM: è quello che Excel in italiano si aspetta.
  // Con la virgola finisce tutto in una colonna sola, e senza BOM gli accenti
  // diventano scarabocchi — e allora il file «non funziona».
  const csv = '\ufeff' + [colonne.map(cellaCsv).join(';'), ...corpo].join('\r\n') + '\r\n';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="prenotazioni-${p.dal}_${p.al}.csv"`);
  res.send(csv);
});

// ---- La scheda di un cliente ----
// La domanda vera non è «fammi vedere le prenotazioni passate», è «chi è
// questo che ha appena prenotato?». Da qui si risponde a quella.
//
// ⚠️ La SCHEDA si apre anche dalla sala, la RICERCA no, ed è una distinzione
// voluta. La scheda si apre da una prenotazione che si ha già davanti: dice
// chi è la persona che arriva stasera, che è esattamente la domanda di chi
// apparecchia. La ricerca invece è un modo di sfogliare l'archivio dei clienti
// a partire da niente, e quello resta sulla piattaforma — come la rubrica.
const rottaSchedaCliente = (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const id = Number(req.query.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Manca la prenotazione da cui aprire la scheda.' });
  }
  const scheda = bot.schedaPersona(db, id, new Date());
  if (!scheda) return res.status(404).json({ error: 'Prenotazione inesistente' });
  res.json(scheda);
};
app.get('/api/bot/cliente', rottaSchedaCliente);

// TUTTI i clienti che hanno prenotato, con scritto se sono già in rubrica.
// È l'elenco da cui il locale li mette in rubrica uno per uno, per gli invii
// WhatsApp e la newsletter. Chi ha chiesto di non ricevere più messaggi arriva
// segnato (`optOut`), così la pagina non offre di rimetterlo in lista.
app.get('/api/bot/clienti', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const voci = bot.elencoPersone(db, new Date());
  const rubrica = db.prepare('SELECT id, nome, cognome, telefono, email, opt_out FROM contacts').all()
    .map((c) => ({ ...c, chiave: normalizePhone(c.telefono), mail: String(c.email || '').trim().toLowerCase() }));
  for (const v of voci) {
    // Stesso aggancio del pannello della prenotazione (numero), più l'email:
    // un contatto messo in rubrica a mano con la sola email è lo stesso
    // cliente, e il tasto non deve ricomparire su chi c'è già.
    const numero = normalizePhone(v.telefono || '');
    const mail = String(v.email || '').trim().toLowerCase();
    const c = rubrica.find((x) => (numero && x.chiave === numero) || (mail && x.mail === mail));
    v.inRubrica = c ? { id: c.id, nome: `${c.nome} ${c.cognome}`.trim(), optOut: !!c.opt_out } : null;
  }
  res.json({ clienti: voci });
});

app.get('/api/bot/clienti/cerca', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  // Il tetto e il minimo di due lettere stanno nel motore, dove valgono per
  // chiunque lo chiami: qui non si riscrivono, o prima o poi ne resta indietro
  // uno dei due.
  res.json({ trovati: bot.cercaPersone(db, String(req.query.q || ''), 8) });
});

// ---- I giorni pieni (sold out) ----
// Un giorno segnato pieno non è una chiusura: il locale c'è, i posti no. Al
// cliente il bot risponde «non c'è più posto», non «siamo chiusi».
app.get('/api/bot/pieni', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  res.json({ giorni: bot.giorniPieni(db, new Date()) });
});

app.post('/api/bot/pieni', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const data = String((req.body || {}).data || '');
  if (!dataVera(data)) {
    return res.status(400).json({ error: 'Giorno non valido: serve una data come 2026-09-05.' });
  }
  // ⚠️ Il passato si rifiuta invece di accettarlo in silenzio: segnare pieno
  // ieri non serve a niente, e quasi sempre vuol dire che qualcuno ha sbagliato
  // a scrivere l'anno. Un errore detto vale più di una riga inutile.
  if (data < bot.comeData(new Date())) {
    return res.status(400).json({ error: 'È un giorno già passato: non c\'è niente da chiudere.' });
  }
  // Una chiusura vera (ferie, evento privato) non si trasforma in un sold out
  // per sbaglio: sono due cose diverse e il cliente le legge diverse.
  const gia = bot.giornoBloccato(db, data);
  if (gia && gia.tipo !== 'pieno') {
    return res.status(409).json({ error: 'Quel giorno è già segnato come chiusura del locale.' });
  }
  bot.segnaPieno(db, data);
  annota('sold out', `${bot.dataItaliana(data)} segnato pieno dalla pagina`);
  res.json({ giorni: bot.giorniPieni(db, new Date()) });
});

// Togliere qualcuno dalla lista d'attesa, a mano. Chi ha ricevuto una
// proposta e sta per rispondere viene riportato all'inizio della conversazione:
// il suo «sì» non deve prenotare un posto che la sala ha appena dato a un altro.
const rottaTogliAttesa = async (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const r = bot.togliDallaAttesa(db, +req.params.id, 'tolta');
  if (!r) return res.status(404).json({ error: 'Non è in lista d\'attesa' });
  annota('lista d\'attesa', `${bot.nomeInSala(r)} tolto dalla lista per ${r.data}`);
  // ⚠️ E glielo si DICE. Tolto in silenzio, quel cliente aspetta tutta la sera
  // un messaggio che non arriverà, e nessuno se ne accorge — né lui né la sala.
  // Il messaggio parte da solo: alle 20:30, col telefono in mano, alla sala non
  // si fa rispondere a una domanda del programma.
  // ⚠️ E NON dichiara un motivo. La sala toglie qualcuno dalla lista per
  // ragioni diverse (gli ha dato un tavolo al telefono, quello ha detto che non
  // viene più, sta facendo pulizia, sa che stasera non si libera niente): una
  // frase che ne dichiara una sarebbe sbagliata in tutti gli altri casi.
  const cfg = bot.config(db);
  if (r.telefono && botAcceso() && state.status === 'connesso') {
    try {
      await rispondiConRitmo(r.telefono, bot.riempi(cfg.bot_t_attesa_rimossa, {
        locale: cfg.bot_locale || 'noi', assistente: cfg.bot_assistente || '',
        nome: r.nome || '', cognome: r.cognome || '',
        quando: r.ora ? `delle ${r.ora} ${bot.dataItaliana(r.data)}` : `per ${bot.dataItaliana(r.data)}`,
        data: bot.dataItaliana(r.data), ora: r.ora || '', persone: r.persone,
      }));
    } catch (e) {
      // ⚠️ Se il messaggio non parte, la rimozione resta comunque fatta: la
      // sala ha premuto, e un ✅ che non ha tolto niente sarebbe la bugia
      // peggiore. Si annota, e chi legge il registro lo sa.
      annota('errore', `lista d'attesa: tolto ${bot.nomeInSala(r)} ma non riesco ad avvisarlo: ${e.message}`);
    }
  }
  res.json({ ok: true });
};
app.delete('/api/bot/attese/:id', rottaTogliAttesa);

app.delete('/api/bot/pieni/:data', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const tolto = bot.togliPieno(db, String(req.params.data || ''));
  // Un ✅ che non ha tolto niente farebbe credere che il bot ricominci a
  // prendere prenotazioni per quel giorno. Non è così, e va detto.
  if (!tolto) return res.status(404).json({ error: 'Quel giorno non era segnato pieno.' });
  annota('sold out', `${bot.dataItaliana(req.params.data)} torna prenotabile`);
  res.json({ giorni: bot.giorniPieni(db, new Date()) });
});

app.get('/api/bot/impostazioni', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  res.json({ impostazioni: bot.config(db), personale: db.prepare('SELECT * FROM bot_personale').all() });
});

// Gli indirizzi a cui questo computer risponde davvero. Serve perché la riga
// «apri questo indirizzo dal tablet» scritta dal browser direbbe «localhost»:
// giusta sul Mac, inutile sul telefono della sala. Il computer invece i suoi
// indirizzi li sa, e sono l'unica cosa che il responsabile deve digitare.
app.get('/api/bot/sala/indirizzi', (req, res) => {
  const rete = [];
  for (const schede of Object.values(os.networkInterfaces() || {})) {
    for (const s of schede || []) {
      // Solo IPv4 e solo schede vere: l'indirizzo interno (127.0.0.1) è quello
      // che vale solo su questo computer, cioè esattamente quello che NON serve.
      if (s.family === 'IPv4' && !s.internal) rete.push(s.address);
    }
  }
  // Il nome Bonjour del Mac: da preferire al numero, perché il numero cambia
  // da solo quando il router riassegna gli indirizzi, il nome no.
  let nome = String(os.hostname() || '').trim();
  if (nome && !nome.includes('.')) nome += '.local';
  res.json({ porta: PORT_SALA, nome, rete });
});

app.post('/api/bot/impostazioni', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const valori = req.body || {};

  // ⚠️ Due impostazioni che si contraddicono spengono il bot senza spegnerlo.
  // «Posti da tenere liberi» uguale o maggiore dei coperti del turno vuol dire
  // che ogni turno nasce già pieno: il bot rifiuta TUTTI, per sempre, a locale
  // vuoto, e dice «siamo al completo» a gente che sarebbe entrata. Nessuno
  // collegherebbe mai quel messaggio a un numero scritto in un'altra scheda.
  const dopo = { ...bot.config(db), ...valori };
  const perTurno = bot.num(dopo.bot_coperti_turno, 0);
  const tenutiLiberi = bot.num(dopo.bot_coperti_liberi, 0);

  // ⚠️ Coperti per turno a zero (o campo svuotato per riscriverlo, e salvato
  // così) non vuol dire «senza limite»: vuol dire che ogni turno nasce pieno.
  // Il bot risponde «siamo al completo» a chiunque, e in sala la tendina delle
  // persone resta senza numeri — il modulo c'è ma non ci si può prenotare
  // niente. Nessuno collegherebbe quel modulo muto a un campo svuotato in
  // un'altra scheda: va detto qui, adesso.
  if (valori.bot_coperti_turno !== undefined && perTurno < 1) {
    return res.status(400).json({
      error: 'I coperti per turno devono essere almeno 1: a zero il bot direbbe a tutti '
        + 'che è al completo, e in sala non si potrebbe più segnare nessuna prenotazione.',
    });
  }

  if (perTurno > 0 && tenutiLiberi >= perTurno) {
    return res.status(400).json({
      error: `I posti da tenere liberi (${tenutiLiberi}) devono essere meno dei coperti del turno `
        + `(${perTurno}): così com'è, il bot direbbe «siamo al completo» anche a locale vuoto.`,
    });
  }

  // ⚠️ La password della sala si salva SENZA spazi ai bordi. Un campo password
  // non mostra quello che c'è dentro: una password incollata con uno spazio in
  // fondo si salva con lo spazio, e chi la ridigita a mano — senza — si sente
  // dire «password errata» senza poter vedere perché.
  if (typeof valori.bot_sala_password === 'string') {
    valori.bot_sala_password = valori.bot_sala_password.trim();
  }

  // ⚠️ Sala accesa senza password non accende niente: `salaAccesa()` chiede
  // tutte e due le cose, e la pagina risponde «non è attiva». Chi ha appena
  // spuntato la casella non ha modo di collegare quel messaggio al campo
  // vuoto qui accanto.
  if (bot.boolDi(dopo.bot_sala_attiva) && !String(dopo.bot_sala_password || '').trim()) {
    return res.status(400).json({
      error: 'Per accendere la pagina della sala serve anche una password: senza, '
        + 'quella pagina resta spenta e chi la apre legge «non è attiva».',
    });
  }

  // ⚠️ Pagamento acceso senza chiave di Stripe: il cliente finirebbe in «attesa
  // di pagamento» SENZA NESSUN MODO DI PAGARE, con il tavolo tenuto fermo fino
  // alla scadenza. Un tavolo perso ogni volta, e nessun errore da nessuna parte.
  if (bot.boolDi(dopo.bot_pagamento_attivo)) {
    const chiave = bot.chiaveStripe(dopo);
    if (!chiave.presente) {
      return res.status(400).json({
        error: 'Per accendere il pagamento serve la chiave di Stripe: senza, il cliente '
          + 'resterebbe in attesa di pagamento senza avere un modo per pagare, e il tavolo '
          + 'verrebbe tenuto fermo fino alla scadenza.',
      });
    }
    if (!chiave.forma) {
      return res.status(400).json({
        error: 'Questa non sembra una chiave di Stripe: cominciano con «rk_live_», «rk_test_» '
          + 'o «sk_». Controlla di averla copiata tutta.',
      });
    }
    // ⚠️ Stripe vuole un indirizzo dove mandare il cliente dopo il pagamento.
    // A noi non serve — la conferma gli arriva in chat — ma è l'ultima pagina
    // che vede di questa prenotazione, e mandarlo su un indirizzo che non esiste
    // è il modo di far finire bene una cosa andata bene.
    if (!/^https?:\/\/.+/i.test(String(dopo.bot_pagamento_ritorno || '').trim())) {
      return res.status(400).json({
        error: 'Serve l\'indirizzo dove torna il cliente dopo aver pagato (il sito del '
          + 'ristorante, o la sua pagina Google). Stripe lo richiede, e dev\'essere un '
          + 'indirizzo intero che comincia con http:// o https://.',
      });
    }
    // ⚠️ E il conto deve dare qualcosa che Stripe accetti davvero. Sotto i 50
    // centesimi rifiuta l'addebito: il link non si creerebbe, e il guasto si
    // scoprirebbe col primo cliente invece che adesso.
    const conti = bot.importoDaPagare(dopo, 1);
    if (conti.adesso < bot.MINIMO_ADDEBITO) {
      return res.status(400).json({
        error: `Con questo prezzo e questa percentuale, a una persona toccherebbe pagare `
          + `${bot.euro(conti.adesso)}: Stripe non accetta addebiti sotto ${bot.euro(bot.MINIMO_ADDEBITO)}. `
          + 'Alza il prezzo o la percentuale.',
      });
    }
  }

  // ⚠️ Il logo viaggia dentro le impostazioni e dentro OGNI email: una foto
  // da 3 MB renderebbe lenta la pagina e pesante ogni riepilogo. La pagina lo
  // rimpicciolisce da sola, ma qui si controlla lo stesso — chi passa da qui
  // non è per forza la pagina.
  if (typeof valori.bot_email_logo === 'string' && valori.bot_email_logo) {
    if (!/^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(valori.bot_email_logo)) {
      return res.status(400).json({ error: 'Il logo non è un\'immagine leggibile (PNG, JPG, GIF o WebP).' });
    }
    if (valori.bot_email_logo.length > 400 * 1024) {
      return res.status(400).json({ error: 'Il logo è troppo pesante: usa un\'immagine più piccola (sotto i 300 KB).' });
    }
  }
  if (typeof valori.bot_email_html === 'string' && valori.bot_email_html.length > 60 * 1024) {
    return res.status(400).json({ error: 'Il modello HTML è troppo lungo (massimo 60 KB).' });
  }

  // Gli orari dei turni si ripuliscono qui: chi li scrive vede subito quello
  // che è rimasto, invece di scoprire un «25:99» fra le proposte al cliente.
  const ripuliti = {};
  for (const chiave of ['bot_turni_pranzo', 'bot_turni_cena']) {
    if (typeof valori[chiave] !== 'string') continue;
    const buoni = bot.turniValidi(valori[chiave]);
    if (buoni.join(',') !== valori[chiave]) ripuliti[chiave] = buoni.join(',');
    valori[chiave] = buoni.join(',');
  }

  for (const [k, v] of Object.entries(valori)) {
    if (!Object.prototype.hasOwnProperty.call(bot.PREDEFINITI, k)) continue; // solo chiavi conosciute
    bot.scrivi(db, k, v);
  }
  res.json({ ok: true, impostazioni: bot.config(db), ripuliti });
});

// Riporta un testo (o tutti) a come era di fabbrica. Si cancella la riga
// salvata: da quel momento torna a valere il valore predefinito, senza doverlo
// ricopiare a mano — e senza il rischio di ricopiarlo sbagliato.
app.post('/api/bot/testi/ripristina', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const chiave = req.body && req.body.chiave;
  if (chiave) {
    if (!String(chiave).startsWith('bot_t_')) return res.status(400).json({ error: 'Non è un testo del bot' });
    db.prepare('DELETE FROM settings WHERE key = ?').run(chiave);
  } else {
    db.prepare("DELETE FROM settings WHERE key LIKE 'bot\\_t\\_%' ESCAPE '\\'").run();
  }
  res.json({ ok: true, impostazioni: bot.config(db) });
});

// ---------- Portare le frasi da una copia all'altra ----------
// Le frasi vivono nel database, che NON va su GitHub: dentro ci sono la rubrica
// dei clienti, le prenotazioni e le credenziali. Ma le frasi in se' non sono
// dati di nessuno, e riscriverle a mano su ogni installazione e' lavoro sprecato
// — soprattutto quando si prepara il mini-PC di un cliente nuovo.
//
// Quindi: un file solo con le frasi. Si porta su una chiavetta, si tiene da
// parte come «set di partenza», e si ricarica dove serve.
app.get('/api/bot/testi/esporta', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const cfg = bot.config(db);
  const frasi = {};
  for (const chiave of Object.keys(bot.PREDEFINITI)) {
    if (chiave.startsWith('bot_t_')) frasi[chiave] = cfg[chiave];
  }
  const dato = {
    istudio: 'frasi-bot',
    versione: 1,
    esportato_il: new Date().toLocaleString('sv-SE'),
    // Il nome del locale non viene reimportato: serve solo a capire, fra sei
    // mesi e tre file sulla scrivania, da quale installazione arriva questo.
    locale: cfg.bot_locale || '',
    frasi,
    faq: db.prepare('SELECT parole, risposta FROM bot_faq ORDER BY id').all(),
  };
  const nome = 'frasi-bot' + (cfg.bot_locale ? '-' + cfg.bot_locale.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase() : '') + '.json';
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${nome}"`);
  res.send(JSON.stringify(dato, null, 2));
});

app.post('/api/bot/testi/importa', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const dato = req.body || {};
  if (dato.istudio !== 'frasi-bot') {
    return res.status(400).json({ error: 'Questo non è un file di frasi di iStudio.' });
  }
  // ⚠️ Si scrivono SOLO le chiavi «bot_t_*» che esistono davvero. Il file e' un
  // testo che chiunque puo' aprire e modificare: senza questo controllo, una
  // riga in piu' potrebbe cambiare i coperti, gli orari o il seriale.
  let frasi = 0, ignorate = 0;
  for (const [k, v] of Object.entries(dato.frasi || {})) {
    const ammessa = k.startsWith('bot_t_')
      && Object.prototype.hasOwnProperty.call(bot.PREDEFINITI, k)
      && typeof v === 'string';
    if (!ammessa) { ignorate++; continue; }
    bot.scrivi(db, k, v.slice(0, 2000));
    frasi++;
  }

  // Le domande frequenti si sostituiscono in blocco: e' un ripristino, non una
  // fusione. Aggiungerle lascerebbe doppioni che poi qualcuno deve togliere a
  // mano una per una.
  let faq = 0;
  if (Array.isArray(dato.faq)) {
    const buone = dato.faq.filter((f) => f && typeof f.parole === 'string' && typeof f.risposta === 'string'
      && f.parole.trim() && f.risposta.trim());
    db.prepare('DELETE FROM bot_faq').run();
    const ins = db.prepare('INSERT INTO bot_faq (parole, risposta) VALUES (?, ?)');
    for (const f of buone) { ins.run(f.parole.slice(0, 200), f.risposta.slice(0, 2000)); faq++; }
  }
  annota('frasi', `caricate ${frasi} frasi e ${faq} domande frequenti da un file`);
  res.json({ ok: true, frasi, faq, ignorate });
});

// «Restano -8 coperti liberi» è una frase che non vuol dire niente: chi la
// legge deve fermarsi a capire cosa sia un coperto libero negativo. Sopra il
// limite si dice quanto lo si sfora, che è il numero su cui poi si decide.
function quantoPosto(liberi, chiesti) {
  if (liberi <= 0) return `il turno è pieno: la sfori di ${chiesti - liberi}`;
  // «restano 1 coperto libero» è scritto male, e queste frasi le legge il
  // cliente quando il locale gliele gira: al singolare il verbo cambia.
  const quanti = liberi === 1 ? 'resta 1 coperto libero' : `restano ${liberi} coperti liberi`;
  return liberi < chiesti ? `${quanti}, te ne servono ${chiesti}` : quanti;
}

// Cercare in rubrica mentre si scrive una prenotazione. Il cliente abituale ha
// già nome, cognome e numero da qualche parte: farli riscrivere ogni volta
// significa sbagliarli — e un numero sbagliato è una prenotazione che non si
// può richiamare quando serve.
//
// ⚠️ Restituisce SOLO le corrispondenze, e poche: non è un modo per farsi dare
// l'elenco dei clienti una lettera per volta. Sotto le due lettere non risponde
// niente.
const rottaCercaRubrica = (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q.length < 2) return res.json([]);
  // Anche per numero: in sala capita di avere il numero sul telefono e non il
  // nome, e cercare «347» deve trovare chi ha quel numero.
  const soloCifre = q.replace(/\D/g, '');
  const righe = db.prepare('SELECT id, nome, cognome, telefono, opt_out FROM contacts').all();
  const trovati = righe.filter((c) => {
    const intero = `${c.nome} ${c.cognome}`.toLowerCase();
    if (intero.includes(q)) return true;
    return soloCifre.length >= 3 && normalizePhone(c.telefono).includes(soloCifre);
  });
  trovati.sort((a, b) => `${a.nome} ${a.cognome}`.localeCompare(`${b.nome} ${b.cognome}`, 'it'));
  res.json(trovati.slice(0, 8).map((c) => ({
    id: c.id, nome: c.nome, cognome: c.cognome, telefono: c.telefono, optOut: !!c.opt_out,
  })));
};
app.get('/api/bot/rubrica/cerca', rottaCercaRubrica);

// Il numero da mettere in rubrica è quello a cui si RICHIAMA, non l'indirizzo
// della chat: con gli indirizzi «@lid» WhatsApp non passa affatto il numero, e
// salvarlo come telefono vorrebbe dire riempire la rubrica di codici interni
// che non chiamano nessuno.
function numeroDaRubrica(p) {
  const contatto = String(p.telefono_contatto || '').trim();
  if (contatto) return contatto;
  const chat = String(p.telefono || '').trim();
  return /^\d{8,}$/.test(chat) ? chat : '';
}

function contattoDellaPrenotazione(rubrica, p) {
  // Prima il collegamento diretto: il numero può essere stato scritto solo in
  // rubrica — succede quando lo si aggiunge a mano nel pannello — e cercare
  // solo per telefono farebbe ricomparire il pulsante su chi c'è già.
  const numero = normalizePhone(numeroDaRubrica(p));
  const c = rubrica.find((x) => (p.contact_id && x.id === p.contact_id)
    || (numero && x.chiave === numero));
  return c ? { id: c.id, nome: `${c.nome} ${c.cognome}`.trim(), optOut: !!c.opt_out } : null;
}

// Mettere in rubrica chi ha prenotato. È il passaggio che trasforma una serata
// in un cliente a cui poter scrivere la prossima volta — ed è il motivo per cui
// questa piattaforma esiste. Resta un gesto DELIBERATO, uno per uno: chi
// prenota un tavolo non ha chiesto di ricevere le novità del locale.
app.post('/api/bot/prenotazioni/:id/rubrica', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const p = db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Prenotazione non trovata' });

  // Si usa quello che c'è scritto ADESSO nel pannello, non quello che è stato
  // salvato: chi corregge «Dani ok» in «Daniele» vuole in rubrica il nome
  // corretto, non quello che aveva scritto il cliente di fretta.
  const corpo = req.body || {};
  const dal = (campo, sePerso) => (corpo[campo] === undefined ? sePerso : String(corpo[campo]).trim());
  const nome = dal('nome', p.nome || '');
  const cognome = dal('cognome', p.cognome || '');
  const telefono = dal('telefono', '') || numeroDaRubrica(p);
  // ⚠️ L'email restava per strada: la prenotazione ce l'ha — il bot la chiede
  // come ultimo passo, ed è quella che conferma il tavolo — ma qui si scriveva
  // stringa vuota, e in rubrica finiva un contatto senza indirizzo. Poi la
  // newsletter non gli arrivava, e nessuno capiva perché.
  const email = dal('email', p.email || '');

  if (!nome) return res.status(400).json({ error: 'Serve almeno il nome per metterlo in rubrica.' });
  if (!telefono) {
    return res.status(400).json({
      error: 'Di questa prenotazione non abbiamo un numero di telefono: WhatsApp non lo ha passato. '
        + 'Scrivilo nel campo Telefono qui sopra e riprova.',
    });
  }

  // ⚠️ L'email va passata anche al controllo dei doppioni. Salvarla senza
  // guardarla lascerebbe entrare due contatti con lo stesso indirizzo — cosa
  // che il modulo normale della rubrica rifiuta — e la rubrica smetterebbe di
  // avere una regola sola.
  const dup = trovaDuplicato(telefono, email, null);
  if (dup) {
    // Non è un errore: è la risposta giusta. Si collega la prenotazione al
    // contatto che c'è già, e non gli si tocca NIENTE — men che meno il
    // consenso di chi aveva chiesto di non ricevere più messaggi.
    db.prepare('UPDATE prenotazioni SET contact_id = ? WHERE id = ?').run(dup.contatto.id, p.id);
    return res.json({
      gia: true,
      contatto: { id: dup.contatto.id, nome: `${dup.contatto.nome} ${dup.contatto.cognome}`.trim(),
                  optOut: !!dup.contatto.opt_out },
    });
  }

  const info = db.prepare('INSERT INTO contacts (nome, cognome, email, telefono) VALUES (?, ?, ?, ?)')
    .run(nome, cognome, email, numeroInRubrica(telefono));
  db.prepare('UPDATE prenotazioni SET contact_id = ? WHERE id = ?').run(info.lastInsertRowid, p.id);
  annota('rubrica', `${nome} ${cognome}`.trim() + ' aggiunto in rubrica da una prenotazione');
  res.json({ gia: false, contatto: { id: info.lastInsertRowid, nome: `${nome} ${cognome}`.trim(), optOut: false } });
});

const rottaServizio = (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  // Una data che non esiste mostrerebbe un giorno vuoto intestato «pippo»:
  // meglio oggi, che è quello che si voleva vedere nel 99% dei casi.
  const data = dataVera(String(req.query.data || '')) ? String(req.query.data) : bot.comeData(new Date());
  const righe = db.prepare('SELECT * FROM prenotazioni WHERE data = ? ORDER BY ora, id').all(data);
  const cfg = bot.config(db);
  const turni = bot.turniDelGiorno(cfg, data).map((t) => ({
    ora: t,
    occupati: bot.copertiOccupati(db, cfg, data, t),
    liberi: bot.postiLiberi(db, cfg, data, t),
  }));
  // Chi è già in rubrica lo si deve vedere PRIMA di premere il pulsante:
  // scoprirlo dopo, con un messaggio d'errore, fa sembrare rotto qualcosa che
  // ha funzionato benissimo la prima volta.
  const rubrica = db.prepare('SELECT id, nome, cognome, telefono, opt_out FROM contacts').all()
    .map((c) => ({ ...c, chiave: normalizePhone(c.telefono) }));
  for (const r of righe) r.inRubrica = contattoDellaPrenotazione(rubrica, r);
  // ⚠️ Se il giorno è segnato pieno o chiuso, chi guarda la giornata lo deve
  // SAPERE. La griglia della settimana lo diceva, l'intestazione del giorno
  // no: uno in sala vedeva «20:00: 3/6» e non aveva modo di accorgersi che il
  // bot stava rifiutando tutti. Il caso peggiore è il responsabile che segna
  // sold out, se ne dimentica, e la settimana dopo si chiede perché non
  // arrivano più prenotazioni.
  res.json({
    data, righe, turni, capienza: bot.num(cfg.bot_coperti_turno, 0),
    soldOut: bot.ePieno(db, data), chiuso: bot.eChiuso(db, data),
    // Chi aspetta un posto per questo giorno: la sala lo deve vedere, sia per
    // sapere che c'è richiesta, sia per chiamare a mano se vuole.
    attese: bot.listaDAttesa(db, data),
  });
};
// Quanto vale adesso il contatore delle prenotazioni. È la richiesta più
// leggera di tutto il programma — una riga sola — e serve alla pagina della
// sala per sapere se c'è qualcosa di nuovo senza riscaricarsi l'elenco intero
// ogni pochi secondi. Il numero lo alza un trigger dell'archivio, quindi sale
// per QUALUNQUE cambiamento: bot, piattaforma, un altro tablet.
const rottaVersionePrenotazioni = (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const r = db.prepare("SELECT value FROM settings WHERE key = 'prenotazioni_versione'").get();
  // ⚠️ Insieme al contatore delle prenotazioni viaggia anche il numero di
  // versione del PROGRAMMA. Non c'entrano niente l'uno con l'altro, ma questa
  // richiesta la sala la fa già ogni quattro secondi: attaccarci un campo costa
  // zero richieste in più, e le fa scoprire in quattro secondi di essere
  // vecchia invece che in cinque minuti. Sul tablet del bancone, cinque minuti
  // con una pagina vecchia sono cinque minuti di conti sbagliati.
  // ⚠️ E per la stessa ragione ci viaggia lo STATO DI WHATSAPP. In sala è
  // l'unica cosa che si deve sapere in quattro secondi e non in cinque minuti:
  // con la linea caduta il bot non risponde a nessuno, e chi sta lavorando se
  // ne accorgeva solo dai clienti che telefonano arrabbiati. È uno stato, non
  // un dato di nessuno: dalla porta della sala può passare.
  res.json({ versione: Number((r && r.value) || 0), programma: versioneInstallata(),
             whatsapp: state.status });
};
app.get('/api/bot/prenotazioni/versione', rottaVersionePrenotazioni);

app.get('/api/bot/prenotazioni', rottaServizio);

// Il planning della settimana: sette giornate con i numeri che servono a
// leggerle a colpo d'occhio. Il dettaglio di una giornata si apre cliccandola —
// qui si guarda l'insieme, non le singole prenotazioni.
const rottaSettimana = (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const cfg = bot.config(db);
  const oggi = bot.comeData(new Date());
  // ⚠️ Il formato non basta: «2026-02-31» lo passa, ma quel giorno non esiste
  // e la settimana veniva costruita da un altro giorno ancora — si chiedeva
  // una settimana e se ne otteneva un'altra, senza un errore.
  const partenza = dataVera(String(req.query.dal || '')) ? req.query.dal : oggi;
  const perTurno = bot.num(cfg.bot_coperti_turno, 0);

  const giorni = [];
  for (let i = 0; i < 7; i++) {
    const [a, m, g] = partenza.split('-').map(Number);
    const data = bot.comeData(new Date(a, m - 1, g + i));
    const turni = bot.turniDelGiorno(cfg, data);
    // ⚠️ Chiuso e pieno non sono la stessa cosa nemmeno qui. Un giorno «sold
    // out» letto come chiusura spariva dal planning: niente coperti, niente
    // barra, e — se c'erano prenotazioni — l'avviso «⚠️ chiuso, ma 40 pren.»,
    // che è un allarme per una cosa normalissima. Il giorno più pieno
    // dell'anno diventava quello che si vedeva meno.
    const bloccato = bot.giornoBloccato(db, data);
    const soldOut = !!bloccato && bloccato.tipo === 'pieno';
    const chiuso = !turni.length || (!!bloccato && !soldOut);
    // ⚠️ Chi sta pagando TIENE il posto: se non contasse qui, il planning
    // scriverebbe «0 coperti» su una sera in cui il bot rifiuta i tavoli, e chi
    // guarda lo schermo prenderebbe al telefono un tavolo che non c'è.
    const righe = db.prepare(
      'SELECT persone FROM prenotazioni WHERE data = ? AND stato IN ' + bot.dentro(bot.STATI_VIVI)
    ).all(data);
    giorni.push({
      data,
      etichetta: bot.dataItaliana(data),
      // La capienza della giornata è i coperti di un turno per quanti turni ci
      // sono: è il massimo onesto contro cui misurare quanto è piena.
      // La capienza di un giorno pieno resta quella vera: serve a leggere
      // quanti coperti ci sono davvero dentro, che è il motivo per cui lo si
      // è chiuso.
      capienza: chiuso ? 0 : perTurno * turni.length,
      turni: turni.length,
      chiuso,
      soldOut,
      passato: data < oggi,
      oggi: data === oggi,
      coperti: righe.reduce((n, r) => n + r.persone, 0),
      prenotazioni: righe.length,
    });
  }
  res.json({ oggi, dal: partenza, giorni });
};
app.get('/api/bot/settimana', rottaSettimana);

// Le prossime prenotazioni, raggruppate per giornata. Entrando nella scheda si
// vedeva SOLO il giorno scelto nel selettore: per sapere se domani c'era gente
// bisognava cambiare data a mano, e chi apre di sfuggita non lo faceva mai —
// quindi le prenotazioni «non si vedevano».
app.get('/api/bot/prenotazioni/prossime', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const cfg = bot.config(db);
  const oggi = bot.comeData(new Date());
  const giorni = Math.min(Math.max(parseInt(req.query.giorni, 10) || 14, 1), 90);
  // «prossimi 7 giorni» vuol dire oggi più i sei successivi — la settimana che
  // uno ha in testa — non oggi più altri sette.
  const fino = bot.comeData(new Date(Date.now() + (giorni - 1) * 86400000));
  // Chi sta ancora pagando compare come tutti gli altri: tiene un posto, e una
  // prenotazione che tiene un posto senza vedersi da nessuna parte è un tavolo
  // perso. Nella riga si legge lo stato, quindi non c'è modo di confonderla con
  // una confermata.
  const righe = db.prepare(
    'SELECT * FROM prenotazioni WHERE data >= ? AND data <= ? AND stato IN '
    + bot.dentro(bot.STATI_VIVI) + ' ORDER BY data, ora, id'
  ).all(oggi, fino);

  // Raggruppate per giornata, col totale dei coperti: è il numero che serve
  // davvero a colpo d'occhio, più dell'elenco stesso.
  const perGiorno = [];
  for (const r of righe) {
    let g = perGiorno.find((x) => x.data === r.data);
    if (!g) { g = { data: r.data, etichetta: bot.dataItaliana(r.data), oggi: r.data === oggi, coperti: 0, righe: [] }; perGiorno.push(g); }
    g.coperti += r.persone;
    g.righe.push(r);
  }
  res.json({
    oggi,
    giorni: perGiorno,
    totale: righe.length,
    coperti: righe.reduce((n, r) => n + r.persone, 0),
    capienza: bot.num(cfg.bot_coperti_turno, 0),
  });
});

// Interrogato dalla pagina ogni tot secondi, mentre è aperta: dice se sono
// arrivate prenotazioni nuove dall'ultima volta, per farne comparire un
// avviso a video senza dover ricaricare. Da qualunque via siano arrivate —
// bot, pannello, NUOVA — non solo da WhatsApp.
//
// Le annullate restano fuori: qui si avvisa di quello che è appena successo
// «in avanti», non del contrario — la riga annullata la si vede comunque
// scomparire dalla tabella al prossimo giro.
app.get('/api/bot/prenotazioni/nuove', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const dopo = parseInt(req.query.dopo, 10) || 0;
  const nuove = db.prepare(
    "SELECT * FROM prenotazioni WHERE id > ? AND stato != 'annullata' ORDER BY id LIMIT 50"
  ).all(dopo);
  const ultimo = db.prepare('SELECT MAX(id) m FROM prenotazioni').get().m || 0;
  res.json({ ultimo, nuove });
});

// Modifica di una prenotazione. Data, ora e persone si possono cambiare —
// succede di continuo al telefono — e il cliente va avvisato, altrimenti si
// presenta all'orario vecchio e la colpa e' del locale.
// ⚠️ Il bug: l'avviso al cliente partiva SEMPRE come «risposta in chat», cioè
// mandato dritto all'indirizzo così com'era scritto. Funziona per chi ha
// scritto su WhatsApp — lì c'è un indirizzo vero — ma NON per una prenotazione
// presa a mano: lì c'è solo un numero (393331234567), che non è un indirizzo di
// chat. WhatsApp non lo riconosce e il messaggio non parte. Il risultato: chi
// prenota da solo veniva avvisato, chi prenotava per telefono no — e la
// pagina diceva comunque «Salvata».
function inviaAlCliente(p, testo) {
  // Se c'è la conversazione, si risponde lì: è l'unico modo che regge anche
  // con gli indirizzi «@lid», dove il numero non lo si conosce affatto.
  if (p.chat_id) return rispondiConRitmo(p.chat_id, testo);
  const numero = String(p.telefono || p.telefono_contatto || '').trim();
  if (!numero) throw new Error('di questa prenotazione non abbiamo un numero');
  // Un numero va prima risolto in indirizzo: ci pensa `inviaBot`.
  return inviaConRitmo(numero, testo);
}

// ---------------------------------------------------------------------------
//  Il controllo di giorno, ora e persone — uno solo, per tutte e due le rotte
// ---------------------------------------------------------------------------
//  ⚠️ Una prenotazione con dentro `data: 'pippo'` o `ora: '99:99'` non dà
//  nessun errore: si salva, e poi **non compare da nessuna parte**. Nessun
//  elenco la mostra (nessun giorno si chiama «pippo»), nessun turno la conta,
//  l'appello di fine serata non la vede. Il cliente ha un tavolo che la sala
//  non sa di avere: è il guaio peggiore che questo programma possa fare, ed è
//  anche il più silenzioso.
//
//  Il formato non basta: `2026-02-31` passa qualsiasi controllo fatto con una
//  espressione regolare, ma il 31 febbraio non esiste. L'unico modo onesto è
//  ricostruire la data e chiederle se è rimasta quella che si era scritta.
function dataVera(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso || ''))) return false;
  const [a, m, g] = String(iso).split('-').map(Number);
  // Mezzogiorno, mai mezzanotte: a mezzanotte il fuso può spostare il giorno.
  const d = new Date(a, m - 1, g, 12, 0, 0);
  return d.getFullYear() === a && d.getMonth() === m - 1 && d.getDate() === g;
}

function oraVera(testo) {
  const m = String(testo || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  return +m[1] <= 23 && +m[2] <= 59;
}

// Un tavolo da novantanovemila persone non è un errore di battitura da
// correggere in silenzio: è un numero che poi finisce nei coperti del turno e
// fa risultare pieno tutto il locale per sempre.
const PERSONE_MASSIMO = 200;

// Il tavolo è un'etichetta scritta a mano dalla sala: «12», «T4», «terrazza 3».
// Venti caratteri bastano a tutte, e sono abbastanza pochi da non farci finire
// una nota intera per sbaglio. Gli spazi doppi si stringono: «12» e «12 » sono
// lo stesso tavolo, e non devono sembrare due.
const TAVOLO_MASSIMO = 20;
function tavoloPulito(t) {
  return String(t === null || t === undefined ? '' : t).replace(/\s+/g, ' ').trim().slice(0, TAVOLO_MASSIMO);
}

//  ⚠️ E un controllo troppo zelante fa un danno suo: se pretende che TUTTA la
//  riga sia a posto, una prenotazione già sbagliata in archivio non si può più
//  correggere — ogni tentativo di sistemarle il giorno viene respinto perché
//  le persone sono ancora quelle assurde di prima. Quindi si controlla solo
//  quello che sta CAMBIANDO: non si può introdurre un valore sbagliato, ma
//  quelli già lì si possono sempre riparare, uno alla volta.
function controllaPrenotazione(nuovi, opzioni = {}) {
  const { permettiPassato, precedente } = opzioni;
  const cambia = (campo) => !precedente || nuovi[campo] !== precedente[campo];

  if (cambia('data') && !dataVera(nuovi.data)) {
    return 'Il giorno non è una data vera (esempio: 2026-09-10).';
  }
  if (cambia('ora') && !oraVera(nuovi.ora)) {
    return 'L\'ora non è un orario vero (esempio: 20:30).';
  }
  if (cambia('persone')
      && (!Number.isInteger(nuovi.persone) || nuovi.persone < 1 || nuovi.persone > PERSONE_MASSIMO)) {
    return `Le persone devono essere un numero da 1 a ${PERSONE_MASSIMO}.`;
  }
  if (!permettiPassato && cambia('data') && nuovi.data < new Date().toLocaleDateString('sv-SE')) {
    return 'Quel giorno è già passato: una prenotazione lì non la vedrebbe più nessuno.';
  }
  return '';
}

const rottaModificaPrenotazione = async (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const b = req.body || {};
  const p = db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Prenotazione inesistente' });
  const cfg = bot.config(db);

  const nuovi = {
    data: typeof b.data === 'string' && b.data ? b.data : p.data,
    ora: typeof b.ora === 'string' && b.ora ? b.ora : p.ora,
    persone: Number.isInteger(+b.persone) && +b.persone > 0 ? +b.persone : p.persone,
    nome: typeof b.nome === 'string' ? b.nome.slice(0, 60) : p.nome,
    cognome: typeof b.cognome === 'string' ? b.cognome.slice(0, 60) : p.cognome,
    note: typeof b.note === 'string' ? b.note.slice(0, 200) : p.note,
    // ⚠️ Si accetta anche «telefono»: la pagina della sala manda quello, e
    // leggendo solo `telefono_contatto` il numero corretto a mano spariva
    // senza un errore — restava quello vecchio, o nessuno.
    telefono_contatto: typeof b.telefono_contatto === 'string'
      ? b.telefono_contatto.replace(/\D/g, '').slice(0, 15)
      : (typeof b.telefono === 'string'
        ? b.telefono.replace(/\D/g, '').slice(0, 15) : p.telefono_contatto),
    // L'email che il cliente ha dato per confermare. Si corregge come tutto il
    // resto: chi la detta al telefono la sbaglia, e un indirizzo sbagliato è
    // una conferma che non arriva.
    email: typeof b.email === 'string' ? b.email.trim().slice(0, 120) : p.email,
    // Il tavolo lo assegna la sala a prenotazione fatta. Non è un cambio che
    // riguarda il cliente — non gli si scrive — e non riguarda gli avvisi:
    // «cambiata», qui sotto, guarda solo giorno, ora e persone.
    tavolo: b.tavolo !== undefined ? tavoloPulito(b.tavolo) : p.tavolo,
    // Tre stati soli: prenotata, conclusa, cancellata. «non_presentato» non si
    // può più assegnare — vedi la migrazione in preparaDatabase.
    // Lo stato che c'è già passa comunque: è un «non cambiare niente».
    stato: ['confermata', 'presentata', 'annullata'].includes(b.stato) || b.stato === p.stato
      ? b.stato : p.stato,
  };

  // ⚠️ Un'email storta non si accetta in silenzio: finirebbe in archivio un
  // dato falso, e la conferma non arriverebbe a nessuno senza che nessuno lo
  // sappia. Vuota sì: non tutti la lasciano.
  if (nuovi.email && !EMAIL_RE.test(nuovi.email)) {
    return res.status(400).json({ error: 'L\'email non è scritta bene: per esempio nome@esempio.it' });
  }

  // ⚠️ Uno stato che non esiste veniva ignorato in silenzio, e la risposta era
  // un 200 con dentro lo stato VECCHIO: chi l'ha mandato crede di averlo
  // cambiato. Un errore detto è meglio di un successo finto.
  // ⚠️ Uno stato uguale a quello che c'è già NON è un cambio, e rifiutarlo
  // bloccava tutto il resto: la sala rimandava indietro lo stato che aveva
  // letto — «attesa_pagamento» — e si sentiva rispondere «stato non valido»
  // mentre stava solo correggendo un cognome. Il controllo serve a impedire di
  // ASSEGNARE uno stato che non esiste, non a impedire di riscrivere il proprio.
  if (b.stato !== undefined && b.stato !== p.stato
      && !['confermata', 'presentata', 'annullata'].includes(b.stato)) {
    return res.status(400).json({ error: 'Stato non valido: confermata, presentata o annullata.' });
  }

  // ⚠️ Si controlla come resterà la prenotazione, non quello che è arrivato:
  // una modifica manda solo i campi toccati, e il resto viene da com'era.
  // Il passato qui è permesso: si corregge anche una serata già fatta, per
  // esempio per segnare chi era venuto davvero.
  const guaio = controllaPrenotazione(nuovi, { permettiPassato: true, precedente: p });
  if (guaio) return res.status(400).json({ error: guaio });

  const cambiata = nuovi.data !== p.data || nuovi.ora !== p.ora || nuovi.persone !== p.persone;

  // ⚠️ Cambiare il numero di persone mentre il cliente sta pagando è la cosa
  // peggiore che si possa fare: lui ha davanti una pagina di Stripe con SOPRA
  // UNA CIFRA, e quella cifra non si può cambiare da qui. Portando la
  // prenotazione da 2 a 6 persone, il conto restava quello di 2 — il cliente
  // pagava 120 € per un tavolo da 360 €, e nessuno se ne accorgeva.
  //
  // Si rifiuta, invece di accettare e mentire sull'importo. La via d'uscita
  // c'è ed è breve: si aspetta il pagamento, oppure si annulla e si rifà.
  if (p.stato === 'attesa_pagamento' && nuovi.persone !== p.persone) {
    return res.status(409).json({
      error: 'Questa prenotazione sta aspettando il pagamento, e il cliente ha davanti una '
        + `pagina con l'importo di ${bot.euro(p.importo_dovuto)}: cambiando le persone quel `
        + 'numero resterebbe sbagliato. Aspetta il pagamento — o annullala e rifalla.',
    });
  }

  // Se sposta o cresce, si controlla che ci sia posto — ma senza contare se
  // stessa, altrimenti una prenotazione risulterebbe sempre in conflitto con
  // la propria vecchia versione.
  //
  // ⚠️ «confermata» non basta più: anche chi sta aspettando il pagamento TIENE
  // il posto. Con il controllo legato al solo stato «confermata», una
  // prenotazione in attesa si poteva spostare su un turno pieno senza nessun
  // controllo — e si contava contro se stessa, perché `copertiOccupati` la
  // conta e la sottrazione qui sotto no.
  if (cambiata && bot.STATI_VIVI.includes(nuovi.stato)) {
    const occupatiAltrui = bot.copertiOccupati(db, cfg, nuovi.data, nuovi.ora)
      - (p.data === nuovi.data && p.ora === nuovi.ora && bot.STATI_VIVI.includes(p.stato) ? p.persone : 0);
    const capienza = bot.num(cfg.bot_coperti_turno, 0) - bot.num(cfg.bot_coperti_liberi, 0);
    if (!b.forza && occupatiAltrui + nuovi.persone > capienza) {
      return res.status(409).json({
        error: `Per ${bot.dataItaliana(nuovi.data)} alle ${nuovi.ora} ${quantoPosto(capienza - occupatiAltrui, nuovi.persone)}.`,
        liberi: capienza - occupatiAltrui,
      });
    }
  }

  db.prepare('UPDATE prenotazioni SET data = ?, ora = ?, persone = ?, nome = ?, cognome = ?, '
    + 'note = ?, telefono_contatto = ?, email = ?, tavolo = ?, stato = ? WHERE id = ?')
    .run(nuovi.data, nuovi.ora, nuovi.persone, nuovi.nome, nuovi.cognome,
         nuovi.note, nuovi.telefono_contatto, nuovi.email, nuovi.tavolo, nuovi.stato, p.id);

  // Spostata su un altro giorno: può essere finita proprio sul giorno per cui
  // quel cliente era in lista d'attesa. Allora la lista non serve più.
  bot.esceDallaLista(db, p.telefono, nuovi.data, p.id);

  // L'acconto facoltativo: il tavolo è confermato e nessuno ha ancora versato
  // niente. Qui le persone si possono cambiare — il tavolo è vero e la sala
  // deve poterlo correggere — ma il conto va rifatto, sennò resta scritto
  // quello di prima e il «resto da saldare» dice una cifra che non esiste.
  if (!p.pagato_at && p.importo_dovuto > 0 && nuovi.persone !== p.persone
      && p.stato !== 'attesa_pagamento') {
    const conti = bot.importoDaPagare(cfg, nuovi.persone);
    db.prepare('UPDATE prenotazioni SET importo_dovuto = ?, importo_totale = ? WHERE id = ?')
      .run(conti.adesso, conti.totale, p.id);
    // Va detto: il collegamento già mandato al cliente chiede ancora la cifra
    // vecchia, e questa è l'unica traccia che qualcuno se ne accorga.
    annota('pagamento', `${bot.nomeInSala(p)}: da ${p.persone} a ${nuovi.persone} persone, `
      + `acconto rifatto da ${bot.euro(p.importo_dovuto)} a ${bot.euro(conti.adesso)} `
      + '(il collegamento già mandato chiede ancora la cifra vecchia)');
  }
  const dopo = db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(p.id);

  // ⚠️ Annullare dalla pagina NON diceva niente a nessuno: né al cliente, che
  // si presentava lo stesso, né a chi in sala riceve gli avvisi. Disdire per
  // il cliente è la cosa più importante da comunicare di tutte, ed era l'unica
  // che partiva soltanto quando l'annullamento passava da WhatsApp.
  const annullataAdesso = nuovi.stato === 'annullata' && p.stato !== 'annullata';
  const daDire = annullataAdesso || (cambiata && nuovi.stato !== 'annullata');

  // ⚠️ Annullare una prenotazione GIÀ PAGATA non restituisce i soldi, e finora
  // non lo diceva nessuno: la riga spariva dalla giornata e l'incasso restava
  // su Stripe, senza che a nessuno venisse in mente che c'era un rimborso da
  // fare. Il rimborso resta una decisione di una persona — non lo facciamo noi,
  // e va bene così — ma la persona deve sapere che c'è da prenderla.
  let avvisoSoldi = '';
  if (annullataAdesso && p.pagato_at && p.importo_dovuto > 0) {
    avvisoSoldi = `Attenzione: questa prenotazione aveva già pagato ${bot.euro(p.importo_dovuto)}. `
      + 'Annullandola i soldi NON tornano indietro da soli: il rimborso si fa dal tuo cruscotto Stripe.';
    annota('pagamento', `annullata la ${p.id} di ${bot.nomeInSala(p)} che aveva pagato `
      + `${bot.euro(p.importo_dovuto)}: rimborso da decidere`);
  }
  // E se NON aveva ancora pagato, il collegamento si chiude: un tavolo che
  // non c'è più non deve poter incassare.
  if (annullataAdesso) await chiudiIlPagamento(p);

  let avvisato = false;
  let avvisoFallito = '';
  if (b.avvisa && daDire) {
    if (!dopo.chat_id && !dopo.telefono && !dopo.telefono_contatto) {
      // Non è un guasto: di questa prenotazione non abbiamo un recapito. Ma va
      // detto, perché chi ha spostato un tavolo crede di aver avvisato.
      avvisoFallito = 'di questa prenotazione non abbiamo un numero';
    } else {
      const frase = annullataAdesso ? cfg.bot_t_annullata_locale : cfg.bot_t_modificata;
      try {
        await inviaAlCliente(dopo, bot.riempi(frase, {
          locale: cfg.bot_locale, assistente: cfg.bot_assistente,
          nome: [dopo.nome, dopo.cognome].filter(Boolean).join(' '),
          data: bot.dataItaliana(dopo.data), ora: dopo.ora, persone: dopo.persone,
        }));
        avvisato = true;
        annota(annullataAdesso ? 'annullata admin' : 'modificata',
          `avvisato il cliente: ${dopo.data} ${dopo.ora}, ${dopo.persone} pers.`);
      } catch (e) {
        avvisoFallito = e.message;
        annota('errore', `non riesco ad avvisare il cliente: ${e.message}`);
      }
    }
  }

  // Chi riceve gli avvisi lo deve sapere comunque, e a prescindere dalla
  // spunta: quella riguarda il CLIENTE. È lo stesso meccanismo già usato
  // quando a disdire o a spostare è il cliente da solo — chi sta in cucina non
  // può sapere di un tavolo tolto solo perché qualcun altro guardava lo schermo.
  if (annullataAdesso) {
    await avvisaPrenotazione(dopo, 'annullata');
  } else if (cambiata && nuovi.stato === 'confermata') {
    await avvisaPrenotazione(dopo, 'spostata',
      { prima: { data: p.data, ora: p.ora, persone: p.persone, tavolo: p.tavolo } });
  }
  // ⚠️ Un avviso non partito va DETTO. Prima finiva solo nel registro: la
  // pagina scriveva «Salvata» e il cliente si presentava all'ora vecchia,
  // convinto che nessuno gli avesse cambiato niente.
  res.json({ ...dopo, avvisato, avvisoFallito, avvisoSoldi });
};
app.patch('/api/bot/prenotazioni/:id', rottaModificaPrenotazione);

// «Questa ha pagato»: la spunta a mano.
//
// ⚠️ NON è un metodo di pagamento — è l'intervento di una persona su
// un'eccezione: il cliente affezionato che passa a pagare al banco, quello che
// ha telefonato. Per questo il pulsante nella pagina sta SOLO sulle
// prenotazioni in attesa: se comparisse su tutte, prima o poi qualcuno lo preme
// su una che non ha pagato niente.
// «Questa chiave funziona?» — si chiede a Stripe chi siamo.
//
// ⚠️ È la stessa regola dell'installatore di Ubuntu, che prova la password
// appena l'hai scelta: il guasto peggiore è quello che si scopre col primo
// cliente vero, di sabato sera.
// Una prenotazione d'esempio per vedere l'email prima che parta davvero. Con
// il pagamento acceso è in attesa, col collegamento dentro: è il caso in cui
// l'email dice di più, ed è quello da guardare.
function prenotazioneDiEsempio(cfg, a) {
  const domani = new Date(Date.now() + 86400000);
  const conPagamento = bot.boolDi(cfg.bot_pagamento_attivo) && bot.serveIlPagamento(cfg, 2);
  const conti = bot.importoDaPagare(cfg, 2);
  return {
    nome: 'Anna', cognome: 'Bianchi', data: bot.comeData(domani), ora: '20:00', persone: 2,
    telefono_contatto: '393331112233', note: 'senza glutine', email: a,
    stato: conPagamento && bot.pagamentoObbligatorio(cfg) ? 'attesa_pagamento' : 'confermata',
    importo_dovuto: conPagamento ? conti.adesso : 0, importo_totale: conPagamento ? conti.totale : 0,
    pagamento_scade_at: conPagamento ? bot.comeOrario(new Date(Date.now() + 30 * 60000)) : null,
    pagato_at: null,
  };
}

// Le impostazioni come sono NEL MODULO, non come sono salvate: si prova prima
// di salvare, altrimenti «Anteprima» e «Salva» andrebbero premuti in
// quest'ordine e nessuno se lo ricorderebbe.
function configDalModulo(req) {
  const cfg = { ...bot.config(db) };
  const b = req.body || {};
  for (const k of ['bot_email_oggetto', 'bot_email_testo', 'bot_email_html', 'bot_email_logo', 'bot_email_attiva']) {
    if (typeof b[k] === 'string') cfg[k] = b[k];
  }
  return cfg;
}

app.post('/api/bot/email/anteprima', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const cfg = configDalModulo(req);
  const p = prenotazioneDiEsempio(cfg, getSetting('smtp_user') || 'cliente@esempio.it');
  const link = p.importo_dovuto ? 'https://checkout.stripe.com/c/pay/esempio' : '';
  const e = composizioneEmail(cfg, p, link);
  // Nell'anteprima il logo non può viaggiare come allegato: si mette dentro
  // la pagina così com'è.
  const html = cfg.bot_email_logo ? e.html.split('cid:logo-istudio').join(cfg.bot_email_logo) : e.html;
  res.type('html').send('<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><title>'
    + htmlSicuro(e.oggetto) + '</title></head><body style="margin:0">'
    + '<div style="font-family:Arial,sans-serif;font-size:13px;color:#667781;padding:10px 14px;border-bottom:1px solid #e0e4e8;background:#fff">'
    + 'Anteprima · oggetto: <b style="color:#222">' + htmlSicuro(e.oggetto) + '</b> · dati d\'esempio, niente è partito</div>'
    + html + '</body></html>');
});

app.post('/api/bot/email/prova', async (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const transporter = buildTransporter();
  if (!transporter) return res.status(400).json({ error: 'La posta non è configurata: Impostazioni → Email.' });
  const a = String((req.body && req.body.a) || getSetting('smtp_user') || '').trim();
  if (!EMAIL_RE.test(a)) return res.status(400).json({ error: 'Scrivi un indirizzo a cui mandare la prova.' });
  const cfg = configDalModulo(req);
  const p = prenotazioneDiEsempio(cfg, a);
  const e = composizioneEmail(cfg, p, p.importo_dovuto ? 'https://checkout.stripe.com/c/pay/esempio' : '');
  const nomeMittente = getSetting('smtp_from_name') || cfg.bot_locale || '';
  try {
    await transporter.sendMail({
      from: nomeMittente ? `"${nomeMittente}" <${getSetting('smtp_user')}>` : getSetting('smtp_user'),
      to: a, subject: '[PROVA] ' + e.oggetto, text: e.testo, html: e.html, attachments: e.allegati,
    });
    res.json({ ok: true, a });
  } catch (err) {
    // L'errore della posta si riporta com'è: dice cose precise.
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/bot/pagamento/prova', async (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  // La chiave arriva dal modulo se la si sta ancora scrivendo, sennò da quella
  // salvata: così si può provare PRIMA di salvare.
  const cfg = { ...bot.config(db) };
  if (req.body && typeof req.body.chiave === 'string' && req.body.chiave.trim()) {
    cfg.bot_pagamento_chiave = req.body.chiave.trim();
  }
  const k = bot.chiaveStripe(cfg);
  if (!k.presente) return res.status(400).json({ error: 'Non c\'è nessuna chiave da provare.' });
  const r = await stripeChiSono(cfg);
  if (!r.ok) return res.status(400).json({ error: r.errore });
  res.json({ ok: true, nome: r.nome, prova: k.prova });
});

app.post('/api/bot/prenotazioni/:id/pagata', async (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const cfg = bot.config(db);
  const esito = bot.segnaPagata(db, cfg, req.params.id, 'mano');
  if (!esito.ok) {
    if (esito.motivo === 'niente posto') {
      // Il caso che fa arrabbiare: nel frattempo il posto è stato dato a un
      // altro. Non si conferma in silenzio, e non si decide da soli cosa fare
      // dei soldi: lo si dice a chi sta guardando lo schermo.
      return res.status(409).json({
        error: 'Su quel turno non c\'è più posto: nel frattempo è stato preso. '
          + 'Se il cliente ha già pagato, va deciso cosa fare — la prenotazione resta com\'è.',
      });
    }
    return res.status(404).json({ error: 'Prenotazione non trovata' });
  }
  const p = esito.prenotazione;
  if (!esito.gia) {
    annota('pagamento', `${bot.nomeInSala(p)} segnata come pagata a mano`);
    // Il cliente deve sapere che adesso il tavolo è suo davvero: fin qui gli
    // avevamo scritto a lettere chiare che NON era prenotato.
    try {
      await inviaAlCliente(p, testoDelPagamento(cfg, p, esito.eraGiaConfermata));
    } catch (e) {
      // La prenotazione È confermata: questo lo sa già il locale, che ha
      // premuto il pulsante. Se il messaggio non parte si dice, ma non si
      // rimette in discussione il tavolo.
      annota('errore', `confermata la ${p.id} ma il messaggio al cliente non è partito: ${e.message}`);
      await mandaEmailPrenotazione(p);
      return res.json({ ok: true, prenotazione: p, avviso: 'Confermata, ma il messaggio al cliente non è partito.' });
    }
    await mandaEmailPrenotazione(p);
  }
  res.json({ ok: true, prenotazione: p });
});

// Una prenotazione presa al telefono o di persona. Il locale non vive solo di
// WhatsApp, e una pagina che mostra meta' delle prenotazioni non la guarda
// nessuno — a quel punto tornano tutti al quaderno.
const rottaNuovaPrenotazione = async (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const b = req.body || {};
  const cfg = bot.config(db);
  const data = String(b.data || '');
  const ora = String(b.ora || '');
  const persone = +b.persone;
  if (!data || !ora || !(persone > 0)) {
    return res.status(400).json({ error: 'Servono giorno, ora e numero di persone' });
  }
  const guaio = controllaPrenotazione({ data, ora, persone });
  if (guaio) return res.status(400).json({ error: guaio });
  const capienza = bot.num(cfg.bot_coperti_turno, 0) - bot.num(cfg.bot_coperti_liberi, 0);
  const occupati = bot.copertiOccupati(db, cfg, data, ora);
  if (!b.forza && occupati + persone > capienza) {
    return res.status(409).json({
      error: `Per ${bot.dataItaliana(data)} alle ${ora} ${quantoPosto(capienza - occupati, persone)}.`,
      liberi: capienza - occupati,
    });
  }
  const telefono = b.telefono ? normalizePhone(String(b.telefono)) : '';
  // Anche presa al telefono la prenotazione può avere un'email: se il cliente
  // la detta, va scritta qui e non in un foglio a parte. Storta si rifiuta —
  // vale la stessa regola della modifica.
  const email = String(b.email || '').trim().slice(0, 120);
  if (email && !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'L\'email non è scritta bene: per esempio nome@esempio.it' });
  }
  // Anche il tavolo, se chi la scrive lo sa già: chi entra senza prenotare
  // e viene segnato a mano si siede in quel momento.
  const info = db.prepare('INSERT INTO prenotazioni (telefono, nome, cognome, data, ora, persone, note, '
    + 'telefono_contatto, email, tavolo, origine) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(telefono, String(b.nome || '').slice(0, 60), String(b.cognome || '').slice(0, 60),
         data, ora, persone, String(b.note || '').slice(0, 200), telefono, email,
         tavoloPulito(b.tavolo), 'manuale');
  const p = db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(info.lastInsertRowid);
  // ⚠️ Se quel cliente stava in lista d'attesa per quel giorno, adesso ha un
  // tavolo: esce dalla lista. Senza, più tardi il bot gli scriveva «si è
  // liberato un posto» per il tavolo che la sala gli aveva appena dato.
  if (bot.esceDallaLista(db, p.telefono, p.data, p.id).length) {
    annota('lista d\'attesa', `${bot.nomeInSala(p)} esce dalla lista: ha un tavolo per il ${p.data}`);
  }
  annota('admin', `${p.data} ${p.ora}, ${p.persone} pers., ${bot.nomeInSala(p)}`);
  await avvisaPrenotazione(p, 'nuova');

  let avvisato = false;
  let avvisoFallito = '';
  if (b.avvisa && telefono) {
    try {
      await inviaConRitmo(telefono, bot.riempi(cfg.bot_t_manuale, {
        locale: cfg.bot_locale, assistente: cfg.bot_assistente,
        nome: [p.nome, p.cognome].filter(Boolean).join(' '),
        data: bot.dataItaliana(p.data), ora: p.ora, persone: p.persone,
      }));
      avvisato = true;
    } catch (e) {
      avvisoFallito = e.message;
      annota('errore', `non riesco a confermare al cliente: ${e.message}`);
    }
  }
  res.json({ ...p, avvisato, avvisoFallito });
};
app.post('/api/bot/prenotazioni', rottaNuovaPrenotazione);

app.get('/api/bot/faq', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  res.json({
    faq: db.prepare('SELECT * FROM bot_faq ORDER BY id').all(),
    nonCapite: db.prepare('SELECT * FROM bot_non_capite WHERE risolta = 0 ORDER BY volte DESC, ultima_at DESC LIMIT 50').all(),
  });
});

app.post('/api/bot/faq', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const { parole, risposta, chiudiNonCapita } = req.body || {};
  if (!parole || !risposta) return res.status(400).json({ error: 'Servono le parole chiave e la risposta' });
  db.prepare('INSERT INTO bot_faq (parole, risposta) VALUES (?, ?)').run(String(parole), String(risposta));
  if (chiudiNonCapita) db.prepare('UPDATE bot_non_capite SET risolta = 1 WHERE id = ?').run(chiudiNonCapita);
  res.json({ ok: true });
});

app.delete('/api/bot/faq/:id', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  db.prepare('DELETE FROM bot_faq WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Togliere una frase dall'elenco senza scriverci una risposta. Serve per le
// prove, per gli sbagli di battitura e per le domande a cui non si vuole
// rispondere: senza questo, una frase inutile resta davanti per sempre e
// l'elenco smette di essere utile — che e' il modo in cui si smette di
// guardarlo.
app.delete('/api/bot/non-capite/:id', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  db.prepare('UPDATE bot_non_capite SET risolta = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.post('/api/bot/non-capite/svuota', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const r = db.prepare('UPDATE bot_non_capite SET risolta = 1 WHERE risolta = 0').run();
  res.json({ ok: true, tolte: r.changes });
});

app.post('/api/bot/personale', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const { nome, telefono, canale, riceve, gestisce } = req.body || {};
  if (!nome || !telefono) return res.status(400).json({ error: 'Servono nome e numero' });
  const tel = normalizePhone(telefono);
  // Mai il numero del locale: il bot manderebbe messaggi a se stesso.
  // Va impedito adesso, non scoperto la prima sera che serve davvero.
  if (state.me && tel === normalizePhone(state.me)) {
    return res.status(400).json({ error: 'Questo è il numero del locale: gli avvisi andrebbero a se stesso.' });
  }
  db.prepare('INSERT INTO bot_personale (nome, telefono, canale, riceve, gestisce) VALUES (?, ?, ?, ?, ?)')
    .run(String(nome), tel, canale || 'whatsapp', riceve || 'niente', gestisce === false ? 0 : 1);
  res.json({ ok: true, personale: db.prepare('SELECT * FROM bot_personale').all() });
});

// Genera il codice da far scrivere alla persona dal SUO telefono. È l'unico
// modo di collegare un telefono che funzioni sempre: non dipende dal fatto che
// WhatsApp ci dica il numero, cosa che con certi indirizzi non fa mai.
app.post('/api/bot/personale/:id/codice', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const p = db.prepare('SELECT * FROM bot_personale WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Persona inesistente' });
  // Stesso alfabeto senza caratteri ambigui dei codici di installazione: va
  // letto ad alta voce e ricopiato su un telefono, di fretta.
  const gruppo = () => Array.from(crypto.randomBytes(4))
    .map((b) => ALFABETO_CODICE[b % ALFABETO_CODICE.length]).join('');
  const codice = 'SALA-' + gruppo();
  db.prepare('UPDATE bot_personale SET codice_collegamento = ?, chat_id = ? WHERE id = ?')
    .run(codice, '', p.id);
  res.json({ ok: true, codice, nome: p.nome });
});

// Cambiare ruolo o numero SENZA cancellare e rifare. Non e' comodita': chi
// viene cancellato perde anche il telefono collegato, e per cambiargli una
// spunta bisognerebbe rifargli scrivere il codice SALA- dal suo telefono.
app.patch('/api/bot/personale/:id', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const p = db.prepare('SELECT * FROM bot_personale WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Persona inesistente' });
  const b = req.body || {};
  const nome = b.nome === undefined ? p.nome : String(b.nome).trim();
  if (!nome) return res.status(400).json({ error: 'Il nome non puo\' restare vuoto' });
  const tel = b.telefono === undefined ? p.telefono : normalizePhone(String(b.telefono));
  if (!tel) return res.status(400).json({ error: 'Il numero non puo\' restare vuoto' });
  if (state.me && tel === normalizePhone(state.me)) {
    return res.status(400).json({ error: 'Questo è il numero del locale: gli avvisi andrebbero a se stesso.' });
  }
  // Il telefono collegato si azzera SOLO se il numero cambia davvero: un altro
  // numero e' un altro apparecchio, e tenere il vecchio indirizzo di chat
  // manderebbe gli avvisi alla persona sbagliata. Correggere un refuso nel
  // nome, invece, non deve costare un nuovo collegamento.
  const cambiaNumero = tel !== p.telefono;
  db.prepare('UPDATE bot_personale SET nome = ?, telefono = ?, gestisce = ?, riceve = ?'
    + (cambiaNumero ? ", chat_id = '', codice_collegamento = ''" : '') + ' WHERE id = ?')
    .run(nome, tel,
         b.gestisce === undefined ? p.gestisce : (b.gestisce ? 1 : 0),
         b.riceve === undefined ? p.riceve : String(b.riceve), p.id);
  res.json({ ok: true, scollegato: cambiaNumero && !!p.chat_id });
});

app.delete('/api/bot/personale/:id', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  db.prepare('DELETE FROM bot_personale WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- Il simulatore ----------
//  Fa girare una conversazione VERA (stesso motore, stesso database) senza
//  passare da WhatsApp. Serve a provare orari, coperti e testi prima di
//  collegare un numero, e a far vedere il bot al ristoratore in due minuti.
//  Il numero finto comincia per 000 così non può mai coincidere con uno vero.
app.post('/api/bot/simula', async (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const testo = String((req.body && req.body.testo) || '');
  const telefono = '000' + String((req.body && req.body.sessione) || '1');
  // Nel simulatore non c'è un telefono vero, ma serve comunque un numero
  // altrimenti la domanda «a quale numero possiamo richiamarti?» non si può
  // provare: rispondendo OK il bot direbbe di non aver capito, e sembrerebbe
  // rotto quando invece sta funzionando.
  const esito = bot.elaboraMessaggio(db, telefono, testo, new Date(), { numero: '393000000000' });
  // ⚠️ Il simulatore è lo strumento con cui il ristoratore prova il bot PRIMA
  // dei clienti veri. Senza questo pezzo, con il pagamento acceso la
  // conversazione finiva nel vuoto dopo l'email: lui avrebbe visto un bot rotto
  // proprio mentre funzionava, e non avrebbe avuto modo di provare la parte che
  // gli interessa di più.
  if (esito.daPagare) {
    const cfg = bot.config(db);
    const p = db.prepare('SELECT * FROM prenotazioni WHERE id = ?').get(esito.daPagare.id);
    const r = p ? await stripeCreaPagamento(cfg, p) : { ok: false, errore: 'prenotazione sparita' };
    if (r.ok) {
      db.prepare('UPDATE prenotazioni SET pagamento_id = ? WHERE id = ?').run(r.id, p.id);
      esito.risposte.push(String(esito.daPagare.testo).split('{link}').join(r.link));
    } else {
      // Anche il fallimento va mostrato: è quello che vedrebbe il cliente, e
      // provare il bot serve proprio a scoprire che Stripe non risponde PRIMA
      // che succeda di sabato sera.
      esito.risposte.push(bot.riempi(cfg.bot_t_pagamento_lento, {
        nome: (p && p.nome) || '', data: p ? bot.dataItaliana(p.data) : '', ora: (p && p.ora) || '',
        persone: (p && p.persone) || '',
      }));
      esito.risposte.push(`⚠️ (solo nel simulatore) Stripe non ha risposto: ${r.errore}`);
    }
    if (p) esito.simulaEmail = await mandaEmailPrenotazione(p, r.ok ? r.link : '');
  } else if (esito.prenotazione) {
    esito.simulaEmail = await mandaEmailPrenotazione(esito.prenotazione);
  }
  // ⚠️ L'email parte DAVVERO, all'indirizzo scritto nella prova: è l'unico modo
  // di sapere se la posta è configurata bene PRIMA che ci sia un cliente vero
  // dall'altra parte. E l'esito si dice: un'email che non parte, nel
  // simulatore, non lascia nessuna traccia visibile — sembrerebbe tutto a
  // posto.
  if (esito.simulaEmail) {
    esito.risposte.push(esito.simulaEmail.ok
      ? `📧 (solo nel simulatore) email di riepilogo mandata a ${esito.simulaEmail.a}`
      : `📧 (solo nel simulatore) email di riepilogo NON mandata: ${esito.simulaEmail.motivo}`);
  }
  res.json({
    risposte: esito.risposte,
    daPagare: !!esito.daPagare,
    passaAUmano: esito.passaAUmano,
    prenotazione: esito.prenotazione,
    annullata: esito.annullata,
    passo: bot.statoDi(db, telefono).passo,
  });
});

app.post('/api/bot/simula/azzera', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  const telefono = '000' + String((req.body && req.body.sessione) || '1');
  bot.azzeraStato(db, telefono);
  db.prepare('UPDATE bot_conversazioni SET muto_fino = NULL, risposte_oggi = 0 WHERE telefono = ?').run(telefono);
  db.prepare("DELETE FROM prenotazioni WHERE telefono = ? ").run(telefono);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`iStudio in ascolto su http://localhost:${PORT}`);
});

// ---------- La pagina della sala, su una porta sua ----------
// Il responsabile di sala deve vedere le prenotazioni e poterle gestire, e
// NIENT'ALTRO: non la rubrica, non le campagne, non le impostazioni, non il
// seriale. La strada facile sarebbe una pagina con meno pulsanti sulla stessa
// porta — ma i pulsanti nascosti non sono una protezione: basta scrivere
// /api/contacts nella barra degli indirizzi per avere l'elenco dei clienti.
//
// Quindi è un server SUO, su una porta sua, dove sono montate soltanto le rotte
// che servono. Quello che non è servito non è raggiungibile, qualunque cosa si
// scriva nella barra.
const PORT_SALA = Number(process.env.ISTUDIO_PORT_SALA || 0) || PORT + 1;

const paginaAccessoSala = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Sala — Accesso</title>\n<link rel="icon" href="/comune/icona.svg" type="image/svg+xml">
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#fff;border:1px solid #e0e4e8;border-radius:14px;padding:34px;width:320px;text-align:center}
h1{font-size:1.3rem;color:#128c7e;margin:0 0 6px}p{color:#667781;font-size:.9rem;margin:0 0 18px}
input{width:100%;padding:12px;border:1px solid #e0e4e8;border-radius:9px;font-size:1rem;box-sizing:border-box;margin-bottom:12px}
button{width:100%;padding:12px;background:#128c7e;color:#fff;border:none;border-radius:9px;font-size:1rem;font-weight:600;cursor:pointer}
.loc{color:#111b21;font-weight:600;font-size:1rem;margin:0 0 4px}
.err{color:#ea4335;font-size:.85rem;min-height:1.2em;margin-top:10px}</style></head>
<body><form class="box" id="f"><h1>Prenotazioni</h1>__LOCALE__<p>Password della sala</p>
<input type="password" id="p" autofocus><button type="submit">Entra</button><div class="err" id="e"></div></form>
<script>document.getElementById('f').addEventListener('submit',async(ev)=>{ev.preventDefault();
const r=await fetch('/api/sala/accesso',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('p').value})});
if(r.ok){location.reload();return;}let d={};try{d=await r.json();}catch{}document.getElementById('e').textContent=d.error||'Password errata';});<\/script></body></html>`;

function salaAccesa() {
  return bot.boolDi(bot.leggi(db, 'bot_sala_attiva'))
    && String(bot.leggi(db, 'bot_sala_password') || '').length > 0;
}

function salaAutenticato(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)istudio_sala=([a-f0-9]+)/);
  if (!m) return false;
  const scadenza = sessioniSala.get(m[1]);
  if (!scadenza || scadenza < Date.now()) { scordaSessione('sala', m[1]); return false; }
  return true;
}

const sala = express();
sala.use(express.json({ limit: '1mb' }));

// L'interruttore vale per TUTTO, compreso l'accesso: spenta, questa porta non
// risponde niente. È l'unico modo per cui «spenta» vuol dire davvero spenta.
sala.use((req, res, next) => {
  if (!salaAccesa()) return res.status(503).send('La pagina della sala non è attiva.');
  next();
});

// ⚠️ Lo stesso cancello dell'abbonamento della piattaforma. Senza, questa porta
// sarebbe il modo di continuare a usare iStudio con il seriale scaduto: basta
// aprire l'altro indirizzo.
sala.use((req, res, next) => {
  if (modalitaAbbonamento && !abbonamento.valido) {
    return res.status(403).send('Abbonamento non attivo: apri iStudio sulla porta principale.');
  }
  if (!botDisponibile() || !botPermesso()) {
    return res.status(403).send('Le prenotazioni non sono incluse in questo abbonamento.');
  }
  next();
});

// Come sulla piattaforma: il logo si serve prima della password, o la pagina
// d'accesso resta senza icona.
sala.get('/comune/icona.svg', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'comune', 'icona.svg')));

// ⚠️ La pagina della sala sta su una porta raggiungibile dalla rete del
// locale — e qualcuno la aprirà anche da fuori. Senza un freno, una password
// da otto caratteri si prova tutta in poche ore con uno script: qui non c'è
// nessun limite ai tentativi, e il confronto è pure velocissimo.
//
// Il freno è volutamente semplice: dopo cinque sbagli da uno stesso indirizzo
// si aspetta un minuto, poi due, poi quattro, fino a un quarto d'ora. Chi ha
// dimenticato la password aspetta un minuto una volta; chi le prova a milioni
// si ferma. Il conto sta in memoria: al riavvio riparte, e va benissimo.
const tentativiSala = new Map();
const SALA_TENTATIVI_LIBERI = 5;

function attesaSala(chi) {
  const r = tentativiSala.get(chi);
  if (!r || r.sbagli < SALA_TENTATIVI_LIBERI) return 0;
  const minuti = Math.min(2 ** (r.sbagli - SALA_TENTATIVI_LIBERI), 15);
  const finoA = r.ultimo + minuti * 60 * 1000;
  return Math.max(0, finoA - Date.now());
}

sala.post('/api/sala/accesso', (req, res) => {
  const chi = String(req.ip || req.socket.remoteAddress || 'ignoto');
  const resta = attesaSala(chi);
  if (resta > 0) {
    const secondi = Math.ceil(resta / 1000);
    return res.status(429).json({
      error: secondi > 60
        ? `Troppi tentativi: riprova fra ${Math.ceil(secondi / 60)} minuti.`
        : `Troppi tentativi: riprova fra ${secondi} secondi.`,
    });
  }
  const attesa = Buffer.from(String(bot.leggi(db, 'bot_sala_password') || '').trim());
  const tentativo = Buffer.from(String((req.body && req.body.password) || '').trim());
  const valida = tentativo.length === attesa.length && crypto.timingSafeEqual(tentativo, attesa);
  if (!valida) {
    const r = tentativiSala.get(chi) || { sbagli: 0, ultimo: 0 };
    r.sbagli += 1;
    r.ultimo = Date.now();
    tentativiSala.set(chi, r);
    if (r.sbagli === SALA_TENTATIVI_LIBERI) {
      annota('sala', `cinque password sbagliate da ${chi}: da ora rallento i tentativi`);
    }
    return res.status(401).json({ error: 'Password errata' });
  }
  tentativiSala.delete(chi);   // entrata buona: il conto riparte da zero
  const token = crypto.randomBytes(32).toString('hex');
  // Trenta giorni: il tablet della sala non deve chiedere la password ogni
  // sera, o dopo una settimana qualcuno la scrive su un foglietto al bancone.
  ricordaSessione('sala', token, Date.now() + SESSION_TTL);
  res.setHeader('Set-Cookie',
    `istudio_sala=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}`);
  res.json({ ok: true });
});

sala.use((req, res, next) => {
  if (salaAutenticato(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Accesso non autorizzato' });
  // Il nome del locale sulla pagina d'accesso: chi apre il tablet — o
  // l'amministratore con tre copie sullo stesso computer — deve sapere di
  // quale ristorante è la sala che sta per aprire. Composto qui e non
  // all'avvio, perché il nome si può cambiare a programma acceso; e passato
  // dal filtro dell'HTML, perché è un testo scritto dal locale.
  const locale = String(bot.leggi(db, 'bot_locale') || '').trim()
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  res.send(paginaAccessoSala.replace('__LOCALE__', locale ? `<p class="loc">${locale}</p>` : ''));
});

// Il planning è lo stesso file che usa la piattaforma: una copia sola.
for (const via of ['/', '/index.html']) {
  sala.get(via, serviPagina(path.join(__dirname, 'public-sala', 'index.html')));
}
sala.use('/comune', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  next();
});
sala.use('/comune', express.static(path.join(__dirname, 'public', 'comune')));
sala.use(express.static(path.join(__dirname, 'public-sala')));

// Chi sta guardando deve sapere di quale locale sono queste prenotazioni: le
// copie di prova e quella vera sono identiche a vedersi.
sala.get('/api/sala/stato', (req, res) => {
  // ⚠️ Anche la sala sa se è uscita una versione nuova. Non perché possa
  // installarla — da lì non si comanda niente — ma perché è l'unica pagina che
  // qualcuno guarda tutte le sere: se un mini-PC resta indietro, è lì che si
  // vede. Il «quando» lo decide il server, che sa su che macchina gira: alle 5
  // sul mini-PC, al prossimo avvio sul Mac.
  res.json({ locale: bot.leggi(db, 'bot_locale') || '', versione: versioneInstallata(),
             tema: bot.leggi(db, 'bot_sala_tema') || 'chiaro',
             // Anche qui, per il primo disegno della spia: la rotta dei quattro
             // secondi lo rinfresca dopo, ma all'apertura non è ancora passata.
             whatsapp: state.status,
             aggiornamento: aggiornamentoDisponibile() });
});

// ⚠️ Qui sotto ci sono SOLO le prenotazioni, e sono ESATTAMENTE gli stessi
// gestori della piattaforma — non una copia, non un ponte fra i due server:
// una copia divergerebbe, e un ponte rifarebbe passare la richiesta da tutti i
// controlli dell'altra porta, password compresa.
// Ogni riga aggiunta a questo elenco è una cosa in più che il tablet della sala
// può fare: si aggiunge una per volta e di proposito, mai «tanto è comodo».
// ⚠️ UNA PORTA IN PIÙ, e aggiunta di proposito. Il QR per riattaccare
// WhatsApp. Il ragionamento è che il guasto succede DI SERA, quando in ufficio
// non c'è nessuno: la linea cade, il bot smette di rispondere e la serata passa
// così. Chi è in sala il telefono del locale ce l'ha in mano — è l'unica
// persona che può rimediare, ed è l'unica che finora non poteva.
//
// ⚠️ Quel codice è una CHIAVE: chi lo scansiona collega il proprio telefono
// come bot del locale. Quindi tre paletti, non uno:
//   • sta dietro la password della sala, come tutto il resto di questa porta;
//   • a WhatsApp COLLEGATO non esce: quando la linea va, quel codice non serve
//     a nessuno e resta solo un modo di sbagliare;
//   • ogni volta che qualcuno lo chiede resta scritto nel registro, con l'ora.
//     Un accoppiamento non deve mai poter succedere senza che ne resti traccia.
sala.get('/api/sala/qr', (req, res) => {
  if (!botDisponibile()) return res.status(503).json({ error: 'Bot non disponibile' });
  if (state.status === 'connesso') {
    return res.json({ collegato: true, qr: null, stato: state.status });
  }
  if (state.qr) annota('sala', 'dalla sala hanno chiesto il QR per riattaccare WhatsApp');
  // Il codice viaggia con la stessa risposta: la finestra lo sta già chiedendo
  // a giro per via del QR che scade, e così si rinfresca da sé anche quello —
  // che WhatsApp rigenera ogni tre minuti esattamente come il quadrato.
  res.json({ collegato: false, qr: state.qr, stato: state.status, ...codiceDiCollegamento() });
});

// ⚠️ La seconda strada per riattaccare: il codice al posto del QR, per un
// telefono con la fotocamera rotta. Sta qui per la stessa ragione del QR — il
// guasto succede di sera, e chi è in sala è l'unico che può rimediare — e
// vale ESATTAMENTE quanto quello: chi ottiene il codice collega il proprio
// telefono come bot del locale. Stessi paletti: password della sala, niente a
// WhatsApp già collegato, e ogni richiesta scritta nel registro col numero.
sala.post('/api/sala/codice', async (req, res) => {
  const r = await chiediCodiceCollegamento(req.body && req.body.numero, 'sala');
  res.status(r.ok ? 200 : 400).json(r);
});
sala.post('/api/sala/codice/annulla', async (req, res) => {
  res.json(await annullaCodiceCollegamento());
});

sala.get('/api/bot/settimana', rottaSettimana);
// La ricerca in rubrica c'è anche in sala: chi prende una prenotazione al
// telefono ha davanti un cliente che spesso è già in archivio, e riscriverne il
// numero a mano vuol dire sbagliarlo. È lo STESSO gestore della piattaforma,
// quindi valgono gli stessi limiti — sotto le due lettere non risponde, e non
// torna mai più di otto risultati: non è un modo di leggere l'elenco dei
// clienti una lettera per volta. Quello che resta fuori dalla sala è tutto il
// resto della rubrica: non si aggiunge, non si modifica, non si scorre.
sala.get('/api/bot/prenotazioni/versione', rottaVersionePrenotazioni);
// La storia di chi arriva stasera: si apre toccando un nome, e da lì soltanto.
sala.get('/api/bot/cliente', rottaSchedaCliente);
sala.get('/api/bot/prenotazioni', rottaServizio);
sala.delete('/api/bot/attese/:id', rottaTogliAttesa);
sala.post('/api/bot/prenotazioni', rottaNuovaPrenotazione);
sala.patch('/api/bot/prenotazioni/:id', rottaModificaPrenotazione);

sala.listen(PORT_SALA, () => {
  console.log(`Pagina della sala in ascolto su http://localhost:${PORT_SALA}`);
});

// ---------- Chiusura pulita ----------
// «Ferma iStudio» manda un SIGTERM. Senza questo pezzo il processo moriva subito e il
// browser interno restava acceso e orfano, bloccando il riavvio successivo. Chiudendolo
// qui, fermare e riavviare torna a funzionare come l'utente si aspetta.
let chiusuraInCorso = false;
for (const segnale of ['SIGTERM', 'SIGINT']) {
  process.on(segnale, async () => {
    if (chiusuraInCorso) return;
    chiusuraInCorso = true;
    console.log(`Chiusura di iStudio (${segnale}): chiudo il browser interno…`);
    try { await client.destroy(); } catch { /* se è già morto va bene lo stesso */ }
    chiudiBrowserOrfani(); // rete di sicurezza, come nel ripristino
    console.log('Chiusura completata.');
    process.exit(0);
  });
}
