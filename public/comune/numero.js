// Il numero di telefono come lo vuole WhatsApp.
//
// ⚠️ Un messaggio si consegna a «<prefisso><numero>@c.us»: senza il prefisso
// internazionale non arriva a nessuno. Per questo un numero italiano scritto
// come lo si detta al telefono — «333 1234567» — viene salvato come
// «393331234567». Non è un capriccio: è l'indirizzo vero del cliente.
//
// Il fatto che succeda da solo, però, non vuol dire che debba succedere di
// nascosto. Chi scrive il numero deve LEGGERE come verrà salvato, prima di
// salvare: una cifra in più comparsa senza spiegazione sembra un guasto, e chi
// la vede o la cancella o smette di fidarsi del modulo.
//
// Questa è la stessa regola di normalizePhone nel server, e una prova le
// confronta su una tabella di casi: se una delle due cambia, l'altra se ne
// accorge.
window.Numero = {
  perWhatsApp(grezzo) {
    let p = String(grezzo || '').replace(/[\s\-().]/g, '');
    if (p.startsWith('+')) p = p.slice(1);
    else if (p.startsWith('00')) p = p.slice(2);
    if (/^3\d{8,9}$/.test(p)) p = '39' + p;
    return p;
  },

  // Quello che si fa leggere sotto al campo: solo quando il numero è cambiato
  // davvero, e solo quando sembra un numero. Un avviso che compare sempre non
  // lo legge più nessuno.
  avvisoPrefisso(grezzo) {
    const scritto = String(grezzo || '').trim();
    if (!scritto) return '';
    const finale = this.perWhatsApp(scritto);
    if (!/^\d{8,14}$/.test(finale)) return '';
    // ⚠️ Il confronto va fatto su quello che il numero era GIÀ, non sul testo
    // così com'è battuto: chi scrive «+39 333 1234567» il prefisso ce l'ha
    // messo lui, e vedersi dire «verrà salvato come +39…» lo lascia a chiedersi
    // cosa stia per cambiare. Trovato aprendo la pagina vera, non qui dentro.
    const gia = scritto.replace(/[\s\-().]/g, '').replace(/^\+/, '').replace(/^00/, '');
    if (finale === gia) return '';
    return 'Verrà salvato come +' + finale;
  },
};
