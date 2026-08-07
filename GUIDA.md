# iStudio — Guida all'uso

Piattaforma per inviare messaggi WhatsApp e newsletter email a partire da una rubrica di contatti.
Funziona sul tuo Mac: i dati restano qui, non su server esterni.

> Gira solo sul tuo Mac e non dipende da nient'altro. È lo stesso programma che viene installato
> sui Mac di altre persone: là serve un seriale di abbonamento per usarlo, qui no. Per l'uso tuo
> di ogni giorno non cambia niente.
>
> **La scritta accanto al nome, in alto a sinistra, ti dice dove sei:** **MASTER** è la tua copia
> di lavoro, **PRO** è quella in abbonamento installata dai clienti. Serve perché le due possono
> stare accese insieme sullo stesso computer e per il resto sono identiche.

---

## Avviare e fermare

**Il modo più comodo:** dopo l'installazione trovi **l'icona di iStudio sulla Scrivania**.
Doppio click e si apre da sola nel browser. Non è una copia del programma, è solo un
collegamento: gli aggiornamenti arrivano lo stesso e non va mai rifatto.

**Oppure:** apri la cartella **Mac** e fai doppio click su **`Avvia iStudio.command`**.
Si apre una finestrella del Terminale con la conferma e la piattaforma si apre nel browser
all'indirizzo **http://localhost:3100**. La finestrella si può chiudere: iStudio resta attiva.

**Per fermare:** cartella **Mac** → doppio click su **`Ferma iStudio.command`**.
Contatti e collegamento WhatsApp restano salvati.

> **iStudio funziona solo mentre il Mac è acceso e la piattaforma è avviata.**
> Se spegni il computer, gli invii in corso si interrompono.

---

## Le sezioni

### Dashboard
La panoramica. In alto lo stato dei tre servizi (WhatsApp, Email, Chat); sotto tre riquadri:
la tua rubrica (quanti contatti e come raggiungerli), i **messaggi WhatsApp** e le **newsletter
email**, ciascuno col numero inviato, la percentuale consegnata e gli errori. Il pulsante «Vedi
la cronologia» di ogni riquadro apre lo storico **già filtrato su quel canale**. In fondo gli ultimi invii.

> **«Partito» non vuol dire «arrivato».** Un'email può risultare inviata ma non arrivare se la
> casella non esiste: il rimbalzo torna nella tua posta, non in iStudio. iStudio però intercetta
> **prima** dell'invio gli indirizzi scritti male e i **domini inesistenti** (es. `test@test.test`),
> segnandoli come errore con il motivo nei «Dettagli» dell'invio.

### Invia messaggio
Il broadcast WhatsApp.
- **Nome dell'invio**: etichetta solo per te, per ritrovarlo nella Cronologia. Non viene inviata.
- **Testo**: puoi usare `[nome]` e `[cognome]`, che vengono sostituiti col dato di ogni contatto.
  Esempio: *"Ciao [nome], ti aspettiamo!"* → *"Ciao Mario, ti aspettiamo!"*
- **Allega immagine**: se la alleghi, il testo diventa la didascalia.
- **Destinatari**: cerca e seleziona. «Seleziona tutti» agisce **solo sui contatti filtrati**,
  quindi puoi fare più ricerche di seguito e sommare le selezioni.

Tra un messaggio e l'altro iStudio attende **10–15 secondi**, e **ogni 50 messaggi si ferma
1–2 minuti** per non farsi notare. Con 100 destinatari servono quindi circa **25 minuti**:
è normale, lascia lavorare.

Puoi **mettere in pausa** l'invio dalla Cronologia e riprenderlo quando vuoi: riparte
esattamente da dove si era fermato, senza rimandare il messaggio a chi l'ha già ricevuto.

### Limite messaggi giornaliero

Il menù **«Limite messaggi giornaliero»** è la protezione più utile per gli invii grossi. Scegli
un valore già pronto (100, 200, 300, 400, 500) oppure **Nessun limite**.

> **Parte già su 100 al giorno**, di proposito: è il valore prudente con cui conviene cominciare
> finché non sai come reagisce il tuo numero. Puoi alzarlo quando vuoi — la scelta vale per il
> singolo invio, non è un'impostazione fissa.

