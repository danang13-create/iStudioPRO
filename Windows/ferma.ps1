# Ferma iStudio su Windows. Equivalente di «Ferma iStudio.command».
# Non si lancia a mano: ci pensa «Ferma iStudio.bat» (doppio click).
$Base = Split-Path -Parent $PSScriptRoot
# Stessa regola dell'avvio: le copie cliente stanno sulla 3200.
$Predefinita = if (Test-Path (Join-Path $Base 'copia-cliente.txt')) { 3200 } else { 3100 }
$Porta = if ($env:ISTUDIO_PORT) { [int]$env:ISTUDIO_PORT } else { $Predefinita }

function PidSullaPorta {
  # L'ultima colonna di netstat è il numero di processo.
  netstat -ano | Select-String ":$Porta\s.*LISTENING" | ForEach-Object {
    ($_ -split '\s+')[-1]
  } | Sort-Object -Unique
}

$pids = @(PidSullaPorta)
if ($pids.Count -eq 0) {
  Write-Host 'iStudio non e'' in esecuzione.'
} else {
  Write-Host 'Chiusura di iStudio in corso...'
  foreach ($p in $pids) { taskkill /PID $p /T 2>$null | Out-Null }
  # Il browser interno usato per WhatsApp impiega qualche secondo a chiudersi.
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Seconds 1
    if (@(PidSullaPorta).Count -eq 0) { break }
  }
  foreach ($p in @(PidSullaPorta)) { taskkill /F /PID $p /T 2>$null | Out-Null }
  Write-Host 'iStudio e'' stata fermata. Contatti e collegamento WhatsApp restano salvati.' -ForegroundColor Green
}

# Rete di sicurezza: chiude il browser interno rimasto orfano.
# Normalmente ci pensa iStudio da sola. Ma se iStudio e' MORTA per un errore non ha
# potuto chiudere niente, e quel browser resta acceso: da li' in poi ogni riavvio
# fallisce con «The browser is already running» e la piattaforma non riparte piu'.
# Il filtro e' la cartella del profilo di iStudio, quindi il browser con cui navighi
# non viene toccato: ha un profilo diverso.
$profilo = Join-Path $Base '.wwebjs_auth'
$orfani = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
          Where-Object { $_.CommandLine -like "*$profilo*" }
if ($orfani) {
  Write-Host 'Trovato un browser interno rimasto aperto: lo chiudo.'
  foreach ($o in $orfani) { taskkill /F /T /PID $o.ProcessId 2>$null | Out-Null }
}
Start-Sleep -Seconds 2
