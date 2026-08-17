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

const PORT = process.env.PORT || 3100;
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

// ---------- WhatsApp client ----------
const state = {
  status: 'inizializzazione', // inizializzazione | qr | connesso | disconnesso
  qr: null,
  me: null,
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

client.on('ready', () => {
  state.status = 'connesso';
  state.qr = null;
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

  const [codice, scadenza] = payload.split('|');
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
  return { ok: true, scadenza };
}

const abbonamento = { valido: false, scadenza: null, giorniRimasti: null };

function ricalcolaAbbonamento() {
  if (!modalitaAbbonamento) { abbonamento.valido = true; return; }
  const esito = verificaSeriale(getSetting('abbonamento_seriale'));
  abbonamento.valido = esito.ok;
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
button{width:100%;padding:12px;background:#25d366;color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer;font-family:inherit;margin-top:10px}
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
const sessions = new Map(); // token -> scadenza

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
  if (!expiry || expiry < Date.now()) { sessions.delete(token); return false; }
  return true;
}

const loginPage = `<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>iStudio — Accesso</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f0f2f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.box{background:#fff;border:1px solid #e0e4e8;border-radius:14px;padding:34px;width:320px;text-align:center}
h1{font-size:1.3rem;color:#128c7e;margin:0 0 6px}p{color:#667781;font-size:.9rem;margin:0 0 18px}
input{width:100%;padding:11px;border:1px solid #e0e4e8;border-radius:8px;font-size:1rem;box-sizing:border-box;margin-bottom:12px}
button{width:100%;padding:11px;background:#25d366;color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer}
button:hover{background:#128c7e}.err{color:#ea4335;font-size:.85rem;min-height:1.2em;margin-top:10px}</style></head>
<body><form class="box" id="f"><h1>iStudio</h1><p>Inserisci la password per accedere</p>
<input type="password" id="p" placeholder="Password" autofocus>
<button type="submit">Entra</button><div class="err" id="e"></div></form>
<script>document.getElementById('f').addEventListener('submit',async(ev)=>{ev.preventDefault();
const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('p').value})});
if(r.ok)location.reload();else document.getElementById('e').textContent='Password errata';});</script></body></html>`;

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


app.post('/api/login', (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true });
  const tentativo = Buffer.from(String(req.body.password || ''));
  const attesa = Buffer.from(APP_PASSWORD);
  const valida = tentativo.length === attesa.length && crypto.timingSafeEqual(tentativo, attesa);
  if (!valida) return res.status(401).json({ error: 'Password errata' });
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL);
  res.setHeader('Set-Cookie',
    `istudio_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL / 1000}`);
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (isAuthed(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Accesso non autorizzato' });
  res.send(loginPage);
});

app.use(express.static(path.join(__dirname, 'public')));

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
  res.json({ ...state, authEnabled: Boolean(APP_PASSWORD), abbonamento: abb, edizione,
             versione: versioneInstallata() });
});

// Uscita dalla piattaforma (chiude la sessione di accesso, solo con password attiva)
app.post('/api/app-logout', (req, res) => {
  const token = getSessionToken(req);
  if (token) sessions.delete(token);
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
    .run(nome.trim(), (cognome || '').trim(), (email || '').trim(), telefono.trim(),
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
    nome.trim(), (cognome || '').trim(), (email || '').trim(), telefono.trim(),
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
      insert.run(nome, cognome, email, telefono,
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
  });
});

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

  const info = db
    .prepare("INSERT INTO campaigns (message, subject, channel, total, alias, daily_limit) VALUES (?, ?, 'email', ?, ?, ?)")
    .run(message, subject, contacts.length, (alias || '').trim() || null, leggiTetto(dailyLimit));
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
  res.json({ attuale, consigliato: RITMO_DEFAULT, disattivato: pauseDisattivate() });
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
    const attuale = {};
    for (const k of RITMO_CAMPI) attuale[k] = ritmoNum(k);
    return res.json({ ok: true, attuale, disattivato: pauseDisattivate() });
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
  const attuale = {};
  for (const k of RITMO_CAMPI) attuale[k] = ritmoNum(k);
  res.json({ ok: true, attuale, disattivato: pauseDisattivate() });
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

app.listen(PORT, () => {
  console.log(`iStudio in ascolto su http://localhost:${PORT}`);
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
