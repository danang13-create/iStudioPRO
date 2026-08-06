#!/bin/bash
# ============================================================
#  Aggiornamento automatico di iStudio (solo copie dei clienti)
#
#  Lo chiama «Avvia iStudio.command» prima di accendere iStudio.
#  Non va lanciato a mano: da solo non fa danni, ma non serve a niente.
#
#  È TUTTO FACOLTATIVO. Si accende solo se esiste il file
#  «aggiornamenti-di-questo-mac.txt» nella cartella di iStudio, che
#  contiene una riga sola: il deposito pubblico da cui scaricare
#  (per esempio  danang13-create/istudio-rilasci ).
#  Se quel file NON c'è — cioè sui Mac di chi sviluppa — questo script
#  esce subito e non contatta nessuno.
#
#  REGOLA D'ORO: non deve MAI impedire a iStudio di partire.
#  Niente internet, GitHub giù, pacchetto rotto → si rinuncia
#  all'aggiornamento in silenzio e iStudio parte con quello che ha.
#
#  Codici di uscita:  0 = niente da fare   10 = aggiornato
# ============================================================

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CFG="$BASE_DIR/aggiornamenti-di-questo-mac.txt"
BACKUP="$BASE_DIR/.versione-precedente"

[ -f "$CFG" ] || exit 0                       # non è una copia cliente: non se ne parla
DEPOSITO="$(tr -d ' \r\n' < "$CFG")"
[ -n "$DEPOSITO" ] || exit 0

# Indirizzi. ISTUDIO_UPDATE_BASE serve SOLO per le prove: punta a un finto GitHub
# locale, così si può collaudare tutto senza pubblicare niente sul serio.
if [ -n "$ISTUDIO_UPDATE_BASE" ]; then
  URL_VERSIONE="$ISTUDIO_UPDATE_BASE/VERSIONE.txt"
  URL_PACCHETTO="$ISTUDIO_UPDATE_BASE/pacchetto.tar.gz"
else
  URL_VERSIONE="https://raw.githubusercontent.com/$DEPOSITO/main/VERSIONE.txt"
  URL_PACCHETTO="https://codeload.github.com/$DEPOSITO/tar.gz/refs/heads/main"
fi

VERSIONE_LOCALE="$(tr -d ' \r\n' < "$BASE_DIR/VERSIONE.txt" 2>/dev/null)"

# --- 1. c'è una versione più nuova? (poca attesa: non si tiene fermo l'avvio) ---
VERSIONE_REMOTA="$(curl -fsS -m 15 "$URL_VERSIONE" 2>/dev/null | tr -d ' \r\n')"
if [ -z "$VERSIONE_REMOTA" ]; then
  echo "   (nessun aggiornamento: non riesco a contattare il deposito, va bene lo stesso)"
  exit 0
fi
[ "$VERSIONE_REMOTA" = "$VERSIONE_LOCALE" ] && exit 0

echo "⏳ È disponibile la versione $VERSIONE_REMOTA (hai la ${VERSIONE_LOCALE:-sconosciuta}). La scarico…"

# --- 2. scarico ed estraggo in una cartella temporanea ---
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! curl -fsSL -m 120 "$URL_PACCHETTO" -o "$TMP/pacchetto.tar.gz" 2>/dev/null; then
  echo "   ⚠️  Scaricamento non riuscito: proseguo con la versione attuale."
  exit 0
fi
mkdir -p "$TMP/estratto"
if ! tar -xzf "$TMP/pacchetto.tar.gz" -C "$TMP/estratto" 2>/dev/null; then
  echo "   ⚠️  Pacchetto illeggibile: proseguo con la versione attuale."
  exit 0
fi

# GitHub mette tutto dentro una cartella con un nome che cambia ogni volta:
# se c'è una sola cartella, si scende dentro.
NUOVA="$TMP/estratto"
if [ "$(ls -1 "$NUOVA" | wc -l)" -eq 1 ] && [ -d "$NUOVA/$(ls -1 "$NUOVA")" ]; then
  NUOVA="$NUOVA/$(ls -1 "$NUOVA")"
fi

# --- 3. controlli PRIMA di toccare qualsiasi cosa ---
if [ ! -f "$NUOVA/server.js" ] || [ ! -f "$NUOVA/public/index.html" ]; then
  echo "   ⚠️  Il pacchetto non contiene i file attesi: non aggiorno."
  exit 0
fi
if ! node --check "$NUOVA/server.js" >/dev/null 2>&1; then
  echo "   ⚠️  Il programma scaricato contiene un errore: non aggiorno."
  exit 0
fi

# --- 4. metto da parte la versione attuale (rete di sicurezza per il ritorno indietro) ---
rm -rf "$BACKUP"; mkdir -p "$BACKUP"
for f in server.js package.json VERSIONE.txt; do
  [ -f "$BASE_DIR/$f" ] && cp "$BASE_DIR/$f" "$BACKUP/$f"
done
[ -d "$BASE_DIR/public" ] && cp -R "$BASE_DIR/public" "$BACKUP/public"

# --- 5. installo ---
# Si usa `mv` e MAI `cp`: sovrascrivere un file .command mentre la shell lo sta
# ancora leggendo lo manderebbe in tilt a metà esecuzione. `mv` cambia solo il nome
# nella cartella, e chi ha il file già aperto continua a leggere quello vecchio.
installa() {
  local sorgente="$1" destinazione="$2"
  [ -e "$sorgente" ] || return 0
  rm -rf "$destinazione.nuovo"
  cp -R "$sorgente" "$destinazione.nuovo" || return 1
  rm -rf "$destinazione.vecchio"
  [ -e "$destinazione" ] && mv "$destinazione" "$destinazione.vecchio"
  mv "$destinazione.nuovo" "$destinazione" || return 1
  rm -rf "$destinazione.vecchio"
}

installa "$NUOVA/server.js"    "$BASE_DIR/server.js"
installa "$NUOVA/public"       "$BASE_DIR/public"
installa "$NUOVA/package.json" "$BASE_DIR/package.json"
# Gli script di avvio/arresto: utile poterli correggere a distanza.
for c in "Avvia iStudio.command" "Ferma iStudio.command"; do
  installa "$NUOVA/$c" "$BASE_DIR/$c" && chmod +x "$BASE_DIR/$c" 2>/dev/null
done
[ -d "$NUOVA/Comandi avanzati" ] && installa "$NUOVA/Comandi avanzati" "$BASE_DIR/Comandi avanzati" \
  && chmod +x "$BASE_DIR/Comandi avanzati/"*.command "$BASE_DIR/Comandi avanzati/"*.sh 2>/dev/null

# --- 6. librerie, se sono cambiate ---
if ! cmp -s "$BACKUP/package.json" "$BASE_DIR/package.json" 2>/dev/null; then
  echo "   ⏳ Sono cambiate le librerie, le aggiorno…"
  (cd "$BASE_DIR" && npm install --no-audit --no-fund >/tmp/istudio-npm.log 2>&1) \
    || echo "   ⚠️  Problema con le librerie: vedi /tmp/istudio-npm.log"
fi

printf '%s\n' "$VERSIONE_REMOTA" > "$BASE_DIR/VERSIONE.txt"
echo "   ✅ Aggiornata alla versione $VERSIONE_REMOTA."
exit 10
