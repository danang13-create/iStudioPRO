#!/bin/bash
# ============================================================
#  Cambia la password della piattaforma, dal mini-PC
#
#      ssh istudio
#      bash ~/iStudio/Linux/"Cambia password.sh"
#
#  È la strada dell'AMMINISTRATORE, e funziona sempre: senza posta, senza
#  internet, senza che nessuno ricordi la password di adesso. Il titolare ne
#  ha due sue: «Cambia password» nel Profilo, se la ricorda, e «Password
#  dimenticata?» nella pagina d'accesso, che manda un codice all'assistenza.
#
#  La password di partenza sta in /etc/istudio.env, che legge solo root.
#  iStudio la tiene nel suo archivio e la riprende da qui ogni volta che
#  questo file CAMBIA — anche se nel frattempo il titolare ne aveva scelta
#  un'altra dal Profilo: il file dell'amministratore ha l'ultima parola.
#
#  ⚠️ Per questo accanto alla password si scrive ISTUDIO_PASSWORD_SCRITTA, la
#  data. Senza, rimettere la STESSA password di prima non sarebbe un
#  cambiamento: iStudio non lo noterebbe, e al ristorante continuerebbe a
#  valere quella del Profilo — con te convinto di averla rimessa.
#
#  Chi era dentro con la password vecchia esce, su tutti i dispositivi.
# ============================================================
set -u
CARTELLA="$(cd "$(dirname "$0")/.." && pwd)"
# ISTUDIO_ENV serve solo alle prove, che girano su un finto mini-PC.
FILE_ENV="${ISTUDIO_ENV:-/etc/istudio.env}"

rosso()  { printf '\033[31m%s\033[0m\n' "$*"; }
verde()  { printf '\033[32m%s\033[0m\n' "$*"; }
giallo() { printf '\033[33m%s\033[0m\n' "$*"; }

if ! sudo test -f "$FILE_ENV"; then
  rosso "❌ Non trovo $FILE_ENV: su questa macchina iStudio non ha una password."
  echo "   Per la prima installazione usa «Installa iStudio su Ubuntu.sh»."
  exit 1
fi

echo
echo "La password nuova della piattaforma (la chiederà il browser)."
PW=""
while [ -z "$PW" ]; do
  # ⚠️ Senza questo controllo, a fine input (Ctrl-D) «read» fallisce, PW resta
  # vuota e il giro ricomincia per sempre.
  read -r -s -p "   Password nuova: " PW || { echo; rosso "❌ Interrotto: la password non è cambiata."; exit 1; }
  echo
  if [ ${#PW} -lt 8 ]; then
    giallo "   Troppo corta: almeno 8 caratteri."; PW=""
    continue
  fi
  # Le stesse regole dell'installatore, per lo stesso motivo: la password passa
  # da un «EnvironmentFile» di systemd, che tratta a modo suo virgolette e barre
  # rovesce, e taglia gli spazi ai bordi. Arriverebbe a iStudio DIVERSA da come
  # è stata scritta: «password errata» con la password giusta.
  case "$PW" in
    *[\"\'\\]*)
      giallo "   Niente virgolette (\" ') né barre rovesce (\\): systemd le interpreta"
      giallo "   e la password arriverebbe storpiata. Tutto il resto va bene."
      PW=""; continue ;;
  esac
  case "$PW" in
    " "*|*" ")
      giallo "   Niente spazi all'inizio o alla fine: non si vedono e vanno persi."
      PW=""; continue ;;
  esac
  read -r -s -p "   Ripetila: " PW2 || { echo; rosso "❌ Interrotto: la password non è cambiata."; exit 1; }
  echo
  [ "$PW" = "$PW2" ] || { giallo "   Non coincidono, riproviamo."; PW=""; }
done

# Si riscrive il file tenendo le altre righe che ci fossero: questo comando
# cambia la password, non il resto.
NUOVO="$(mktemp)"   # nasce leggibile solo da chi lo crea
sudo grep -v -e '^ISTUDIO_PASSWORD=' -e '^ISTUDIO_PASSWORD_SCRITTA=' "$FILE_ENV" > "$NUOVO" || true
printf 'ISTUDIO_PASSWORD=%s\nISTUDIO_PASSWORD_SCRITTA=%s\n' "$PW" "$(date +%s)" >> "$NUOVO"
if ! sudo install -m 600 "$NUOVO" "$FILE_ENV"; then
  rm -f "$NUOVO"
  rosso "❌ Non sono riuscito a scrivere $FILE_ENV: la password non è cambiata."
  exit 1
fi
rm -f "$NUOVO"

echo "⏳ Riavvio iStudio, che la legge solo all'accensione…"
sudo systemctl restart istudio || { rosso "❌ Non riesco a riavviare il servizio."; exit 1; }

# ⚠️ Non si dà per buono: si prova la password, adesso, finché c'è qualcuno
# davanti. È lo stesso controllo dell'installatore.
echo -n "   ⏳ controllo che la password nuova funzioni"
RISPOSTA=""
for i in $(seq 1 45); do
  CODICE="$(printf '{"password":"%s"}' "$PW" \
    | curl -s -o /dev/null -w '%{http_code}' -m 3 \
           -H 'Content-Type: application/json' --data-binary @- \
           http://127.0.0.1:3100/api/login 2>/dev/null)"
  # 000 = non risponde ancora: sta ancora partendo, si riprova.
  [ "$CODICE" = "000" ] || { RISPOSTA="$CODICE"; break; }
  echo -n "."; sleep 1
done
echo
case "$RISPOSTA" in
  200)
    verde "✅ Fatto: la password nuova funziona."
    echo "   Chi era dentro con quella vecchia dovrà rientrare, su ogni dispositivo." ;;
  401)
    rosso "❌ iStudio è ripartita, ma NON accetta la password nuova."
    echo "   Vuol dire che nel passaggio attraverso systemd è cambiata."
    echo "   Rilancia questo comando con una password fatta solo di lettere,"
    echo "   numeri e - _ . (niente \$ né simboli strani)."
    exit 1 ;;
  "")
    giallo "⚠️  iStudio non ha ancora risposto: non ho potuto provare la password."
    giallo "   Controlla fra un minuto con:  bash \"$CARTELLA/Linux/Diagnostica.sh\""
    exit 1 ;;
  *)
    giallo "⚠️  Risposta inattesa dal controllo della password (HTTP $RISPOSTA)."
    giallo "   Controlla con:  bash \"$CARTELLA/Linux/Diagnostica.sh\""
    exit 1 ;;
esac
