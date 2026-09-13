#!/bin/bash
# ============================================================
#  Lascia in vista solo l'essenziale
#
#  Equivalente di «Mac/riordina-cartella.sh», nella grammatica di Linux.
#  Un cliente apre la cartella iStudio e trova venti voci, fra cui «Mac» e
#  «Windows», che sul suo mini-PC non servono a niente e non si possono
#  nemmeno usare. Qui resta in vista quello che lo riguarda: la cartella
#  «Linux» con i comandi di tutti i giorni, e la guida.
#
#  ⚠️ COME, e perché così. Niente viene spostato né cancellato: si scrive un
#  file «.hidden» con l'elenco dei nomi, che è il modo in cui il gestore file
#  di Ubuntu (e di GNOME in generale) decide cosa non mostrare. I percorsi
#  restano quelli di prima, quindi il programma, il servizio e l'aggiornamento
#  continuano a funzionare identici. Da terminale si vede ancora tutto: è lo
#  stesso limite che ha la versione Mac, dove «chflags hidden» nasconde nel
#  Finder e non altrove.
#
#  Lo chiamano l'installatore, «Avvia.sh» e l'aggiornamento notturno: è
#  idempotente, e rifarlo dopo un aggiornamento rinasconde ciò che è appena
#  arrivato.
#  ⚠️ Solo sulle copie dei clienti: sul computer di chi sviluppa la cartella
#  resta com'è, perché lì servono tutti i file.
# ============================================================
set -u
BASE="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
[ -d "$BASE" ] || exit 0

# Solo le copie dei clienti: è il file che accende l'abbonamento, e sul Mac di
# chi sviluppa non c'è.
[ -f "$BASE/copia-cliente.txt" ] || exit 0

# ⚠️ L'elenco è ESPLICITO, non un «tutto tranne». Se un domani arriva un file
# nuovo resterà visibile: è meglio che nascondere per sbaglio qualcosa che il
# cliente deve vedere. È la stessa scelta fatta sul Mac.
# Restano in vista di proposito: «Linux» (Avvia, Ferma, Diagnostica, Aggiorna
# adesso) e «GUIDA.md». Sul mini-PC non ci sono scorciatoie da doppio click —
# un «.sh» cliccato si apre in un editor invece di partire — quindi la cartella
# dei comandi deve restare raggiungibile.
cat > "$BASE/.hidden" <<'ELENCO'
Mac
Windows
Installazione
public
public-sala
node_modules
server.js
bot-prenotazioni.js
package.json
package-lock.json
INSTALLA-CLIENTE.md
README.md
VERSIONE.txt
.gitattributes
chiave-seriali-pubblica.pem
copia-cliente.txt
aggiornamenti-di-questo-mac.txt
assistenza-email.txt
assistenza-whatsapp.txt
data.db
data.db-shm
data.db-wal
allegati-invii
aggiornamenti.log
ELENCO

exit 0
