#!/bin/bash
# ============================================================
#  Diagnostica di iStudio
#
#      bash Diagnostica.sh
#
#  Risponde a tre domande, in questo ordine: è viva? a che indirizzo la
#  raggiungo? e se non va, cosa dice il registro?
#
#  ⚠️ Non ripara niente di proposito. Uno strumento che "aggiusta" mentre
#     guardi ti toglie l'unica cosa che serve al telefono: sapere com'era
#     PRIMA che qualcuno toccasse qualcosa.
# ============================================================

set -u
CARTELLA="$(cd "$(dirname "$0")/.." && pwd)"

echo "════════════════════════════════════════════"
echo "  Diagnostica di iStudio"
echo "  $(date '+%d/%m/%Y %H:%M')"
echo "════════════════════════════════════════════"
echo

# --- 1. Il servizio ---
echo "── Il servizio ──"
if systemctl is-active --quiet istudio; then
  echo "   ✅ iStudio è ACCESA"
  echo "   accesa da: $(systemctl show istudio -p ActiveEnterTimestamp --value)"
else
  echo "   ❌ iStudio è SPENTA"
  echo "   stato: $(systemctl is-active istudio 2>/dev/null) / $(systemctl is-failed istudio 2>/dev/null)"
fi
if systemctl is-enabled --quiet istudio 2>/dev/null; then
  echo "   ✅ riparte da sola all'accensione"
else
  echo "   ⚠️  NON riparte da sola: dopo un blackout resterebbe spenta."
  echo "      Rimedio:  sudo systemctl enable istudio"
fi
echo

# --- 2. Risponde davvero? ---
# ⚠️ «Il servizio è attivo» non vuol dire «la pagina si apre»: node può essere
# vivo con dentro un errore. L'unica prova che conta è chiedere una pagina.
echo "── Risponde? ──"
for P in 3100 3101; do
  COSA=$([ "$P" = 3100 ] && echo "piattaforma" || echo "pagina sala")
  CODICE="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$P/" 2>/dev/null)"
  case "$CODICE" in
    200|401) echo "   ✅ $COSA (porta $P) risponde — HTTP $CODICE" ;;
    000)     echo "   ❌ $COSA (porta $P) NON risponde" ;;
    *)       echo "   ⚠️  $COSA (porta $P) risponde HTTP $CODICE" ;;
  esac
done
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo "   indirizzo in questa rete:  http://${IP:-?}:3100"
if command -v tailscale >/dev/null 2>&1; then
  TS="$(tailscale ip -4 2>/dev/null | head -1)"
  [ -n "$TS" ] && echo "   da fuori con Tailscale:    http://$TS:3100"
fi
echo

# --- 3. WhatsApp ---
echo "── WhatsApp ──"
if [ -d "$CARTELLA/.wwebjs_auth" ]; then
  echo "   ✅ sessione presente (collegato almeno una volta)"
else
  echo "   ⚠️  nessuna sessione: WhatsApp non è mai stato collegato."
  echo "      Apri la piattaforma e inquadra il QR code."
fi
PROC="$(pgrep -c -f 'chrome|chromium' 2>/dev/null || echo 0)"
echo "   processi del browser attivi: $PROC"
echo

# --- 4. Spazio e memoria ---
# Il disco pieno è la causa che non sospetta nessuno: il database smette di
# scrivere e le prenotazioni spariscono senza un errore visibile in pagina.
echo "── Spazio e memoria ──"
df -h "$CARTELLA" | awk 'NR==2 {printf "   disco: %s usati su %s (%s pieno)\n", $3, $2, $5}'
LIBERO="$(df --output=pcent "$CARTELLA" | tail -1 | tr -cd '0-9')"
[ "${LIBERO:-0}" -ge 90 ] && echo "   ⚠️  DISCO QUASI PIENO: sopra il 90% iStudio può smettere di salvare."
free -h | awk 'NR==2 {printf "   memoria: %s usati su %s\n", $3, $2}'
if [ -f "$CARTELLA/data.db" ]; then
  echo "   database: $(du -h "$CARTELLA/data.db" | cut -f1)"
else
  echo "   ⚠️  data.db non c'è: iStudio non è mai partita in questa cartella."
fi
echo

# --- 5. Versione ---
echo "── Versione ──"
echo "   iStudio: $(tr -d ' \r\n' < "$CARTELLA/VERSIONE.txt" 2>/dev/null || echo '?')"
echo "   Node.js: $(node -v 2>/dev/null || echo 'non trovato')"
echo "   Ubuntu:  $(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-?}")"
echo

# --- 6. Il registro ---
echo "── Ultimi errori nel registro ──"
ERR="$(journalctl -u istudio --since '48 hours ago' --no-pager 2>/dev/null | grep -iE 'error|errore|failed|exception' | tail -12)"
if [ -n "$ERR" ]; then
  echo "$ERR" | sed 's/^/   /'
else
  echo "   nessun errore nelle ultime 48 ore ✅"
fi
echo
echo "   Registro completo:   journalctl -u istudio -f"
echo