Se scegli 200, iStudio
ne manda 200 e poi **si mette in pausa da sola**; il giorno dopo **alle 9:00 riprende da sola**
da dove si era fermata, senza che tu debba ricordarti niente. Così una rubrica da 1400 persone
si smaltisce in pochi giorni invece che in un colpo solo.

Sotto al menù compare una **stima del tempo**: in base a quanti destinatari hai selezionato,
iStudio ti dice più o meno quanto ci metterà (es. *«150 destinatari · tempo stimato ≈ 34 minuti»*).
Se i destinatari superano il limite giornaliero, ti dice anche in quanti giorni (es. *«500
destinatari · 200 al giorno → circa 3 giorni»*). È una stima indicativa: i tempi fra un messaggio
e l'altro sono volutamente un po' casuali.

Se premi ▶️ quando il limite di oggi è già stato raggiunto, iStudio te lo dice e ti chiede
conferma: puoi insistere, ma sai che lo stai facendo. Il limite torna valido il giorno dopo.

### Newsletter
Come sopra ma via email. Due campi da non confondere:
- **Nome dell'invio** → solo per te
- **Oggetto** → questo sì che il destinatario lo vede

L'immagine allegata compare in cima all'email.
Vengono elencati solo i contatti che hanno un indirizzo email.

### Cronologia
Lo storico degli invii, filtrabile per canale (WhatsApp / Newsletter).
Il cestino elimina la registrazione dallo storico; **i messaggi già consegnati non vengono toccati.**

Accanto a ogni invio ci sono i pulsanti:

| Pulsante | Cosa fa |
|---|---|
| 🔍 | **Dettagli**: quanti sono partiti, quanti no e **chi**, con il motivo spiegato in italiano |
| 🔁 | Dentro i Dettagli: **rimette in coda** chi è fallito per un problema di collegamento (vedi sotto) |
| ⏸️ | Mette in **pausa** l'invio (si ferma dopo il messaggio in corso) |
| ▶️ | **Riprende** da dove si era fermato — nessuno riceve il messaggio due volte |
| 🗑️ | Elimina la riga dallo storico |

Stati possibili:

| Stato | Significato |
|---|---|
| **In corso** | Sta inviando |
| **In riposo** | Pausa automatica di 1–2 minuti dopo 50 messaggi. Riparte da sola |
| **In pausa** | Fermo. Sotto c'è scritto il perché (l'hai fermato tu, WhatsApp si è scollegato, iStudio è stata chiusa). Si riprende col ▶️ |
| **Completata** | Finito |

### Quando il collegamento cade a metà invio

Se WhatsApp si stacca mentre l'invio è in corso, **chi non è stato raggiunto in quel momento
resta «ancora da fare», non «non riuscito»**: non è colpa sua, e verrà riprovato. L'invio si
mette in pausa e riparte da solo appena il collegamento torna.

Se però WhatsApp si scollega **tre volte di fila** senza riuscire a mandare niente, iStudio
smette di insistere e te lo scrive: vai in **Impostazioni → 🔄 Ripristina collegamento
WhatsApp**, poi riprendi l'invio col ▶️. **Nessun destinatario viene perso.**

> **Invii fatti con le versioni precedenti.** Prima iStudio segnava come «non riusciti» anche
> quelli falliti per il collegamento caduto, e il ▶️ non li riprovava: restavano senza messaggio
> per sempre. Se apri i **Dettagli** di un vecchio invio e trovi un riquadro giallo, premi
> **🔁 Rimetti in coda**: quelle persone tornano fra quelle «ancora da fare» e il ▶️ le serve.
> Gli errori veri (numeri senza WhatsApp) restano come sono.

Se invece è stata chiusa iStudio o si è spento il Mac, al riavvio l'invio resta **In pausa**
e riparte quando premi tu ▶️: così non parte niente a tua insaputa.

### Chat
Legge le conversazioni direttamente dal tuo WhatsApp: elenco a sinistra, messaggi a destra.
Puoi rispondere e allegare immagini con il pulsante 📎.
Sotto ogni messaggio inviato compare lo stato: *inviato*, *non letto*, **letto** (azzurro).

Dalla freccia ▾ accanto al nome della conversazione puoi **aggiungere il contatto in Rubrica**,
con il numero già compilato.

Si può disattivare da Impostazioni.

