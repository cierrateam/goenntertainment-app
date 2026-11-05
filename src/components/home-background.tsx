import { BlurTargetView } from 'expo-blur';
import type { ReactNode, RefObject } from 'react';
import { StyleSheet, View, type ViewInstance, type ViewProps } from 'react-native';

import { Palette } from '@/constants/theme';
import { useResolvedScheme } from '@/lib/theme-preference';

/**
 * Leinwand der App – eine ruhige, einfarbige Fläche wie bei Instagram und TikTok.
 *
 * Vorher lagen hier ein 1px-Raster, zwei Farbscheine und ein Verlauf (cira.systems-
 * Look). Für eine App, deren Inhalt Fotos von Events sind, war das Unruhe hinter
 * den Bildern: Instagram und TikTok zeigen bewusst NUR Weiß bzw. Schwarz, damit
 * die Fotos das Farbigste auf dem Bildschirm sind. Der Name bleibt, weil über
 * zwanzig Screens ihn benutzen.
 */
type HomeBackgroundProps = ViewProps & {
  /**
   * Macht die Leinwand samt Inhalt zur Vorlage für einen `BlurView`. Seit Expo
   * SDK 55 zeichnet Android nur noch weich, was in einem `BlurTargetView`
   * liegt – ohne dieses Ziel bliebe vom Glas nur die Tönung übrig.
   */
  blurTarget?: RefObject<ViewInstance | null>;
  /**
   * Liegt über der Leinwand, aber AUSSERHALB des Blur-Ziels. Hierhin gehört
   * das Glas selbst (das Konto-Blatt): Läge es im Ziel, müsste es sich selbst
   * weichzeichnen.
   */
  overlay?: ReactNode;
};

export function HomeBackground({
  children,
  style,
  blurTarget,
  overlay,
  ...rest
}: HomeBackgroundProps) {
  const scheme = useResolvedScheme();
  const base = scheme === 'dark' ? Palette.canvasDark : Palette.canvas;

  if (!blurTarget) {
    return (
      <View style={[styles.container, { backgroundColor: base }, style]} {...rest}>
        {children}
        {overlay}
      </View>
    );
  }

  // Nur mit Ziel eine zusätzliche Hülle: Sie schöbe sich sonst zwischen den
  // Bildschirm und seine Kinder, und Layout-Styles wie `styles.centered` kämen
  // bei den Kindern nicht mehr an.
  return (
    <View style={[styles.container, { backgroundColor: base }, style]} {...rest}>
      {/* Das Ziel trägt den Grund noch einmal selbst: Der Weichzeichner sieht
          nur, was IM Ziel gezeichnet wird – ohne eigene Farbe wäre die
          Leinwand für ihn durchsichtig. */}
      <BlurTargetView ref={blurTarget} style={[styles.canvas, { backgroundColor: base }]}>
        {children}
      </BlurTargetView>
      {overlay}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    overflow: 'hidden',
  },
  canvas: { flex: 1 },
});
