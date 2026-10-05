// Gli orari di una giornata, in una tendina. Il campo libero lasciava scrivere
// qualunque cosa — «2:00» invece di «20:00», o un turno che il locale non fa —
// e l'errore non si vedeva fino alla sera, quando il cliente arriva e il tavolo
// non c'è.
//
// Nella tendina ci sono SOLO i turni impostati nella piattaforma: niente
// scorciatoie, niente «altro orario». Un orario fuori turno si può ancora
// avere — una prenotazione vecchia, o gli orari cambiati dopo — e in quel caso
// resta scritto, marcato «fuori turno»: toglierlo vorrebbe dire cambiare l'ora
// di una prenotazione in silenzio, solo per aver aperto una finestra.
//
// ⚠️ Questo file lo caricano DUE pagine: la piattaforma e la sala. Una copia sola.
window.Turni = (function () {
  // L'ultima giornata caricata, per non richiedere due volte la stessa cosa
  // mentre si compila un modulo.
  let ultimaData = null;
  let ultimiTurni = [];
  let ultimaCapienza = 0;
  // Il locale ha elencato i suoi tavoli? Allora «liberi» vuol dire un'altra
  // cosa: il gruppo più grande che si può ancora sedere, non le sedie vuote.
  let conTavoli = false;
  // ⚠️ La memoria dura pochi secondi, non tutta la giornata: serve solo a non
  // chiedere due volte la stessa cosa mentre si compila UN modulo. Tenendola
  // più a lungo, la tendina finisce per dire «3 liberi» su un posto che nel
  // frattempo si è liberato — un numero vecchio che sembra vero.
  let quando = 0;
  const DURA = 5000;

  async function dellaGiornata(data) {
    if (!data) return [];
    if (data === ultimaData && Date.now() - quando < DURA) return ultimiTurni;
    try {
      const d = await (await fetch('/api/bot/prenotazioni?data=' + encodeURIComponent(data))).json();
      ultimiTurni = d.error ? [] : (d.turni || []);
      // Con i tavoli il tetto della tendina è il tavolo più grande: più di
      // così, in un tavolo solo, non ci si siede.
      conTavoli = !d.error && Array.isArray(d.tavoli) && d.tavoli.length > 0;
      ultimaCapienza = d.error ? 0 : (conTavoli ? (d.gruppoMassimo || 0) : (d.capienza || 0));
      ultimaData = data;
      quando = Date.now();
    } catch { ultimiTurni = []; }
    return ultimiTurni;
  }

  // I coperti di un turno, come li ha impostati il locale. Serve a chi deve
  // proporre «per quante persone»: più di così non ce ne stanno.
  async function capienza(data) {
    await dellaGiornata(data);
    return ultimaCapienza;
  }

  // Quanti posti restano DAVVERO, per il turno scelto.
  //
  // ⚠️ Prima la tendina delle persone andava sempre da 1 ai coperti del turno,
  // anche quando su quell'ora c'erano già delle prenotazioni: il 1° settembre
  // con due posti già presi proponeva lo stesso «6», e chi segnava un tavolo da
  // sei scopriva solo al salvataggio che non ci stava. Il numero libero c'era
  // già — la tendina degli ORARI lo scrive accanto a ogni turno — e non veniva
  // usato dove serviva davvero.
  //
  // Senza un'ora ancora scelta si prende il turno più libero della giornata:
  // proporre meno vorrebbe dire nascondere una scelta che a un'altra ora è
  // possibile.
  //
  // `giaSue` sono i posti della prenotazione che si sta MODIFICANDO: quelli non
  // contano contro di lei. Senza, aprendo un tavolo da quattro su un turno ormai
  // pieno la tendina resterebbe vuota — e sparirebbe anche il numero che c'è
  // già, cambiando una prenotazione solo per aver aperto una finestra.
  async function liberiPer(data, ora, giaSue) {
    const turni = await dellaGiornata(data);
    if (!turni.length) return 0;
    const suoi = Number(giaSue) || 0;
    // ⚠️ Con i tavoli i posti suoi NON si sommano: chi ha un tavolo da quattro
    // e un tavolo da sei libero accanto non può diventare un gruppo da dieci.
    // Può restare com'è, o passare al tavolo libero più grande. (Se il suo
    // tavolo è più grande di quelli liberi potrebbe crescere un po' anche lì:
    // la tendina non lo sa, il server sì, e lo accetta.)
    const conIMiei = (liberi) => (conTavoli ? Math.max(liberi, suoi) : liberi + suoi);
    const scelto = turni.find((t) => t.ora === ora);
    if (scelto) return conIMiei(Math.max(Number(scelto.liberi) || 0, 0));
    // Nessuna ora scelta (o un'ora fuori turno): il meglio che la giornata offre.
    return conIMiei(turni.reduce((m, t) => Math.max(m, Number(t.liberi) || 0), 0));
  }

  // La tendina delle persone: SOLO i numeri che ci stanno davvero su quel turno.
  //
  // ⚠️ Il campo libero lasciava scrivere qualunque cosa, e in sala si scrive di
  // fretta: «12» invece di «2» è un tavolo che non esiste, scoperto la sera.
  //
  // ⚠️ Prima le voci oltre i posti liberi restavano, marcate «oltre i posti
  // liberi». Sono state tolte: una voce che non si può usare è rumore, e in una
  // tendina lunga il segnino si legge dopo averla già aperta. Chi deve sforare
  // ha una strada più onesta — cambiare l'ora, o togliere posti a un'altra
  // prenotazione — invece di una scelta segnata di rosso che il salvataggio
  // rimette in discussione. Il controllo sul server resta comunque: la tendina
  // è una comodità, non è lei a difendere i coperti.
  //
  // Il numero che c'è GIÀ resta sempre, anche se supera la capienza di oggi —
  // una prenotazione vecchia da otto quando adesso i coperti sono sei è un
  // fatto, e aprire una finestra non deve cambiarlo in silenzio.
  async function riempiPersone(select, data, quanteAdesso, ora) {
    const el = typeof select === 'string' ? document.querySelector(select) : select;
    if (!el) return;
    const massimo = await capienza(data);
    const attuale = Number(quanteAdesso) || 0;
    // ⚠️ Senza coperti impostati la tendina restava con la sola voce vuota: un
    // campo che c'è ma non si può usare, e nessuna spiegazione. Chi lo guarda
    // pensa che sia rotto il modulo, mentre il rimedio è in un'altra scheda.
    if (massimo < 1 && attuale < 1) {
      el.innerHTML = '<option value="">— manca «coperti per turno» nelle impostazioni —</option>';
      return;
    }
    const liberi = Math.min(await liberiPer(data, ora, attuale), massimo);
    // ⚠️ Turno esaurito: la tendina lo DICE. Restare con la sola voce vuota
    // sarebbe la stessa cosa di un campo rotto, e chi la guarda non saprebbe se
    // il turno è pieno o se la pagina non ha caricato.
    if (liberi < 1 && attuale < 1) {
      el.innerHTML = '<option value="">— nessun posto libero a quest\'ora —</option>';
      return;
    }
    const voci = ['<option value="">Quante persone…</option>'];
    for (let n = 1; n <= liberi; n++) {
      voci.push(`<option value="${n}"${n === attuale ? ' selected' : ''}>${n}</option>`);
    }
    // La prenotazione che si sta modificando resta scegliibile anche quando è
    // più grande dei coperti di oggi: è un dato che esiste, non una proposta.
    if (attuale > liberi) {
      voci.push(`<option value="${attuale}" selected>${attuale} · oltre i coperti</option>`);
    }
    el.innerHTML = voci.join('');
  }

  // Le voci della tendina degli orari, divise per servizio.
  //
  // ⚠️ Chiesto dal titolare: con pranzo e cena la tendina era una lista unica
  // di nove, dieci orari, e il turno non si leggeva. Adesso un gruppo per
  // servizio («Pranzo», «Cena»), e coi turni fissi ogni voce dice quale turno
  // è. Il VALORE resta l'orario: è quello che si salva.
  function opzioniOrari(turni, oraAttuale) {
    const NOMI = { pranzo: 'Pranzo', cena: 'Cena' };
    const voce = (t) => {
      // Con i tavoli si contano i TAVOLI liberi: «12 liberi» farebbe
      // pensare a dodici sedie per chiunque, mentre sono magari sei tavoli
      // da due.
      let liberi = '';
      if (typeof t.tavoliLiberi === 'number') {
        liberi = t.tavoliLiberi > 0
          ? ` · ${t.tavoliLiberi === 1 ? '1 tavolo libero' : `${t.tavoliLiberi} tavoli liberi`}`
          : ' · pieno';
      } else if (typeof t.liberi === 'number') {
        liberi = t.liberi > 0 ? ` · ${t.liberi} liberi` : ' · pieno';
      }
      const turno = t.turno ? `${t.turno}° turno · ` : '';
      return `<option value="${t.ora}"${t.ora === oraAttuale ? ' selected' : ''}>${turno}${t.ora}${liberi}</option>`;
    };
    const servizi = [...new Set(turni.map((t) => t.servizio).filter(Boolean))];
    if (!servizi.length) return turni.map(voce).join('');
    return servizi.map((s) => `<optgroup label="${NOMI[s] || s}">`
      + turni.filter((t) => t.servizio === s).map(voce).join('') + '</optgroup>').join('')
      // Un orario senza servizio (non dovrebbe esserci) non sparisce.
      + turni.filter((t) => !t.servizio).map(voce).join('');
  }

  // Riempie la tendina con i turni del giorno.
  // `oraAttuale` è quella della prenotazione che si sta modificando: se non è
  // fra i turni — perché il locale ha cambiato orari dopo, o perché era stata
  // scritta a mano — deve restare comunque, altrimenti aprire il pannello le
  // cambierebbe l'ora in silenzio. Un dato che si modifica da solo aprendo una
  // finestra è il modo più rapido di perdere fiducia in tutta la pagina.
  async function riempi(select, data, oraAttuale) {
    const el = typeof select === 'string' ? document.querySelector(select) : select;
    if (!el) return;
    const turni = await dellaGiornata(data);
    const voci = [];
    if (!turni.length) {
      voci.push('<option value="">— il locale è chiuso in questo giorno —</option>');
    } else {
      voci.push('<option value="">Scegli l\'orario…</option>');
      voci.push(opzioniOrari(turni, oraAttuale));
    }
    // L'ora che c'è già ma che non è un turno: si tiene, e si dice che è fuori
    // turno invece di farla sparire.
    if (oraAttuale && !turni.some((t) => t.ora === oraAttuale)) {
      voci.push(`<option value="${oraAttuale}" selected>${oraAttuale} · fuori turno</option>`);
    }
    el.innerHTML = voci.join('');
  }

  // ── Com'è messa la giornata: una scheda per turno ──
  //
  // ⚠️ Chiesto dal titolare: il riepilogo stava schiacciato nell'intestazione,
  // accanto alla data, come tre righe di testo grigio — «Cena · 1° turno
  // 20:00–22:00: 0/10 tavoli · 0 coperti». Adesso un gruppo per servizio e una
  // scheda per turno: la fascia, i tavoli occupati in grande con la barra, i
  // coperti sotto. La barra è quella del planning (stesse classi, stessi
  // colori verificati); e lo stato non sta nel solo colore: «pieno» e «quasi
  // pieno» sono SCRITTI.
  //
  // Lo usano la piattaforma e la sala: una copia sola.
  const sicuro = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const NOMI_SERVIZI = { pranzo: 'Pranzo', cena: 'Cena' };
  function schedaTurno(r) {
    const quota = r.totale ? Math.min(r.occupati / r.totale, 1) : 0;
    const stato = r.pieno ? 'pieno' : quota >= 0.8 ? 'quasi' : '';
    const titolo = r.tipo === 'turno' ? `${r.turno}° turno`
      : r.tipo === 'servizio' ? 'Tutto il servizio'
      : r.tipo === 'chiuso' ? '⚠️ Chiuso' : 'Orario';
    const coperti = `${r.coperti} ${r.coperti === 1 ? 'coperto' : 'coperti'}`;
    // Coi tavoli il numero grande sono i tavoli, e i coperti stanno sotto: alla
    // cucina servono. Senza tavoli il numero grande sono già i coperti.
    const numero = r.tipo === 'chiuso'
      ? `<b>${r.coperti}</b> ${r.coperti === 1 ? 'coperto prenotato' : 'coperti prenotati'}`
      : `<b>${r.occupati}</b><span class="tg-di">/${r.totale} ${r.unita}</span>`;
    // Quante prenotazioni di questo turno aspettano ancora il numero del tavolo.
    const daAssegnare = r.senzaTavolo > 0
      ? `<div class="tg-da-assegnare">⚠️ ${r.senzaTavolo} senza tavolo</div>` : '';
    const sotto = [
      r.tipo === 'chiuso' ? 'il servizio è chiuso' : (r.unita === 'tavoli' ? coperti : ''),
      r.tipo === 'servizio' ? 'al massimo insieme' : '',
      stato === 'pieno' ? 'pieno' : stato === 'quasi' ? 'quasi pieno' : '',
    ].filter(Boolean).join(' · ');
    return `<div class="tg-scheda${stato ? ' ' + stato : ''}${r.tipo === 'chiuso' ? ' chiuso' : ''}"
        title="${sicuro(`${r.etichetta}: ${r.testo}`)}">
      <div class="tg-testa"><span class="tg-titolo">${sicuro(titolo)}</span><span class="tg-ora">${sicuro(r.orario)}</span></div>
      <div class="tg-num">${numero}</div>
      ${r.tipo === 'chiuso' ? '' : `<div class="meter" role="img" aria-label="${r.occupati} su ${r.totale} ${r.unita}"><i class="${stato}" style="width:${Math.round(quota * 100)}%"></i></div>`}
      ${sotto ? `<div class="tg-sotto">${sicuro(sotto)}</div>` : ''}
      ${daAssegnare}
    </div>`;
  }
  // ── L'avviso «mancano i tavoli» ──
  //
  // ⚠️ Deciso dal titolare: il bot conta coi tavoli ma il NUMERO non lo
  // scrive — lo assegna l'operatore prima della serata. Allora la sala deve
  // vedere quante prenotazioni lo aspettano ancora, e arrivarci con un tocco.
  // Il server lo manda solo da oggi in avanti, e solo coi tavoli elencati.
  function avvisoTavoli(d) {
    const a = d && d.daAssegnare;
    if (!a || (!a.senza && !(a.sconosciuti || []).length)) return '';
    const parti = [];
    if (a.senza) parti.push(`<b>${a.senza} ${a.senza === 1 ? 'prenotazione' : 'prenotazioni'} senza tavolo</b>`);
    if ((a.sconosciuti || []).length) {
      const quali = [...new Set(a.sconosciuti.map((x) => x.tavolo))].map(sicuro).join(', ');
      parti.push(`<b>${a.sconosciuti.length} con un tavolo che non c'è</b> (${quali})`);
    }
    return `<div class="tg-assegna" role="status">
      <span>⚠️ ${parti.join(' · ')}: assegnale prima del servizio.</span>
      ${a.senza ? '<button type="button" class="btn btn-secondario btn-piccolo" data-vai-al-tavolo>Vai alla prima</button>' : ''}
    </div>`;
  }
  // Porta al primo campo «tavolo» ancora vuoto, e ci mette il cursore.
  function vaiAlPrimoSenzaTavolo() {
    const campo = [...document.querySelectorAll('.tavolo-campo')].find((i) => !i.value.trim());
    if (!campo) return;
    campo.scrollIntoView({ block: 'center', behavior: 'smooth' });
    campo.focus({ preventScroll: true });
  }

  // `d` è la risposta di /api/bot/prenotazioni: riepilogo, soldOut, chiuso.
  function disegnaRiepilogo(el, d) {
    if (!el) return;
    const righe = (d && d.riepilogo) || [];
    // Il cartello «pieno» sta PRIMA dei numeri: è la cosa che cambia il senso
    // di tutto il resto. Chi legge «3/10» senza sapere che il bot rifiuta
    // crede che i sette tavoli siano ancora vendibili.
    const avviso = avvisoTavoli(d);
    const cartello = (d && d.soldOut ? '<p class="tg-cartello">🚫 Sold out — il bot non prende prenotazioni</p>'
      : d && d.chiuso ? '<p class="tg-cartello">🔒 Chiusura — il bot non prende prenotazioni</p>' : '')
      + avviso;
    // I campi «tavolo» vuoti si fanno notare nell'elenco, quando c'è da
    // assegnarli (vedi planning.css, «tavoli-da-assegnare»).
    if (typeof document !== 'undefined' && document.body) {
      document.body.classList.toggle('tavoli-da-assegnare', !!avviso);
    }
    el.onclick = (e) => { if (e.target.closest('[data-vai-al-tavolo]')) vaiAlPrimoSenzaTavolo(); };
    if (!righe.length) {
      el.innerHTML = cartello || '<p class="tg-vuoto">Chiuso in questo giorno</p>';
      return;
    }
    const servizi = [...new Set(righe.map((r) => r.servizio))];
    el.innerHTML = cartello + '<div class="turni-giorno">' + servizi.map((s) => `
      <section class="tg-servizio" aria-label="${sicuro(NOMI_SERVIZI[s] || s)}">
        <h3>${sicuro(NOMI_SERVIZI[s] || s)}</h3>
        <div class="tg-schede">${righe.filter((r) => r.servizio === s).map(schedaTurno).join('')}</div>
      </section>`).join('') + '</div>';
  }

  // Rifà SOLO il riepilogo — le schede e l'avviso dei tavoli — senza toccare
  // l'elenco: chi assegna i tavoli passa da un campo all'altro, e ridisegnare
  // le righe sotto le sue dita gli porterebbe via quello che sta scrivendo.
  async function aggiornaRiepilogo(el, data) {
    try {
      const d = await (await fetch('/api/bot/prenotazioni?data=' + encodeURIComponent(data))).json();
      if (!d.error) disegnaRiepilogo(el, d);
    } catch { /* la rete che balla: resta quello di prima, e lo dice la barra */ }
  }

  // Quando cambia il giorno, i turni possono essere altri (pranzo, chiusure).
  function dimentica() { ultimaData = null; ultimiTurni = []; ultimaCapienza = 0; conTavoli = false; quando = 0; }

  return { dellaGiornata, riempi, riempiPersone, liberiPer, capienza, dimentica, opzioniOrari, disegnaRiepilogo,
           aggiornaRiepilogo };
})();
