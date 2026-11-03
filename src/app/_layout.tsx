import {
  InstrumentSans_400Regular,
  InstrumentSans_500Medium,
  InstrumentSans_600SemiBold,
  InstrumentSans_700Bold,
} from '@expo-google-fonts/instrument-sans';
import { Pacifico_400Regular, useFonts } from '@expo-google-fonts/pacifico';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router/react-navigation';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { CelebrationProvider } from '@/components/celebration';
import { CreditsSheetProvider } from '@/components/credits-sheet';
import { MascotDockProvider } from '@/components/mascot-dock';
import { PerfMeterOverlay } from '@/components/perf-meter';
import { renderAppHeader } from '@/components/ui/app-header';
import { AppSettingsProvider } from '@/lib/app-settings';
import { AuthProvider, useAuth } from '@/lib/auth-context';
import { FeaturesProvider } from '@/lib/features-context';
import { MarketProvider } from '@/lib/market-context';
import { ThemePreferenceProvider, useResolvedScheme } from '@/lib/theme-preference';

SplashScreen.preventAutoHideAsync();

function RootNavigator({ fontsReady }: { fontsReady: boolean }) {
  const { isBootstrapping, token } = useAuth();
  const ready = fontsReady && !isBootstrapping;

  useEffect(() => {
    if (ready) {
      SplashScreen.hideAsync();
    }
  }, [ready]);

  // Splash bleibt, bis Schrift geladen UND der gespeicherte Token geprüft ist.
  if (!ready) {
    return null;
  }

  return (
    // `header`: Jeder Screen, der seinen Kopf einschaltet, bekommt den der App –
    // runder Zurück-Knopf statt System-Pfeil, überall gleich (app-header.tsx).
    // `animation`: Jeder neue Screen schiebt sich von rechts herein – auf iOS UND
    // Android gleich; Zurückwischen geht über die ganze Breite.
    // `headerTransparent: false`: Seit SDK 58 ist der Kopf auf iOS 26+ von sich aus
    // durchsichtig; der Inhalt rutschte dann unter AppHeader. Screens über einem Bild
    // schalten ihn weiter selbst ein.
    <Stack
      screenOptions={{
        headerShown: false,
        headerTransparent: false,
        headerBackTitle: 'Zurück',
        headerBackButtonDisplayMode: 'default',
        header: renderAppHeader,
        animation: 'slide_from_right',
        gestureEnabled: true,
        fullScreenGestureEnabled: true,
      }}>
      <Stack.Protected guard={!!token}>
        {/* Die Tabs: Home · Gruppen · Finden · Tickets · Karte (src/components/app-tabs.tsx). */}
        <Stack.Screen name="(app)" />

        {/* Marktplatz */}
        <Stack.Screen name="offer/[id]" />
        <Stack.Screen name="partner/[id]" />
        <Stack.Screen name="booking/[id]" />

        {/* Club, Credits, Stempel, Check-in */}
        <Stack.Screen name="club" />
        <Stack.Screen name="wallet" />
        <Stack.Screen name="stamps" />
        {/* Stadt-Bingo – nur sichtbar, wenn ein Admin es freischaltet. */}
        <Stack.Screen name="bingo" />
        <Stack.Screen name="checkin" />
        {/* Aufkleber-Link `…/c/<token>` – leitet in den Check-in. */}
        <Stack.Screen name="c/[token]" />

        {/* Gruppe im Detail und Gruppen-Chat (die Liste ist ein Tab). */}
        <Stack.Screen name="group/[id]" />
        <Stack.Screen name="join/[code]" />
        <Stack.Screen name="chat" />

        {/* Konto: hinter dem Profilbild oben rechts. */}
        <Stack.Screen name="account" />
        <Stack.Screen name="profile" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="security/password" />
        <Stack.Screen name="security/email" />
        <Stack.Screen name="security/two-factor" />
        <Stack.Screen name="security/delete-account" />
        <Stack.Screen name="blocked" />

        {/* Partner-Modus (Mitarbeitende eines Partners). */}
        <Stack.Screen name="partner-mode" />

        {/* Admin-Bereich: eigene Stack-Routen, erreichbar über das Konto. */}
        <Stack.Screen name="admin-dashboard" />
        <Stack.Screen name="admin-partners" />
        <Stack.Screen name="admin-partner" />
        <Stack.Screen name="admin-offer" />
        <Stack.Screen name="admin-vouchers" />
        <Stack.Screen name="admin-users" />
        <Stack.Screen name="admin-user" />
        <Stack.Screen name="admin-reports" />
        <Stack.Screen name="admin-evidence" />
        {/* Funktions-Schalter: für alle Nutzer bzw. nur für mich. */}
        <Stack.Screen name="admin-features" />
        <Stack.Screen name="admin-preview" />
        {/* Testphase (admins only). A screen not listed inside a guard would be reachable signed
            out (src/domain/app-routes.test.ts). */}
        <Stack.Screen name="admin-test" />
        <Stack.Screen name="admin-test-challenge" />
        <Stack.Screen name="badges" />
      </Stack.Protected>
      <Stack.Protected guard={!token}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
      {/* Rechtstexte IN der App: Impressum, Nutzungsbedingungen, Haftung, Regeln,
          Datenschutz (siehe src/domain/legal.ts).

          Bewusst AUSSERHALB beider Wächter: Bei der Registrierung muss man den
          Bedingungen zustimmen, und genau dort gibt es noch keinen Token. Lägen
          diese Texte im geschützten Bereich, führte der Link im
          Zustimmungssatz ins Leere – man müsste zustimmen, ohne lesen zu können. */}
      <Stack.Screen name="legal" />
    </Stack>
  );
}

