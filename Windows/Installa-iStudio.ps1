# ============================================================
#  Installa iStudio su questo PC Windows
#
#  Si lancia da PowerShell con una riga sola (vedi INSTALLA-CLIENTE.md).
#  Fa tutto da solo: scarica iStudio, la mette in Documenti, installa
#  quello che serve, la configura e la avvia.
#
#  Equivalente Windows di «Installa iStudio.command».
# ============================================================

$ErrorActionPreference = 'Stop'
# PowerShell vecchio parte in TLS 1.0, che GitHub rifiuta: senza questa riga
# lo scaricamento fallisce con un errore incomprensibile.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Deposito    = 'danang13-create/iStudioPRO'
$UrlPacchetto = "https://codeload.github.com/$Deposito/zip/refs/heads/main"
# GetFolderPath e NON "$env:USERPROFILE\Documents": con OneDrive attivo la cartella
# Documenti sta altrove, e usando il percorso fisso iStudio finirebbe nel posto sbagliato.
$Documenti   = [Environment]::GetFolderPath('MyDocuments')
$Destinazione = Join-Path $Documenti 'iStudio'
$VersioneNode = 'v22.14.0'

function Ok($m)      { Write-Host "   $m" -ForegroundColor Green }
function Passo($m)   { Write-Host $m -ForegroundColor Cyan }
function Guaio($m)   { Write-Host "   $m" -ForegroundColor Red }
function Fine($codice) {
  Write-Host ''
  Read-Host 'Premi Invio per chiudere'
  exit $codice
}

Write-Host '════════════════════════════════════════════'
Write-Host '  Installazione di iStudio'
Write-Host '════════════════════════════════════════════'
Write-Host ''
Write-Host "Sto per installare iStudio in:"
Write-Host "   $Destinazione"
Write-Host ''
Write-Host 'Ci vogliono circa 10 minuti, quasi tutti di attesa.'
Write-Host 'Serve una connessione a internet.'
Write-Host ''

# --- C'è già un'installazione? Mai sovrascriverla alla cieca ---
# Dentro ci sarebbero i contatti e il collegamento WhatsApp di chi la sta usando.
if (Test-Path $Destinazione) {
  if (Test-Path (Join-Path $Destinazione 'data.db')) {
    Guaio "In quella cartella c'e' GIA' un'installazione di iStudio, con dei dati dentro."
    Guaio 'Non la tocco: se la sovrascrivessi perderesti contatti e cronologia.'
    Write-Host ''
    Write-Host '   Se vuoi aggiornarla non serve reinstallare: iStudio si aggiorna da sola'
    Write-Host '   a ogni avvio. Ti basta aprire «Avvia iStudio».'
    Fine 1
  }
  $r = Read-Host "Esiste gia' una cartella iStudio ma sembra vuota. La sostituisco? (si/no)"
  if ($r -notmatch '^(s|si|sì|y|yes)$') { Write-Host '   Ok, non tocco niente.'; Fine 0 }
  Remove-Item $Destinazione -Recurse -Force
} else {
  $r = Read-Host "Procedo con l'installazione? (si/no)"
  if ($r -notmatch '^(s|si|sì|y|yes)$') { Write-Host '   Ok, non faccio niente.'; Fine 0 }
}
Write-Host ''

