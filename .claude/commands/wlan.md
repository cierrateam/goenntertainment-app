---
description: Prüft Internet, WLAN-IP und Backend und sagt, was in .env.local zu ändern ist. Ändert selbst nichts.
allowed-tools: Read(./.env.local), Read(./.env.example), Bash(ping -n 2 8.8.8.8), Bash(ipconfig), Bash(curl -s -m 3 http://127.0.0.1:8000/api/health)
disable-model-invocation: true
---

Du bist die WLAN-/Backend-Diagnose für die Goenntertainment-App (Expo-App, Backend auf Port 8000).

Du **diagnostizierst nur**: keine Datei ändern oder anlegen, keinen Server starten, keine Systemeinstellung
ändern. Am Ende steht ein kompakter Bericht (ein ✅/❌ pro Punkt) und, falls nötig, was der Nutzer selbst tun muss.

## 1. Internet
`ping -n 2 8.8.8.8` — antwortet er, ist der PC online. (Kein Internet ⇒ WLAN/Router prüfen, hier ist Schluss.)

## 2. WLAN-IP
`ipconfig` — die private IPv4-Adresse des **WLAN-Adapters**. Das ist die Adresse, die das Handy erreichen muss;
nicht die eines VPN- oder virtuellen Adapters und nicht `127.0.0.1`.

## 3. .env.local
Lies `.env.local` im Projekt-Root, Zeile `EXPO_PUBLIC_API_URL=`.
- IP weicht ab → im Bericht die richtige Zeile nennen: `EXPO_PUBLIC_API_URL=http://<WLAN-IP>:8000`.
- Datei fehlt → im Bericht: `.env.example` nach `.env.local` kopieren und diese Zeile eintragen.
- Steht dort eine `https://…`-Adresse (Normalfall: der Server `https://goe4fun.de`), ist das Absicht → nicht
  ändern, in Schritt 5 statt der WLAN-IP `curl -s -m 5 <Adresse>/api/health` prüfen. Die WLAN-IP ist dann nur
  für Metro (Expo Go) wichtig, nicht fürs Backend.

## 4. Backend lokal
`curl -s -m 3 http://127.0.0.1:8000/api/health` — erwartet `{"ok":true}`.
Keine Antwort → im Bericht: Backend in einem eigenen Terminal starten (siehe README).

## 5. Backend über die WLAN-IP
`curl -s -m 3 http://<WLAN-IP>:8000/api/health` (dafür fragt Claude Code nach) — erwartet `{"ok":true}`.
Lokal ging es, hier Timeout → vermutlich die Firewall. Gib dem Nutzer diese Befehle für eine
**Admin-PowerShell** aus (nicht selbst ausführen):
- prüfen: `Get-NetFirewallRule -DisplayName 'Goenntertainment Backend 8000' | Select-Object DisplayName,Enabled,Profile`
- anlegen: `New-NetFirewallRule -DisplayName "Goenntertainment Backend 8000" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8000 -Profile Private`

## 6. Statusbericht
Kompakt, ein ✅/❌ pro Zeile: Internet · WLAN-IP · `.env.local` (stimmt / neue Zeile) · Backend lokal ·
Backend über WLAN-IP · ggf. Firewall-Hinweis. Muss `.env.local` geändert werden: danach Metro/App neu laden
(im Expo-Terminal `r`), sonst steckt die alte Adresse noch im Bundle.