> **La spia «Chat» in Dashboard.** La Chat legge le conversazioni dentro WhatsApp: se WhatsApp
> non è collegato, non può funzionare anche se l'interruttore nelle Impostazioni è acceso. In quel
> caso la spia diventa **gialla** e scrive **«WhatsApp scollegato»** — non è la Chat a essere
> rotta, sta solo aspettando il collegamento. Verde «Attiva» vuol dire che funziona davvero;
> rossa «Disattivata» vuol dire che l'hai spenta tu dalle Impostazioni.

### Rubrica
I contatti: nome, cognome, email, telefono. La pagina mostra solo la lista, pulita.
- Ordinabile per **Nome** o **Cognome** cliccando l'intestazione (▲ A→Z, ▼ Z→A)
- 100 contatti per pagina
- **➕ Aggiungi contatto** apre una finestrella con la scheda vuota
- **Modifica** apre la stessa finestrella già compilata con tutti i dati del contatto
- **Importa ed Esporta CSV** si trovano in **Impostazioni → Backup della rubrica**
  — colonne `nome; cognome; email; telefono; non_contattare`

### Il consenso

Dentro la scheda di ogni contatto (finestrella **Modifica** o **Aggiungi**) c'è l'interruttore
**Consenso: Sì / No**.

- **Tutti i contatti partono con consenso «Sì»**: possono essere contattati.
- Mettendo **«No»**, il contatto **resta in rubrica ma non riceve più niente**, né WhatsApp né
  newsletter: sparisce dall'elenco dei destinatari (non lo selezioni per sbaglio) ed è escluso
  anche dagli invii **già partiti e in pausa**.

Nella lista, chi ha consenso «No» ha la **riga leggermente colorata** con un piccolo 🚫 accanto
al nome, così lo riconosci a colpo d'occhio senza aprire la scheda. La Dashboard ne conta il numero.

> **Consenso «No» = «non contattare»: sono la stessa cosa.** Un solo interruttore, non due
> controlli separati.

> **Perché mettere «No» invece di cancellare il contatto:** se lo cancelli, alla prima
> importazione CSV rientra e ricomincia a ricevere messaggi. Il «No» invece resta, e viaggia
> nell'esportazione CSV (colonna `non_contattare`), così un backup non fa rientrare chi non va contattato.

### Le richieste di cancellazione riconosciute da sole

Ogni 10 minuti iStudio legge le conversazioni e riconosce chi ha risposto con una richiesta
esplicita: *stop*, *cancellami*, *rimuovimi*, *toglimi dalla lista*, *non scrivetemi più*,
*non voglio più ricevere*, *disiscrivimi*, *unsubscribe*.

Quando ne trova, in cima alla Rubrica compare un riquadro arancione (e il menu segna
**Rubrica (2)**) con nome, frase esatta e data. Tu decidi:

- **✓ Non contattare più** → il contatto è escluso da ogni invio futuro
- **Ignora** → non se ne parla più per quel messaggio

**iStudio non blocca mai nessuno da sola, e c'è un motivo.** Dalle conversazioni legge il
*nome*, non il numero. Se in rubrica hai due omonimi, o se la persona non c'è, non tira a
indovinare: te lo dice e ti fa scegliere il contatto giusto con una ricerca. Un abbinamento
sbagliato escluderebbe per sempre un cliente vero senza che nessuno se ne accorga.

**Limite da conoscere:** iStudio se ne accorge solo mentre è accesa e finché la conversazione
è abbastanza in alto nell'elenco delle chat. Se arrivano molti messaggi nel frattempo, una
richiesta può sfuggire: il pulsante 🚫 a mano resta la rete di sicurezza.
Le richieste nei **gruppi** vengono ignorate, e così i messaggi scritti da te.
- Gli **omonimi sono ammessi**, ma **telefono ed email devono essere unici**:
  se provi a inserire un doppione, iStudio te lo segnala indicando a chi appartiene già

### Profilo (solo sulle copie in abbonamento)

Il pulsante **👤 Profilo** in alto a destra, accanto alle spie WhatsApp ed Email. Compare solo
se questa copia di iStudio funziona ad abbonamento; sulla versione personale non c'è.

Dentro trovi:

- il tuo **codice installazione** (es. `IST-4K7P-9XQ2`) — è quello da comunicare per farsi
  mandare un seriale nuovo
