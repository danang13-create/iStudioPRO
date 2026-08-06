# Installare iStudio su un altro Mac

Da fare **una volta sola** su ogni nuovo computer. Servono circa 15 minuti.

---

## Passo 1 — Autorizza il nuovo Mac su GitHub

Sul **nuovo Mac**, apri l'app **Terminale** (Applicazioni → Utility → Terminale) e incolla:

```bash
ssh-keygen -t ed25519 -C "angellottidaniele@gmail.com" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Premi Invio. L'ultima riga stampata è la tua **chiave pubblica**: copiala tutta
(inizia con `ssh-ed25519` e finisce con la tua email).

Poi vai su **https://github.com/settings/ssh/new**:
- **Title** → `Portatile`
- **Key** → incolla la riga copiata
- premi **Add SSH key**

> La chiave pubblica non è segreta. La parte privata resta sul Mac e non va condivisa con nessuno.

---

## Passo 2 — Scarica il progetto

Sempre nel Terminale del nuovo Mac:

```bash
git clone git@github.com:danang13-create/istudio.git ~/Documents/iStudio
```

Se chiede *"Are you sure you want to continue connecting?"* scrivi `yes` e premi Invio.

---

## Passo 3 — Prepara tutto (automatico)

Apri la cartella **Documenti → iStudio → Comandi avanzati** e fai **doppio click su `PRIMO-AVVIO.command`**.

Lo script fa da solo:
- installa Node.js se manca (chiede conferma prima di scaricarlo)
- installa le librerie del progetto

Se al doppio click macOS dice *"impossibile aprire perché proviene da uno sviluppatore non identificato"*:
click destro sul file → **Apri** → **Apri**. Succede solo la prima volta.

---

## Passo 4 — Collega WhatsApp ed email

1. Doppio click su **`Avvia iStudio.command`** → si apre il browser
2. **Impostazioni** → inquadra il **QR code** col telefono
   (WhatsApp → Impostazioni → Dispositivi collegati → Collega un dispositivo)
3. **Impostazioni** → reinserisci server, indirizzo e **password per le app** di Gmail,
   poi premi **«Prova connessione»** finché la spia dell'Email in alto non diventa verde

---

## Passo 5 — Porta i contatti

I contatti **non** viaggiano su GitHub (sono dati personali, restano solo sui tuoi Mac).
Per copiarli:

1. Sul Mac di partenza: **Impostazioni → Backup della rubrica → 📤 Esporta CSV**
2. Trasferisci il file (AirDrop, email a te stesso, chiavetta…)
3. Sul nuovo Mac: **Impostazioni → Backup della rubrica → 📥 Importa CSV**

I contatti già presenti vengono saltati, quindi puoi reimportare lo stesso file senza creare doppioni.

---

## Uso quotidiano con due Mac

| Quando | Cosa fare |
|---|---|
| **Prima** di iniziare a lavorare | Comandi avanzati → doppio click su **`Scarica da GitHub`** |
| **Dopo** aver fatto modifiche | Comandi avanzati → doppio click su **`Salva su GitHub`** |

Regola semplice: **scarica prima, invia dopo.** Così i due Mac non entrano mai in conflitto.

---

## Cosa NON si sincronizza (e perché)

| | Sincronizzato? | Motivo |
|---|---|---|
| Programma e guide | ✅ via GitHub | è codice, si aggiorna bene |
| Contatti (`data.db`) | ❌ manuale via CSV | dati personali di persone reali: non vanno su servizi esterni |
| Sessione WhatsApp | ❌ mai | WhatsApp ammette **un solo dispositivo collegato per volta** |
| Impostazioni email | ❌ da reinserire | contengono la password |

> Se ti serve davvero vedere **gli stessi contatti** da entrambi i Mac senza esportare nulla,
> l'unica soluzione pulita è pubblicare iStudio online: una sola piattaforma, un solo database.
> Istruzioni in **`DEPLOY.md`**.
