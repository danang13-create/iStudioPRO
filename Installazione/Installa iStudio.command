#!/bin/bash
# ============================================================
#  Installa iStudio su questo Mac
#
#  Doppio click e basta. Fa tutto da solo:
#  scarica iStudio, la mette al posto giusto, installa quello che
#  serve, la configura e la avvia.
#
#  Non chiede di rinominare cartelle né di scrivere file a mano:
#  erano i due passaggi in cui si sbagliava più facilmente.
# ============================================================

DEPOSITO="danang13-create/iStudioPRO"
# Le due variabili qui sotto si possono cambiare da fuori, ma servono UNICAMENTE per
# collaudare l'installazione su una cartella finta senza rischiare quella vera
# (vedi NOTE-TECNICHE.md). Con il doppio click valgono sempre i valori normali.
DESTINAZIONE="${ISTUDIO_DEST:-$HOME/Documents/iStudio}"
URL="${ISTUDIO_URL:-https://codeload.github.com/$DEPOSITO/tar.gz/refs/heads/main}"
# Dove finisce una SECONDA iStudio installata accanto a una che c'è già (vedi più sotto).
AFFIANCATA="${DESTINAZIONE}-Cliente"

echo "════════════════════════════════════════════"
echo "  Installazione di iStudio"
echo "════════════════════════════════════════════"
echo
echo "Sto per installare iStudio in:"
echo "   $DESTINAZIONE"
echo
echo "Ci vogliono circa 10 minuti, quasi tutti di attesa."
echo "Serve una connessione a internet."
echo

# --- C'è già un'installazione? Mai sovrascriverla alla cieca ---
# Dentro ci sarebbero i contatti e il collegamento WhatsApp di chi la sta usando.
if [ -e "$DESTINAZIONE" ]; then
  if [ -f "$DESTINAZIONE/data.db" ]; then
    echo "⚠️  In quella cartella c'è GIÀ un'installazione di iStudio, con dei dati dentro."
    echo "   Non la tocco: se la sovrascrivessi perderesti contatti e cronologia."
    echo
    echo "   Se volevi solo aggiornarla, non serve reinstallare: iStudio si aggiorna da"
    echo "   sola a ogni avvio. Chiudi pure qui e fai doppio click su «Avvia iStudio»."
    echo
    # La seconda copia si offre SOLO se quella che c'è è una iStudio normale. Se è già
    # una copia in abbonamento, chi sta rilanciando l'installatore è un cliente che voleva
    # aggiornare: due copie cliente finirebbero sulla stessa porta 3200 e la seconda non
    # partirebbe, dicendo per giunta «è già avviata». Meglio non proporglielo affatto.
    if [ -f "$DESTINAZIONE/copia-cliente.txt" ]; then
      read -r -p "Premi Invio per chiudere…"
      exit 1
    fi
    echo "   ────────────────────────────────────────"
    echo "   Se invece ti serve una SECONDA iStudio accanto a quella che c'è già —"
    echo "   per esempio la versione in abbonamento, per vedere cosa vede un cliente —"
    echo "   posso installarla in una cartella tutta sua:"
    echo
    echo "        $AFFIANCATA"
    echo
    echo "   Le due non si danno fastidio: restano separate, con i propri contatti e la"
    echo "   propria cronologia, e ognuna risponde a un indirizzo diverso nel browser."
    echo "   Quella che c'è già non viene toccata in nessun modo."
    echo
    read -r -p "   Installo la seconda copia accanto? (scrivi si oppure no) " R
    case "$R" in
      s|si|sì|Si|Sì|SI|y|Y|yes) ;;
      *) echo "   Ok, non tocco niente."; read -r -p "Premi Invio per chiudere…"; exit 0 ;;
    esac
    # La seconda copia non deve poter cancellare una terza installazione: se la cartella
    # affiancata esiste già con dei dati dentro ci si ferma, come si è appena fatto per
    # la prima. Rinominare o rimuovere è una decisione di chi usa il Mac, non di questo script.
    if [ -f "$AFFIANCATA/data.db" ]; then
      echo
      echo "   ⚠️  Esiste già anche «$(basename "$AFFIANCATA")», e ha dei dati dentro."
      echo "      Anche questa non la tocco. Se non ti serve più, spostala nel Cestino"
      echo "      a mano e rilancia questa installazione."
      read -r -p "Premi Invio per chiudere…"
      exit 1
    fi
    rm -rf "$AFFIANCATA"          # eventuale cartella vuota o incompleta di un tentativo andato male
    DESTINAZIONE="$AFFIANCATA"
    echo
    echo "   Ok: installo la seconda copia in $DESTINAZIONE"
  else
    echo "⚠️  Esiste già una cartella «iStudio» in Documenti, ma sembra vuota o incompleta."
    read -r -p "   La sostituisco? (scrivi si oppure no) " R
    case "$R" in
      s|si|sì|Si|Sì|SI|y|Y|yes) rm -rf "$DESTINAZIONE" ;;
      *) echo "   Ok, non tocco niente."; read -r -p "Premi Invio per chiudere…"; exit 0 ;;
    esac
  fi
