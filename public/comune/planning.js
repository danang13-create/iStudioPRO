// Il planning della settimana: sette riquadri coi numeri già fatti, al posto di
// un elenco che si legge riga per riga. Prima qui c'era quell'elenco, e per
// capire «com'è messa la settimana» bisognava sommare a mente.
//
// ⚠️ Questo file lo caricano DUE pagine — la piattaforma e la pagina della sala.
// Due copie dello stesso codice divergono: in questo progetto è già successo,
// con due funzioni identiche rimaste in giro dopo una modifica. Qui la copia è
// una sola, e chi la corregge la corregge per tutti.
window.Planning = (function () {
  let dal = null;                     // null = i sette giorni da oggi
  const GG = ['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'];

  // Il testo scritto dall'utente finisce dentro l'HTML: se contiene un < o una
  // virgoletta si porta via il resto della riga, e con esso i pulsanti.
  function sicuro(valore) {
    return String(valore === null || valore === undefined ? '' : valore)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function oggiLocale() { return new Date().toLocaleDateString('sv-SE'); }

  // Il lunedì della settimana che contiene questa data. Serve dove il planning
  // deve essere una SETTIMANA DI CALENDARIO e non sette giorni che scorrono:
  // in sala si ragiona per settimane — «giovedì com'è messo?» — e una griglia
  // che ogni giorno parte da un giorno diverso costringe a rileggere le
  // intestazioni ogni volta invece di riconoscerle a colpo d'occhio.
  function lunediDi(iso) {
    const [a, m, g] = iso.split('-').map(Number);
    const d = new Date(a, m - 1, g);
    // getDay(): 0 domenica … 6 sabato. Domenica sta in FONDO alla settimana,
    // non in cima: per l'Italia la domenica è il settimo giorno, e la formula
    // deve riportare indietro di sei, non lasciarla lì come primo giorno.
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.toLocaleDateString('sv-SE');
  }

  async function carica(opzioni) {
    const griglia = document.querySelector(opzioni.griglia);
    if (!griglia) return;
    // Con `settimanaIntera` la partenza si chiede sempre, e cade sempre di
    // lunedì: senza dirlo, il server partirebbe da oggi.
    if (opzioni.settimanaIntera) dal = lunediDi(dal || oggiLocale());
    const url = '/api/bot/settimana' + (dal ? '?dal=' + dal : '');
    let d;
    try { d = await (await fetch(url)).json(); } catch { return; }
    if (d.error) return;
    dal = d.dal;

    const periodo = opzioni.periodo && document.querySelector(opzioni.periodo);
    if (periodo) {
      const primo = d.giorni[0], ultimo = d.giorni[d.giorni.length - 1];
      periodo.textContent = `${primo.etichetta} — ${ultimo.etichetta}`;
    }

    griglia.innerHTML = d.giorni.map((g) => {
      const gg = +g.data.split('-')[2];
      // Mezzogiorno, non mezzanotte: costruire la data a mezzanotte e leggerne
      // il giorno espone allo scarto di fuso, che sposta il giorno di uno.
      const settimanale = new Date(g.data + 'T12:00:00').getDay();
      const quota = g.capienza ? Math.min(g.coperti / g.capienza, 1) : 0;
      const pieno = !!g.capienza && g.coperti >= g.capienza;
      const quasi = !pieno && quota >= 0.8;
      // ⚠️ Lo stato NON è affidato al colore: il numero c'è sempre, e quando il
      // giorno è pieno lo dice anche a parole. Il colore rinforza, non informa —
      // e con questo verde/ambra/rosso il controllo dei contrasti lo impone.
      // ⚠️ Un giorno chiuso CON gente dentro è il caso che spariva. Succede
      // sempre allo stesso modo: qualcuno prenota, e solo dopo il locale segna
      // quel giorno come chiusura (ferie, un lunedì aggiunto). Le prenotazioni
      // restano in archivio, ma qui si leggeva solo «chiuso» — e nessuno apre
      // il dettaglio di un giorno chiuso. Quella sera arriva gente e il locale
      // è a saracinesca abbassata.
      const chiusoConGente = g.chiuso && g.prenotazioni > 0;
      // Un giorno segnato «sold out» NON è chiuso: i coperti dentro si devono
      // vedere tutti, ed è normale che siano tanti. Letto come chiusura, il
      // giorno più pieno dell'anno diventava quello che si vedeva meno.
      const nota = g.soldOut ? `🚫 sold out${g.prenotazioni ? ` · ${g.prenotazioni} pren.` : ''}`
        : chiusoConGente ? `⚠️ chiuso, ma ${g.prenotazioni} pren.`
        : g.chiuso ? 'chiuso'
        : !g.prenotazioni ? 'libero'
        : `${g.prenotazioni} pren.${pieno ? ' · pieno' : quasi ? ' · quasi pieno' : ''}`;
      const classi = ['giorno', g.oggi ? 'oggi' : '', g.chiuso ? 'chiuso' : '',
        g.soldOut ? 'sold-out' : '',
        chiusoConGente ? 'chiuso-con-gente' : '', g.passato ? 'passato' : '']
        .filter(Boolean).join(' ');
      return `
        <button class="${classi}" data-giorno="${g.data}"
                title="${sicuro(g.etichetta)}${g.chiuso
                  ? (chiusoConGente ? ` — chiuso, ma ci sono ${g.prenotazioni} prenotazioni per ${g.coperti} coperti` : ' — chiuso')
                  : ` — ${g.coperti} coperti su ${g.capienza}, ${g.prenotazioni} prenotazioni`}">
          <span class="gg">${GG[settimanale]} ${gg}${g.oggi ? ' · oggi' : ''}</span>
          <span class="num">${g.chiuso && !chiusoConGente ? '—' : g.coperti}</span>
          ${g.chiuso ? '' : `<span class="meter"><i class="${pieno ? 'pieno' : quasi ? 'quasi' : ''}" style="width:${Math.round(quota * 100)}%"></i></span>`}
          <span class="sotto capienza">${g.chiuso ? 'chiuso' : `su ${g.capienza} coperti`}</span>
          <span class="sotto">${nota}</span>
        </button>`;
    }).join('');

    // Cliccando una giornata si apre il suo dettaglio: dove, lo decide la
    // pagina che sta usando il planning.
    griglia.querySelectorAll('[data-giorno]').forEach((b) => {
      b.addEventListener('click', () => opzioni.alGiorno(b.dataset.giorno));
    });
    centraOggi(griglia);
    ultimaGriglia = griglia;
  }
  // Girando il telefono la striscia cambia larghezza: «oggi» si ricentra.
  // (Le prove leggono questo file con una finestra finta senza eventi: si
  // controlla che ci sia, invece di dare per scontato il browser.)
  let ultimaGriglia = null;
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', () => { if (ultimaGriglia) centraOggi(ultimaGriglia); });
  }
  // Sul telefono la settimana è una striscia che scorre di lato, e «oggi» è il
  // quinto giorno: senza questo, all'apertura si vedevano lunedì e martedì, e
  // la casella evidenziata stava fuori dallo schermo. Solo scrollLeft, mai
  // scrollIntoView: quello sposta anche la pagina in verticale, e in sala non
  // deve muoversi niente che non si sia toccato. Su uno schermo largo, dove
  // la griglia non scorre, non fa niente.
  function centraOggi(griglia) {
    const oggi = griglia.querySelector('.giorno.oggi');
    if (!oggi || griglia.scrollWidth <= griglia.clientWidth) return;
    griglia.scrollLeft = oggi.offsetLeft - griglia.offsetLeft - (griglia.clientWidth - oggi.offsetWidth) / 2;
  }

  function sposta(giorni, opzioni) {
    const partenza = dal || (opzioni.settimanaIntera ? lunediDi(oggiLocale()) : oggiLocale());
    const [a, m, g] = partenza.split('-').map(Number);
    dal = new Date(a, m - 1, g + giorni).toLocaleDateString('sv-SE');
    return carica(opzioni);
  }

  // Torna al punto di partenza: i sette giorni da oggi, oppure — dove il
  // planning è una settimana di calendario — la settimana in cui siamo.
  function daOggi(opzioni) { dal = null; return carica(opzioni); }

  return { carica, sposta, daOggi, lunediDi };
})();
