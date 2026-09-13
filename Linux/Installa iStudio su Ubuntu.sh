#!/bin/bash
# ============================================================
#  Installa iStudio su Ubuntu
#
#  Si lancia UNA VOLTA SOLA, in laboratorio, con monitor e tastiera:
#
#      bash "Installa iStudio su Ubuntu.sh"
#
#  Fa tutto: librerie di sistema, Node.js, iStudio, il servizio che la tiene
#  accesa, l'aggiornamento notturno e (se vuoi) Tailscale.
#
#  ⚠️ Non usa «set -e». Un installatore che muore a metà lascia la macchina in
#     uno stato che nessuno sa descrivere al telefono: qui ogni passo si
#     controlla da solo e, se fallisce, DICE cosa fare.
# ============================================================

set -u

DEPOSITO="danang13-create/iStudioPRO"
DESTINAZIONE="${ISTUDIO_DEST:-$HOME/iStudio}"
URL="${ISTUDIO_URL:-https://codeload.github.com/$DEPOSITO/tar.gz/refs/heads/main}"
NODE_VER="v22.14.0"
NODE_DIR="$HOME/.local/node"

# «Solo prove»: esegue i controlli e stampa cosa farebbe, senza toccare niente.
# Serve a collaudare questo script senza avere una macchina da sacrificare.
PROVA="${ISTUDIO_PROVA:-}"

rosso()  { printf '\033[31m%s\033[0m\n' "$*"; }
verde()  { printf '\033[32m%s\033[0m\n' "$*"; }
giallo() { printf '\033[33m%s\033[0m\n' "$*"; }

muori() {
  echo
  rosso "❌ $1"
  shift
  for r in "$@"; do echo "   $r"; done
  echo
  exit 1
}

echo "════════════════════════════════════════════"
echo "  Installazione di iStudio su Ubuntu"
echo "════════════════════════════════════════════"
echo

# ------------------------------------------------------------------
# 0. È la macchina giusta?
# ------------------------------------------------------------------
# ⚠️ Questi controlli stanno PRIMA di tutto di proposito: scoprire a metà
# installazione di essere su un ARM significa aver già scaricato 700 MB e
# aver toccato la configurazione di sistema per niente.

[ -r /etc/os-release ] || muori "Questo non sembra un Linux con /etc/os-release." \
  "iStudio su server si installa su Ubuntu Server o Desktop 24.04."
. /etc/os-release

if [ "${ID:-}" != "ubuntu" ]; then
  giallo "⚠️  Questa non è Ubuntu ma «${PRETTY_NAME:-sconosciuta}»."
  giallo "   Lo script è provato su Ubuntu 24.04. Su altre distribuzioni i nomi"
  giallo "   dei pacchetti cambiano e qualche passaggio può fallire."
  read -r -p "   Vuoi continuare lo stesso? [s/N] " R
  [ "${R,,}" = "s" ] || exit 1
fi

ARCH="$(uname -m)"
if [ "$ARCH" != "x86_64" ]; then
  muori "Questa macchina è «$ARCH», non un PC a 64 bit (x86_64)." \
    "Su ARM — Raspberry Pi e mini-PC simili — il browser che serve a WhatsApp" \
    "non si scarica da solo, e iStudio non può collegarsi."
fi

if [ "$(id -u)" = "0" ]; then
  muori "Non lanciare questo script come root (né con «sudo bash …»)." \
    "iStudio deve appartenere al tuo utente normale, altrimenti i suoi dati" \
    "finiscono in /root e il servizio gira con più poteri del necessario." \
    "" \
    "Rilancialo così, dal tuo utente:    bash \"$(basename "$0")\"" \
    "La password ti verrà chiesta solo per i pochi passi che la richiedono."
fi

sudo -v || muori "Serve poter usare «sudo» per installare le librerie di sistema."

# Su Ubuntu 24.04 alcuni pacchetti hanno il suffisso «t64» (passaggio alle date a
# 64 bit); sulle versioni precedenti no. Sbagliare nome fa fallire l'installazione
# con «pacchetto non trovato», che sembra un problema di rete e non lo è.
UBUNTU_VER="${VERSION_ID:-24.04}"
if [ "$(printf '%s\n24.04\n' "$UBUNTU_VER" | sort -V | head -1)" = "24.04" ]; then
  T64="t64"        # 24.04 e successive