else
  read -r -p "Procedo con l'installazione? (scrivi si oppure no) " R
  case "$R" in
    s|si|sì|Si|Sì|SI|y|Y|yes) ;;
    *) echo "   Ok, non faccio niente."; read -r -p "Premi Invio per chiudere…"; exit 0 ;;
  esac
fi
echo

# --- 1. Scarico ---
echo "⏳ [1/5] Scarico iStudio…"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if ! curl -fsSL -m 180 "$URL" -o "$TMP/istudio.tar.gz"; then
  echo "   ❌ Scaricamento non riuscito. Controlla la connessione a internet e riprova."
  read -r -p "Premi Invio per chiudere…"; exit 1
fi
mkdir -p "$TMP/estratto"
if ! tar -xzf "$TMP/istudio.tar.gz" -C "$TMP/estratto"; then
  echo "   ❌ Il file scaricato è rovinato. Riprova fra qualche minuto."
  read -r -p "Premi Invio per chiudere…"; exit 1
fi
# GitHub racchiude tutto in una cartella dal nome variabile: si scende dentro.
SORGENTE="$TMP/estratto/$(ls -1 "$TMP/estratto" | head -1)"
if [ ! -f "$SORGENTE/server.js" ]; then
  echo "   ❌ Il pacchetto scaricato non è quello atteso. Avvisa chi ti ha dato questo file."
  read -r -p "Premi Invio per chiudere…"; exit 1
fi
echo "   ✅ scaricata"

# --- 2. Metto al posto giusto ---
echo "⏳ [2/5] Metto iStudio in Documenti…"
mkdir -p "$HOME/Documents"
if ! mv "$SORGENTE" "$DESTINAZIONE"; then
  echo "   ❌ Non riesco a creare la cartella. Controlla i permessi di Documenti."
  read -r -p "Premi Invio per chiudere…"; exit 1
fi
chmod +x "$DESTINAZIONE/Mac/"*.command 2>/dev/null
chmod +x "$DESTINAZIONE/Mac/"*.sh 2>/dev/null
# macOS marchia come "scaricato da internet" tutto quello che arriva dalla rete e poi
# si rifiuta di aprirlo. Qui lo si toglie, così i doppi click successivi funzionano
# senza il giro di click destro → Apri.
xattr -dr com.apple.quarantine "$DESTINAZIONE" 2>/dev/null
echo "   ✅ pronta"

# --- 3. Node.js e librerie ---
echo "⏳ [3/5] Installo quello che serve per farla funzionare…"
export PATH="$HOME/.local/node/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "   ⏳ scarico Node.js (circa 50 MB)…"
  if [ "$(uname -m)" = "arm64" ]; then ARCH="darwin-arm64"; else ARCH="darwin-x64"; fi
  VER="v22.14.0"
  mkdir -p "$HOME/.local"
  if ! curl -fsSL -m 300 "https://nodejs.org/dist/${VER}/node-${VER}-${ARCH}.tar.gz" -o "$TMP/node.tar.gz"; then
    echo "   ❌ Non riesco a scaricare Node.js. Controlla la connessione e rilancia."
    read -r -p "Premi Invio per chiudere…"; exit 1
  fi
  rm -rf "$HOME/.local/node"; mkdir -p "$HOME/.local/node"
  tar -xzf "$TMP/node.tar.gz" -C "$HOME/.local/node" --strip-components=1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "   ❌ Node.js non risulta installato. Rilancia questo file."
  read -r -p "Premi Invio per chiudere…"; exit 1
