# Installare iStudio

Circa 10 minuti, quasi tutti di attesa. Non devi spostare cartelle né scrivere file:
fa tutto da solo.

- **Hai un Mac?** vai al punto 1 qui sotto
- **Hai un PC Windows?** salta alla sezione **«Su Windows»**

---

# Su Mac

## 1. Apri il Terminale

Premi **⌘ + Spazio**, scrivi `Terminale` e premi Invio. Si apre una finestra bianca o nera:
è normale, serve solo per far partire l'installazione.

## 2. Incolla questa riga e premi Invio

```bash
curl -fsSL "https://raw.githubusercontent.com/danang13-create/iStudioPRO/main/Installazione/Installa%20iStudio.command" -o /tmp/installa-istudio.command && bash /tmp/installa-istudio.command
```

Ti chiede una conferma: scrivi **si** e premi Invio.

Da lì fa tutto da solo: scarica iStudio, la mette in **Documenti → iStudio**, installa
quello che serve e la apre nel browser. Puoi lasciarlo lavorare senza guardare.

> Se qualcosa va storto (per esempio manca la connessione) lo scrive in italiano e non
> combina danni: puoi chiudere e riprovare più tardi.

Ora salta al punto **«3. Attiva iStudio»**.

---

# Su Windows

## 1. Apri PowerShell

Premi il tasto **Windows**, scrivi `powershell` e premi Invio.

## 2. Incolla questa riga e premi Invio

```powershell
irm https://raw.githubusercontent.com/danang13-create/iStudioPRO/main/Installazione/Installa-iStudio.ps1 | iex
```

Ti chiede una conferma: scrivi **si** e premi Invio. Poi fa tutto da solo, come sopra.

---

# 3. Attiva iStudio

Nel browser si apre iStudio con la schermata di attivazione. Dentro c'è il tuo
**codice installazione**, una cosa tipo `IST-4K7P-9XQ2`.

1. Scegli **per quanto tempo** vuoi attivarla (1, 3, 6 o 12 mesi)
2. Premi **«Richiedi attivazione»**: si apre WhatsApp con il messaggio già scritto,
   codice compreso — devi solo premere invio
3. Quando ricevi il **seriale**, incollalo nella casella e premi **«Attiva iStudio»**

Fatto: si apre la piattaforma.

# 4. Collega WhatsApp e l'email

Vai in **Impostazioni**:

- **WhatsApp** → inquadra il **QR code** col telefono
  (WhatsApp → Impostazioni → Dispositivi collegati → Collega un dispositivo)
- **Email** → inserisci i dati della tua posta e premi **«Prova connessione»**, finché la
  spia dell'Email non diventa verde

> Con Gmail serve una **«password per le app»**, non la password normale del tuo account.
> Come si crea è spiegato in `GUIDA.md`.

# 5. Carica i contatti

**Impostazioni → Backup della rubrica → 📥 Importa CSV**, con un file che abbia le colonne
`nome; cognome; email; telefono; non_contattare`.

Reimportare lo stesso file non crea doppioni.

---

# Da qui in poi

| Per | Su Mac | Su Windows |
|---|---|---|
| **usare iStudio** | cartella **Mac** → `Avvia iStudio` | cartella **Windows** → `Avvia iStudio.bat` |
| **fermarla** | cartella **Mac** → `Ferma iStudio` | cartella **Windows** → `Ferma iStudio.bat` |
| **aggiornarla** | niente: lo fa da sola a ogni avvio | idem |

> La cartella **Installazione** serve solo la prima volta: dopo puoi ignorarla.

Per l'uso quotidiano vedi **`GUIDA.md`**.

# Il tuo abbonamento

Il pulsante **👤 Profilo** in alto a destra mostra il tuo codice, fino a quando è valido e
quanti giorni restano. Da lì puoi anche **rinnovare**: scegli i mesi, premi «Rinnova», e
parte la richiesta su WhatsApp col codice già dentro.

Negli ultimi 7 giorni compare un avviso in cima alla pagina che te lo ricorda.

> Se l'abbonamento scade iStudio si blocca, ma **non perdi niente**: contatti, cronologia e
> collegamento WhatsApp restano dove sono, e appena inserisci il seriale nuovo ritrovi tutto.

---

# Se qualcosa non funziona

| Problema | Cosa fare |
|---|---|
| La pagina non si apre | cartella **Mac** (o **Windows**) → `Avvia iStudio` |
| «Abbonamento non attivo» | il seriale è scaduto o non ancora inserito: vedi il punto 3 |
| WhatsApp risulta scollegato | Impostazioni → **🔄 Ripristina collegamento WhatsApp** |
| Su Windows, non parte niente | cartella **Windows** → doppio clic su **`Diagnostica.bat`**: copia negli appunti un resoconto da mandare a chi ti assiste |

iStudio si apre all'indirizzo **http://localhost:3200**.

Registro tecnico degli errori: su Mac `~/Library/Logs/istudio.log`, su Windows
`%LOCALAPPDATA%\istudio.log`.

> **Reinstallare non serve mai**, e comunque non cancella niente: se rilanci l'installazione
> su una copia che ha già i tuoi dati, si ferma e te lo dice.
