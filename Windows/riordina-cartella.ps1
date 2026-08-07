# ============================================================
#  Lascia in vista solo l'essenziale (versione Windows)
#
#  Equivalente di «Mac/riordina-cartella.sh». Un cliente apre Documenti\iStudio
#  e trova «Avvia iStudio» e «Ferma iStudio»: niente server.js, niente
#  node_modules, niente guide tecniche.
#
#  I file NON vengono spostati né cancellati: si usa l'attributo «nascosto» di
#  Windows. Niente si rompe, e si rivedono togliendo la spunta «Elementi
#  nascosti» in Esplora file.
#
#  Lo chiamano l'installazione e ogni avvio: rieseguirlo dopo un aggiornamento
#  rinasconde ciò che è appena arrivato.
# ============================================================
param([string]$Base)

if (-not $Base) { $Base = Split-Path -Parent $PSScriptRoot }
# Solo sulle copie dei clienti: su quelle di sviluppo la cartella resta com'è.
if (-not (Test-Path (Join-Path $Base 'copia-cliente.txt'))) { return }

# I due comandi di tutti i giorni, in vista. Sono richiami di una riga a quelli veri
# dentro «Windows», così un aggiornamento che li corregge vale subito.
foreach ($n in 'Avvia iStudio','Ferma iStudio') {
  $f = Join-Path $Base "$n.bat"
  if (-not (Test-Path $f)) {
    $dest = if ($n -like 'Avvia*') { 'avvia.ps1' } else { 'ferma.ps1' }
    $righe = "@echo off`r`ntitle $n`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0Windows\$dest`"`r`n"
    [IO.File]::WriteAllText($f, $righe)
  }
}

# Elenco esplicito e non «tutto tranne»: se un domani arriva un file nuovo resta
# visibile, ed è meglio che nascondere per sbaglio qualcosa di utile.
$daNascondere = @(
  'server.js','package.json','package-lock.json','public','node_modules',
  'Mac','Windows','Installazione',
  'GUIDA.md','INSTALLA-CLIENTE.md','README.md','VERSIONE.txt','.gitattributes',
  'chiave-seriali-pubblica.pem','copia-cliente.txt',
  'aggiornamenti-di-questo-mac.txt','assistenza-whatsapp.txt',
  'data.db','data.db-shm','data.db-wal','allegati-invii','.versione-precedente'
)
foreach ($n in $daNascondere) {
  $p = Join-Path $Base $n
  if (Test-Path $p) {
    try {
      $i = Get-Item $p -Force
      $i.Attributes = $i.Attributes -bor [IO.FileAttributes]::Hidden
    } catch { }
  }
}
