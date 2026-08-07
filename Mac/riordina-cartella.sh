#!/bin/bash
# ============================================================
#  Lascia in vista solo l'essenziale
#
#  Un cliente non deve vedere server.js, node_modules, le guide tecniche o la
#  cartella dell'altro sistema operativo: apre «Documenti → iStudio» e trova
#  «Avvia iStudio» e «Ferma iStudio». Basta.
#
#  I file NON vengono spostati né cancellati: si usa l'attributo «nascosto» del
#  Finder (chflags hidden). Così niente si rompe — i percorsi restano quelli — e
#  con ⌘⇧. si possono rivedere in qualsiasi momento.
#
#  Lo chiamano l'installazione e ogni avvio: è idempotente, e rieseguirlo dopo un
#  aggiornamento rinasconde ciò che è appena arrivato.
#  Sulle copie di sviluppo NON viene mai chiamato (lo fa solo l'avvio dei clienti,
#  e solo se esiste «copia-cliente.txt»).
# ============================================================

BASE="${1:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$BASE" || exit 0

# Solo sulle copie dei clienti: sul Mac di chi sviluppa la cartella resta com'è.
[ -f "$BASE/copia-cliente.txt" ] || exit 0

# I due comandi di tutti i giorni, in vista nella cartella principale: sono
# richiami di una riga a quelli veri dentro «Mac», così un aggiornamento che
# corregge l'avvio vale subito senza doverli rigenerare.
for coppia in "Avvia iStudio:Avvia" "Ferma iStudio:Ferma"; do
  nome="${coppia%%:*}"
  if [ ! -f "$BASE/$nome.command" ]; then
    printf '#!/bin/bash\ncd "$(dirname "$0")" || exit 1\nexec "./Mac/%s.command"\n' "$nome" \
      > "$BASE/$nome.command"
    chmod +x "$BASE/$nome.command"
  fi
done

# Tutto il resto sparisce dalla vista. L'elenco è esplicito e non un «tutto tranne»:
# se un domani arriva un file nuovo resterà visibile, ed è meglio che nascondere
# per sbaglio qualcosa che il cliente deve vedere.
for elemento in server.js package.json package-lock.json public node_modules \
                Mac Windows Installazione \
                GUIDA.md INSTALLA-CLIENTE.md README.md VERSIONE.txt .gitattributes \
                chiave-seriali-pubblica.pem copia-cliente.txt \
                aggiornamenti-di-questo-mac.txt assistenza-whatsapp.txt \
                data.db data.db-shm data.db-wal allegati-invii .versione-precedente; do
  # -h è indispensabile: senza, su un collegamento chflags agisce su CIÒ A CUI PUNTA,
  # non sul collegamento. In prova ha nascosto la cartella node_modules vera di un'altra
  # installazione. Con -h tocca solo quello che c'è in questa cartella.
  [ -e "$BASE/$elemento" ] || [ -L "$BASE/$elemento" ] && chflags -h hidden "$BASE/$elemento" 2>/dev/null
done

exit 0
