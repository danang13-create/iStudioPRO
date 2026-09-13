#!/bin/bash
# ============================================================
#  Aggiornamento notturno di iStudio
#
#  Lo lancia il crontab alle 5 del mattino, a locale chiuso. Mai nel mezzo
#  del servizio della sera: un riavvio alle 21 è una prenotazione persa.
#
#  Con «--adesso» lo lancia «Avvia.sh», e allora salta l'orario.
#
#  ⚠️ Quello che NON tocca, e non deve toccare mai:
#     data.db (prenotazioni e rubrica), .wwebjs_auth (il collegamento
#     WhatsApp), allegati-invii, copia-cliente.txt, e i file di assistenza.
#     Sono i dati del cliente: il programma si sostituisce, loro no.
# ============================================================
set -u
CARTELLA="$(cd "$(dirname "$0")/.." && pwd)"
DEPOSITO="danang13-create/iStudioPRO"
URL="${ISTUDIO_URL:-https://codeload.github.com/$DEPOSITO/tar.gz/refs/heads/main}"
REGISTRO="$CARTELLA/aggiornamenti.log"
ADESSO=""
[ "${1:-}" = "--adesso" ] && ADESSO="si"

nota() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$REGISTRO"; }

export PATH="$HOME/.local/node/bin:$PATH"

# ⚠️ Il registro va tagliato, sennò in tre anni di notti diventa il file più
# grosso della cartella — e su un disco piccolo è proprio lui a riempirlo.
if [ -f "$REGISTRO" ] && [ "$(wc -l < "$REGISTRO")" -gt 2000 ]; then
  tail -500 "$REGISTRO" > "$REGISTRO.tmp" && mv "$REGISTRO.tmp" "$REGISTRO"
fi

nota "── controllo aggiornamenti ──"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! curl -fsSL -m 600 "$URL" -o "$TMP/nuova.tar.gz"; then
  nota "niente da fare: non riesco a scaricare (connessione?)"
  [ -n "$ADESSO" ] && echo "   ⚠️  Non riesco a scaricare l'aggiornamento. Tengo quella che c'è."
  exit 0
fi

mkdir -p "$TMP/nuova"
if ! tar -xzf "$TMP/nuova.tar.gz" -C "$TMP/nuova" --strip-components=1; then
  nota "pacchetto scaricato illeggibile: non tocco niente"
  exit 0
fi

# --- È davvero una versione nuova? ---
VECCHIA="$(tr -d ' \r\n' < "$CARTELLA/VERSIONE.txt" 2>/dev/null)"
NUOVA="$(tr -d ' \r\n' < "$TMP/nuova/VERSIONE.txt" 2>/dev/null)"
if [ -z "$NUOVA" ]; then
  nota "il pacchetto non ha VERSIONE.txt: non mi fido, non tocco niente"
  exit 0
fi
if [ "$VECCHIA" = "$NUOVA" ]; then
  nota "già alla $VECCHIA, niente da fare"
  [ -n "$ADESSO" ] && echo "   ✅ già aggiornata ($VECCHIA)"
  exit 0
fi

# --- Ma è più NUOVA, non solo diversa? ---
# ⚠️ Costato quasi una notte al primo mini-PC. Installato dalla chiavetta con
# la 2026.09.12.1, trovava nel deposito la 2026.08.17.4 — più VECCHIA — e
# stava per installarla al posto della sua: «diversa» era tutto quello che
# controllava. Si è fermato solo perché quel pacchetto vecchio non passava
# il controllo di sintassi. Con un pacchetto sano, alle 5 sarebbe tornato ad
# agosto, e nessuno avrebbe capito perché il campo «Tavolo» era sparito.
# La regola è la stessa dell'aggiornatore del Mac (Mac/aggiornamento-
# automatico.sh), che l'aveva già imparata il 6 agosto: si aggiorna SOLO in
# avanti. Per tornare indietro si pubblica un numero NUOVO col codice vecchio.
# Il confronto è numerico campo per campo: «.56» di ieri è più vecchio di «.1»
# di oggi, e un confronto testuale non lo saprebbe.
piu_recente() {   # $1 > $2 ?
  [ "$1" = "$2" ] && return 1
  [ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n -k4,4n | tail -1)" = "$1" ]
}
if [ -n "$VECCHIA" ] && ! piu_recente "$NUOVA" "$VECCHIA"; then
  nota "nel deposito c'è la $NUOVA, più vecchia della $VECCHIA installata: non torno indietro"
  [ -n "$ADESSO" ] && echo "   ✅ qui c'è già una versione più nuova ($VECCHIA) di quella pubblicata ($NUOVA)"
  exit 0