else
  T64=""           # 22.04 e precedenti
fi

# L'elenco non è a memoria: ricavato con «ldd» sul Chromium vero scaricato da
# puppeteer e verificato pacchetto per pacchetto su Ubuntu 24.04. Senza queste,
# il browser non parte e l'errore («error while loading shared libraries») non
# dice a nessuno che cosa fare.
LIBRERIE=(
  libnss3 libnspr4
  "libatk1.0-0${T64}" "libatk-bridge2.0-0${T64}" "libatspi2.0-0${T64}"
  "libcups2${T64}" libdrm2 libgbm1 libxkbcommon0
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libxext6 libx11-6
  "libasound2${T64}" libpango-1.0-0 libcairo2
  fonts-liberation ca-certificates curl
)

# ------------------------------------------------------------------
# 1. Desktop o Server?
# ------------------------------------------------------------------
# Su Desktop ci sono quattro cose che possono far tacere il bot, e vanno spente.
# La domanda si fa QUI, all'inizio, così l'installazione non si ferma a metà per
# aspettare una risposta.
if [ -n "${ISTUDIO_DESKTOP:-}" ]; then
  DESKTOP="$ISTUDIO_DESKTOP"
elif command -v gnome-shell >/dev/null 2>&1 || [ -n "${XDG_CURRENT_DESKTOP:-}" ]; then
  DESKTOP="si"
  echo "Ho riconosciuto una versione DESKTOP di Ubuntu."
else
  DESKTOP="no"
  echo "Ho riconosciuto una versione SERVER di Ubuntu."
fi
echo

echo "Sto per installare iStudio in:"
echo "   $DESTINAZIONE"
echo
echo "Ci vogliono circa 15 minuti, quasi tutti di attesa."
echo "Serve una connessione a internet."
echo
if [ -n "$PROVA" ]; then giallo "MODO PROVA: non tocco niente, dico solo cosa farei."; echo; fi
read -r -p "Vado? [S/n] " R
[ -z "$R" ] || [ "${R,,}" = "s" ] || exit 1
echo

# ------------------------------------------------------------------
# 2. C'è già un'installazione?
# ------------------------------------------------------------------
# Dentro ci sarebbero le prenotazioni, la rubrica e il collegamento WhatsApp.
if [ -f "$DESTINAZIONE/data.db" ]; then
  rosso "⚠️  In quella cartella c'è GIÀ iStudio, con dei dati dentro."
  echo "   Non la tocco: sovrascrivendola perderesti prenotazioni e contatti."
  echo
  echo "   Per aggiornarla non serve reinstallare — ci pensa l'aggiornamento"
  echo "   notturno. Per farlo subito:    bash \"$DESTINAZIONE/Linux/Avvia.sh\""
  exit 1
fi

esegui() {
  if [ -n "$PROVA" ]; then echo "   [prova] $*"; return 0; fi
  "$@"
}

# ------------------------------------------------------------------
# 3. Le librerie di sistema
# ------------------------------------------------------------------
echo "⏳ [1/6] Installo le librerie che servono al browser di WhatsApp…"
esegui sudo apt-get update -qq
if ! esegui sudo apt-get install -y -qq "${LIBRERIE[@]}"; then
  muori "Non sono riuscito a installare le librerie di sistema." \
    "Quasi sempre è la connessione. Controlla internet e rilancia:" \
    "riprende da capo senza fare danni."
fi
verde "   ✅ fatto"

