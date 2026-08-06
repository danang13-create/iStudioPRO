# Raccoglie tutto quello che serve per capire perché iStudio non parte su questo PC.
# Non modifica niente: guarda e basta. Alla fine copia il resoconto negli appunti,
# così basta incollarlo in un messaggio.
#
# Esiste perché su Windows nessuno di questi script è mai stato provato: quando
# qualcosa non va, avere questo resoconto evita venti messaggi di andata e ritorno.

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Base = Split-Path -Parent $PSScriptRoot
$out = New-Object System.Collections.Generic.List[string]
function R($t) { $out.Add($t); Write-Host $t }

R '===== DIAGNOSTICA iStudio ====='
R ("Data:            " + (Get-Date -Format 'dd/MM/yyyy HH:mm'))
R ("Windows:         " + (Get-CimInstance Win32_OperatingSystem).Caption)
R ("Versione:        " + [Environment]::OSVersion.Version)
R ("Architettura:    " + $env:PROCESSOR_ARCHITECTURE)
R ("PowerShell:      " + $PSVersionTable.PSVersion)
R ''
R '--- Cartelle ---'
R ("Documenti:       " + [Environment]::GetFolderPath('MyDocuments'))
R ("iStudio:         " + $Base)
R ("  esiste:        " + (Test-Path $Base))
foreach ($f in 'server.js','package.json','VERSIONE.txt','copia-cliente.txt',
               'chiave-seriali-pubblica.pem','aggiornamenti-di-questo-mac.txt','data.db') {
  R ("  $f".PadRight(35) + (Test-Path (Join-Path $Base $f)))
}
R ("  node_modules:  " + (Test-Path (Join-Path $Base 'node_modules')))
if (Test-Path (Join-Path $Base 'VERSIONE.txt')) {
  R ("  versione:      " + (Get-Content (Join-Path $Base 'VERSIONE.txt') -Raw).Trim())
}
R ''
R '--- Node.js ---'
$CartellaNode = Join-Path $env:LOCALAPPDATA 'istudio-node'
$NodeExe = Join-Path $CartellaNode 'node.exe'
R ("Cartella:        " + $CartellaNode)
R ("node.exe:        " + (Test-Path $NodeExe))
if (Test-Path $NodeExe) {
  R ("Versione node:   " + (& $NodeExe --version))
  & $NodeExe --check (Join-Path $Base 'server.js') 2>&1 | Out-Null
  R ("server.js sano:  " + ($LASTEXITCODE -eq 0))
}
R ''
R '--- Rete e porta 3100 ---'
$occupata = netstat -ano | Select-String ":3100\s.*LISTENING"
R ("Porta 3100 occupata: " + [bool]$occupata)
if ($occupata) { $occupata | ForEach-Object { R ("  " + $_.ToString().Trim()) } }
try {
  $r = Invoke-WebRequest -Uri 'http://localhost:3100/api/status' -UseBasicParsing -TimeoutSec 5
  R ("Risposta iStudio: " + $r.Content)
} catch { R "iStudio non risponde su localhost:3100" }
try {
  $v = (Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/danang13-create/iStudioPRO/main/VERSIONE.txt' -UseBasicParsing -TimeoutSec 15).Content.Trim()
  R ("GitHub raggiungibile, versione pubblicata: " + $v)
} catch { R "GitHub NON raggiungibile: $($_.Exception.Message)" }
R ''
R '--- Browser interni attivi ---'
$proc = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like '*wwebjs_auth*' }
R ("Processi sul profilo WhatsApp: " + @($proc).Count)
R ''
R '--- Ultime righe del registro ---'
$log = Join-Path $env:LOCALAPPDATA 'istudio.log'
if (Test-Path $log) { Get-Content $log -Tail 20 | ForEach-Object { R ("  " + $_) } }
else { R "  (nessun registro in $log)" }
$err = "$log.err"
if ((Test-Path $err) -and (Get-Item $err).Length -gt 0) {
  R '--- Errori ---'
  Get-Content $err -Tail 20 | ForEach-Object { R ("  " + $_) }
}
R ''
R '===== FINE ====='

try {
  $out -join "`r`n" | Set-Clipboard
  Write-Host ''
  Write-Host 'Il resoconto e'' stato copiato: incollalo in un messaggio (CTRL+V).' -ForegroundColor Green
} catch { }
