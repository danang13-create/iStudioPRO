// ============================================================
//  Chiaro, scuro, automatico — la regola, per tutte e due le pagine
// ============================================================
//  ⚠️ Va caricato nella TESTA del documento, con un <script src> normale (non
//  «defer», non «async»): deve girare PRIMA che la pagina si disegni. Se il
//  tema si applicasse dopo, ogni apertura sarebbe mezzo secondo di schermo
//  bianco — che è esattamente il fastidio da cui nasce questa funzione.
//
//  ⚠️ E sta in un file SOLO, letto dalla piattaforma e dalla sala. Scritto in
//  due posti, prima o poi uno dice le 19 e l'altro le 20.
// ============================================================
window.Tema = (function () {
  var MODI = ['chiaro', 'scuro', 'auto'];
  var DA = 19, A = 6;          // scuro dalle 19:00 alle 6:00

  // «Automatico» va a OROLOGIO, non a quello che dice il computer.
  // Il tablet di un ristorante spesso non ha mai avuto il tema scuro
  // configurato, o è fisso su chiaro: «segui il sistema» lì non succede mai, e
  // l'impostazione sembrerebbe rotta. E quando il sistema ce l'ha, segue
  // l'alba e il tramonto del posto, non l'orario del locale. Un orario fisso è
  // prevedibile: alle 19 si abbassa, la mattina torna su, sempre, ovunque.
  function orarioScuro(adesso) {
    var h = (adesso || new Date()).getHours();
    return h >= DA || h < A;
  }
  function risolvi(modo, adesso) {
    if (modo === 'scuro') return 'scuro';
    if (modo === 'chiaro') return 'chiaro';
    return orarioScuro(adesso) ? 'scuro' : 'chiaro';
  }
  function pulisci(modo) { return MODI.indexOf(modo) >= 0 ? modo : 'chiaro'; }
  function applica(modo) {
    var m = pulisci(modo);
    document.documentElement.dataset.modo = m;
    document.documentElement.dataset.tema = risolvi(m);
    return m;
  }
  // ⚠️ Ogni pagina ha la SUA chiave: la piattaforma e la sala stanno su due
  // porte diverse, quindi su due archivi diversi del browser — ma se un giorno
  // finissero sulla stessa, chi cambia il tema al tablet non deve cambiarlo
  // anche al computer dell'ufficio.
  function chiave() { return 'istudio_tema_' + (window.TEMA_DOVE || 'sala'); }
  function scelto() {
    try { return localStorage.getItem(chiave()); } catch (e) { return null; }
  }
  function ricorda(modo) {
    try { localStorage.setItem(chiave(), pulisci(modo)); } catch (e) {}
  }

  // ⚠️ LE ICONE STANNO QUI, non nelle due pagine. Erano scritte in tutti e due
  // i posti: la sala e la piattaforma hanno lo stesso tasto e devono avere lo
  // stesso disegno, sennò prima o poi uno cambia e l'altro no.
  // ⚠️ E sono DISEGNI, non emoji. Un'emoji la disegna il sistema operativo:
  // ☀️ è una cosa su Windows, un'altra su Mac, un'altra su Android — e accanto
  // a un'icona a tratto sembra un adesivo appiccicato sopra. Un disegno nostro
  // è uguale ovunque e prende il colore del testo che lo circonda.
  // ⚠️ Per «automatica» resta una «A», non un monitor. Il monitor, negli altri
  // programmi, vuol dire «segui il sistema operativo»: qui NON è quello che
  // succede — automatica vuol dire scuro dalle 19 alle 6, a orologio. Un'icona
  // che promette una cosa diversa da quella che il programma fa è peggio di
  // nessuna icona.
  var disegno = function (dentro) {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"'
      + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + dentro + '</svg>';
  };
  var ICONE = {
    chiaro: disegno('<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.5 1.5'
      + 'M17.9 17.9l1.5 1.5M2.5 12h2M19.5 12h2M4.6 19.4l1.5-1.5M17.9 6.1l1.5-1.5"/>'),
    scuro: disegno('<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>'),
    auto: '<span class="lettera">A</span>',
  };
  var NOMI = { chiaro: 'Chiara', scuro: 'Scura', auto: 'Automatica (scura dalle 19 alle 6)' };

  applica(scelto() || 'chiaro');

  // Alle 19 lo schermo deve abbassarsi da solo: la pagina è aperta da ore, e
  // col modo automatico l'ora cambia sotto. Costa un confronto al minuto.
  setInterval(function () {
    applica(document.documentElement.dataset.modo || 'chiaro');
  }, 60 * 1000);

  return { MODI: MODI, DA: DA, A: A, orarioScuro: orarioScuro, risolvi: risolvi,
           applica: applica, scelto: scelto, ricorda: ricorda, ICONE: ICONE, NOMI: NOMI };
})();
