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

# ------------------------------------------------------------------
#  Cosa NON si tocca — l'elenco al CONTRARIO
# ------------------------------------------------------------------
# ⚠️ Prima qui c'era l'elenco dritto: «copia questi file». Sembra più prudente,
# ed è la trappola: a decidere è l'aggiornatore VECCHIO, quello già installato
# su quel mini-PC, che le cartelle nuove non le conosce. Una versione che
# aggiunge una cartella non arriverebbe MAI alle macchine già in giro, e il
# guaio non si presenta come «manca una cartella»: si presenta mesi dopo, come
# una funzione che da quel cliente non va e da tutti gli altri sì.
# L'aggiornatore del Mac l'aveva già imparato il 6 agosto 2026, quando i comandi
# furono divisi in «Mac» e «Windows»; qui era rimasto il modo vecchio.
# Adesso la regola è la stessa nei due posti: si sostituisce tutto, tranne
# quello che appartiene a QUESTA installazione.
DA_NON_TOCCARE="data\.db|data\.db-.*|\.wwebjs_auth|\.wwebjs_cache|allegati-invii|node_modules|\.versione-precedente|aggiornamenti\.log|VERSIONE\.txt|copia-cliente\.txt|aggiornamenti-di-questo-mac\.txt|chrome-di-questo-mac\.txt|\.env|\.git"

da_toccare() {   # $1 = nome
  ! printf '%s' "$1" | grep -qE "^($DA_NON_TOCCARE)$"
}

