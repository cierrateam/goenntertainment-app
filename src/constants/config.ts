import Constants from 'expo-constants';

/**
 * Basis-URL der API (Laravel, Ordner `api/`).
 *
 * Die Adresse steht bewusst NICHT mehr im Code, sondern kommt aus der Umgebung:
 *
 *   `.env.local`      → dieser Rechner (liegt nicht im Git, siehe `.gitignore`)
 *   `eas.json` → env  → die gebauten Apps (APK/IPA)
 *
 * Warum? Eine hier verdrahtete WLAN-IP fesselt die App ans Heimnetz: Ein
 * fertiges APK mit `192.168.178.x` läuft nur, solange das Handy in derselben
 * Fritzbox hängt, und ist unterwegs auf Mobilfunk tot. Über die Variable zeigen
 * Dev-Betrieb und Build auf den Server unter der eigenen Domain
 * (`https://goe4fun.de`); wer API-Änderungen am eigenen PC testet, trägt in
 * `.env.local` vorübergehend die LAN-IP ein – ohne dass an dieser Datei eine
 * Zeile geändert werden muss.
 *
 * WICHTIG: `process.env.EXPO_PUBLIC_API_URL` muss genau so ausgeschrieben
 * dastehen. Metro ersetzt diesen Ausdruck beim Bündeln durch den Wert; ein
 * Umweg wie `process.env['EXPO_PUBLIC_API_URL']` oder Destrukturieren wird
 * NICHT ersetzt und ist im Build `undefined`.
 *
 * Nach einer Änderung an `.env.local` Metro neu starten, sonst steckt der alte
 * Wert noch im Bundle.
 */
const CONFIGURED_API_URL = process.env.EXPO_PUBLIC_API_URL?.trim().replace(/\/+$/, '');

const BACKEND_PORT = 8000;

/**
 * Notnagel für den Dev-Betrieb ohne `.env.local`: dieselbe Adresse wie Metro,
 * nur auf Port 8000.
 *
 * Vorsicht, das Raten geht auf diesem Rechner regelmäßig schief – es liefert
 * `127.0.0.1` (das wäre das Handy selbst) oder die Hamachi-VPN-IP `25.x`, die
 * das Handy im WLAN nicht erreicht. Beides endet im Login-Timeout. Deshalb ist
 * `.env.local` der normale Weg und das hier nur der letzte Ausweg.
 */
function guessDevHost(): string {
  const hostUri =
    Constants.expoConfig?.hostUri ??
    // ältere Expo-Go-Variante
    (Constants as unknown as { expoGoConfig?: { debuggerHost?: string } }).expoGoConfig?.debuggerHost;

  const host = hostUri?.split(':')[0];

  return host ? `http://${host}:${BACKEND_PORT}` : `http://localhost:${BACKEND_PORT}`;
}

export const API_BASE_URL = CONFIGURED_API_URL || guessDevHost();

if (__DEV__ && !CONFIGURED_API_URL) {
  // Nicht nur ein Schönheitsfehler: geraten wird meist die falsche Adresse, und
  // der Fehler zeigt sich erst als hängender Login.
  console.warn(
    `[config] EXPO_PUBLIC_API_URL ist nicht gesetzt – geraten wird ${API_BASE_URL}. ` +
      'Trag https://goe4fun.de in .env.local ein (Vorlage: .env.example).',
  );
}

export const API_URL = `${API_BASE_URL}/api`;
