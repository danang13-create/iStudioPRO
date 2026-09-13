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
      ultimaCapienza = d.error ? 0 : (d.capienza || 0);
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
    const scelto = turni.find((t) => t.ora === ora);
    if (scelto) return Math.max(Number(scelto.liberi) || 0, 0) + suoi;
    // Nessuna ora scelta (o un'ora fuori turno): il meglio che la giornata offre.
    return turni.reduce((m, t) => Math.max(m, Number(t.liberi) || 0), 0) + suoi;
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
      for (const t of turni) {
        const liberi = typeof t.liberi === 'number'
          ? (t.liberi > 0 ? ` · ${t.liberi} liberi` : ' · pieno') : '';
        voci.push(`<option value="${t.ora}"${t.ora === oraAttuale ? ' selected' : ''}>${t.ora}${liberi}</option>`);
      }
    }
    // L'ora che c'è già ma che non è un turno: si tiene, e si dice che è fuori
    // turno invece di farla sparire.
    if (oraAttuale && !turni.some((t) => t.ora === oraAttuale)) {
      voci.push(`<option value="${oraAttuale}" selected>${oraAttuale} · fuori turno</option>`);
    }
    el.innerHTML = voci.join('');
  }

  // Quando cambia il giorno, i turni possono essere altri (pranzo, chiusure).
  function dimentica() { ultimaData = null; ultimiTurni = []; ultimaCapienza = 0; quando = 0; }

  return { dellaGiornata, riempi, riempiPersone, liberiPer, capienza, dimentica };
})();
