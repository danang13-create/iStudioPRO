#!/bin/bash
# ============================================================
#  Rimette in /etc il servizio, ripreso dal modello aggiornato
#
#      bash ~/iStudio/Linux/"Aggiorna il servizio.sh"
#
#  ⚠️ PERCHÉ SERVE UN COMANDO A PARTE. Il file che comanda davvero sta in
#     /etc/systemd/system/istudio.service, e lo scrive SOLO l'installatore.
#     L'aggiornamento notturno porta il modello nuovo dentro ~/iStudio/Linux,
#     ma in /etc non può scrivere — e non deve: il permesso senza password è
#     ristretto a start/stop/restart/reload di questo servizio, e allargarlo
#     vorrebbe dire dare root pieno a un comando che gira da solo alle 5 del
#     mattino. Quindi una correzione al modello resta lì finché qualcuno, con
#     la password, non la porta dentro. Questo comando fa quello, e basta.
#
#  ⚠️ NON tocca la password del servizio: /etc/istudio.env resta com'è, e la
#     riga che lo richiama viene rimessa. Riscriverla vorrebbe dire chiederla
#     di nuovo a chi voleva solo aggiornare il servizio.
# ============================================================
set -u
CARTELLA="$(cd "$(dirname "$0")/.." && pwd)"
MODELLO="$CARTELLA/Linux/istudio.service"
INSTALLATO=/etc/systemd/system/istudio.service

[ -f "$MODELLO" ] || { echo "❌ Manca $MODELLO."; exit 1; }
[ -f "$INSTALLATO" ] || { echo "❌ iStudio non risulta installata come servizio ($INSTALLATO non c'è)."
                          echo "   Per la prima installazione usa «Installa iStudio su Ubuntu.sh»."; exit 1; }

# Da dove gira adesso: si riprende dal servizio installato, non si indovina.
# Cambiare utente o cartella non è compito di questo comando.
UTENTE="$(systemctl show istudio -p User --value)"
DOVE="$(systemctl show istudio -p WorkingDirectory --value)"
NODE="$(command -v node || true)"
[ -n "$UTENTE" ] || UTENTE="$USER"
[ -n "$DOVE" ] || DOVE="$CARTELLA"
[ -n "$NODE" ] || { echo "❌ Non trovo «node» su questa macchina."; exit 1; }

NUOVO="$(mktemp)"
sed -e "s|@@UTENTE@@|$UTENTE|g" -e "s|@@CARTELLA@@|$DOVE|g" -e "s|@@NODE@@|$NODE|g" \
    "$MODELLO" > "$NUOVO"
# La password sta in /etc/istudio.env, che non tocchiamo: qui si rimette solo
# la riga che lo richiama, che nel modello non c'è.
if [ -f /etc/istudio.env ]; then
  sed -i '/^\[Service\]/a EnvironmentFile=/etc/istudio.env' "$NUOVO"
fi

if sudo diff -q "$INSTALLATO" "$NUOVO" >/dev/null 2>&1; then
  echo "✅ Il servizio installato è già quello nuovo: non c'è niente da fare."
  rm -f "$NUOVO"
  exit 0
fi

echo "⏳ Cosa cambia:"
sudo diff "$INSTALLATO" "$NUOVO" | sed 's/^/   /'
echo
printf "Lo scrivo e riavvio il servizio? [Invio = sì, n = no] "
read -r RISPOSTA
case "$RISPOSTA" in
  n|N|no|NO) echo "   Lasciato com'era."; rm -f "$NUOVO"; exit 0 ;;
esac

# ⚠️ Una copia di quello di prima: se il servizio non riparte, si torna indietro
# senza dover ricostruire niente a mente.
PRIMA="/tmp/istudio.service.prima-di-$(date +%Y%m%d-%H%M%S)"
sudo cp "$INSTALLATO" "$PRIMA"
sudo install -m 644 "$NUOVO" "$INSTALLATO"
rm -f "$NUOVO"
# ⚠️ Senza «daemon-reload» systemd continua a usare quello di PRIMA e avvisa
# «unit file changed on disk»: il file nuovo c'è e non comanda niente.
sudo systemctl daemon-reload
sudo systemctl restart istudio

echo -n "⏳ Aspetto che risponda"
for i in $(seq 1 30); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' -m 2 http://127.0.0.1:3100/ 2>/dev/null)" != "000" ]; then
    echo; echo "✅ Servizio aggiornato e iStudio risponde."
    echo "   La copia di prima, se mai servisse: $PRIMA"
    exit 0
  fi
  echo -n "."; sleep 1
done
echo
echo "❌ Il servizio non risponde. Rimetto quello di prima."
sudo install -m 644 "$PRIMA" "$INSTALLATO"
sudo systemctl daemon-reload
sudo systemctl restart istudio
echo "   Rimesso. Guarda cosa dice:  bash \"$CARTELLA/Linux/Diagnostica.sh\""
exit 1
