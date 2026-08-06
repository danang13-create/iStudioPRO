# Installare iStudio

Circa 10 minuti, quasi tutti di attesa. Non devi scrivere niente né spostare cartelle.

> **Hai un PC Windows?** Salta alla sezione **«Su Windows»** in fondo.

---

# Su Mac

Serve una sola cosa: il file **`Installa iStudio.command`** che ti è stato mandato.

---

## 1. Apri il file

Il file arriva dentro un archivio: fai **doppio click** per aprirlo, poi trovi dentro
`Installa iStudio.command`.

⚠️ **Al primo doppio click macOS lo blocca.** È normale, succede con tutti i programmi che
non arrivano dal suo negozio. Per aprirlo:

> **Click destro** sul file → **Apri** → nella finestrella che compare, **Apri** di nuovo.

(Se fai solo doppio click, macOS dice *«impossibile aprire perché proviene da uno sviluppatore
non identificato»* e non parte niente. Serve il click destro, solo questa volta.)

---

## 2. Lascialo lavorare

Si apre una finestra nera con delle scritte. Ti chiede una conferma: scrivi **si** e premi Invio.

Da lì fa tutto da solo:

1. scarica iStudio
2. la mette in **Documenti → iStudio**
3. installa quello che serve per farla funzionare
4. la avvia e apre la pagina nel browser

Puoi lasciarlo lavorare senza guardare. Quando ha finito te lo dice.

> Se qualcosa va storto (per esempio manca la connessione), lo scrive in italiano e non
> combina danni: puoi richiudere e rilanciare il file più tardi.

---

## 3. Registrati e aspetta l'attivazione

Nel browser si apre iStudio con una schermata di **registrazione**: inserisci i tuoi dati
e scegli un nome utente e una password.

Poi resta in attesa. **Quando l'amministratore ti attiva, la schermata si sblocca da sola:**
non devi ricaricare la pagina né richiamare nessuno.

---

## 4. Collega WhatsApp e l'email

Una volta entrato, vai in **Impostazioni**:

- **WhatsApp** → inquadra il **QR code** col telefono
  (WhatsApp → Impostazioni → Dispositivi collegati → Collega un dispositivo)
- **Email** → inserisci i dati della tua posta e premi **«Prova connessione»**, finché la
  spia dell'Email in alto non diventa verde

> Con Gmail serve una **«password per le app»**, non la password normale.
> Come si crea è spiegato in `GUIDA.md`.

---

## 5. Carica i contatti

**Impostazioni → Backup della rubrica → 📥 Importa CSV**, con un file che abbia le colonne
`nome; cognome; email; telefono; non_contattare`.

Reimportare lo stesso file non crea doppioni.

---

## Da qui in poi

| Per | Fai |
|---|---|
| **usare iStudio** | Documenti → iStudio → **Mac** → doppio click su **`Avvia iStudio`** |
| **fermarla** | cartella **Mac** → doppio click su **`Ferma iStudio`** |
| **aggiornarla** | niente: si aggiorna da sola a ogni avvio |

Per l'uso quotidiano vedi **`GUIDA.md`**.

---

## Se qualcosa non funziona

| Problema | Cosa fare |
|---|---|
| Il file non si apre | click destro → **Apri** → **Apri** (vedi il punto 1) |
| La pagina non si apre | cartella **Mac** → `Avvia iStudio` |
| «Questa copia non è attiva» | l'amministratore non ti ha ancora attivato: sentilo |
| WhatsApp risulta scollegato | Impostazioni → **🔄 Ripristina collegamento WhatsApp** |

Registro tecnico degli errori: `~/Library/Logs/istudio.log`

> **Reinstallare non serve mai**, e comunque non cancella niente: se rilanci
> `Installa iStudio.command` su un'installazione che ha già i tuoi dati, si ferma e te lo dice.

---

# Su Windows

## 1. Apri PowerShell

Premi il tasto **Windows**, scrivi `powershell` e premi Invio.
Si apre una finestra blu (o nera): è normale.

## 2. Incolla questa riga e premi Invio

```powershell
irm https://raw.githubusercontent.com/danang13-create/iStudioPRO/main/windows/Installa-iStudio.ps1 | iex
```

Ti chiede una conferma: scrivi **si** e premi Invio.

Da lì fa tutto da solo: scarica iStudio, la mette in **Documenti → iStudio**, installa
quello che serve e la avvia. Puoi lasciarlo lavorare senza guardare.

## 3. Poi è tutto uguale al Mac

Registrazione del seriale, QR di WhatsApp, email e contatti: identici ai punti 3, 4 e 5
qui sopra.

## Da qui in poi, su Windows

| Per | Fai |
|---|---|
| **usare iStudio** | Documenti → iStudio → **Windows** → doppio clic su **`Avvia iStudio.bat`** |
| **fermarla** | cartella **Windows** → doppio clic su **`Ferma iStudio.bat`** |
| **aggiornarla** | niente: si aggiorna da sola a ogni avvio |

> Al primo doppio clic Windows può mostrare un avviso di sicurezza («PC protetto da
> Windows»): premi **Ulteriori informazioni** → **Esegui comunque**. Capita solo la
> prima volta.

## Se su Windows qualcosa non funziona

Nella cartella **Windows** c'è **`Diagnostica.bat`**: doppio clic e basta. Non modifica niente,
raccoglie solo le informazioni utili e **te le copia negli appunti**. Incollale in un
messaggio a chi ti assiste (CTRL+V): da lì si capisce quasi sempre cos'è successo.
