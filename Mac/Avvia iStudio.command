#!/bin/bash
# Avvia la piattaforma iStudio e apre la pagina nel browser
export PATH="$HOME/.local/node/bin:$PATH"

# Ogni copia avvia SÉ STESSA: la cartella si ricava da dove sta questo script, non da
# un percorso fisso. Prima era scritto dentro «$HOME/Documents/iStudio», e allora una
# copia messa altrove avviava la iStudio di Documenti — cioè un'ALTRA installazione —
# e dichiarava perfino di essere partita. Vale anche per il cliente che sposta la
# cartella sulla Scrivania o dentro OneDrive: prima si rompeva tutto senza spiegazioni.
# Due posizioni possibili, ed è giusto che siano entrambe: questo script vive in «Mac»,
# ma sulle copie dei clienti «riordina-cartella.sh» mette anche un richiamo di una riga
# nella cartella principale, che però entra qui dentro prima di eseguirlo.
# ISTUDIO_DIR resta rispettata se qualcuno la imposta da fuori (serve alle prove), e se
# lo script finisse in un posto irriconoscibile si torna al percorso di sempre.
QUI="$(cd "$(dirname "$0")" && pwd)"
if [ -f "$QUI/server.js" ]; then       PROPRIA="$QUI"
elif [ -f "$QUI/../server.js" ]; then  PROPRIA="$(cd "$QUI/.." && pwd)"
else                                   PROPRIA="$HOME/Documents/iStudio"; fi
ISTUDIO_DIR="${ISTUDIO_DIR:-$PROPRIA}"
# Le copie dei clienti vivono sulla 3200, quelle di sviluppo sulla 3100. Così le due
# possono stare accese sullo stesso Mac senza darsi fastidio: prima una copia cliente
# installata accanto alla iStudio di lavoro non partiva, perché trovava la porta occupata.
if [ -f "$ISTUDIO_DIR/copia-cliente.txt" ]; then PREDEFINITA=3200; else PREDEFINITA=3100; fi
PORTA="${ISTUDIO_PORT:-$PREDEFINITA}"
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

# L'aggiornamento va fatto PRIMA di guardare se la porta è occupata, e prima di
# qualunque altra cosa. Se si controlla la porta per prima, un'installazione che la
# trova occupata dice «è già avviata» ed esce: non si aggiorna MAI, e resta bloccata
# per sempre su una versione vecchia. È successo davvero il 7 agosto 2026, su una copia
# cliente installata accanto a una iStudio già in funzione.
AGGIORNATA=0
if [ -n "$ISTUDIO_GIA_AGGIORNATO" ]; then
  AGGIORNATA=1      # ci siamo appena riavviati dopo un aggiornamento (vedi sotto)
elif [ -x "$ISTUDIO_DIR/Mac/aggiornamento-automatico.sh" ]; then
  "$ISTUDIO_DIR/Mac/aggiornamento-automatico.sh"
  if [ $? -eq 10 ]; then
    # L'aggiornamento ha cambiato anche QUESTO script, che però è già in esecuzione
    # nella versione vecchia. Ripartendo da capo valgono subito le regole nuove —
    # per esempio la porta — invece che solo al prossimo avvio.
    export ISTUDIO_GIA_AGGIORNATO=1
    exec "$ISTUDIO_DIR/Mac/Avvia iStudio.command"
  fi
fi

# Sulle copie dei clienti rimette in ordine la cartella: dopo un aggiornamento
# i file appena arrivati tornerebbero visibili. Sulle altre non fa niente.
[ -x "$ISTUDIO_DIR/Mac/riordina-cartella.sh" ] && "$ISTUDIO_DIR/Mac/riordina-cartella.sh" "$ISTUDIO_DIR"

if lsof -ti :$PORTA >/dev/null 2>&1; then
  echo "✅ iStudio è già avviata."
else
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
    [ -d "$BK/public-sala" ]  && rm -rf "$ISTUDIO_DIR/public-sala" \
                              && cp -R "$BK/public-sala" "$ISTUDIO_DIR/public-sala"
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
echo "o non usi «Ferma iStudio» nella cartella Mac."
sleep 2
