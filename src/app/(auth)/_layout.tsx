import { Stack } from 'expo-router';

import { renderAppHeader } from '@/components/ui/app-header';
import { ForceScheme } from '@/lib/theme-preference';

/**
 * Die Anmelde-Screens laufen immer auf der hellen Leinwand (GoennBackground).
 * Damit Felder und Karten darin nicht in Dark-Mode-Farben kippen, wenn im
 * Konto Dark-Mode gewählt ist, wird das Schema hier fest auf hell gesetzt.
 *
 * Eigener Stack, also eigener Kopf-Eintrag: Die `screenOptions` des äußeren
 * Stacks gelten hier nicht.
 */
export default function AuthLayout() {
  return (
    <ForceScheme scheme="light">
      <Stack
        screenOptions={{
          headerShown: false,
          // Wie im äußeren Stack: SDK 58 macht den Kopf auf iOS 26+ sonst durchsichtig.
          headerTransparent: false,
          headerBackTitle: 'Zurück',
          headerBackButtonDisplayMode: 'default',
          header: renderAppHeader,
        }}
      />
    </ForceScheme>
  );
}
