#!/bin/bash
# ============================================================
#  Aggiorna iStudio adesso, senza aspettare le 5 del mattino
#
#  Si lancia così, dal mini-PC o da lontano con Tailscale:
#      bash ~/iStudio/"Linux/Aggiorna adesso.sh"
#
#  Fa esattamente quello che fa la notte — stesso controllo, stessa rete di
#  sicurezza, stesso ritorno indietro se la versione nuova non parte — solo
#  senza aspettare l'orario.
#
#  ⚠️ Non tocca i dati: prenotazioni, rubrica, collegamento WhatsApp e allegati
#     restano dove sono. Si sostituisce il programma, non il locale.
#
#  ⚠️ Se qui c'è già la versione pubblicata, non fa niente e lo dice: non è un
#     errore. Un aggiornamento si vede dal NUMERO, e un numero uguale vuol dire
#     programma uguale.
# ============================================================
set -u
QUI="$(cd "$(dirname "$0")" && pwd)"

if [ "$(id -u)" = "0" ]; then
  echo "❌ Non lanciarlo con «sudo»: iStudio appartiene al tuo utente normale."
  echo "   Rilancialo così:   bash ~/iStudio/\"Linux/Aggiorna adesso.sh\""
  exit 1
fi

echo "════════════════════════════════════════════"
echo "  Aggiornamento di iStudio"
echo "════════════════════════════════════════════"
echo
echo "   versione qui: $(tr -d ' \r\n' < "$QUI/../VERSIONE.txt" 2>/dev/null || echo sconosciuta)"
echo

exec bash "$QUI/aggiornamento-automatico.sh" --adesso
