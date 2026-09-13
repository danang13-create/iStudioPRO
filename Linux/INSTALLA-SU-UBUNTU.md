# Installare iStudio su un mini-PC Ubuntu

Si fa **una volta sola, in laboratorio**, con monitor e tastiera attaccati. Al ristorante
poi arriva solo corrente e cavo di rete.

Tempo: circa un'ora, quasi tutta di attesa.

---

## Cosa serve prima di cominciare

- Il **mini-PC**: **Beelink EQ14** (Intel N150, 16 GB, SSD 500 GB) è il modello scelto — arriva
  completo, ha due HDMI e la RAM in uno slot invece che saldata. Va bene qualunque macchina
  **x86_64** con 16 GB, un SSD, Ethernet e un'uscita HDMI; le ragioni della scelta e le
  alternative scartate stanno in `PIANO-BOT-PRENOTAZIONI.md`, «Il modello scelto».
  La **prima installazione vera è stata fatta su un HP ProDesk 400 G5 Desktop Mini**
  ricondizionato (i5 di nona generazione, 16 GB, SSD 256 GB): va benissimo, e le differenze
  rispetto al Beelink sono annotate qui sotto dove capitano
- Una **chiavetta USB da 8 GB** (si cancella tutto quello che c'è dentro)
- Monitor, tastiera, mouse — **e il cavo giusto**: non tutti i mini-PC hanno l'HDMI. L'HP
  ProDesk 400 G5 esce con **due DisplayPort**, e l'HDMI c'era solo se chi lo comprò scelse
  la porta opzionale. Guarda il retro *prima* di preparare la chiavetta: il monitor serve
  proprio per il BIOS, ed è seccante scoprirlo a lavoro iniziato
- **Cavo di rete**: il wi-fi in un ristorante cade, e col cavo non c'è niente da riconfigurare
  quando la macchina cambia rete
- Un **numero WhatsApp di prova** — *non* quello del ristorante

---

## Fase 1 — Ubuntu

1. Scarica **Ubuntu 24.04 LTS** da `ubuntu.com` — Desktop o Server, vedi sotto.
2. Scrivi la chiavetta con **balenaEtcher** (c'è per Mac e per Windows).
3. Avvia il mini-PC dalla chiavetta e installa. Il disco si formatta: il Windows che c'era
   sparisce, ed è quello che vogliamo.
4. Nell'installatore spunta **«Install OpenSSH server»** e, se te lo propone, **importa le
   chiavi da GitHub** (utente `danang13-create`): da quel momento entri dal Mac senza password.

### Desktop o Server?

Tutti e due vanno bene: iStudio parte come **servizio di sistema**, cioè si accende da sola
prima del login, anche su Desktop dove al login grafico non ci arriva nessuno.

**Desktop** — se vuoi poter attaccare un monitor e lavorare sulla macchina anche quando non
hai il portatile con te. Costa circa 1 GB di RAM in più e qualche aggiornamento in più. Con
16 GB non si sente. L'installatore riconosce da solo che è un Desktop e spegne le quattro
cose che potrebbero far tacere il bot (vedi sotto).

**Server** — se la macchina non deve essere toccata da nessuno e ci lavori sempre da remoto.

### ⚠️ Il BIOS, prima di tutto il resto

Entra nel BIOS e attiva **«riaccenditi quando torna la corrente»**. Va messa su **Power On**,
mai su *Stato precedente*: quella riaccende solo se la macchina era accesa nell'istante del
black-out, e dopo uno spegnimento anomalo non è detto che lo fosse.

**Il tasto per entrare dipende dalla marca.** Sugli **HP** è **F10** (non `Canc` né `F2`:
`F2` apre le diagnostiche hardware, che è un'altra cosa e confonde). Sempre su HP, **F9** è
il menù dei dispositivi di avvio, quello che serve per partire dalla chiavetta.

**Anche il nome della voce cambia**, e non sta dove ci si aspetta:

| Marca | Dove sta | Come si chiama |
|---|---|---|
| HP ProDesk / EliteDesk | **Avanzate → Opzioni di avvio** | «Dopo interruzione alimentazione» |
| altre | *Power Management*, *Power-On Options*, *ACPI* | *After Power Loss*, *AC Power Recovery*, *Restore on AC Power Loss* |

⚠️ Sull'HP ProDesk 400 G5 la voce si trova in **Opzioni di avvio**, **non** in «Opzioni di
risparmio energetico» come verrebbe da pensare: lì dentro ci sono solo due voci e nessuna è
questa. Può anche apparire **grigia, già su «Accendi»**: in quel caso è bloccata sul valore
giusto e non c'è niente da fare — lo conferma la prova della spina.

È il motivo principale per cui il monitor serve: da nessun'altra parte si può fare.

---

## Fase 2 — iStudio

Ci sono due strade. **La prima è più corta e non può sbagliare versione**: usala.

### Strada A — dalla chiavetta (consigliata)

Sul **Mac**: `Comandi avanzati` → **Prepara chiavetta per mini-PC.command**.

Ti lascia sulla Scrivania una cartella **«Installazione Linux»** con dentro iStudio
esattamente com'è su questo Mac, più un `INSTALLA.sh` e un foglietto di istruzioni.
Copiala su una chiavetta, portala sul mini-PC, copiala sulla Scrivania, apri la cartella,
clic destro → *Apri nel terminale*, e dai:

```sh
bash INSTALLA.sh
```

Fa tutto: installa `curl` se manca, copia il programma in `~/iStudio`, rimette i permessi
che la chiavetta perde per strada, e lancia l'installatore vero.

**Perché è la strada buona**: il programma viaggia dal Mac al mini-PC *direttamente*.
Non passa dal deposito pubblico, quindi non può capitare di installare una versione
vecchia — che è l'errore che è costato un'ora alla prima installazione, e che si presenta
come un file mancante invece che come quello che è.

### Strada B — da internet

Serve quando il mini-PC è lontano e la chiavetta non c'è. In più richiede un passaggio
in più, ed è quello che si dimentica.

#### ⚠️ Prima: nel deposito deve esserci la versione giusta

Il mini-PC **non** prende il programma da un Mac: lo scarica dal deposito pubblico
`iStudioPRO`. Se lì c'è una versione vecchia, è quella che si installa — e i guai non si
vedono come «versione vecchia», si vedono come **file che mancano**.

**Dalla versione 2026.09.13.1 nel deposito ci finisce da sola** ogni versione che arriva su
`main`, dopo che tutte le prove sono passate (`.github/workflows/pubblica.yml`). Serve una
cosa sola, una volta: sul Mac, `Comandi avanzati` → **Collega la pubblicazione
automatica.command**. Per controllare che sia arrivata, da qualunque terminale:

```sh
curl -fsSL https://raw.githubusercontent.com/danang13-create/iStudioPRO/main/VERSIONE.txt
```

Se per qualche motivo GitHub non pubblica, resta la strada a mano dal Mac — in quest'ordine:
**Scarica da GitHub.command**, poi **Pubblica versione per i clienti.command**. Tutti e due
avvisano se il Mac è rimasto indietro.

#### Poi, sul mini-PC

Con il tuo utente normale — **non** con `sudo`:

```sh
sudo apt update && sudo apt install -y curl
curl -fsSL -o istudio.tar.gz https://codeload.github.com/danang13-create/iStudioPRO/tar.gz/refs/heads/main
mkdir -p ~/iStudio && tar -xzf istudio.tar.gz -C ~/iStudio --strip-components=1
bash ~/iStudio/Linux/"Installa iStudio su Ubuntu.sh"
```

⚠️ La prima riga c'è perché **Ubuntu Desktop non porta `curl` di serie**: senza, il comando
dopo risponde «Comando curl non trovato» e la guida sembrerebbe sbagliata.

⚠️ Le **virgolette** intorno al nome dell'installatore servono: quel nome ha degli spazi
dentro, e senza virgolette il terminale lo legge come tre comandi diversi.

Si scarica **una volta sola**: l'installatore sta dentro il pacchetto e usa la copia che
hai appena estratto, invece di riscaricarla.

Lo script fa tutto e ti chiede tre cose: la password della piattaforma, se installare
Tailscale, e il nome del locale. Alla fine ti scrive gli indirizzi.

**Se qualcosa va storto**, lo script si ferma e dice cosa fare. Rilanciarlo non fa danni:
riprende da capo e non tocca un'installazione che ha già dei dati dentro.

### I tre intoppi già incontrati

| Cosa dice il terminale | Cosa vuol dire | Come si esce |
|---|---|---|
| `Comando «curl» non trovato` | Ubuntu Desktop non ce l'ha di serie | `sudo apt update && sudo apt install -y curl`, poi si ricomincia |
| `…/Linux/Installa iStudio su Ubuntu.sh: File o directory non esistente` | **Il pacchetto scaricato è più vecchio della cartella `Linux/`**: non è un errore del mini-PC, è il deposito rimasto indietro | Controlla con `cat ~/iStudio/VERSIONE.txt`. Poi dal Mac: «Scarica da GitHub», «Pubblica versione», e sul mini-PC `rm -rf ~/iStudio istudio.tar.gz` prima di rifare |
| `Non lanciare questo script come root` | è stato lanciato con `sudo` | Rilancialo senza: la password la chiede lui quando serve |

Il secondo è quello che inganna di più, perché l'errore parla di un file mancante e la
causa vera sta su un'altra macchina. **Il primo comando da dare quando qualcosa non torna
è sempre `cat ~/iStudio/VERSIONE.txt`**: dice subito se il mini-PC sta installando quello
che pensi.

Per vedere cosa farebbe senza toccare niente:

```sh
ISTUDIO_PROVA=1 bash Linux/"Installa iStudio su Ubuntu.sh"
```

---

## Fase 3 — collegare WhatsApp

1. Apri `http://<indirizzo>:3100` (te lo scrive l'installatore).
2. Inquadra il QR code con il **numero di prova**.
3. Fai una prenotazione finta dal tuo telefono e controlla che il bot risponda.

---

## Fase 4 — la prova della spina

**Stacca fisicamente la corrente e riattaccala.**

Il mini-PC deve tornare su da solo, con iStudio già accesa e WhatsApp ancora collegato,
senza che nessuno tocchi niente. Controlla con:

```sh
bash ~/iStudio/Linux/Diagnostica.sh
```

È la prova che dice se il lavoro è finito, e va fatta **in laboratorio**, dove si può
rimediare — non al ristorante di sabato sera.

Poi stacca monitor e tastiera.

---

## Al ristorante

Corrente, cavo di rete, accendere. Nient'altro.

L'indirizzo IP sarà diverso da quello di laboratorio: non è un problema, perché ci si
arriva **per nome** via Tailscale. Non scrivere l'IP di laboratorio da nessuna parte.

---

## I comandi di tutti i giorni

Stanno in `~/iStudio/Linux/`:

| | |
|---|---|
| `bash Diagnostica.sh` | È viva? A che indirizzo? Cosa dice il registro? Non ripara niente di proposito |
| `bash Avvia.sh` | La aggiorna e la riavvia |
| `bash "Aggiorna adesso.sh"` | Prende subito la versione pubblicata, senza aspettare le 5 |
| `bash riordina-cartella.sh` | Rimette in vista solo i comandi e la guida (lo fanno già installazione e aggiornamento) |
| `bash Ferma.sh` | La ferma (riparte da sola se la macchina si riavvia) |
| `journalctl -u istudio -f` | Il registro dal vivo |

**L'aggiornamento è automatico alle 5 del mattino**, a locale chiuso — mai nel mezzo del
servizio della sera. Se la versione nuova non risponde entro un minuto, torna da sola alla
precedente: alle 5 non c'è nessuno che possa farlo.

Per non aspettare — una correzione urgente, una prova da fare adesso — c'è
`bash "Aggiorna adesso.sh"`, che fa esattamente quello che farebbe la notte, subito. Se qui
c'è già la versione pubblicata non fa niente e lo dice: non è un errore, un numero uguale
vuol dire programma uguale. **Il numero si legge in fondo a ogni pagina**, piattaforma e
sala: è il modo più veloce per sapere se un tablet sta guardando la copia aggiornata.

---

## Cosa fa l'installatore sul Desktop

Quattro cose, e la prima è l'unica che può davvero far tacere il bot:

1. **Spegne la sospensione automatica.** Una macchina che si addormenta alle due di notte,
   la mattina dopo non risponde.
2. **Mette iStudio come servizio systemd**, non come programma di avvio dell'utente: così
   parte anche se al login non ci arriva nessuno.
3. **Disattiva la proposta di salto di versione** («È disponibile Ubuntu 26.04»). Gli
   aggiornamenti di *sicurezza* restano attivi.
4. **Sposta gli aggiornamenti degli snap alle 3 di notte**, invece che a orari qualsiasi.

E aggiunge un permesso `sudo` ristretto a **quattro comandi su un solo servizio**, senza il
quale l'aggiornamento notturno si fermerebbe a chiedere una password che, dal crontab, non
digiterà nessuno.

---

## Se un giorno riattacchi il monitor

Se non vedi niente, è normale: la macchina è partita senza schermo e non ha inizializzato
l'uscita video. Riavviala con il monitor **già collegato**.
