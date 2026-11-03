import { forwardRef, memo, useRef, useState, type ReactNode } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type BlurEvent,
  type FocusEvent,
  type StyleProp,
  type TextInputInstance,
  type TextInputProps,
  type ViewInstance,
  type ViewStyle,
} from 'react-native';

import { FontFamily, Radius, Spacing } from '@/constants/theme';
import { useBrandSurface } from '@/hooks/use-theme';

import { useFormScroll } from './form-scroll-context';
import { EyeIcon, EyeOffIcon } from './icons';

export type TextFieldProps = TextInputProps & {
  label?: string;
  error?: string;
  /** Erklärung unter dem Feld, solange kein Fehler ansteht. */
  hint?: string;
  /** Symbol links im Feld (Brief, Schloss, …). */
  leftIcon?: ReactNode;
  /**
   * Bedienbares Element rechts im Feld (z. B. Karten-Pin). Bei Passwörtern hat
   * der Augen-Umschalter Vorrang.
   */
  rightAccessory?: ReactNode;
  /** Rahmen um Beschriftung + Feld + Fehlertext. */
  containerStyle?: StyleProp<ViewStyle>;
  /**
   * Die Feldfläche selbst (Höhe, Innenabstand, Farben). Nötig für kompakte
   * Zeilen wie die Bearbeiten-Zeile in den Einstellungen. Wird NACH den
   * Vorgaben angewendet, überschreibt sie also.
   */
  fieldStyle?: StyleProp<ViewStyle>;
};

/**
 * Eingabefeld – von Grund auf neu geschrieben (Ersatz für `brand-text-field`).
 *
 * Vier Regeln, die hier eingehalten werden, weil jeder Bruch davon schon einen
 * Tastatur-Bug verursacht hat:
 *
 * 1. **Beim Fokus ändert sich nur Farbe, nie Geometrie.** Kein `shadowColor`,
 *    kein `elevation`, keine wechselnde Randbreite, kein anderer Innenabstand.
 *    Android baut die native View bei Schatten- und Layout-Props neu auf –
 *    dabei geht der Fokus verloren und die Tastatur klappt sofort zu.
 * 2. **Die View-Kette über dem `TextInput` ist konstant.** Zwischen Feld und
 *    Bildschirm wird nichts bedingt gerendert; alles Bedingte (Symbol links,
 *    Knopf rechts, Fehlertext) hängt an Props oder steht NACH dem Feld, kann
 *    es also nicht neu einhängen.
 * 3. **Eigene Handler ergänzen die des Aufrufers, sie ersetzen sie nicht.**
 *    `...rest` steht zuerst, `onFocus`/`onBlur` danach – und rufen die
 *    übergebenen Fassungen mit auf. (Vorher stand der Spread hinten und hat
 *    die internen Handler still überschrieben.)
 * 4. **`memo` + weitergegebenes `ref`.** Ein Re-Render des Formulars bei jedem
 *    Tastendruck läuft nicht mehr durch alle anderen Felder.
 *
 * Freigestellt wird das Feld nicht von hier, sondern von `KeyboardForm`: beim
 * Fokussieren meldet es sich dort über `ensureVisible` an. Ohne diesen
 * Container bleibt das wirkungslos, das Feld funktioniert aber trotzdem.
 */