- **fino a quando** l'abbonamento è valido e quanti giorni restano
- il campo dove **incollare il seriale** per rinnovare

Puoi rinnovare **anche prima della scadenza**: il nuovo periodo sostituisce quello in corso.
Negli ultimi 7 giorni compare in cima a ogni pagina una fascia gialla che te lo ricorda.

> **Come si chiede il seriale.** Alla **prima attivazione** il pulsante «Richiedi attivazione»
> apre l'**email già scritta**: dentro c'è tutto — durata scelta, codice installazione e
> versione — devi solo inviarla. Prova prima il programma di posta del computer; se su quel
> computer non ce n'è uno configurato apre da sola Gmail nel browser, così l'email si apre
> comunque. Per i **rinnovi** successivi il
> pulsante apre invece **WhatsApp** col messaggio pronto, così la richiesta va nella
> conversazione che hai già. In tutti e due i casi il codice installazione lo scrive il
> programma: non ricopiarlo a mano, una lettera storta rende il seriale inservibile.

> Se l'abbonamento scade, iStudio si blocca ma **non perdi niente**: contatti, cronologia e
> collegamento WhatsApp restano dove sono, e appena inserisci il seriale nuovo ritrovi tutto
> come lo avevi lasciato.

### Impostazioni
Collegamento WhatsApp (QR code), dati dell'account email, interruttore della Chat, le
**Impostazioni pause**, il **Backup della rubrica** e la **Cancellazione dati**.

**Impostazioni pause:** qui regoli quanto iStudio attende tra un messaggio e l'altro — la difesa
principale contro il blocco del numero. Per WhatsApp puoi cambiare la pausa tra i messaggi, ogni
quanti messaggi fare il riposo lungo e quanto dura; per la Newsletter la pausa tra un'email e
l'altra. I valori consigliati sono già impostati; c'è **«Ripristina valori consigliati»** per
tornare indietro. Se metti tempi WhatsApp troppo bassi compare un avviso rosso (ma puoi salvare
lo stesso). I nuovi tempi valgono dal prossimo invio, e la stima del tempo si adegua da sola.

> L'**interruttore in alto a destra** del blocco spegne le pause: i campi restano con i loro
> valori ma diventano sbiaditi e non modificabili, e i messaggi partono uno dopo l'altro quasi
> senza attesa. **Sconsigliato**, alza parecchio il rischio di blocco del numero — c'è una
> conferma prima di spegnerlo. Riaccendendolo tornano esattamente i valori numerici di prima,
> senza bisogno di «Ripristina».

**Cancellazione dati:** svuota rubrica o cronologia singolarmente, oppure **«Inizializza»**, che
riporta iStudio come appena installata in un colpo solo — contatti, cronologia, dati email e
collegamento WhatsApp (da riscansionare). Richiede una doppia conferma, l'ultima scrivendo la
parola INIZIALIZZA. **Non è annullabile**: fai prima un «Esporta CSV» dal Backup della rubrica.

---

## Limiti importanti da conoscere

### WhatsApp — rischio di blocco del numero
iStudio usa il tuo WhatsApp personale tramite una libreria **non ufficiale**, che viola i
termini di servizio di WhatsApp. **Invia solo a persone che ti conoscono e hanno acconsentito.**
Invii massivi a sconosciuti, o molte segnalazioni come spam, possono portare al **blocco del tuo numero**.
La pausa automatica tra i messaggi riduce il rischio ma non lo elimina.

Per volumi importanti la strada corretta è l'**API ufficiale WhatsApp Business** (a pagamento).

**Cosa conta davvero.** Il blocco non arriva dalla velocità ma dalle **segnalazioni**: se le
persone ti bloccano o ti segnalano come spam, il numero salta anche andando pianissimo.
Quindi, in ordine di importanza:

1. scrivi solo a chi ti conosce e ha il tuo numero
2. usa `[nome]`: un messaggio personale viene segnalato molto meno di un volantino
3. offri sempre una via d'uscita («se non vuoi più ricevere questi messaggi scrivimi»):
   chi vuole smettere ti risponde invece di segnalarti
4. rispondi a chi ti risponde — le conversazioni a due sensi sono un buon segnale
5. usa il **tetto giornaliero** per spalmare gli invii grossi su più giorni

