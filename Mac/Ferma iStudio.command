#!/bin/bash
# Ferma la piattaforma iStudio

# Cartella e porta: quelle di sempre. Si possono cambiare solo impostando ISTUDIO_DIR e
# ISTUDIO_PORT prima di lanciare lo script, e serve unicamente per le prove su copie
# isolate — senza, «Ferma la prova» spegnerebbe la iStudio VERA sulla 3100.
ISTUDIO_DIR="${ISTUDIO_DIR:-$HOME/Documents/iStudio}"
PORTA="${ISTUDIO_PORT:-3100}"

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
