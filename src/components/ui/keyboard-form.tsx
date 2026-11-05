import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Keyboard,
  Platform,
  ScrollView,
  View,
  type KeyboardEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
  type ScrollViewProps,
  type ViewInstance,
  type LayoutChangeEvent,
} from 'react-native';

import { Spacing } from '@/constants/theme';

import { FormScrollContext, type FormScrollApi } from './form-scroll-context';

export type KeyboardFormProps = ScrollViewProps & {
  children: ReactNode;
  /** Luft zwischen Feldunterkante und Tastaturoberkante. */
  gapAboveKeyboard?: number;
};

/**
 * Scrollbares Formular, das die Tastatur selbst freistellt.
 *
 * Warum NICHT `KeyboardAvoidingView`? Beide Betriebsarten waren hier defekt:
 *
 * - `behavior={undefined}` (was auf Android nötig schien) ist laut RN-Quelle
 *   der `default:`-Fall und rendert eine ganz normale `View` – die Komponente
 *   tut also buchstäblich NICHTS. Zusammen mit `softwareKeyboardLayoutMode:
 *   "pan"`, das unter dem ab SDK 54 erzwungenen edge-to-edge nicht mehr
 *   zuverlässig greift, gab es auf Android gar keine Freistellung mehr: die
 *   Tastatur legte sich einfach über das Feld. Genau das ist „die Tastatur
 *   funktioniert nicht".
 * - `behavior="padding"` ruft bei jedem Tastatur-Ereignis
 *   `LayoutAnimation.configureNext` und verändert dabei die Höhe des
 *   Container-Views. Auf Android (Fabric) baut das die Views neu auf, der
 *   Fokus geht verloren – das war das „Feld springt auf und sofort wieder zu".
 *
 * Dieser Container umgeht beides: die Tastaturhöhe kommt als eigener
 * Abstandshalter ans ENDE des Inhalts. Die ScrollView behält ihre Größe, es
 * gibt keine LayoutAnimation und damit keine Rückkopplung zwischen Messung
 * und Tastatur. Zusätzlich wird das fokussierte Feld über die Tastatur
 * gescrollt – dafür liefert das Tastatur-Ereignis mit `endCoordinates.screenY`
 * die Oberkante direkt, ohne Rechnung mit Fenstermaßen (die sich unter
 * edge-to-edge beim Tastatur-Öffnen selbst ändern).
 */
export function KeyboardForm({
  children,
  gapAboveKeyboard = Spacing.four,
  onScroll,
  onLayout,
  ...rest
}: KeyboardFormProps) {
  const scrollRef = useRef<ScrollViewInstance>(null);
  /** Aktueller Scrollstand – für die Umrechnung „um wie viel muss ich schieben". */
  const scrollY = useRef(0);
  /** Oberkante der Tastatur in Bildschirmkoordinaten, `null` = zu. */
  const keyboardTop = useRef<number | null>(null);
  /** Feld, das gerade den Fokus bekommen hat (wartet ggf. auf die Tastatur). */
  const awaiting = useRef<ViewInstance | null>(null);
  const [inset, setInset] = useState(0);

  /**
   * Schiebt das Feld frei, sofern die Tastatur schon steht. `measureInWindow`
   * liefert Bildschirmkoordinaten – die sind direkt mit der Tastaturoberkante
   * vergleichbar, ohne Scrollstand oder Fensterhöhe einzurechnen.
   */
  const reveal = useCallback(
    (node: ViewInstance | null) => {
      const top = keyboardTop.current;
      const scroll = scrollRef.current;
      if (!node || !scroll || top == null) return;

      node.measureInWindow((_x, y, _width, height) => {
        if (!Number.isFinite(y) || !Number.isFinite(height)) return;

        const overlap = y + height + gapAboveKeyboard - top;
        if (overlap > 1) {
          scroll.scrollTo({ y: scrollY.current + overlap, animated: true });
        }
      });
    },
    [gapAboveKeyboard],
  );

  // Immer die frische `reveal`-Fassung aufrufen, ohne die Listener neu zu
  // registrieren: ein Ab-/Anmelden mitten im Fokus-Wechsel würde Ereignisse
  // verschlucken.
  const revealRef = useRef(reveal);
  // Updated after commit, not during render (React Compiler rule: no ref writes
  // in render). Keyboard events and focus callbacks only fire after commit.
  useLayoutEffect(() => {
    revealRef.current = reveal;
  }, [reveal]);

  useEffect(() => {
    // iOS kündigt an („will"), Android meldet erst hinterher („did").
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const subs = [
      Keyboard.addListener(showEvent, (event: KeyboardEvent) => {
        const coords = event.endCoordinates;
        keyboardTop.current = Number.isFinite(coords?.screenY) ? coords.screenY : null;
        setInset(Math.max(0, coords?.height ?? 0));
        // Das Feld, das die Tastatur ausgelöst hat, jetzt freischieben.
        revealRef.current(awaiting.current);
      }),
      Keyboard.addListener(hideEvent, () => {
        keyboardTop.current = null;
        awaiting.current = null;
        setInset(0);
      }),
    ];

    return () => subs.forEach((sub) => sub.remove());
  }, []);

  const api = useMemo<FormScrollApi>(
    () => ({
      ensureVisible: (node) => {
        awaiting.current = node;
        // Steht die Tastatur schon (Sprung von Feld zu Feld), kommt kein
        // weiteres `keyboardDidShow` – dann sofort selbst schieben.
        if (keyboardTop.current != null) revealRef.current(node);
      },
    }),
    [],
  );

  return (
    <FormScrollContext.Provider value={api}>
      <ScrollView
        {...rest}
        ref={scrollRef}
        // `handled` genügt: der Absenden-Knopf reagiert auf den ersten Tipp,
        // ohne dass ein Tastendruck die Tastatur schließt. Bewusst KEIN
        // `keyboardDismissMode="on-drag"` – das Verschieben beim Öffnen zählt
        // als Drag und schloss die gerade geöffnete Tastatur sofort wieder.
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) => {
          scrollY.current = event.nativeEvent.contentOffset.y;
          onScroll?.(event);
        }}
        onLayout={(event: LayoutChangeEvent) => {
          onLayout?.(event);
        }}>
        {children}
        {/* Platz für die Tastatur. Als letztes Kind angehängt: das verändert
            keine Geschwister und lässt das Layout bei geschlossener Tastatur
            unberührt (kein Abstand, kein zusätzliches `gap`). */}
        {inset > 0 ? <View style={{ height: inset }} /> : null}
      </ScrollView>
    </FormScrollContext.Provider>
  );
}
