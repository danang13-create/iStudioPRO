#!/bin/bash
# ============================================================
#  Installa iStudio su questo Mac
#
#  Doppio click e basta. Fa tutto da solo:
#  scarica iStudio, la mette al posto giusto, installa quello che
#  serve, la configura e la avvia.
#
#  Non chiede di rinominare cartelle né di scrivere file a mano:
#  erano i due passaggi in cui si sbagliava più facilmente.
# ============================================================

DEPOSITO="danang13-create/iStudioPRO"
# Le due variabili qui sotto si possono cambiare da fuori, ma servono UNICAMENTE per
# collaudare l'installazione su una cartella finta senza rischiare quella vera
# (vedi NOTE-TECNICHE.md). Con il doppio click valgono sempre i valori normali.
DESTINAZIONE="${ISTUDIO_DEST:-$HOME/Documents/iStudio}"
URL="${ISTUDIO_URL:-https://codeload.github.com/$DEPOSITO/tar.gz/refs/heads/main}"

echo "════════════════════════════════════════════"
echo "  Installazione di iStudio"
echo "════════════════════════════════════════════"
echo
echo "Sto per installare iStudio in:"
echo "   $DESTINAZIONE"
echo
echo "Ci vogliono circa 10 minuti, quasi tutti di attesa."
echo "Serve una connessione a internet."
echo

# --- C'è già un'installazione? Mai sovrascriverla alla cieca ---
# Dentro ci sarebbero i contatti e il collegamento WhatsApp di chi la sta usando.
if [ -e "$DESTINAZIONE" ]; then
  if [ -f "$DESTINAZIONE/data.db" ]; then
    echo "⚠️  In quella cartella c'è GIÀ un'installazione di iStudio, con dei dati dentro."
    echo "   Non la tocco: se la sovrascrivessi perderesti contatti e cronologia."
    echo
    echo "   Se vuoi aggiornarla, non serve reinstallare: iStudio si aggiorna da sola"
    echo "   a ogni avvio. Ti basta fare doppio click su «Mac → Avvia iStudio»."
    echo
    read -r -p "Premi Invio per chiudere…"
    exit 1
  fi
  echo "⚠️  Esiste già una cartella «iStudio» in Documenti, ma sembra vuota o incompleta."
  read -r -p "   La sostituisco? (scrivi si oppure no) " R
  case "$R" in
    s|si|sì|Si|Sì|SI|y|Y|yes) rm -rf "$DESTINAZIONE" ;;
    *) echo "   Ok, non tocco niente."; read -r -p "Premi Invio per chiudere…"; exit 0 ;;
  esac
else
  read -r -p "Procedo con l'installazione? (scrivi si oppure no) " R
  case "$R" in
    s|si|sì|Si|Sì|SI|y|Y|yes) ;;
    *) echo "   Ok, non faccio niente."; read -r -p "Premi Invio per chiudere…"; exit 0 ;;
  esac
fi
echo

# --- 1. Scarico ---
echo "⏳ [1/4] Scarico iStudio…"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if ! curl -fsSL -m 180 "$URL" -o "$TMP/istudio.tar.gz"; then
  echo "   ❌ Scaricamento non riuscito. Controlla la connessione a internet e riprova."
  read -r -p "Premi Invio per chiudere…"; exit 1
fi
mkdir -p "$TMP/estratto"
if ! tar -xzf "$TMP/istudio.tar.gz" -C "$TMP/estratto"; then
  echo "   ❌ Il file scaricato è rovinato. Riprova fra qualche minuto."
  read -r -p "Premi Invio per chiudere…"; exit 1
fi
# GitHub racchiude tutto in una cartella dal nome variabile: si scende dentro.
SORGENTE="$TMP/estratto/$(ls -1 "$TMP/estratto" | head -1)"
if [ ! -f "$SORGENTE/server.js" ]; then
  echo "   ❌ Il pacchetto scaricato non è quello atteso. Avvisa chi ti ha dato questo file."
  read -r -p "Premi Invio per chiudere…"; exit 1
fi
echo "   ✅ scaricata"

# --- 2. Metto al posto giusto ---
echo "⏳ [2/4] Metto iStudio in Documenti…"
mkdir -p "$HOME/Documents"
if ! mv "$SORGENTE" "$DESTINAZIONE"; then
  echo "   ❌ Non riesco a creare la cartella. Controlla i permessi di Documenti."
  read -r -p "Premi Invio per chiudere…"; exit 1
fi
chmod +x "$DESTINAZIONE/Mac/"*.command 2>/dev/null
chmod +x "$DESTINAZIONE/Mac/"*.sh 2>/dev/null
# macOS marchia come "scaricato da internet" tutto quello che arriva dalla rete e poi
# si rifiuta di aprirlo. Qui lo si toglie, così i doppi click successivi funzionano
# senza il giro di click destro → Apri.
xattr -dr com.apple.quarantine "$DESTINAZIONE" 2>/dev/null
echo "   ✅ pronta"

# --- 3. Node.js e librerie ---
echo "⏳ [3/4] Installo quello che serve per farla funzionare…"
export PATH="$HOME/.local/node/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "   ⏳ scarico Node.js (circa 50 MB)…"
  if [ "$(uname -m)" = "arm64" ]; then ARCH="darwin-arm64"; else ARCH="darwin-x64"; fi
  VER="v22.14.0"
  mkdir -p "$HOME/.local"
  if ! curl -fsSL -m 300 "https://nodejs.org/dist/${VER}/node-${VER}-${ARCH}.tar.gz" -o "$TMP/node.tar.gz"; then
    echo "   ❌ Non riesco a scaricare Node.js. Controlla la connessione e rilancia."
    read -r -p "Premi Invio per chiudere…"; exit 1
  fi
  rm -rf "$HOME/.local/node"; mkdir -p "$HOME/.local/node"
  tar -xzf "$TMP/node.tar.gz" -C "$HOME/.local/node" --strip-components=1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "   ❌ Node.js non risulta installato. Rilancia questo file."
  read -r -p "Premi Invio per chiudere…"; exit 1
fi
echo "   ⏳ installo le librerie (qualche minuto, circa 100 MB)…"
if ! (cd "$DESTINAZIONE" && npm install --no-audit --no-fund >/tmp/istudio-npm.log 2>&1); then
  echo "   ❌ Installazione delle librerie non riuscita. Dettagli in /tmp/istudio-npm.log"
  read -r -p "Premi Invio per chiudere…"; exit 1
fi
echo "   ✅ fatto"

# --- 4. Avvio ---
echo "⏳ [4/4] Avvio iStudio…"
echo
if ! "$DESTINAZIONE/Mac/Avvia iStudio.command"; then
  echo "   ⚠️  Non è partita. Apri Documenti → iStudio e fai doppio click su «Mac → Avvia iStudio»."
  read -r -p "Premi Invio per chiudere…"; exit 1
fi

echo
echo "════════════════════════════════════════════"
echo "  ✅ iStudio è installata"
echo "════════════════════════════════════════════"
echo
echo "Nel browser si è aperta la pagina di iStudio. Da qui:"
echo
echo "  1. Registrati con i tuoi dati e scegli utente e password"
echo "  2. Aspetta: quando l'amministratore ti attiva, la pagina si sblocca da sola"
echo "  3. Poi vai in Impostazioni e collega WhatsApp inquadrando il QR col telefono"
echo
echo "D'ora in poi, per usare iStudio: Documenti → iStudio → Mac → «Avvia iStudio»."
echo "Gli aggiornamenti arrivano da soli: non devi fare niente."
echo
read -r -p "Premi Invio per chiudere…"
