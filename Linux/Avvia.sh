#!/bin/bash
# ============================================================
#  Avvia (o riavvia) iStudio, aggiornandola
#
#      bash Avvia.sh
#
#  Su Mac iStudio si aggiorna a ogni avvio. Qui il servizio non si ferma mai,
#  quindi l'aggiornamento tocca all'orario notturno — ma quando si riavvia a
#  mano è perché è appena uscita una versione, e aspettare le 5 non ha senso.
# ============================================================
set -u
CARTELLA="$(cd "$(dirname "$0")/.." && pwd)"

echo "⏳ Aggiorno iStudio…"
bash "$CARTELLA/Linux/aggiornamento-automatico.sh" --adesso

echo "⏳ Riavvio il servizio…"
sudo systemctl restart istudio || { echo "❌ Non riesco a riavviare il servizio."; exit 1; }

# ⚠️ Il servizio "attivo" non vuol dire che la pagina si apra: node può essere
# vivo con dentro un errore. Si aspetta la pagina, non il processo.
echo -n "⏳ Aspetto che risponda"
for i in $(seq 1 30); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 http://127.0.0.1:3100/ 2>/dev/null)" != "000" ]; then
    echo; echo "✅ iStudio è accesa — http://$(hostname -I | awk '{print $1}'):3100"
    exit 0
  fi
  echo -n "."; sleep 1
done
echo
echo "⚠️  Il servizio è partito ma la pagina non risponde ancora."
echo "   Guarda cosa dice:   bash \"$CARTELLA/Linux/Diagnostica.sh\""
