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

# Il confronto è «diversa», non «più recente», ed è voluto: così ripubblicando una
# versione precedente si fa tornare indietro tutti i clienti in un colpo solo, che è
# il modo più rapido di rimediare a un rilascio sbagliato. Il messaggio quindi non
# promette «una versione più nuova»: dice solo che ci si allinea a quella pubblicata.
echo "⏳ La versione pubblicata è $VERSIONE_REMOTA, qui c'è la ${VERSIONE_LOCALE:-sconosciuta}. Mi allineo…"

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

# Si installa TUTTO quello che c'è nel pacchetto, tranne ciò che appartiene a questa
# installazione (dati e configurazione). Prima l'elenco era fisso, file per file: così
# però una versione con cartelle NUOVE non le avrebbe mai portate, perché a decidere è
# l'aggiornatore VECCHIO, che quelle cartelle non le conosce. È esattamente quello che
# sarebbe successo passando da 2026.08.06.3 a .4, quando i comandi sono stati divisi in
# «Mac» e «Windows»: l'installazione sarebbe rimasta metà vecchia e metà nuova, per sempre.
# Con l'elenco al contrario (cosa NON toccare) il problema non si ripresenta.
# Cosa NON si tocca: i dati del cliente, e i due file che dicono «chi sono» —
# «aggiornamenti-di-questo-mac.txt» perché sovrascriverlo con un valore sbagliato
# toglierebbe al cliente la possibilità stessa di ricevere correzioni, e VERSIONE.txt
# perché lo scrive l'aggiornatore alla fine.
# «assistenza-whatsapp.txt» e la chiave pubblica invece SÌ: sono roba
# dell'amministratore, e se cambia numero o chiave i clienti devono riceverla.
DA_NON_TOCCARE="data.db|data.db-.*|\.wwebjs_auth|\.wwebjs_cache|allegati-invii|node_modules|\.versione-precedente|VERSIONE\.txt|aggiornamenti-di-questo-mac\.txt|chrome-di-questo-mac\.txt|\.git"

for elemento in "$NUOVA"/* "$NUOVA"/.[!.]*; do
  [ -e "$elemento" ] || continue
  nome="$(basename "$elemento")"
  if printf '%s' "$nome" | grep -qE "^($DA_NON_TOCCARE)$"; then continue; fi
  installa "$elemento" "$BASE_DIR/$nome"
done
chmod +x "$BASE_DIR/Mac/"*.command "$BASE_DIR/Mac/"*.sh 2>/dev/null
chmod +x "$BASE_DIR"/*.command 2>/dev/null

# --- 6. librerie, se sono cambiate ---
if ! cmp -s "$BACKUP/package.json" "$BASE_DIR/package.json" 2>/dev/null; then
  echo "   ⏳ Sono cambiate le librerie, le aggiorno…"
  (cd "$BASE_DIR" && npm install --no-audit --no-fund >/tmp/istudio-npm.log 2>&1) \
    || echo "   ⚠️  Problema con le librerie: vedi /tmp/istudio-npm.log"
fi

printf '%s\n' "$VERSIONE_REMOTA" > "$BASE_DIR/VERSIONE.txt"
echo "   ✅ Ora è alla versione $VERSIONE_REMOTA."
exit 10