fi
echo "   ⏳ installo le librerie (qualche minuto, circa 100 MB)…"
# Il registro tiene la data nel nome: «/tmp/istudio-npm.log» era un nome fisso, e il primo
# tentativo successivo ci scriveva sopra — cancellando le prove proprio del guasto che si
# stava cercando di capire. Il collegamento «-ultimo» resta per chi sa già dove guardare.
LOG_NPM="/tmp/istudio-npm-$(date '+%Y%m%d-%H%M%S').log"
if ! (cd "$DESTINAZIONE" && npm install --no-audit --no-fund >"$LOG_NPM" 2>&1); then
  ln -sf "$LOG_NPM" /tmp/istudio-npm-ultimo.log 2>/dev/null
  echo "   ❌ Installazione delle librerie non riuscita."
  echo
  # L'errore va mostrato QUI. Mandare a cercare un file in /tmp significa, per chi non è
  # tecnico, non leggerlo mai — e intanto il tentativo dopo lo sovrascrive.
  echo "   ────────── ultime righe dell'errore ──────────"
  tail -15 "$LOG_NPM" | sed 's/^/   /'
  echo "   ──────────────────────────────────────────────"
  echo
  # Le due cause di gran lunga più frequenti, con il rimedio già scritto. Una delle
  # cinque librerie (better-sqlite3) non è JavaScript puro: se non esiste un pacchetto
  # già pronto per questo Mac, va compilata, e senza gli strumenti Apple non si può.
  if grep -qiE "gyp|clang|xcodebuild|command line tools|make: \*\*\*|node-pre-gyp" "$LOG_NPM"; then
    echo "   👉 Sembra mancare il compilatore di Apple. Prova così, poi rilancia:"
    echo
    echo "        xcode-select --install"
    echo
    echo "      Si apre una finestra di Apple: accetta e aspetta che finisca."
  elif grep -qiE "ENOTFOUND|ETIMEDOUT|ECONNRESET|network|EAI_AGAIN" "$LOG_NPM"; then
    echo "   👉 Sembra un problema di connessione, non del tuo Mac."
    echo "      Controlla internet e rilancia questo file: riprende da capo senza danni."
  fi
  echo
  echo "   Il registro completo è qui, e non verrà sovrascritto:"
  echo "        $LOG_NPM"
  read -r -p "Premi Invio per chiudere…"; exit 1
fi
echo "   ✅ fatto"

# --- 4. Collegamento sulla Scrivania ---
# Un alias al file «.command» erediterebbe l'icona del Terminale, che a un cliente non
# dice niente. Serve una vera applicazione: una cartella «.app» con dentro un lanciatore
# e l'icona. Costruirla a mano è banale e non richiede nessuno strumento da sviluppatore.
# L'app NON contiene iStudio: apre quella installata, quindi gli aggiornamenti valgono
# subito e il collegamento non va rifatto.
crea_collegamento() {
  # Due nomi diversi, e vanno tenuti separati:
  #  - «cartella» è dove sta iStudio, e serve al lanciatore per ritrovarla;
  #  - «nome» è la scritta sotto l'icona, che è un'altra cosa.
  local cartella="$(basename "$DESTINAZIONE")"
  # Stessa regola del bollino in alto a sinistra (`edizione` in /api/status): decide
  # «copia-cliente.txt». Così la Scrivania e il programma non possono mai dire il
  # contrario l'uno dell'altro.
  local nome="iStudio"
  [ -f "$DESTINAZIONE/copia-cliente.txt" ] && nome="iStudio PRO"

  local app="$HOME/Desktop/$nome.app"
  # Due installazioni sullo stesso Mac avrebbero lo stesso nome, e la seconda
  # cancellerebbe in silenzio il collegamento della prima — che resterebbe lì a puntare
  # alla cartella sbagliata. Se il nome è già preso da un collegamento verso un'ALTRA
  # cartella, si distingue. Se punta alla stessa, lo si rifà e basta.
  if [ -f "$app/Contents/MacOS/avvia" ] && \
     ! grep -q "^CARTELLA=\"$DESTINAZIONE\"$" "$app/Contents/MacOS/avvia" 2>/dev/null; then
    nome="$nome — $cartella"
    app="$HOME/Desktop/$nome.app"
  fi

  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" || return 1

  cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$nome</string>
  <key>CFBundleDisplayName</key><string>$nome</string>
  <key>CFBundleExecutable</key><string>avvia</string>
  <key>CFBundleIconFile</key><string>iStudio</string>
  <key>CFBundleIdentifier</key><string>it.istudio.avvio</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

  # Il percorso viene scritto qui dentro dall'installazione. L'unico ripiego è la cartella
  # con lo STESSO NOME in Documenti, per il caso di chi la sposta e poi la rimette al suo
  # posto. Di proposito NON si ripiega su un'altra iStudio qualsiasi: su un Mac dove
  # convivono la copia di lavoro e quella cliente, aprire quella sbagliata in silenzio è
  # peggio che non aprire niente — ed è lo stesso errore che «Avvia» e «Ferma» facevano
  # prima del 7 agosto 2026. Se non si trova nulla si avvisa con una finestra, invece di
  # restare muti: l'app non ha un Terminale dove scrivere.
  cat > "$app/Contents/MacOS/avvia" <<LANCIA
#!/bin/bash
CARTELLA="$DESTINAZIONE"
[ -d "\$CARTELLA" ] || CARTELLA="\$HOME/Documents/$cartella"
AVVIO="\$CARTELLA/Mac/Avvia iStudio.command"
if [ ! -x "\$AVVIO" ]; then
  osascript -e 'display alert "Non trovo iStudio" message "La cartella di iStudio è stata spostata o rinominata. Aprila e fai doppio click su «Avvia iStudio»." as critical'
  exit 1
fi
# stdin da /dev/null: senza Terminale una eventuale richiesta di premere Invio
# resterebbe appesa per sempre, e l'app sembrerebbe bloccata.
"\$AVVIO" </dev/null >/dev/null 2>&1
LANCIA
  chmod +x "$app/Contents/MacOS/avvia"

  if [ -f "$DESTINAZIONE/Installazione/iStudio.icns" ]; then
    cp "$DESTINAZIONE/Installazione/iStudio.icns" "$app/Contents/Resources/iStudio.icns"
  fi
  # Il Finder tiene in cache le icone: senza un tocco alla cartella .app a volte
  # continua a mostrare quella generica finché non si riavvia.
  touch "$app"
  NOME_COLLEGAMENTO="$nome"      # serve al messaggio qui sotto
  [ -x "$app/Contents/MacOS/avvia" ]
}

