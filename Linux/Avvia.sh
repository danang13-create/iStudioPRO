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

# Sulle copie dei clienti rimette in ordine la cartella: dopo un aggiornamento
# i file appena arrivati tornerebbero visibili. Sulle altre non fa niente.
[ -x "$CARTELLA/Linux/riordina-cartella.sh" ] && "$CARTELLA/Linux/riordina-cartella.sh" "$CARTELLA"

echo "⏳ Aggiorno iStudio…"
bash "$CARTELLA/Linux/aggiornamento-automatico.sh" --adesso

# ⚠️ Il file del servizio è cambiato sul disco e systemd usa ancora quello di
# prima: è il «Warning: The unit file … changed on disk. Run 'systemctl
# daemon-reload'» visto sul mini-PC (19 ottobre 2026). Riavviare non basta —
# il file nuovo resta lì e non comanda niente. Glielo si fa rileggere QUI,
# dove c'è qualcuno davanti che può dare la password; l'aggiornamento delle 5
# non può (il permesso senza password è solo start/stop/restart/reload).
if systemctl show istudio -p NeedDaemonReload --value 2>/dev/null | grep -q yes; then
  echo "⏳ Il servizio è cambiato sul disco: lo faccio rileggere (può chiedere la password del computer)…"
  sudo systemctl daemon-reload \
    || echo "⚠️  Non sono riuscito a farlo rileggere. A mano:  sudo systemctl daemon-reload"
fi

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
