# Avvia iStudio su Windows. Equivalente di «Avvia iStudio.command».
# Non si lancia a mano: ci pensa «Avvia iStudio.bat» (doppio click).
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# La cartella di iStudio è quella che contiene questa cartella «windows».
$Base = Split-Path -Parent $PSScriptRoot
# Le copie dei clienti vivono sulla 3200, quelle di sviluppo sulla 3100: così le due
# possono stare accese sullo stesso computer senza darsi fastidio.
$Predefinita = if (Test-Path (Join-Path $Base 'copia-cliente.txt')) { 3200 } else { 3100 }
$Porta = if ($env:ISTUDIO_PORT) { [int]$env:ISTUDIO_PORT } else { $Predefinita }
$CartellaNode = Join-Path $env:LOCALAPPDATA 'istudio-node'
$env:Path = "$CartellaNode;$env:Path"
$Registro = Join-Path $env:LOCALAPPDATA 'istudio.log'

function PortaOccupata {
  # Get-NetTCPConnection non c'è su Windows 7: netstat funziona ovunque.
  $r = netstat -ano | Select-String ":$Porta\s.*LISTENING"
  return [bool]$r
}

function Accendi {
  # La porta va passata al programma, non solo controllata: senza questa riga node
  # partiva sempre sulla 3100 mentre lo script controllava un'altra porta.
  $env:PORT = "$Porta"
  Start-Process -FilePath (Join-Path $CartellaNode 'node.exe') `
    -ArgumentList 'server.js' -WorkingDirectory $Base -WindowStyle Hidden `
    -RedirectStandardOutput $Registro -RedirectStandardError "$Registro.err"
  for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Seconds 1
    if (PortaOccupata) { return $true }
  }
  return $false
}

if (PortaOccupata) {
  Write-Host 'iStudio e'' gia'' avviata.' -ForegroundColor Green
} else {
  # Aggiornamento automatico: attivo solo sulle copie dei clienti (vedi lo script).
  # Non può impedire l'avvio: se qualcosa non va, rinuncia e si prosegue.
  $Aggiornata = $false
  $agg = Join-Path $PSScriptRoot 'aggiornamento-automatico.ps1'
  if (Test-Path $agg) {
    try { if ((& $agg) -eq 10) { $Aggiornata = $true } } catch { }
  }

  # Sulle copie dei clienti rimette in ordine la cartella: dopo un aggiornamento
  # i file appena arrivati tornerebbero visibili. Sulle altre non fa niente.
  $rio = Join-Path $PSScriptRoot 'riordina-cartella.ps1'
  if (Test-Path $rio) { try { & $rio $Base } catch { } }

  Write-Host 'Avvio iStudio...'
  if (Accendi) {
    Write-Host 'iStudio e'' partita.' -ForegroundColor Green
  } elseif ($Aggiornata -and (Test-Path (Join-Path $Base '.versione-precedente'))) {
    # La versione appena scaricata non parte: si torna indietro da soli.
    # Senza questo, un aggiornamento sbagliato lascerebbe il cliente con iStudio
    # morta e nessun modo di rimediare da solo.
    Write-Host 'La versione appena scaricata non parte: torno a quella precedente...' -ForegroundColor Yellow
    $bk = Join-Path $Base '.versione-precedente'
    foreach ($f in 'server.js','package.json','VERSIONE.txt') {
      $s = Join-Path $bk $f
      if (Test-Path $s) { Copy-Item $s (Join-Path $Base $f) -Force }
    }
    if (Test-Path (Join-Path $bk 'public')) {
      Remove-Item (Join-Path $Base 'public') -Recurse -Force -ErrorAction SilentlyContinue
      Copy-Item (Join-Path $bk 'public') (Join-Path $Base 'public') -Recurse -Force
    }
    if (Accendi) {
      Write-Host 'iStudio e'' ripartita con la versione precedente.' -ForegroundColor Green
      Write-Host "   L'aggiornamento verra' riprovato al prossimo avvio."
    } else {
      Write-Host "iStudio non parte. Dettagli in: $Registro" -ForegroundColor Red
      Read-Host 'Premi Invio per chiudere'; exit 1
    }
  } else {
    Write-Host "Qualcosa e' andato storto. Dettagli in: $Registro" -ForegroundColor Red
    Read-Host 'Premi Invio per chiudere'; exit 1
  }
}

Start-Process "http://localhost:$Porta"
Write-Host ''
Write-Host "La pagina si sta aprendo nel browser: http://localhost:$Porta"
Write-Host 'Puoi chiudere questa finestra: iStudio resta attiva finche'' non spegni il PC'
Write-Host 'o non usi «Ferma iStudio».'
Start-Sleep -Seconds 2