export const TextField = memo(
  forwardRef<TextInputInstance, TextFieldProps>(function TextField(
    {
      label,
      error,
      hint,
      leftIcon,
      rightAccessory,
      containerStyle,
      fieldStyle,
      style,
      secureTextEntry,
      multiline,
      onFocus,
      onBlur,
      ...rest
    },
    ref,
  ) {
    const surface = useBrandSurface();
    const { ensureVisible } = useFormScroll();

    const [focused, setFocused] = useState(false);
    const [revealed, setRevealed] = useState(false);

    // `collapsable={false}`: sonst faltet Android die reine Layout-View weg und
    // `measureInWindow` liefert keine brauchbaren Koordinaten mehr.
    const wrapper = useRef<ViewInstance>(null);

    const borderColor = error ? SIGNAL_ERROR : focused ? surface.accent : surface.fieldBorder;

    function handleFocus(event: FocusEvent) {
      setFocused(true);
      ensureVisible(wrapper.current);
      onFocus?.(event);
    }

    function handleBlur(event: BlurEvent) {
      setFocused(false);
      onBlur?.(event);
    }

    return (
      <View ref={wrapper} collapsable={false} style={[styles.container, containerStyle]}>
        {label ? <Text style={[styles.label, { color: surface.textMuted }]}>{label}</Text> : null}

        <View
          style={[
            styles.row,
            multiline ? styles.rowMultiline : null,
            { backgroundColor: surface.fieldBg, borderColor },
            fieldStyle,
          ]}>
          {leftIcon ? <View style={styles.iconLeft}>{leftIcon}</View> : null}

          <TextInput
            {...rest}
            ref={ref}
            multiline={multiline}
            secureTextEntry={secureTextEntry ? !revealed : false}
            placeholderTextColor={surface.fieldPlaceholder}
            style={[styles.input, multiline ? styles.inputMultiline : null, { color: surface.text }, style]}
            onFocus={handleFocus}
            onBlur={handleBlur}
          />

          {secureTextEntry ? (
            <Pressable
              onPress={() => setRevealed((value) => !value)}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={revealed ? 'Passwort verbergen' : 'Passwort anzeigen'}
              style={styles.iconRight}>
              {revealed ? <EyeOffIcon color={surface.textMuted} /> : <EyeIcon color={surface.textMuted} />}
            </Pressable>
          ) : rightAccessory ? (
            <View style={styles.iconRight}>{rightAccessory}</View>
          ) : null}
        </View>

        {error ? (
          <Text style={styles.error}>{error}</Text>
        ) : hint ? (
          <Text style={[styles.hint, { color: surface.textMuted }]}>{hint}</Text>
        ) : null}
      </View>
    );
  }),
);

const SIGNAL_ERROR = '#ef4444';

const styles = StyleSheet.create({
  container: {
    gap: Spacing.two,
    minWidth: 0,
  },
  label: {
    marginLeft: Spacing.half,
    fontSize: 13,
    fontWeight: '700',
    fontFamily: FontFamily.bold,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.three,
    minHeight: 56,
    borderRadius: Radius.field,
    // Feste Randbreite: eine im Fokus wechselnde Breite verschiebt das Layout
    // und kostet auf Android den Fokus.
    borderWidth: 1.5,
  },
  rowMultiline: {
    // Mehrzeilig wächst das Feld nach unten – der Text soll oben anfangen.
    alignItems: 'flex-start',
    paddingVertical: Spacing.two,
  },
  iconLeft: {
    marginRight: Spacing.two,
  },
  iconRight: {
    marginLeft: Spacing.two,
    padding: Spacing.half,
  },
  input: {
    flex: 1,
    // Im Web hat ein <input> sonst eine Mindestbreite (~20 Zeichen) und schiebt
    // schmale Reihen über den Rand ihrer Karte.
    minWidth: 0,
    paddingVertical: Spacing.three,
    fontSize: 16,
    fontFamily: FontFamily.regular,
    ...Platform.select({
      // Ohne das sitzt der Text auf Android durch die Schriftmetrik zu tief.
      android: { includeFontPadding: false } as object,
      web: { outlineStyle: 'none' } as object,
      default: {},
    }),
  },
  inputMultiline: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
  error: {
    marginLeft: Spacing.half,
    fontSize: 13,
    fontFamily: FontFamily.medium,
    color: SIGNAL_ERROR,
  },
  hint: {
    marginLeft: Spacing.half,
    fontSize: 13,
    fontFamily: FontFamily.regular,
  },
});
