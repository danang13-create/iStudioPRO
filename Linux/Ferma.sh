#!/bin/bash
# ============================================================
#  Ferma iStudio
#
#      bash Ferma.sh
#
#  ⚠️ Resta ferma finché non si lancia «Avvia.sh» — MA se qualcuno riavvia la
#     macchina, o va via la corrente, iStudio riparte da sola.
#
#     È voluto, ed è la direzione giusta in cui sbagliare: chi ferma iStudio
#     per farci qualcosa sopra è lì e se ne ricorda; chi la dimentica ferma
#     non c'è, e un ristorante col bot muto per giorni è molto peggio di un
#     aggiornamento interrotto. Per tenerla ferma davvero, anche dopo un
#     riavvio, serve dirlo a mano:  sudo systemctl disable istudio
# ============================================================
set -u
CARTELLA="$(cd "$(dirname "$0")/.." && pwd)"

echo "⏳ Fermo iStudio…"
sudo systemctl stop istudio

# Gli orfani di Chromium tengono occupato il profilo di WhatsApp, e al riavvio
# successivo iStudio non riesce ad aprirlo (5 agosto 2026, cinque riavvii di
# fila). «KillMode=control-group» nel servizio dovrebbe bastare: questa è la
# rete di sicurezza, come su Mac.
sleep 2
RIMASTI="$(pgrep -f "$CARTELLA.*chrome" 2>/dev/null | wc -l)"
if [ "$RIMASTI" -gt 0 ]; then
  echo "   ⏳ chiudo $RIMASTI processi del browser rimasti indietro…"
  pkill -f "$CARTELLA.*chrome" 2>/dev/null
  sleep 2
  pkill -9 -f "$CARTELLA.*chrome" 2>/dev/null
fi

if systemctl is-active --quiet istudio; then
  echo "❌ Non è riuscita a fermarsi. Guarda:  journalctl -u istudio -n 50"
  exit 1
fi
echo "✅ iStudio è ferma."
echo
echo "   Per riaccenderla:   bash \"$CARTELLA/Linux/Avvia.sh\""
echo
echo "   ⚠️  Se la macchina si riavvia — o va via la corrente — iStudio riparte"
echo "       da sola. Per tenerla ferma davvero:  sudo systemctl disable istudio"
