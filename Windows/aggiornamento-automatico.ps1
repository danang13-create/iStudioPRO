# Aggiornamento automatico di iStudio su Windows.
# Equivalente di «Comandi avanzati/aggiornamento-automatico.sh». Lo chiama avvia.ps1
# prima di accendere il server: non va lanciato a mano.
#
# È TUTTO FACOLTATIVO: si accende solo se esiste «aggiornamenti-di-questo-mac.txt»
# nella cartella di iStudio, che contiene il deposito da cui scaricare.
#
# REGOLA D'ORO: non deve MAI impedire a iStudio di partire. Niente internet,
# GitHub giù, pacchetto rotto → si rinuncia in silenzio e iStudio parte com'è.
#
# Restituisce 10 se ha aggiornato, 0 se non c'era niente da fare.

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Base = Split-Path -Parent $PSScriptRoot
$Cfg  = Join-Path $Base 'aggiornamenti-di-questo-mac.txt'
$Bk   = Join-Path $Base '.versione-precedente'

if (-not (Test-Path $Cfg)) { return 0 }          # non è una copia cliente
$Deposito = (Get-Content $Cfg -Raw).Trim()
if (-not $Deposito) { return 0 }

$UrlVersione  = "https://raw.githubusercontent.com/$Deposito/main/VERSIONE.txt"
$UrlPacchetto = "https://codeload.github.com/$Deposito/zip/refs/heads/main"

$fileVersione = Join-Path $Base 'VERSIONE.txt'
$Locale = if (Test-Path $fileVersione) { (Get-Content $fileVersione -Raw).Trim() } else { '' }

# --- 1. c'è una versione diversa? (poca attesa: non si tiene fermo l'avvio) ---
try {
  $Remota = (Invoke-WebRequest -Uri $UrlVersione -UseBasicParsing -TimeoutSec 15).Content.Trim()
} catch {
  Write-Host '   (nessun aggiornamento: non riesco a contattare il deposito, va bene lo stesso)'
  return 0
}
if (-not $Remota -or $Remota -eq $Locale) { return 0 }

# Il confronto è «diversa», non «più recente», ed è voluto: ripubblicando una versione
# precedente si fa tornare indietro tutti i clienti in un colpo solo.
Write-Host "La versione pubblicata e' $Remota, qui c'e' la $Locale. Mi allineo..."

$Tmp = Join-Path $env:TEMP ("istudio-agg-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Tmp -Force | Out-Null
try {
  # --- 2. scarico ed estraggo in una cartella temporanea ---
  $zip = Join-Path $Tmp 'p.zip'
  try {
    Invoke-WebRequest -Uri $UrlPacchetto -OutFile $zip -UseBasicParsing -TimeoutSec 120
  } catch {
    Write-Host '   Scaricamento non riuscito: proseguo con la versione attuale.'
    return 0
  }
  $est = Join-Path $Tmp 'e'
  try { Expand-Archive -Path $zip -DestinationPath $est -Force } catch {
    Write-Host '   Pacchetto illeggibile: proseguo con la versione attuale.'
    return 0
  }
  $nuova = Get-ChildItem $est -Directory | Select-Object -First 1
  if (-not $nuova) { return 0 }
  $nuova = $nuova.FullName

  # --- 3. controlli PRIMA di toccare qualsiasi cosa ---
  if (-not (Test-Path (Join-Path $nuova 'server.js')) -or
      -not (Test-Path (Join-Path $nuova 'public\index.html'))) {
    Write-Host '   Il pacchetto non contiene i file attesi: non aggiorno.'
    return 0
  }
  $node = Join-Path $env:LOCALAPPDATA 'istudio-node\node.exe'
  if (Test-Path $node) {
    & $node --check (Join-Path $nuova 'server.js') 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Host '   Il programma scaricato contiene un errore: non aggiorno.'
      return 0
    }
  }

  # --- 4. metto da parte la versione attuale (per il ritorno indietro) ---
  if (Test-Path $Bk) { Remove-Item $Bk -Recurse -Force }
  New-Item -ItemType Directory -Path $Bk -Force | Out-Null
  foreach ($f in 'server.js','package.json','VERSIONE.txt') {
    $s = Join-Path $Base $f
    if (Test-Path $s) { Copy-Item $s (Join-Path $Bk $f) -Force }
  }
  if (Test-Path (Join-Path $Base 'public')) {
    Copy-Item (Join-Path $Base 'public') (Join-Path $Bk 'public') -Recurse -Force
  }

  # --- 5. installo ---
  foreach ($f in 'server.js','package.json') {
    $s = Join-Path $nuova $f
    if (Test-Path $s) { Copy-Item $s (Join-Path $Base $f) -Force }
  }
  foreach ($c in 'public','Mac','Windows') {
    $s = Join-Path $nuova $c
    if (Test-Path $s) {
      Remove-Item (Join-Path $Base $c) -Recurse -Force -ErrorAction SilentlyContinue
      Copy-Item $s (Join-Path $Base $c) -Recurse -Force
    }
  }
  
  # --- 6. librerie, se sono cambiate ---
  if (-not (Test-Path (Join-Path $Bk 'package.json')) -or
      (Get-FileHash (Join-Path $Bk 'package.json')).Hash -ne
      (Get-FileHash (Join-Path $Base 'package.json')).Hash) {
    Write-Host '   Sono cambiate le librerie, le aggiorno...'
    $npm = Join-Path $env:LOCALAPPDATA 'istudio-node\npm.cmd'
    if (Test-Path $npm) {
      Start-Process -FilePath $npm -ArgumentList 'install','--no-audit','--no-fund' `
        -WorkingDirectory $Base -NoNewWindow -Wait `
        -RedirectStandardOutput (Join-Path $env:TEMP 'istudio-npm.log') `
        -RedirectStandardError  (Join-Path $env:TEMP 'istudio-npm.err')
    }
  }

  Set-Content -Path $fileVersione -Value $Remota -NoNewline
  Write-Host "   Ora e' alla versione $Remota." -ForegroundColor Green
  return 10
} finally {
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}
