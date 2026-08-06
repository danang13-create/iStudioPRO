#!/bin/bash
# Avvia la piattaforma iStudio e apre la pagina nel browser
export PATH="$HOME/.local/node/bin:$PATH"

# La cartella di iStudio. Resta quella di sempre; si può cambiare solo impostando
# ISTUDIO_DIR prima di lanciare lo script, cosa che serve unicamente per le prove
# su copie isolate (vedi NOTE-TECNICHE.md).
ISTUDIO_DIR="${ISTUDIO_DIR:-$HOME/Documents/iStudio}"
PORTA="${ISTUDIO_PORT:-3100}"
cd "$ISTUDIO_DIR" || exit 1

# Chrome personalizzato per QUESTO computer (facoltativo).
# Serve sui Mac più vecchi, dove il browser che WhatsApp scarica da solo non parte:
# in quel caso si mette qui il percorso di un Google Chrome installato a mano.
# Il file "chrome-di-questo-mac.txt" NON va su GitHub: è diverso per ogni computer.
CFG_CHROME="$ISTUDIO_DIR/chrome-di-questo-mac.txt"
if [ -f "$CFG_CHROME" ]; then
  export PUPPETEER_EXECUTABLE_PATH="$(cat "$CFG_CHROME")"
fi

# Licenza (facoltativo): serve solo sulle copie installate sui Mac dei clienti.
# Se il file c'è, contiene l'indirizzo dell'«Amministratore dei iStudio client», che
# decide se questa installazione può funzionare. Se il file NON c'è, iStudio funziona
# come sempre e non contatta nessuno: è il caso dell'uso personale.
# Anche questo file NON va su GitHub: è diverso per ogni computer.
CFG_LICENZA="$ISTUDIO_DIR/licenza-di-questo-mac.txt"
if [ -f "$CFG_LICENZA" ]; then
  export LICENSE_SERVER_URL="$(tr -d '\r\n' < "$CFG_LICENZA")"
fi

# Accende iStudio e aspetta che risponda davvero sulla porta 3100.
accendi() {
  mkdir -p "$HOME/Library/Logs"
  PORT=$PORTA nohup node server.js >> "$HOME/Library/Logs/istudio.log" 2>&1 &
  disown
  for _ in $(seq 1 10); do
    sleep 1
    lsof -ti :$PORTA >/dev/null 2>&1 && return 0
  done
  return 1
}

if lsof -ti :$PORTA >/dev/null 2>&1; then
  echo "✅ iStudio è già avviata."
else
  # Aggiornamento automatico: attivo solo sulle copie dei clienti (vedi lo script).
  # Non può impedire l'avvio: se qualcosa non va, rinuncia e si prosegue.
  AGGIORNATA=0
  if [ -x "$ISTUDIO_DIR/Comandi avanzati/aggiornamento-automatico.sh" ]; then
    "$ISTUDIO_DIR/Comandi avanzati/aggiornamento-automatico.sh"
    [ $? -eq 10 ] && AGGIORNATA=1
  fi

  echo "⏳ Avvio iStudio…"
  if accendi; then
    echo "✅ iStudio è partita."
  elif [ "$AGGIORNATA" = 1 ] && [ -d "$ISTUDIO_DIR/.versione-precedente" ]; then
    # La versione appena scaricata non parte: si torna indietro da soli.
    # Senza questo, un aggiornamento sbagliato lascerebbe il cliente con iStudio
    # morta e nessun modo di rimediare da solo.
    echo "⚠️  La versione appena scaricata non parte: torno a quella precedente…"
    BK="$ISTUDIO_DIR/.versione-precedente"
    [ -f "$BK/server.js" ]    && cp "$BK/server.js"    "$ISTUDIO_DIR/server.js"
    [ -f "$BK/package.json" ] && cp "$BK/package.json" "$ISTUDIO_DIR/package.json"
    [ -f "$BK/VERSIONE.txt" ] && cp "$BK/VERSIONE.txt" "$ISTUDIO_DIR/VERSIONE.txt"
    [ -d "$BK/public" ]       && rm -rf "$ISTUDIO_DIR/public" \
                              && cp -R "$BK/public" "$ISTUDIO_DIR/public"
    if accendi; then
      echo "✅ iStudio è ripartita con la versione precedente."
      echo "   L'aggiornamento verrà riprovato al prossimo avvio."
    else
      echo "❌ iStudio non parte. Dettagli in: ~/Library/Logs/istudio.log"
      read -r -p "Premi Invio per chiudere…"
      exit 1
    fi
  else
    echo "❌ Qualcosa è andato storto. Dettagli in: ~/Library/Logs/istudio.log"
    read -r -p "Premi Invio per chiudere…"
    exit 1
  fi
fi

open "http://localhost:$PORTA"
echo ""
echo "La pagina si sta aprendo nel browser: http://localhost:$PORTA"
echo "Puoi chiudere questa finestra: iStudio resta attiva finché non spegni il Mac"
echo "o non usi «Ferma iStudio»."
sleep 2