fi

# --- Il programma nuovo è sano? ---
# ⚠️ Si controlla PRIMA di fermare quella che funziona. Sostituire e poi
# scoprire che non parte vuol dire un ristorante senza bot fino al mattino,
# e nessuno lì che sappia rimediare.
if ! node --check "$TMP/nuova/server.js" >/dev/null 2>&1 \
  || ! node --check "$TMP/nuova/bot-prenotazioni.js" >/dev/null 2>&1; then
  nota "la versione $NUOVA contiene un errore: NON aggiorno, tengo la $VECCHIA"
  exit 0
fi

nota "aggiorno: $VECCHIA → $NUOVA"

# --- Una copia di sicurezza del programma (non dei dati) ---
# Serve a tornare indietro se la nuova non parte. I dati non ci vanno: sono
# già al loro posto e non vengono toccati.
RIPIEGO="$CARTELLA/.versione-precedente"
rm -rf "$RIPIEGO"; mkdir -p "$RIPIEGO"
for x in server.js bot-prenotazioni.js public public-sala Linux VERSIONE.txt; do
  [ -e "$CARTELLA/$x" ] && cp -a "$CARTELLA/$x" "$RIPIEGO/" 2>/dev/null
done

sudo systemctl stop istudio 2>/dev/null

# Solo il programma. L'elenco è esplicito: un «cp -a nuova/* .» copierebbe anche
# quello che nel pacchetto non c'è più, e soprattutto renderebbe possibile un
# giorno sovrascrivere data.db senza che nessuno se ne accorga.
for x in server.js bot-prenotazioni.js package.json package-lock.json \
         public public-sala Mac Windows Linux Installazione \
         GUIDA.md INSTALLA-CLIENTE.md chiave-seriali-pubblica.pem VERSIONE.txt; do
  [ -e "$TMP/nuova/$x" ] || continue
  rm -rf "$CARTELLA/$x"
  cp -a "$TMP/nuova/$x" "$CARTELLA/$x"
done
chmod +x "$CARTELLA/Linux/"*.sh 2>/dev/null

# Le librerie possono essere cambiate. Se npm fallisce si torna indietro: meglio
# la versione di ieri che funziona di quella di oggi che non parte.
if ! (cd "$CARTELLA" && npm install --no-audit --no-fund >>"$REGISTRO" 2>&1); then
  nota "npm install fallito: torno alla $VECCHIA"
  cp -a "$RIPIEGO/." "$CARTELLA/" 2>/dev/null
  (cd "$CARTELLA" && npm install --no-audit --no-fund >>"$REGISTRO" 2>&1)
fi

sudo systemctl start istudio 2>/dev/null

# --- Risponde? ---
# ⚠️ «Il servizio è partito» non basta: node può essere vivo con dentro un
# errore. Se la pagina non si apre entro un minuto si torna indietro da soli,
# perché alle 5 del mattino non c'è nessuno che possa farlo.
SU=""
for i in $(seq 1 60); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 http://127.0.0.1:3100/ 2>/dev/null)" != "000" ]; then
    SU="si"; break
  fi
  sleep 1
done

if [ -n "$SU" ]; then
  nota "aggiornata alla $NUOVA, risponde ✅"
  [ -n "$ADESSO" ] && echo "   ✅ aggiornata: $VECCHIA → $NUOVA"
else
  nota "la $NUOVA non risponde: torno alla $VECCHIA"
  sudo systemctl stop istudio 2>/dev/null
  cp -a "$RIPIEGO/." "$CARTELLA/" 2>/dev/null
  (cd "$CARTELLA" && npm install --no-audit --no-fund >>"$REGISTRO" 2>&1)
  sudo systemctl start istudio 2>/dev/null
  [ -n "$ADESSO" ] && echo "   ⚠️  La nuova versione non partiva: sono tornato alla $VECCHIA."
fi