$Tmp = Join-Path $env:TEMP ("istudio-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Tmp -Force | Out-Null

try {
  # --- 1. Scarico ---
  Passo '[1/4] Scarico iStudio...'
  $zip = Join-Path $Tmp 'istudio.zip'
  try {
    Invoke-WebRequest -Uri $UrlPacchetto -OutFile $zip -UseBasicParsing -TimeoutSec 180
  } catch {
    Guaio 'Scaricamento non riuscito. Controlla la connessione a internet e riprova.'
    Guaio $_.Exception.Message
    Fine 1
  }
  $estratto = Join-Path $Tmp 'estratto'
  Expand-Archive -Path $zip -DestinationPath $estratto -Force
  # GitHub racchiude tutto in una cartella dal nome variabile: si scende dentro.
  $sorgente = Get-ChildItem $estratto -Directory | Select-Object -First 1
  if (-not $sorgente -or -not (Test-Path (Join-Path $sorgente.FullName 'server.js'))) {
    Guaio "Il pacchetto scaricato non e' quello atteso. Avvisa chi ti ha dato iStudio."
    Fine 1
  }
  Ok 'scaricata'

  # --- 2. Metto al posto giusto ---
  Passo '[2/4] Metto iStudio in Documenti...'
  New-Item -ItemType Directory -Path $Documenti -Force | Out-Null
  Move-Item $sorgente.FullName $Destinazione
  # Windows marchia come "scaricato da internet" i file presi dalla rete e poi li
  # blocca: qui il marchio si toglie, cosi' non compaiono avvisi.
  Get-ChildItem $Destinazione -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
  Ok 'pronta'

  # --- 3. Node.js e librerie ---
  Passo '[3/4] Installo quello che serve per farla funzionare...'
  $CartellaNode = Join-Path $env:LOCALAPPDATA 'istudio-node'
  $NodeExe = Join-Path $CartellaNode 'node.exe'
  if (-not (Test-Path $NodeExe)) {
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'win-arm64' } else { 'win-x64' }
    Write-Host "   scarico Node.js ($arch, circa 30 MB)..."
    $nodeZip = Join-Path $Tmp 'node.zip'
    try {
      Invoke-WebRequest -UseBasicParsing -TimeoutSec 300 `
        -Uri "https://nodejs.org/dist/$VersioneNode/node-$VersioneNode-$arch.zip" -OutFile $nodeZip
    } catch {
      Guaio 'Non riesco a scaricare Node.js. Controlla la connessione e rilancia.'
      Fine 1
    }
    $nodeEstratto = Join-Path $Tmp 'node'
    Expand-Archive -Path $nodeZip -DestinationPath $nodeEstratto -Force
    $dentro = Get-ChildItem $nodeEstratto -Directory | Select-Object -First 1
    if (Test-Path $CartellaNode) { Remove-Item $CartellaNode -Recurse -Force }
    Move-Item $dentro.FullName $CartellaNode
  }
  if (-not (Test-Path $NodeExe)) {
    Guaio "Node.js non risulta installato. Rilancia l'installazione."
    Fine 1
  }
  $env:Path = "$CartellaNode;$env:Path"

  Write-Host '   installo le librerie (qualche minuto, circa 100 MB)...'
  $npm = Join-Path $CartellaNode 'npm.cmd'
  $log = Join-Path $env:TEMP 'istudio-npm.log'
  $p = Start-Process -FilePath $npm -ArgumentList 'install','--no-audit','--no-fund' `
       -WorkingDirectory $Destinazione -NoNewWindow -Wait -PassThru `
       -RedirectStandardOutput $log -RedirectStandardError "$log.err"
  if ($p.ExitCode -ne 0) {
    Guaio "Installazione delle librerie non riuscita. Dettagli in: $log"
    Fine 1
  }
  Ok 'fatto'

  # --- 4. Avvio ---
  Passo '[4/4] Avvio iStudio...'
  Write-Host ''
  & (Join-Path $Destinazione 'Windows\avvia.ps1')

} finally {
  Remove-Item $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host '════════════════════════════════════════════'
Write-Host '  iStudio e'' installata' -ForegroundColor Green
Write-Host '════════════════════════════════════════════'
Write-Host ''
Write-Host 'Nel browser si e'' aperta la pagina di iStudio. Da qui:'
Write-Host ''
Write-Host '  1. Comunica il codice che vedi a chi ti ha fornito iStudio'
Write-Host '  2. Incolla il seriale che ricevi e premi «Attiva iStudio»'
Write-Host '  3. Poi vai in Impostazioni e collega WhatsApp col QR code'
Write-Host ''
Write-Host "D'ora in poi, per usare iStudio: Documenti > iStudio > Windows > «Avvia iStudio»."
Write-Host 'Gli aggiornamenti arrivano da soli: non devi fare niente.'
Fine 0
