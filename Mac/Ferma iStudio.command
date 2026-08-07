#!/bin/bash
# Ferma la piattaforma iStudio

# Ogni copia comanda SÉ STESSA: la cartella si ricava da dove sta questo script, non
# da un percorso fisso. Prima era scritto dentro «$HOME/Documents/iStudio», e allora
# il «Ferma» di una copia messa altrove spegneva la iStudio di Documenti — cioè
# un'ALTRA installazione, magari nel bel mezzo di un invio.
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
# Stessa regola dell'avvio: le copie cliente stanno sulla 3200.
if [ -f "$ISTUDIO_DIR/copia-cliente.txt" ]; then PREDEFINITA=3200; else PREDEFINITA=3100; fi
PORTA="${ISTUDIO_PORT:-$PREDEFINITA}"

PIDS=$(lsof -ti :$PORTA 2>/dev/null)

if [ -z "$PIDS" ]; then
  echo "iStudio non è in esecuzione."
  sleep 2
  exit 0
fi

echo "⏳ Chiusura di iStudio in corso…"
kill $PIDS 2>/dev/null

# Il browser interno usato per WhatsApp impiega qualche secondo a chiudersi:
# aspetto che la porta sia davvero libera prima di dichiarare la chiusura.
for i in $(seq 1 15); do
  sleep 1
  [ -z "$(lsof -ti :$PORTA 2>/dev/null)" ] && break
done

# Se dopo 15 secondi resiste ancora, forzo la chiusura
if [ -n "$(lsof -ti :$PORTA 2>/dev/null)" ]; then
  kill -9 $(lsof -ti :$PORTA) 2>/dev/null
  sleep 2
fi

if [ -z "$(lsof -ti :$PORTA 2>/dev/null)" ]; then
  echo "🛑 iStudio è stata fermata. Contatti e collegamento WhatsApp restano salvati."
else
  echo "⚠️ Non sono riuscito a fermare iStudio. Riprova o riavvia il Mac."
fi

# Rete di sicurezza: chiude il browser interno rimasto orfano.
# Normalmente ci pensa iStudio da sola quando la si ferma. Ma se iStudio è MORTA per un
# errore, non ha potuto chiudere niente e quel browser resta acceso: da lì in poi ogni
# riavvio fallisce con «The browser is already running» e la piattaforma non riparte più.
# È successo il 5 agosto 2026 durante un invio da ~1500 destinatari: 5 riavvii falliti.
# Il filtro è la cartella del profilo di iStudio, quindi il Chrome con cui navighi non
# viene toccato: ha un profilo diverso.
ORFANI=$(pgrep -f "$ISTUDIO_DIR/.wwebjs_auth" 2>/dev/null)
if [ -n "$ORFANI" ]; then
  echo "🧹 Trovato un browser interno rimasto aperto: lo chiudo."
  kill -9 $ORFANI 2>/dev/null
fi
sleep 2
