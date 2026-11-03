<#
  GÖ4Fun – Entwicklungsumgebung hochfahren.

  Läuft beim Start von Claude Code (SessionStart-Hook
  in .claude/settings.local.json – bewusst die PERSÖNLICHE Datei: Die IP und die
  Server gehören zu diesem PC, nicht zu jedem, der das Repo klont). Von Hand:

      powershell -ExecutionPolicy Bypass -File scripts\dev-up.ps1

  Was passiert, der Reihe nach:
    1. Warten, bis das Internet da ist (nach dem Hochfahren braucht das WLAN ein paar Sekunden).
    2. Die WLAN-IP dieses PCs ermitteln und in .env.local als EXPO_PUBLIC_API_URL eintragen.
       Die IP kommt per DHCP von der Fritzbox und wechselt – genau das war bisher der
       häufigste Grund für „Login dauert ewig" am Handy.
    3. Laravel (8000) und Expo/Metro (8081) in eigenen Fenstern (das Node-Backend
       wird seit dem Marktplatz-Umbau nicht mehr gebraucht)
       starten – nur was noch nicht läuft. Hat sich die IP geändert, wird ein laufendes
       Metro neu gestartet, denn Metro liest .env.local nur beim Start.
    4. Kurzer Statusbericht mit der exp://-Adresse fürs Handy.

  Das Skript ist bewusst idempotent: Es zweimal hintereinander laufen zu lassen, ändert
  nichts und startet nichts doppelt.

  Schalter:
    -NoServers  nur Internet + IP, keine Server starten
    -Quiet      knappe Ausgabe (für den Claude-Code-Hook)
#>
param(
    [switch]$NoServers,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
# Ausgabe als UTF-8 – sonst kommen Umlaute im Claude-Hook und in Git-Bash als Fragezeichen an.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env.local'
$envExample = Join-Path $root '.env.example'

function Say([string]$text) { if (-not $Quiet) { Write-Host $text } }

function Test-Port([int]$port) {
    return [bool](Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
}

function Test-Health([string]$url, [int]$timeoutSec = 3) {
    try {
        $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec $timeoutSec
        return $r.StatusCode -eq 200 -and $r.Content -match '"ok"\s*:\s*true'
    } catch {
        return $false
    }
}

# ---------------------------------------------------------------- 1. Internet
Say 'GÖ4Fun Dev – warte auf Internet …'
$online = $false
for ($i = 0; $i -lt 60; $i++) {
    if (Test-Connection -ComputerName 8.8.8.8 -Count 1 -Quiet -ErrorAction SilentlyContinue) {
        $online = $true
        break
    }
    Start-Sleep -Seconds 2
}

# ---------------------------------------------------------------- 2. WLAN-IP
# Nur private 192.168.*-Adressen: Das Handy muss den PC im WLAN erreichen. Die
# Hamachi-VPN-Adresse (25.x) und 127.0.0.1 sind aus Sicht des Handys unerreichbar.
# Gibt es mehrere, gewinnt das Fritzbox-Netz 192.168.178.x.
$candidates = @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -like '192.168.*' -and $_.AddressState -eq 'Preferred' })
$pick = $candidates | Where-Object { $_.IPAddress -like '192.168.178.*' } | Select-Object -First 1
if (-not $pick) { $pick = $candidates | Select-Object -First 1 }
$ip = if ($pick) { $pick.IPAddress } else { $null }

$envChanged = $false
$envNote = ''
$keepRemote = $false

if ($ip) {
    $wanted = "http://${ip}:8000"

    if (-not (Test-Path $envFile)) {
        $lines = if (Test-Path $envExample) { [System.IO.File]::ReadAllLines($envExample) } else { @() }
    } else {
        $lines = [System.IO.File]::ReadAllLines($envFile)
    }

    $activeIndex = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^\s*EXPO_PUBLIC_API_URL\s*=') { $activeIndex = $i }
    }
    $current = if ($activeIndex -ge 0) { ($lines[$activeIndex] -split '=', 2)[1].Trim() } else { '' }

    # Eine https-Adresse ist Absicht: Die App soll WLAN-unabhängig laufen.
    # Der Server unter der eigenen Domain (https://goe4fun.de) bleibt immer stehen –
    # auch wenn er beim Hochfahren gerade nicht antwortet. Nur eine Wegwerf-Adresse
    # von `cloudflared tunnel --url` (*.trycloudflare.com) ist nach einem Neustart
    # tot, dann zurück aufs WLAN.
    $isHttps = $current -like 'https://*'
    $isQuickTunnel = $current -match '^https://[^/]+\.trycloudflare\.com(/|$)'
    $keepRemote = $isHttps -and (-not $isQuickTunnel -or (Test-Health "$current/api/health" 5))

    if ($keepRemote) {
        $envNote = "$current (Server, WLAN-IP nicht eingetragen)"
    } elseif ($current -ne $wanted) {
        $new = [System.Collections.Generic.List[string]]::new()
        foreach ($line in $lines) {
            if ($line -match '^\s*EXPO_PUBLIC_API_URL\s*=') {
                # Alten Wert als Kommentar stehen lassen – eine Tunnel-Adresse will
                # man vielleicht wieder einschalten.
                if ($line -like '*https://*') { $new.Add("# $line") }
                continue
            }
            $new.Add($line)
        }
        $new.Add("EXPO_PUBLIC_API_URL=$wanted")
        # UTF-8 ohne BOM – dotenv liest ein BOM sonst als Teil des ersten Schlüssels.
        [System.IO.File]::WriteAllLines($envFile, $new, [System.Text.UTF8Encoding]::new($false))
        $envChanged = $true
        $envNote = if ($current) { "$current -> $wanted" } else { "neu: $wanted" }
    } else {
        $envNote = "$wanted (unverändert)"
    }
}