# ------------------------------------------------------------------
#  La copia di sicurezza (del programma, non dei dati)
# ------------------------------------------------------------------
# ⚠️ Prima salvava un elenco fisso più corto di quello che poi sostituiva:
# package.json non c'era. Un ritorno indietro rimetteva il server vecchio
# tenendosi le librerie nuove, e rilanciava npm con il package.json sbagliato.
# Adesso mette da parte ESATTAMENTE quello che sta per cambiare, e segna anche
# cosa prima non c'era, per poterlo togliere tornando indietro.
RIPIEGO="$CARTELLA/.versione-precedente"
rm -rf "$RIPIEGO"; mkdir -p "$RIPIEGO"
: > "$RIPIEGO/.aggiunti"
for elemento in "$TMP/nuova"/* "$TMP/nuova"/.[!.]*; do
  [ -e "$elemento" ] || continue
  nome="$(basename "$elemento")"
  da_toccare "$nome" || continue
  if [ -e "$CARTELLA/$nome" ]; then
    cp -a "$CARTELLA/$nome" "$RIPIEGO/$nome"
  else
    printf '%s\n' "$nome" >> "$RIPIEGO/.aggiunti"
  fi
done
printf '%s\n' "$VECCHIA" > "$RIPIEGO/VERSIONE.txt"

torna_indietro() {
  local n x
  while IFS= read -r n; do
    [ -n "$n" ] && rm -rf "$CARTELLA/$n"
  done < "$RIPIEGO/.aggiunti"
  for x in "$RIPIEGO"/*; do
    [ -e "$x" ] || continue
    n="$(basename "$x")"
    rm -rf "$CARTELLA/$n"
    cp -a "$x" "$CARTELLA/$n"
  done
  (cd "$CARTELLA" && npm install --no-audit --no-fund >>"$REGISTRO" 2>&1)
}

# ------------------------------------------------------------------
#  Si ferma il servizio — e se non ci si riesce, NON si tocca niente
# ------------------------------------------------------------------
# ⚠️ Prima l'esito non si guardava. Senza il permesso di fermare il servizio
# senza password (lo scrive l'installatore in /etc/sudoers.d/istudio, e su una
# macchina installata a mano può mancare) i file venivano sostituiti SOTTO il
# programma acceso: la pagina rispondeva ancora — era il processo vecchio — e
# il registro scriveva «aggiornata, risponde ✅». Una bugia, ogni notte.
if ! sudo systemctl stop istudio 2>>"$REGISTRO"; then
  nota "non riesco a FERMARE il servizio: non tocco niente, resto alla $VECCHIA"
  nota "   (manca /etc/sudoers.d/istudio? serve per fermare e riavviare senza password)"
  [ -n "$ADESSO" ] && {
    echo "   ⚠️  Non riesco a fermare iStudio, quindi non aggiorno niente."
    echo "      Riprova con:  sudo systemctl stop istudio"
  }
  exit 0
fi

# ------------------------------------------------------------------
#  Si sostituisce il programma
# ------------------------------------------------------------------
for elemento in "$TMP/nuova"/* "$TMP/nuova"/.[!.]*; do
  [ -e "$elemento" ] || continue
  nome="$(basename "$elemento")"
  da_toccare "$nome" || continue
  rm -rf "$CARTELLA/$nome"
  cp -a "$elemento" "$CARTELLA/$nome"
done
chmod +x "$CARTELLA/Linux/"*.sh 2>/dev/null

# Le librerie possono essere cambiate. Se npm fallisce si torna indietro: meglio
# la versione di ieri che funziona di quella di oggi che non parte.
if ! (cd "$CARTELLA" && npm install --no-audit --no-fund >>"$REGISTRO" 2>&1); then
  nota "npm install fallito: torno alla $VECCHIA"
  torna_indietro
  sudo systemctl start istudio 2>>"$REGISTRO"
  [ -n "$ADESSO" ] && echo "   ⚠️  Le librerie non si sono installate: sono tornato alla $VECCHIA."
  exit 0
fi

sudo systemctl start istudio 2>>"$REGISTRO"

# ------------------------------------------------------------------
#  Risponde?
# ------------------------------------------------------------------
# ⚠️ «Il servizio è partito» non basta: node può essere vivo con dentro un
# errore. Si guardano TUTTE E DUE le porte — la piattaforma e la pagina della
# sala — perché la sala gira nello stesso processo ma su un'altra porta, e una
# delle due può non legarsi. Se non rispondono entro un minuto si torna
# indietro da soli: alle 5 del mattino non c'è nessuno che possa farlo.
# ISTUDIO_PORTA e ISTUDIO_ATTESA servono SOLO alle prove automatiche, che
# fanno rispondere un finto iStudio su porte libere e non possono aspettare
# un minuto per ogni caso. In produzione valgono i valori veri.
PORTA="${ISTUDIO_PORTA:-3100}"
PORTA_SALA=$((PORTA + 1))
ATTESA="${ISTUDIO_ATTESA:-60}"
risponde() {   # $1 = porta
  [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$1/" 2>/dev/null)" != "000" ]
}
SU=""
for i in $(seq 1 "$ATTESA"); do
  if risponde "$PORTA" && risponde "$PORTA_SALA"; then SU="si"; break; fi
  sleep 1
done

if [ -n "$SU" ]; then
  printf '%s\n' "$NUOVA" > "$CARTELLA/VERSIONE.txt"
  nota "aggiornata alla $NUOVA, risponde ✅"
  [ -n "$ADESSO" ] && echo "   ✅ aggiornata: $VECCHIA → $NUOVA"
  exit 0
fi

nota "la $NUOVA non risponde: torno alla $VECCHIA"
sudo systemctl stop istudio 2>>"$REGISTRO"
torna_indietro
sudo systemctl start istudio 2>>"$REGISTRO"

# ⚠️ E il ritorno indietro, ha funzionato? Prima non lo controllava nessuno: se
# falliva anche quello, il locale restava senza bot e il registro non diceva
# niente. Una riga che si legge è l'unica cosa che resta a chi guarda dopo.
TORNATA=""
for i in $(seq 1 "$ATTESA"); do
  if risponde "$PORTA"; then TORNATA="si"; break; fi
  sleep 1
done
if [ -n "$TORNATA" ]; then
  nota "tornata alla $VECCHIA, risponde ✅"
  [ -n "$ADESSO" ] && echo "   ⚠️  La nuova versione non partiva: sono tornato alla $VECCHIA."
else
  nota "❌ GRAVE: né la $NUOVA né la $VECCHIA rispondono. iStudio è FERMA."
  [ -n "$ADESSO" ] && {
    echo "   ❌ GRAVE: iStudio non riparte, né con la nuova né con la vecchia."
    echo "      Guarda:  bash \"$CARTELLA/Linux/Diagnostica.sh\""
  }
fi