/** Navigations-Theme an das aufgelöste Farbschema (inkl. Dark-Mode-Setting) koppeln. */
function ThemedNavigation({ fontsReady }: { fontsReady: boolean }) {
  const scheme = useResolvedScheme();

  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <RootNavigator fontsReady={fontsReady} />
    </ThemeProvider>
  );
}

export default function RootLayout() {
  // Pacifico = Wortmarke, Instrument Sans = Schrift der gesamten Oberfläche.
  const [fontsLoaded] = useFonts({
    Pacifico_400Regular,
    InstrumentSans_400Regular,
    InstrumentSans_500Medium,
    InstrumentSans_600SemiBold,
    InstrumentSans_700Bold,
  });

  return (
    // Wurzel für alle Wisch-Gesten (Tabs, Blätter, Bildschirme zuziehen). Ohne
    // sie kommen Gesten auf Android gar nicht an.
    <GestureHandlerRootView style={styles.root}>
      <AuthProvider>
        <ThemePreferenceProvider>
          <AppSettingsProvider>
            {/* Admin-Schalter (Bingo, Saison-Thema) – vor allem, was Deko und Goenni zeichnet. */}
            <FeaturesProvider>
              {/* Angebote, Club, Gruppen, Buchungen – ein Stand für alle Screens. */}
              <MarketProvider>
                {/* Goenni als Begleiter: Zustand hier, Figur in den Tabs. */}
                <MascotDockProvider>
                  <CreditsSheetProvider>
                    {/* Feier-Moment (Buchung, Abo, Gutschein) liegt über der Navigation. */}
                    <CelebrationProvider>
                      <ThemedNavigation fontsReady={fontsLoaded} />
                      {/* Bilder pro Sekunde – nur wenn in den Einstellungen eingeschaltet. */}
                      <PerfMeterOverlay />
                    </CelebrationProvider>
                  </CreditsSheetProvider>
                </MascotDockProvider>
              </MarketProvider>
            </FeaturesProvider>
          </AppSettingsProvider>
        </ThemePreferenceProvider>
      </AuthProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});
