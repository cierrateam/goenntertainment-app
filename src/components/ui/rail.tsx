import { useCallback, useRef, useState, type ReactNode } from 'react';
import {
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollViewInstance,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { ScrollHint } from '@/components/ui/scroll-hint';
import { Spacing } from '@/constants/theme';

type Props = {
  /** Breite einer Seite – bestimmt, wie weit ein Wisch springt. */
  itemWidth: number;
  /** Abstand zwischen den Seiten. */
  gap?: number;
  /** Die Seiten. */
  children: ReactNode;
  /** Was Screenreader an den Pfeilen vorlesen. */
  labels?: { left: string; right: string };
  /**
   * Höhe des Feldes, in dem die Pfeile mittig sitzen – Standard: die ganze Reihe.
   *
   * Nötig für Reihen, die sehr hoch werden können (aufgeklappte Kategorie-Spalten):
   * Mittig über einer drei Bildschirme hohen Spalte lägen die Pfeile irgendwo in
   * der Liste, weit weg von dem, was sie bewegen.
   */
  hintHeight?: number;
  /** Zusätzlicher Stil für die Spur (z. B. `alignItems`). */
  contentStyle?: StyleProp<ViewStyle>;
};

/**
 * Eine waagerecht wischbare Reihe mit Einrasten und Pfeilen an den Rändern.
 *
 * Die reine Mechanik, ohne Wissen darüber, was in den Seiten steht: Regale mit
 * Karten, Kategorie-Spalten und die Sektionen der Startseite brauchen alle
 * dasselbe Verhalten – Einrasten auf Seitenbreite, und ein Pfeil, der zeigt, dass
 * es weitergeht. Dreimal derselbe Ablauf mit drei Ausblendzeiten wäre an genau der
 * Stelle verschieden, an der es niemandem auffällt und alle es spüren.
 */
export function Rail({
  itemWidth,
  gap = Spacing.three,
  children,
  labels,
  hintHeight,
  contentStyle,
}: Props) {
  const scrollRef = useRef<ScrollViewInstance>(null);
  const step = itemWidth + gap;

  // Wohin lässt sich noch wischen? Die Maße liegen in einem Ref, damit das
  // Scrollen selbst nichts neu rendert – nur wenn ein Pfeil tatsächlich
  // erscheint oder verschwindet, geht ein Render los.
  const geo = useRef({ x: 0, view: 0, content: 0 });
  const [reach, setReach] = useState({ left: false, right: false });

  const sync = useCallback(() => {
    const { x, view, content } = geo.current;
    // 8 px Toleranz: gegen Rundungsfehler und das Gummiband am Rand.
    const left = x > 8;
    const right = content - view - x > 8;
    setReach((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => {
      geo.current.view = event.nativeEvent.layout.width;
      sync();
    },
    [sync],
  );

  const onContentSizeChange = useCallback(
    (width: number) => {
      geo.current.content = width;
      sync();
    },
    [sync],
  );

  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
      geo.current = {
        x: contentOffset.x,
        view: layoutMeasurement.width,
        content: contentSize.width,
      };
      sync();
    },
    [sync],
  );

  /** Eine Seite weiter blättern – der Pfeil ist Hinweis UND Knopf. */
  const page = useCallback(
    (direction: -1 | 1) => {
      const target = Math.max(0, geo.current.x + direction * step);
      scrollRef.current?.scrollTo({ x: target, animated: true });
    },
    [step],
  );

  return (
    <View>
      <ScrollView
        ref={scrollRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        decelerationRate="fast"
        snapToInterval={step}
        snapToAlignment="start"
        scrollEventThrottle={32}
        onScroll={onScroll}
        onLayout={onLayout}
        onContentSizeChange={onContentSizeChange}
        contentContainerStyle={[styles.track, { gap }, contentStyle]}>
        {children}
      </ScrollView>

      {/* Die Pfeile liegen über der Reihe, fangen aber nur ihre eigene Fläche ab –
          gewischt wird weiter überall. */}
      <View
        style={[styles.hints, hintHeight === undefined ? styles.hintsFull : { height: hintHeight }]}
        pointerEvents="box-none">
        <ScrollHint
          side="left"
          visible={reach.left}
          onPress={() => page(-1)}
          label={labels?.left}
        />
        <ScrollHint
          side="right"
          visible={reach.right}
          onPress={() => page(1)}
          label={labels?.right}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    paddingHorizontal: Spacing.four,
    // Luft für den Schatten der Seiten, oben wie unten.
    paddingVertical: 2,
  },
  hints: { position: 'absolute', left: 0, right: 0, top: 0 },
  hintsFull: { bottom: 0 },
});