# ------------------------------------------------------------------
# 4. Node.js
# ------------------------------------------------------------------
# Non quello dei repository di Ubuntu: sulla 24.04 è il 18, e «better-sqlite3»
# verrebbe compilato contro un ABI diverso da quello che usiamo su Mac e Windows.
# Un aggiornamento di sistema lo rimpiazzerebbe e iStudio smetterebbe di partire.
echo "⏳ [2/6] Installo Node.js $NODE_VER…"
export PATH="$NODE_DIR/bin:$PATH"
if ! command -v node >/dev/null 2>&1 || [ "$(node -v 2>/dev/null)" != "$NODE_VER" ]; then
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  if ! esegui curl -fsSL -m 600 "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-x64.tar.gz" -o "$TMP/node.tar.gz"; then
    muori "Non riesco a scaricare Node.js." "Controlla la connessione e rilancia."
  fi
  esegui rm -rf "$NODE_DIR"
  esegui mkdir -p "$NODE_DIR"
  esegui tar -xzf "$TMP/node.tar.gz" -C "$NODE_DIR" --strip-components=1
fi
if [ -z "$PROVA" ] && ! command -v node >/dev/null 2>&1; then
  muori "Node.js non risulta installato." "Rilancia questo script."
fi
# ⚠️ Il PATH va scritto anche nel profilo, altrimenti al prossimo accesso «node»
# non si trova più e la diagnostica a mano non funziona.
if ! grep -q "$NODE_DIR/bin" "$HOME/.profile" 2>/dev/null; then
  esegui bash -c "printf '\n# Node.js per iStudio\nexport PATH=\"%s/bin:\$PATH\"\n' '$NODE_DIR' >> '$HOME/.profile'"
fi
verde "   ✅ $( [ -n "$PROVA" ] && echo "$NODE_VER" || node -v )"

# ------------------------------------------------------------------
# 5. iStudio
# ------------------------------------------------------------------
# ⚠️ Questo script sta DENTRO il pacchetto di iStudio: se sei arrivato qui è
# perché l'hai già scaricato. Riscaricarlo sarebbe 30 MB inutili, ma soprattutto
# renderebbe l'installazione difficile da spiegare — «scarica, poi lui riscarica»
# è il genere di passaggio in cui chi legge si convince di aver sbagliato.
SORGENTE=""
if [ -f "$(dirname "$0")/../server.js" ]; then
  SORGENTE="$(cd "$(dirname "$0")/.." && pwd)"
fi

if [ -n "$SORGENTE" ]; then
  echo "⏳ [3/6] Copio iStudio (l'hai già scaricata, non la riscarico)…"
else
  echo "⏳ [3/6] Scarico iStudio…"
fi
if [ -z "$PROVA" ] && [ -n "$SORGENTE" ]; then
  mkdir -p "$DESTINAZIONE"
  # ⚠️ La copia non deve inghiottire una cartella dentro l'altra: se qualcuno
  # scarica il pacchetto proprio in ~/iStudio, sorgente e destinazione
  # coincidono e «cp -a» girerebbe a vuoto copiando dentro se stessa.
  if [ "$SORGENTE" != "$DESTINAZIONE" ]; then
    cp -a "$SORGENTE/." "$DESTINAZIONE/" || muori "Non riesco a copiare iStudio in $DESTINAZIONE."
  fi
elif [ -z "$PROVA" ]; then
  TMP2="$(mktemp -d)"
  if ! curl -fsSL -m 600 "$URL" -o "$TMP2/istudio.tar.gz"; then
    rm -rf "$TMP2"
    muori "Non riesco a scaricare iStudio." "Controlla la connessione e rilancia."
  fi
  mkdir -p "$DESTINAZIONE"
  tar -xzf "$TMP2/istudio.tar.gz" -C "$DESTINAZIONE" --strip-components=1 || {
    rm -rf "$TMP2"; muori "Il pacchetto scaricato non si apre." "Rilancia: probabilmente il download si è interrotto."
  }
  rm -rf "$TMP2"
else
  echo "   [prova] ${SORGENTE:+copierei $SORGENTE}${SORGENTE:-scaricherei $URL} in $DESTINAZIONE"
fi
verde "   ✅ pronta"

