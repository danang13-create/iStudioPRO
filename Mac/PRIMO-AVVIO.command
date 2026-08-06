#!/bin/bash
# ============================================================
#  iStudio — Preparazione di un nuovo Mac
#  Da eseguire UNA VOLTA SOLA dopo aver scaricato il progetto.
#  Doppio click su questo file.
# ============================================================

cd "$(dirname "$0")/.." || exit 1  # sale dalla cartella "Comandi avanzati" alla cartella iStudio
echo "════════════════════════════════════════════"
echo "  Preparazione di iStudio su questo Mac"
echo "════════════════════════════════════════════"
echo

# ---------- 1. Node.js ----------
export PATH="$HOME/.local/node/bin:$PATH"

if command -v node >/dev/null 2>&1; then
  echo "✅ Node.js già presente ($(node --version))"
else
  echo "⚠️  Node.js non è installato su questo Mac."
  echo "   Serve per far funzionare iStudio (circa 50 MB)."
  echo
  read -r -p "   Vuoi che lo scarichi dal sito ufficiale nodejs.org? [s/n] " RISPOSTA
  if [ "$RISPOSTA" != "s" ] && [ "$RISPOSTA" != "S" ]; then
    echo "   Annullato. Puoi installarlo a mano da https://nodejs.org e rilanciare questo script."
    read -r -p "Premi Invio per chiudere…"
    exit 1
  fi

  # architettura del Mac (Apple Silicon o Intel)
  if [ "$(uname -m)" = "arm64" ]; then ARCH="darwin-arm64"; else ARCH="darwin-x64"; fi
  VERSIONE="v22.14.0"
  URL="https://nodejs.org/dist/${VERSIONE}/node-${VERSIONE}-${ARCH}.tar.gz"

  echo "   ⏳ Scarico Node ${VERSIONE} (${ARCH})…"
  mkdir -p "$HOME/.local"
  if ! curl -fsSL "$URL" -o /tmp/node-istudio.tar.gz; then
    echo "   ❌ Scaricamento fallito. Controlla la connessione a internet."
    read -r -p "Premi Invio per chiudere…"; exit 1
  fi
  rm -rf "$HOME/.local/node"
  mkdir -p "$HOME/.local/node"
  tar -xzf /tmp/node-istudio.tar.gz -C "$HOME/.local/node" --strip-components=1
  rm -f /tmp/node-istudio.tar.gz

  if command -v node >/dev/null 2>&1; then
    echo "   ✅ Node installato ($(node --version))"
  else
    echo "   ❌ Qualcosa non ha funzionato."
    read -r -p "Premi Invio per chiudere…"; exit 1
  fi
fi
echo

# ---------- 2. Librerie del progetto ----------
echo "⏳ Installo le librerie necessarie (qualche minuto, scarica ~100 MB)…"
if npm install --no-audit --no-fund >/tmp/istudio-npm.log 2>&1; then
  echo "✅ Librerie installate"
else
  echo "❌ Installazione fallita. Dettagli in /tmp/istudio-npm.log"
  read -r -p "Premi Invio per chiudere…"; exit 1
fi
echo

# ---------- 3. Riepilogo ----------
echo "════════════════════════════════════════════"
echo "  ✅ Questo Mac è pronto"
echo "════════════════════════════════════════════"
echo
echo "Restano tre cose da fare a mano, la prima volta:"
echo
echo "  1. Torna nella cartella iStudio e fai doppio click su «Avvia iStudio»"
echo "  2. Impostazioni → scansiona il QR col telefono per collegare WhatsApp"
echo "  3. Impostazioni → reinserisci i dati email e premi «Prova connessione»"
echo
echo "Per portare i contatti dall'altro Mac:"
echo "  Impostazioni → Backup della rubrica → Esporta CSV  (sul Mac di partenza)"
echo "  Impostazioni → Backup della rubrica → Importa CSV  (qui)"
echo
echo "Nota: WhatsApp resta collegato a UN SOLO computer per volta."
echo
read -r -p "Premi Invio per chiudere…"