E ricorda che **per la massa c'è la newsletter email**, che non ha nessun rischio di blocco.

### WhatsApp può cambiare senza preavviso
Essendo non ufficiale, quando WhatsApp aggiorna il suo sito alcune funzioni possono smettere
di funzionare finché la libreria non viene adeguata. È già successo con la lettura delle chat.

### Contatti WhatsApp Business
Per gli account business WhatsApp mostra nome e categoria **ma non il numero di telefono**.
Con quei contatti «Aggiungi in rubrica» apre la scheda col solo nome: il numero va scritto a mano.
Non è un errore: il dato proprio non è disponibile.

### Conferme di lettura
Se il destinatario ha **disattivato le conferme di lettura**, il messaggio resterà sempre
«non letto» anche dopo che l'ha aperto. Vale identicamente su WhatsApp: non è un limite di iStudio.

### Email — Gmail
Serve una **«password per le app»** di Google (16 caratteri), *non* la password normale
dell'account. Si crea su myaccount.google.com → Sicurezza → Verifica in due passaggi → Password per le app.
Dopo averla inserita premi **«Prova connessione»**: la spia dell'Email in alto diventa verde
solo se funziona davvero.

Gmail ha inoltre un limite indicativo di **circa 500 email al giorno**. Per volumi maggiori
conviene un servizio dedicato (Brevo, Mailchimp): basta cambiare i dati SMTP nelle Impostazioni.

---

## Dove sono i dati e come salvarli

Tutto sta in questa cartella (`Documenti/iStudio`):

| File / cartella | Contenuto |
|---|---|
| `data.db` | Contatti, cronologia invii, impostazioni |
| `allegati-invii/` | Le immagini degli invii, tenute da parte per poterli riprendere |
| `.wwebjs_auth/` | Il collegamento a WhatsApp (il QR già scansionato) |
| `server.js`, `public/` | Il programma vero e proprio |

**Per un backup rapido dei contatti:** Impostazioni → Backup della rubrica → **Esporta CSV**.
**Per un backup completo:** copia l'intera cartella `Documenti/iStudio`.

> Tieni la cartella in `Documenti/iStudio`: gli script di avvio si aspettano quel percorso.

---

## Se qualcosa non funziona

**La pagina non si apre** → iStudio non è avviata: cartella **Mac** → `Avvia iStudio.command`.

**WhatsApp risulta disconnesso** → Impostazioni, pulsante **🔄 Ripristina collegamento
WhatsApp**: chiude tutto e ricollega in una ventina di secondi, **senza spegnere iStudio** e
senza perdere contatti o cronologia. Nella maggior parte dei casi torna su da solo e il QR non
serve nemmeno. Se invece il collegamento non è più valido comparirà il QR: riscansionalo dal
telefono (WhatsApp → Impostazioni → Dispositivi collegati → Collega un dispositivo).

> Di norma **non devi fare niente**: se il collegamento cade durante un invio, iStudio se ne
> accorge e si ricollega da sola in pochi secondi, poi riprende l'invio da dove era rimasto.
> Il pulsante serve per i casi in cui non ce la fa da sola.

**La sessione WhatsApp può essere attiva in un posto solo:** o qui, o su un altro computer.

**Le newsletter non partono** → Impostazioni → «Prova connessione». Se le credenziali sono
rifiutate, quasi sempre è perché è stata inserita la password normale invece della password per le app.

**Un invio è rimasto a metà** → al riavvio lo trovi «In pausa» in Cronologia, con scritto il
motivo. Premi ▶️ per farlo ripartire da dove si era fermato, oppure 🗑️ per lasciar perdere.

**Registro tecnico degli errori:** `~/Library/Logs/istudio.log`

---

## Pubblicare iStudio online

Tecnicamente si può, ma **non su un hosting classico** (Aruba, Altervista): servirebbe un
servizio che esegua container, oppure un server dedicato.

**È una strada che è stata valutata e messa da parte**, per un motivo che non è tecnico: online
tutte le linee WhatsApp partirebbero dallo stesso indirizzo, ed è esattamente l'impronta che
WhatsApp riconosce come invio automatico. Il rischio di blocco non solo salirebbe, ma
riguarderebbe **tutti insieme** invece che uno per volta. Con iStudio installata su ogni
computer, ognuno resta per conto suo.