echo "⏳ [4/6] Installo le librerie di iStudio (qualche minuto, ~700 MB col browser)…"
LOG_NPM="/tmp/istudio-npm-$(date '+%Y%m%d-%H%M%S').log"
if [ -z "$PROVA" ]; then
  if ! (cd "$DESTINAZIONE" && npm install --no-audit --no-fund >"$LOG_NPM" 2>&1); then
    ln -sf "$LOG_NPM" /tmp/istudio-npm-ultimo.log 2>/dev/null
    rosso "   ❌ Installazione delle librerie non riuscita."
    echo
    echo "   ────────── ultime righe dell'errore ──────────"
    tail -15 "$LOG_NPM" | sed 's/^/   /'
    echo "   ──────────────────────────────────────────────"
    echo
    if grep -qiE "gyp|make: \*\*\*|node-pre-gyp|g\+\+|cc1plus" "$LOG_NPM"; then
      echo "   👉 Sembra mancare un compilatore. Prova così, poi rilancia:"
      echo
      echo "        sudo apt install -y build-essential python3"
    elif grep -qiE "ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network" "$LOG_NPM"; then
      echo "   👉 Sembra un problema di connessione, non della macchina."
      echo "      Controlla internet e rilancia: riprende da capo senza danni."
    fi
    echo
    echo "   Il registro completo è qui:  $LOG_NPM"
    exit 1
  fi
fi
verde "   ✅ fatto"

