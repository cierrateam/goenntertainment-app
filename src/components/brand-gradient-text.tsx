import MaskedViewNative from '@react-native-masked-view/masked-view';
import { LinearGradient } from 'expo-linear-gradient';
import type { ComponentType, ReactElement } from 'react';
import { Platform, StyleSheet, Text, type TextProps, type ViewProps } from 'react-native';

import { Brand, BrandGradient } from '@/constants/theme';

// Die Typen von masked-view 0.3.2 erben von `NativeMethods`, das React Native seit 0.88
// (strikte Typen) nicht mehr exportiert – zur Laufzeit ist die Komponente unverändert.
const MaskedView = MaskedViewNative as unknown as ComponentType<ViewProps & { maskElement: ReactElement }>;

/**
 * Text im Marken-Verlauf (Lila → Pink), wie `brand-gradient-text` im Web.
 * Native: über eine Maske aus dem Text. Web: einfacher Voll-Lila-Fallback,
 * da MaskedView im Browser nicht überall sauber läuft.
 */
export function BrandGradientText({ style, children, ...rest }: TextProps) {
  if (Platform.OS === 'web') {
    return (
      <Text style={[style, { color: Brand.purple }]} {...rest}>
        {children}
      </Text>
    );
  }

  return (
    <MaskedView
      maskElement={
        <Text style={[style, styles.maskText]} {...rest}>
          {children}
        </Text>
      }>
      <LinearGradient colors={BrandGradient} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}>
        <Text style={[style, { opacity: 0 }]} {...rest}>
          {children}
        </Text>
      </LinearGradient>
    </MaskedView>
  );
}

const styles = StyleSheet.create({
  maskText: {
    backgroundColor: 'transparent',
  },
});
