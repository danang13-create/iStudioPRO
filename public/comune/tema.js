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

  applica(scelto() || 'chiaro');

  // Alle 19 lo schermo deve abbassarsi da solo: la pagina è aperta da ore, e
  // col modo automatico l'ora cambia sotto. Costa un confronto al minuto.
  setInterval(function () {
    applica(document.documentElement.dataset.modo || 'chiaro');
  }, 60 * 1000);

  return { MODI: MODI, DA: DA, A: A, orarioScuro: orarioScuro, risolvi: risolvi,
           applica: applica, scelto: scelto, ricorda: ricorda };
})();