# ------------------------------------------------------------------
# 6. La password della piattaforma
# ------------------------------------------------------------------
# ⚠️ Va nel file del servizio, non in un file dentro la cartella di iStudio:
# quella cartella si sovrascrive a ogni aggiornamento notturno.
echo
echo "La piattaforma va protetta con una password (te la chiederà il browser)."
PW=""
while [ -z "$PW" ]; do
  read -r -s -p "   Password per iStudio: " PW; echo
  if [ ${#PW} -lt 8 ]; then
    giallo "   Troppo corta: almeno 8 caratteri."; PW=""
    continue
  fi
  # ⚠️ La password finisce in un «EnvironmentFile» di systemd, che tratta a modo
  # suo virgolette e barre rovesce: una password con dentro " ' o \ arriverebbe
  # a iStudio DIVERSA da come è stata scritta. Il risultato sarebbe la peggiore
  # specie di guasto — «password errata» con la password giusta, e nessun errore
  # da nessuna parte. Meglio dirlo adesso che scoprirlo al ristorante.
  case "$PW" in
    *[\"\'\\]*)
      giallo "   Niente virgolette (\" ') né barre rovesce (\\): systemd le interpreta"
      giallo "   e la password arriverebbe storpiata. Tutto il resto va bene."
      PW=""; continue ;;
  esac
  # Uno spazio all'inizio o alla fine non si vede, e systemd lo taglia: chi l'ha
  # scritto giurerebbe di aver messo la password giusta.
  case "$PW" in
    " "*|*" ")
      giallo "   Niente spazi all'inizio o alla fine: non si vedono e vanno persi."
      PW=""; continue ;;
  esac
  read -r -s -p "   Ripetila: " PW2; echo
  [ "$PW" = "$PW2" ] || { giallo "   Non coincidono, riproviamo."; PW=""; }
done

# ------------------------------------------------------------------
# 7. Il servizio
# ------------------------------------------------------------------
echo "⏳ [5/6] Installo il servizio che tiene iStudio sempre accesa…"
MODELLO="$DESTINAZIONE/Linux/istudio.service"
[ -f "$MODELLO" ] || [ -n "$PROVA" ] || muori "Manca $MODELLO nel pacchetto scaricato."
if [ -z "$PROVA" ]; then
  UNITA="$(mktemp)"
  sed -e "s|@@UTENTE@@|$USER|g" \
      -e "s|@@CARTELLA@@|$DESTINAZIONE|g" \
      -e "s|@@NODE@@|$(command -v node)|g" "$MODELLO" > "$UNITA"
  # La password come variabile d'ambiente del servizio, in un file che solo root
  # può leggere. In chiaro nell'unità sarebbe leggibile da chiunque con
  # «systemctl cat».
  sudo install -m 600 /dev/null /etc/istudio.env
  printf 'ISTUDIO_PASSWORD=%s\n' "$PW" | sudo tee /etc/istudio.env >/dev/null
  sudo sed -i '/^\[Service\]/a EnvironmentFile=/etc/istudio.env' "$UNITA"
  sudo install -m 644 "$UNITA" /etc/systemd/system/istudio.service
  rm -f "$UNITA"
  sudo systemctl daemon-reload
  sudo systemctl enable --now istudio.service

  # ⚠️ Senza questo, l'aggiornamento notturno NON funziona: parte dal crontab,
  # dove non c'è un terminale, e «sudo systemctl restart» si ferma a chiedere
  # una password che nessuno digiterà. Fallirebbe ogni notte in silenzio — e il
  # guasto peggiore è quello che non si vede.
  #
  # Il permesso è ristretto a QUESTE quattro righe e a QUESTO servizio, con il
  # percorso completo: «systemctl» con argomenti liberi sarebbe root pieno.
  REGOLA="$(mktemp)"
  cat > "$REGOLA" <<REGOLE
# Permette a $USER di governare il solo servizio iStudio senza password.
# Scritto dall'installatore di iStudio. Non aggiungere righe a mano qui.
$USER ALL=(root) NOPASSWD: /usr/bin/systemctl start istudio, /usr/bin/systemctl stop istudio, /usr/bin/systemctl restart istudio, /usr/bin/systemctl reload istudio
REGOLE
  # visudo -c prima di installarla: una regola malformata rende «sudo»
  # inutilizzabile su tutta la macchina, e da lì non si torna indietro senza
  # un disco di ripristino.
  if sudo visudo -cf "$REGOLA" >/dev/null 2>&1; then
    sudo install -m 440 "$REGOLA" /etc/sudoers.d/istudio
  else
    giallo "   ⚠️  Non ho potuto installare il permesso per il riavvio automatico."
    giallo "      iStudio funziona, ma l'aggiornamento notturno non riuscirà a"
    giallo "      riavviarla: andrà fatto a mano con «Avvia.sh»."
  fi
  rm -f "$REGOLA"
else
  echo "   [prova] scriverei /etc/systemd/system/istudio.service e /etc/istudio.env"
fi

# ------------------------------------------------------------------
#  La password funziona DAVVERO?
# ------------------------------------------------------------------
# ⚠️ Fra quello che scrivi qui e quello che iStudio riceve c'è di mezzo systemd,
# che legge il file dell'ambiente a modo suo. Dare per buono che il passaggio
# sia fedele è esattamente il tipo di fiducia che produce il guasto peggiore:
# «password errata» con la password giusta, senza un errore da nessuna parte.
# Quindi non si dà per buono: si prova, adesso, finché c'è qualcuno davanti.
if [ -z "$PROVA" ]; then
  echo -n "   ⏳ controllo che la password funzioni"
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
      verde "   ✅ la password funziona" ;;
    401)
      rosso "   ❌ iStudio risponde, ma NON accetta la password appena scelta."
      echo "      Vuol dire che nel passaggio attraverso systemd è cambiata."
      echo "      Rimedio: rilancia l'installazione scegliendo una password fatta"
      echo "      solo di lettere, numeri e - _ . (niente \$ né simboli strani)."
      echo
      echo "      iStudio è comunque installata e accesa: si può correggere anche"
      echo "      dopo, scrivendo la password in /etc/istudio.env e poi"
      echo "      «sudo systemctl restart istudio»." ;;
    "")
      giallo "   ⚠️  iStudio non ha ancora risposto: non ho potuto provare la password."
      giallo "      Controlla fra un minuto con:  bash \"$DESTINAZIONE/Linux/Diagnostica.sh\"" ;;
    *)
      giallo "   ⚠️  Risposta inattesa dal controllo della password (HTTP $RISPOSTA)."
      giallo "      Controlla con:  bash \"$DESTINAZIONE/Linux/Diagnostica.sh\"" ;;
  esac
fi
unset PW PW2
verde "   ✅ installato e avviato"