echo "⏳ [4/5] Metto il collegamento sulla Scrivania…"
if crea_collegamento; then
  echo "   ✅ fatto: «$NOME_COLLEGAMENTO» sulla Scrivania"
else
  # Non è un motivo per fermare l'installazione: iStudio funziona lo stesso, si apre
  # dalla sua cartella. Meglio dirlo e proseguire che far fallire tutto per un'icona.
  echo "   ⚠️  Non ci sono riuscito. Nessun problema: iStudio si apre dalla sua cartella."
fi

# --- 5. Avvio ---
# Lascia in vista solo «Avvia» e «Ferma»: il resto è roba tecnica che confonde.
[ -x "$DESTINAZIONE/Mac/riordina-cartella.sh" ] && "$DESTINAZIONE/Mac/riordina-cartella.sh" "$DESTINAZIONE"

echo "⏳ [5/5] Avvio iStudio…"
echo
# ISTUDIO_DIR va passato per forza: senza, «Avvia» ripiega sul suo valore predefinito
# ($HOME/Documents/iStudio) e accende UN'ALTRA iStudio invece di quella appena
# installata. Se su quel Mac ce n'è già una accesa, scrive perfino «è già avviata» e
# l'installazione si dichiara riuscita mentre la copia nuova non è mai partita.
# Con la destinazione predefinita i due valori coincidono e non cambia niente.
if ! ISTUDIO_DIR="$DESTINAZIONE" "$DESTINAZIONE/Mac/Avvia iStudio.command"; then
  echo "   ⚠️  Non è partita. Apri «$DESTINAZIONE» e fai doppio click su «Avvia iStudio»."
  read -r -p "Premi Invio per chiudere…"; exit 1
fi

echo
echo "════════════════════════════════════════════"
echo "  ✅ iStudio è installata"
echo "════════════════════════════════════════════"
echo
echo "Nel browser si è aperta la pagina di iStudio. Da qui:"
echo
echo "  1. Trovi il tuo CODICE INSTALLAZIONE (tipo IST-4K7P-9XQ2): comunicalo a chi"
echo "     ti ha fornito iStudio, con il pulsante che apre WhatsApp già compilato"
echo "  2. Ti arriva un seriale: incollalo nel riquadro e premi Attiva"
echo "  3. Poi vai in Impostazioni e collega WhatsApp inquadrando il QR col telefono"
echo
echo "D'ora in poi, per usare iStudio: apri «$DESTINAZIONE» e fai doppio click"
echo "su «Avvia iStudio». Gli aggiornamenti arrivano da soli: non devi fare niente."

# Avviso solo per la seconda copia affiancata. Le due iStudio convivono senza problemi,
# ma il telefono è uno solo: collegare WhatsApp qui aggiunge un dispositivo collegato,
# e farlo mentre l'altra sta inviando è il momento peggiore per muovere quel pezzo.
if [ "$DESTINAZIONE" = "$AFFIANCATA" ]; then
  echo
  echo "⚠️  Hai due iStudio su questo Mac, e restano separate: contatti, cronologia e"
  echo "   indirizzo nel browser sono diversi. Attento a una cosa sola: il telefono è"
  echo "   uno. Se sull'altra iStudio c'è un invio in corso, NON collegare WhatsApp qui"
  echo "   finché non è finito."
fi
echo
read -r -p "Premi Invio per chiudere…"