# ---------------------------------------------------------------- 3. Server
function Start-DevWindow([string]$title, [string]$command) {
    $script = "`$Host.UI.RawUI.WindowTitle='$title'; Set-Location '$root'; $command"
    Start-Process powershell -WorkingDirectory $root -ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-Command', $script | Out-Null
}

function Stop-MetroOnPort([int]$port) {
    # Beendet Metro am Port – nur Metro (node … expo … start), nie ein fremdes Programm, das den
    # Port zufällig belegt. Das Fenster, in dem es lief, schließt nur, wenn dieses Skript es
    # geöffnet hat (sein Titel steht in der Befehlszeile): ein eigenes Terminal bleibt offen.
    # $true, wenn Metro beendet wurde.
    $owner = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -First 1
    if (-not $owner) { return $false }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue
    if (-not $proc -or $proc.Name -ne 'node.exe' -or $proc.CommandLine -notmatch 'expo.*\bstart\b') { return $false }
    $cur = $proc
    $window = $null
    while ($cur) {
        if ($cur.Name -eq 'powershell.exe') { $window = $cur; break }
        $cur = Get-CimInstance Win32_Process -Filter "ProcessId=$($cur.ParentProcessId)" -ErrorAction SilentlyContinue
    }
    Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
    if ($window -and $window.CommandLine -like '*Goenn Expo/Metro*') {
        Stop-Process -Id $window.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
    return $true
}

$started = @()
$mysqlUp = Test-Port 3306

if (-not $NoServers) {
    if (-not (Test-Port 8000)) {
        Start-DevWindow 'Goenn Laravel-API 8000' 'php api/artisan serve --host=0.0.0.0 --port=8000'
        $started += 'Laravel'
    }
    if ($envChanged -and (Test-Port 8081)) {
        if (Stop-MetroOnPort 8081) { $started += 'Metro (neu, wegen neuer IP)' }
        else { $started += 'Port 8081 gehört nicht Metro – nicht angefasst' }
    }
    if (-not (Test-Port 8081)) {
        $hostEnv = if ($ip) { "`$env:REACT_NATIVE_PACKAGER_HOSTNAME='$ip'; " } else { '' }
        Start-DevWindow 'Goenn Expo/Metro 8081' "${hostEnv}npx expo start --lan --port 8081"
        if ($started -notcontains 'Metro (neu, wegen neuer IP)') { $started += 'Metro' }
    }

    # Kurz warten, bis Laravel antwortet (meist nach 2–3 s).
    for ($i = 0; $i -lt 20; $i++) {
        if (Test-Health 'http://127.0.0.1:8000/api/health') { break }
        Start-Sleep -Seconds 2
    }
}

# ---------------------------------------------------------------- 4. Bericht
$ok = [char]0x2705
$bad = [char]0x274C
function Mark([bool]$v) {
    # Im Hook ASCII: Die Zeile landet im Kontext von Claude, nicht vor Augen.
    if ($Quiet) { if ($v) { 'OK' } else { 'FEHLT' } } elseif ($v) { $ok } else { $bad }
}

$laravel = Test-Health 'http://127.0.0.1:8000/api/health'
$lan = if ($ip) { Test-Health "http://${ip}:8000/api/health" } else { $false }
# Zeigt die App auf den Server, zählt dessen Antwort statt der WLAN-Strecke zum PC.
$remote = if ($keepRemote) { Test-Health "$current/api/health" 5 } else { $false }
$metro = Test-Port 8081

$report = @(
    "$(Mark $online) Internet",
    "$(Mark ([bool]$ip)) WLAN-IP: $(if ($ip) { $ip } else { 'keine 192.168.*-Adresse gefunden' })",
    "$(Mark ([bool]$ip)) .env.local: $envNote",
    "$(Mark $mysqlUp) MySQL (3306)",
    "$(Mark $laravel) Laravel-API (8000)",
    $(if ($keepRemote) { "$(Mark $remote) Backend $current erreichbar" } else { "$(Mark $lan) Backend übers WLAN erreichbar" }),
    "$(Mark $metro) Expo/Metro (8081)"
)
if ($started.Count -gt 0) { $report += "Gestartet: $($started -join ', ')" }
if ($ip) { $report += "Expo Go: exp://${ip}:8081" }
if (-not $mysqlUp) { $report += 'MySQL läuft nicht – in Herd/Dienste starten, sonst antwortet kein Backend.' }
if ($laravel -and -not $lan -and $ip -and -not $keepRemote) {
    $report += 'Lokal ok, übers WLAN nicht -> Firewall (Admin-PowerShell): New-NetFirewallRule -DisplayName "Goenntertainment Backend 8000" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8000 -Profile Private'
}

if ($Quiet) {
    Write-Output ('GÖ4Fun Dev-Umgebung: ' + ($report -join ' | '))
} else {
    Write-Host ''
    $report | ForEach-Object { Write-Host $_ }
    Write-Host ''
}