# ------------------------------------------------------------------
# 8. Le protezioni del Desktop
# ------------------------------------------------------------------
# ⚠️ Su Desktop la sospensione automatica è l'unica cosa che può davvero far
# tacere il bot: una macchina che si addormenta alle due di notte, la mattina
# dopo non risponde. Le altre tre servono a non farla riavviare da sola nel
# mezzo di un servizio.
if [ "$DESKTOP" = "si" ]; then
  echo "⏳ [6/6] Spengo sospensione e riavvii automatici (versione Desktop)…"
  esegui sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
  if command -v gsettings >/dev/null 2>&1; then
    esegui gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'
    esegui gsettings set org.gnome.settings-daemon.plugins.power sleep-inactive-battery-type 'nothing'
    esegui gsettings set org.gnome.desktop.session idle-delay 0
  fi
  # Aggiornamenti di sicurezza sì, salto di versione no: la finestra «È
  # disponibile Ubuntu 26.04» su una macchina senza monitor non la vede nessuno.
  if [ -f /etc/update-manager/release-upgrades ]; then
    esegui sudo sed -i 's/^Prompt=.*/Prompt=never/' /etc/update-manager/release-upgrades
  fi
  # Gli snap si aggiornano quattro volte al giorno a orari qualsiasi. Spostati
  # di notte, a locale chiuso.
  esegui sudo snap set system refresh.timer=03:00-04:00 2>/dev/null
  verde "   ✅ fatto"
else
  echo "⏳ [6/6] Versione Server: niente da spegnere."
fi

# ------------------------------------------------------------------
# 9. Aggiornamento notturno
# ------------------------------------------------------------------
# Su un Mac iStudio si aggiorna a ogni avvio. Qui non si riavvia mai, quindi non
# si aggiornerebbe mai: alle 5 del mattino, a locale chiuso.
if [ -z "$PROVA" ]; then
  ( crontab -l 2>/dev/null | grep -v 'iStudio: aggiornamento notturno'
    echo "0 5 * * * bash '$DESTINAZIONE/Linux/aggiornamento-automatico.sh' >/dev/null 2>&1  # iStudio: aggiornamento notturno"
  ) | crontab -
else
  echo "   [prova] aggiungerei l'aggiornamento notturno delle 5:00 al crontab"
fi

# ------------------------------------------------------------------
# 10. Tailscale (facoltativo)
# ------------------------------------------------------------------
echo
echo "Vuoi installare Tailscale? Serve a entrare in questa macchina da casa"
echo "senza aprire nessuna porta sul router. (Consigliato)"
read -r -p "   Installo Tailscale? [S/n] " R
if [ -z "$R" ] || [ "${R,,}" = "s" ]; then
  if esegui bash -c "curl -fsSL https://tailscale.com/install.sh | sh"; then
    # ⚠️ Il nome è «istudio-<nomelocale>», non «istudio»: sulla stessa rete
    # Tailscale macchine con lo stesso nome si rinominano da sole in istudio-1,
    # istudio-2… e non decidi tu quale è quale.
    read -r -p "   Nome del locale (una parola, senza spazi): " LOCALE
    LOCALE="$(echo "${LOCALE:-locale}" | tr '[:upper:] ' '[:lower:]-' | tr -cd 'a-z0-9-')"
    esegui sudo tailscale up --hostname "istudio-$LOCALE"
  else
    giallo "   ⚠️  Tailscale non si è installato. Puoi rifarlo dopo, non è bloccante."
  fi
fi

# ------------------------------------------------------------------
# Fine
# ------------------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo
verde "════════════════════════════════════════════"
verde "  iStudio è installata e già accesa."
verde "════════════════════════════════════════════"
echo
echo "  Piattaforma:   http://${IP:-questo-computer}:3100"
echo "  Pagina sala:   http://${IP:-questo-computer}:3101"
echo
echo "  Per collegare WhatsApp apri la piattaforma e inquadra il QR code."
echo
echo "  Comandi utili (dentro $DESTINAZIONE/Linux):"
echo "     bash Diagnostica.sh     — dice se è viva e mostra gli ultimi errori"
echo "     bash Ferma.sh           — la ferma"
echo "     bash Avvia.sh           — la riavvia e la aggiorna"
echo
giallo "  ⚠️  PRIMA DI PORTARLA AL RISTORANTE, fai la prova della spina:"
echo "     stacca la corrente e riattaccala. Deve tornare su da sola, con"
echo "     iStudio accesa e WhatsApp collegato, senza toccare niente."
echo "     E nel BIOS attiva «riaccenditi quando torna la corrente»."
echo
