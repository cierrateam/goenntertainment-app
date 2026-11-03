import { LinearGradient } from 'expo-linear-gradient';
import { useIsFocused, useRouter } from 'expo-router';
import { Tabs, TabList, TabSlot, TabTrigger, type TabListProps, type TabTriggerSlotProps } from 'expo-router/ui';
import { createContext, memo, startTransition, useCallback, useContext, useDeferredValue, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets';

import { MascotDock, useDockActions } from '@/components/mascot-dock';
import { TopBar } from '@/components/top-bar';
import { Icon } from '@/components/ui/icon';
import { MotionPause } from '@/components/ui/motion-pause';
import { BrandGradient, FontFamily, Spacing, Stroke } from '@/constants/theme';
import { nextExpiring } from '@/domain/booking-status';
import { tabDragOffset, tabSwipeTarget } from '@/domain/gestures';
import type { MascotScene } from '@/domain/mascot-lines';
import type { UiIconName } from '@/domain/ui-icon';
import { useTheme } from '@/hooks/use-theme';
import { useNow } from '@/hooks/use-now';
import * as feedback from '@/lib/feedback';
import { useMarket } from '@/lib/market-context';

/**
 * Die untere Leiste – fünf Ziele:
 *
 *   Home  ·  Gruppen  ·  ( Entdecken )  ·  Tickets  ·  Karte
 *
 * ## Warum Gruppen und Tickets eigene Tabs sind
 *
 * Vorher hingen beide am Konto (Profilbild → Konto → Gruppen). So fand man sie
 * nicht: Gruppen sind der Grund für den Rabatt, Tickets das, was man beim
 * Partner vorzeigt – beides gehört mit einem Tipp erreichbar in die Leiste.
 * Gruppen zeigen Ungelesenes als Zahl, Tickets einen Punkt, wenn eins bald
 * verfällt.
 *
 * ## Warum „Entdecken" in der Mitte heraussticht
 *
 * Der Finder ist der Kern: Wie viele seid ihr, was wollt ihr – und die App sagt,
 * was passt. Er sitzt als runder Verlaufsknopf erhöht in der Mitte, genau dort,
 * wo der Daumen liegt.
 *
 * ## Der Wechsel
 *
 * Tabs gleiten seitlich hinein und hinaus wie Seiten (`SlidingSlot`): nach
 * rechts, wenn das Ziel rechts liegt, sonst nach links. So sieht man, wohin man
 * „gegangen" ist. Bei „Bewegung reduzieren" wechselt der Inhalt sofort.
 *
 * ## Wischen
 *
 * Links/rechts wischen blättert zum Nachbar-Tab (Nutzerwunsch Okt. 2026): Die
 * Seite folgt dem Finger, der Nachbar schiebt sich daneben herein, und beim
 * Loslassen entscheidet `tabSwipeTarget` (src/domain/gestures.ts), ob es
 * weitergeht oder zurückfedert. Damit der Nachbar beim Ziehen schon da ist,
 * werden die beiden Tabs neben dem vorderen vorab gezeichnet – erst NACH dem
 * Wechsel, wenn der Finger ruht (`PRELOAD_DELAY_MS`), damit der Aufbau weder den
 * Wechsel noch das Scrollen bremst. Die Karte nie (zu schwer, sie zeigt beim
 * Hineinziehen einen Platzhalter).
 *
 * Senkrechtes Scrollen und waagerechte Reihen (Rail, Chips) gewinnen gegen das
 * Wischen: Die Geste startet erst nach 18 Punkten waagerecht und gibt auf, wenn
 * der Finger vorher 14 Punkte senkrecht wandert. Auf der Karte ist Wischen aus –
 * dort verschiebt der Finger die Karte.
 *
 * Über der Leiste sitzt Goenni als Begleiter (src/components/mascot-dock.tsx).
 *
 * Eigene Leiste statt der nativen: Nur so lässt sich der Mittelknopf erhöht und
 * im Markenverlauf zeichnen, und iOS, Android und Web sehen gleich aus.
 */
type TabName = 'index' | 'groups' | 'finder' | 'bookings' | 'map';

type TabDef = {
  name: TabName;
  href: '/' | '/groups' | '/finder' | '/bookings' | '/map';
  label: string;
  icon: UiIconName;
};

const TABS: TabDef[] = [
  { name: 'index', href: '/', label: 'Home', icon: 'home' },
  { name: 'groups', href: '/groups', label: 'Gruppen', icon: 'users' },
  { name: 'finder', href: '/finder', label: 'Entdecken', icon: 'compass' },
  { name: 'bookings', href: '/bookings', label: 'Tickets', icon: 'ticket' },
  { name: 'map', href: '/map', label: 'Karte', icon: 'map' },
];

const SCENE: Record<string, MascotScene> = { index: 'home', groups: 'groups', finder: 'finder', bookings: 'bookings', map: 'map' };

/** Stelle jedes Tabs in der Leiste – maßgeblich für Richtung und Nachbarn. */
const POSITION: Record<string, number> = Object.fromEntries(TABS.map((tab, i) => [tab.name, i]));

/** Auf diesen Tabs ist Wischen aus: Die Karte braucht den Finger selbst. */
const NO_SWIPE: ReadonlySet<TabName> = new Set(['map']);

/** Waagerechter Weg, ab dem das Wischen startet … */
const SWIPE_START = 18;
/** … und senkrechter Weg, nach dem es aufgibt (dann scrollt die Seite). */
const SWIPE_GIVE_UP = 14;

/** Zurückfedern, wenn das Wischen nicht gereicht hat. */
const SPRING_BACK = { damping: 22, stiffness: 260, mass: 0.7 } as const;

/** So lange darf der Tab-Wechsel nach einem Wischen dauern, bevor die Seiten zurückfedern. */
const SWIPE_ARRIVAL_TIMEOUT_MS = 1200;

/**
 * So lange muss ein Tab vorn stehen und der Finger ruhen, bevor die Nachbarn fürs
 * Wischen vorbereitet werden – lang genug, dass ein Scroll-Schwung ausläuft.
 */
const PRELOAD_DELAY_MS = 900;

/** `warm` plus die beiden Nachbarn von `index` – dasselbe Feld, wenn nichts dazukommt. */
function withNeighbours(warm: readonly number[], index: number): readonly number[] {
  const add = [index - 1, index + 1].filter((i) => i >= 0 && i < TABS.length && !warm.includes(i));
  return add.length > 0 ? [...warm, ...add] : warm;
}

/** Grobe Höhe der Leiste, bis sie gemessen ist. */
const BAR_ESTIMATE = 62;

export default function AppTabs() {
  const insets = useSafeAreaInsets();
  const [barHeight, setBarHeight] = useState(BAR_ESTIMATE + Math.max(insets.bottom, Spacing.two));
  // Unter einer Detailseite sieht man Goenni nicht – dann ruht er auch.
  const focused = useIsFocused();

  return (
    <Tabs style={styles.root} options={{ backBehavior: 'history' }}>
      <SlidingSlot />
      {/* Vor der Leiste gezeichnet: Beim Ducken verschwindet Goenni HINTER ihr. */}
      <MotionPause paused={!focused}>
        <MascotDock bottom={barHeight} />
      </MotionPause>
      <TabList asChild>
        <BottomBar onHeight={setBarHeight}>
          {TABS.map((tab) => (
            <TabTrigger key={tab.name} name={tab.name} href={tab.href} asChild>
              <TabButton tab={tab} />
            </TabTrigger>
          ))}
        </BottomBar>
      </TabList>
    </Tabs>
  );
}

/* ============================================================ Übergang */

type Motion = {
  from: SharedValue<number>;
  to: SharedValue<number>;
  progress: SharedValue<number>;
  /** Welcher Tab zuletzt vorn war – −1 bis zum ersten. */
  current: SharedValue<number>;
  /** Wie weit die vordere Seite gerade gezogen ist (Punkte, 0 = Ruhe). */
  drag: SharedValue<number>;
  /** Zu welchem Tab ein Wischen gerade geführt hat (−1 = keinem) – dann kein zweiter Übergang. */
  swipedTo: SharedValue<number>;
  /** Meldet, welcher Tab vorn ist (für das Vorab-Zeichnen der Nachbarn). */
  onFront: (index: number) => void;
  width: number;
};

const MotionContext = createContext<Motion | null>(null);

/**
 * Der Inhalt der Tabs, jeder als eigene Seite übereinander. Beim Wechsel
 * schieben sich alte und neue Seite gemeinsam zur Seite (wie ein Blättern);
 * alle übrigen liegen unsichtbar außerhalb. Wischen zieht die Seiten mit dem
 * Finger (siehe oben, „Wischen").
 */
function SlidingSlot() {
  const { width } = useWindowDimensions();
  const router = useRouter();
  const from = useSharedValue(0);
  const to = useSharedValue(0);
  const progress = useSharedValue(1);
  const current = useSharedValue(-1);
  const drag = useSharedValue(0);
  const swipedTo = useSharedValue(-1);
  /** Der vordere Tab – entscheidet, ob Wischen gerade geht (auf der Karte nicht). */
  const [front, setFront] = useState(-1);
  /** Welche Tabs schon gezeichnet sind, ohne besucht zu sein (vorbereitete Nachbarn). Sie bleiben es. */
  const [warm, setWarm] = useState<readonly number[]>([]);
  // Die Nachbarn erst aufbauen, wenn der Wechsel durch ist und der Finger ruht –
  // und dann mit niedriger Priorität. Gleich beim Wechsel mitgebaut kostete der
  // Aufbau den Wechsel selbst (gemessen über eine Sekunde bei gedrosselter CPU);
  // mitten im Scrollen gäbe er einen Ruckler. Jede Berührung schiebt ihn auf.
  const preloadAround = useRef(-1);
  const preload = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(preload.current), []);
  const schedulePreload = useCallback(() => {
    clearTimeout(preload.current);
    const index = preloadAround.current;
    if (index < 0) return;
    preload.current = setTimeout(() => startTransition(() => setWarm((prev) => withNeighbours(prev, index))), PRELOAD_DELAY_MS);
  }, []);
  const holdPreload = useCallback(() => clearTimeout(preload.current), []);
  const onFront = useCallback(
    (index: number) => {
      startTransition(() => setFront(index));
      preloadAround.current = index;
      schedulePreload();
    },
    [schedulePreload],
  );

  const goTo = useCallback(
    (target: number) => {
      const tab = TABS[target];
      if (!tab) return;
      feedback.selected();
      router.navigate(tab.href);
      // Rückfall: Kommt der Wechsel nicht an (TabPane setzt `swipedTo` dann zurück),
      // federn die Seiten zurück, statt halb verschoben stehen zu bleiben.
      setTimeout(() => {
        if (swipedTo.get() !== target) return;
        swipedTo.set(-1);
        drag.set(withSpring(0, SPRING_BACK));
      }, SWIPE_ARRIVAL_TIMEOUT_MS);
    },
    [router, swipedTo, drag],
  );

  const frontTab = TABS[front];
  const swipeEnabled = frontTab !== undefined && !NO_SWIPE.has(frontTab.name);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(swipeEnabled)
        .activeOffsetX([-SWIPE_START, SWIPE_START])
        .failOffsetY([-SWIPE_GIVE_UP, SWIPE_GIVE_UP])
        .onUpdate((event) => {
          drag.set(tabDragOffset(current.get(), TABS.length, event.translationX, width));
        })
        .onEnd((event, success) => {
          const index = current.get();
          const target = success ? tabSwipeTarget(index, TABS.length, event.translationX, event.velocityX, width) : null;
          if (target === null) {
            drag.set(withSpring(0, SPRING_BACK));
            return;
          }
          // Sofort wechseln: Die Seiten bleiben, wo der Finger sie losgelassen hat,
          // und `TabPane` fährt beim Ankommen den Rest des Weges von genau dort.
          swipedTo.set(target);
          scheduleOnRN(goTo, target);
        }),
    [swipeEnabled, width, goTo, current, drag, swipedTo],
  );

  // Stabil halten: Ein neues Objekt bei jedem Rendern ließe alle Seiten mitrendern.
  const motion = useMemo(() => ({ from, to, progress, current, drag, swipedTo, onFront, width }), [from, to, progress, current, drag, swipedTo, onFront, width]);

  return (
    <MotionContext.Provider value={motion}>
      {/* `pan-y`: Im Browser bleibt senkrechtes Scrollen beim Browser, waagerecht gehört der Geste.
          `userSelect`: Texte (Buchungscodes) bleiben markierbar – RNGH sperrt das im Web sonst. */}
      <GestureDetector gesture={pan} touchAction="pan-y" userSelect="auto">
        <View style={styles.slot} collapsable={false} onTouchStart={holdPreload} onTouchEnd={schedulePreload} onTouchCancel={schedulePreload}>
          <TabSlot
            style={styles.fill}
            detachInactiveScreens={false}
            renderFn={(descriptor, { index, isFocused, loaded }) => {
              const position = POSITION[descriptor.route.name] ?? index;
              if (!loaded && !isFocused && !warm.includes(position)) return null;
              // Die Karte wird nie vorab gezeichnet – beim Hineinziehen steht dort ihr Platzhalter.
              const placeholder = !loaded && !isFocused && descriptor.route.name === 'map';
              return (
                <TabPane key={descriptor.route.key} index={position} name={descriptor.route.name} focused={isFocused}>
                  <PaneContent route={descriptor.route} placeholder={placeholder} render={descriptor.render} />
                </TabPane>
              );
            }}
          />
        </View>
      </GestureDetector>
    </MotionContext.Provider>
  );
}

/**
 * Der Inhalt einer Tab-Seite – neu gerendert nur, wenn sich ihre Route ändert
 * (z. B. neue Parameter wie `/finder?group=…`).
 *
 * Ohne diese Sperre rendert jeder Tab-Wechsel ALLE geladenen Seiten komplett neu
 * (react-navigation legt bei `descriptor.render()` jedes Mal neue Elemente an,
 * und nichts davon ist gemerkt). Gemessen: Home → Gruppen stand dadurch über
 * drei Sekunden still (CPU wie ein Mittelklasse-Handy). Was die Seite selbst
 * braucht (Fokus, Daten aus dem Kontext), erreicht sie weiter über ihre Hooks.
 */
const PaneContent = memo(
  function PaneContent({ placeholder, render }: { route: object; placeholder: boolean; render: () => ReactNode }) {
    return placeholder ? <MapPlaceholder /> : render();
  },
  (prev, next) => prev.route === next.route && prev.placeholder === next.placeholder,
);

/** Steht beim Hineinziehen dort, wo gleich die Karte kommt. */
function MapPlaceholder() {
  const colors = useTheme();
  return (
    <View style={[styles.fill, { backgroundColor: colors.backgroundElement }]}>
      <TopBar decor={false} />
      <View style={styles.placeholder}>
        <Icon name="map" size={40} color={colors.textSecondary} />
        <Text style={[styles.placeholderText, { color: colors.textSecondary }]}>Karte</Text>
      </View>
    </View>
  );
}

function TabPane({ index, name, focused, children }: { index: number; name: string; focused: boolean; children: ReactNode }) {
  const motion = useContext(MotionContext)!;
  const reduced = useReducedMotion();
  const dock = useDockActions();
  // Liegen die Tabs selbst vorn? (Nicht, solange eine Detailseite darüber liegt.)
  const layoutFocused = useIsFocused();
  // Animationen anhalten bzw. wieder starten ist nicht eilig: Erst kommt der Wechsel,
  // danach (unterbrechbar) das Umschalten. Im selben Schritt kostete es über die
  // Hälfte des Wechsels – Goenni, Stempel und Girlande rendern dafür neu.
  const paused = useDeferredValue(!focused || !layoutFocused);
  const { from, to, progress, current, drag, swipedTo, onFront, width } = motion;

  // Ankommen: nur beim Fokuswechsel, mit den jeweils aktuellen Werten.
  const arrive = useEffectEvent(() => {
    const previous = current.get();
    const swiped = swipedTo.get() === index;
    swipedTo.set(-1);
    onFront(index);
    if (swiped && previous >= 0 && previous !== index) {
      // Gewischt: Die Seiten stehen noch dort, wo der Finger losließ. Den Rest des
      // Weges als normalen Übergang fahren, der genau dort beginnt – alles in
      // einem Schritt auf dem UI-Thread, sonst flackert für einen Frame die alte Lage.
      scheduleOnUI(() => {
        'worklet';
        const start = Math.min(1, Math.abs(drag.get()) / width);
        current.set(index);
        from.set(previous);
        to.set(index);
        drag.set(0);
        progress.set(start);
        progress.set(withTiming(1, { duration: reduced ? 0 : Math.max(110, Math.round(300 * (1 - start))), easing: Easing.out(Easing.cubic) }));
      });
    } else if (previous < 0 || previous === index || reduced) {
      scheduleOnUI(() => {
        'worklet';
        current.set(index);
        from.set(index);
        to.set(index);
        progress.set(1);
        drag.set(0);
      });
    } else {
      current.set(index);
      drag.set(0);
      from.set(previous);
      to.set(index);
      progress.set(0);
      progress.set(withTiming(1, { duration: 320, easing: Easing.out(Easing.cubic) }));
    }
    dock.setScene(SCENE[name] ?? 'home');
  });
  useLayoutEffect(() => {
    if (focused) arrive();
  }, [focused]);

  const style = useAnimatedStyle(() => {
    // Beim Wischen: die vordere Seite folgt dem Finger, der Nachbar schiebt sich daneben herein.
    const d = drag.value;
    const c = current.value;
    if (d !== 0 && c >= 0) {
      // Die vordere Seite tritt beim Wegziehen leicht zurück – wie beim Übergang per Tipp.
      if (index === c) return { opacity: 1 - Math.min(1, Math.abs(d) / width) * 0.35, transform: [{ translateX: d }] };
      if (index === c - 1 && d > 0) return { opacity: 1, transform: [{ translateX: d - width }] };
      if (index === c + 1 && d < 0) return { opacity: 1, transform: [{ translateX: d + width }] };
      return { opacity: 0, transform: [{ translateX: width * 2 }] };
    }
    const a = from.value;
    const b = to.value;
    const p = progress.value;
    const dir = b >= a ? 1 : -1;
    if (index === b) return { opacity: 1, transform: [{ translateX: (1 - p) * dir * width }] };
    if (index === a && p < 1) return { opacity: 1 - p * 0.35, transform: [{ translateX: -p * dir * width }] };
    return { opacity: 0, transform: [{ translateX: width * 2 }] };
  });

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, style]}
      pointerEvents={focused ? 'auto' : 'none'}
      accessibilityElementsHidden={!focused}
      importantForAccessibility={focused ? 'auto' : 'no-hide-descendants'}>
      {/* Nur der vordere Tab bewegt sich – und auch der nicht, solange eine Detailseite darüber liegt. */}
      <MotionPause paused={paused}>{children}</MotionPause>
    </Animated.View>
  );
}

/* ============================================================ Leiste */

// Ohne `ref`: TabTrigger reicht keins durch, und expo-router tippt es noch auf den alten
// Klassen-Typ von `View` – an `Pressable` (RN 0.88, strikte Typen) passt das nicht mehr.
function TabButton({ tab, isFocused, onPress, ...props }: Omit<TabTriggerSlotProps, 'ref'> & { tab: TabDef }) {
  const colors = useTheme();
  const market = useMarket();
  const color = isFocused ? colors.tint : colors.textSecondary;
  const center = tab.name === 'finder';

  const unread = market.groups.reduce((sum, g) => sum + g.unread, 0);
  const now = useNow();
  const expiring = nextExpiring(market.bookings, now);
  const badge = tab.name === 'groups' && unread > 0 ? (unread > 9 ? '9+' : String(unread)) : null;
  /** Punkt statt Zahl: „da läuft bald etwas ab" – die Zahl steht auf dem Ticket. */
  const dot = tab.name === 'bookings' && expiring?.info.tone === 'urgent';

  return (
    <Pressable
      {...props}
      onPress={(event) => {
        if (!isFocused) feedback.selected();
        onPress?.(event);
      }}
      accessibilityRole="tab"
      accessibilityLabel={center ? 'Entdecken: was passt zu uns?' : `${tab.label}${badge ? `, ${badge} neu` : ''}${dot ? ', ein Ticket verfällt bald' : ''}`}
      accessibilityState={{ selected: !!isFocused }}
      style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
      {center ? (
        <View style={styles.centerSlot}>
          <LinearGradient
            colors={[...BrandGradient]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={[styles.centerButton, { borderColor: colors.background }, isFocused && styles.centerFocused]}>
            <Icon name="compass" size={27} color="#ffffff" />
          </LinearGradient>
        </View>
      ) : (
        <View style={styles.iconSlot}>
          {/* Aktiver Tab: getönte Pille hinter dem Symbol – man sieht sofort, wo man ist. */}
          <View style={[styles.pill, isFocused && { backgroundColor: colors.backgroundSelected }]}>
            <Icon name={tab.icon} size={24} color={color} />
          </View>
          {badge ? (
            <View style={[styles.badge, { backgroundColor: colors.tint, borderColor: colors.background }]}>
              <Text style={styles.badgeText}>{badge}</Text>
            </View>
          ) : null}
          {dot ? <View style={[styles.dot, { borderColor: colors.background }]} /> : null}
        </View>
      )}
      <Text
        style={[
          styles.label,
          { color: center ? (isFocused ? colors.tint : colors.text) : isFocused ? colors.text : colors.textSecondary, fontFamily: isFocused || center ? FontFamily.bold : FontFamily.medium },
        ]}
        numberOfLines={1}>
        {tab.label}
      </Text>
    </Pressable>
  );
}

function BottomBar({ onHeight, ...props }: TabListProps & { onHeight: (height: number) => void }) {
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      {...props}
      onLayout={(event: LayoutChangeEvent) => onHeight(Math.round(event.nativeEvent.layout.height))}
      style={[
        styles.bar,
        {
          backgroundColor: colors.background,
          borderTopColor: colors.border,
          paddingBottom: Math.max(insets.bottom, Spacing.two),
        },
      ]}>
      <View style={styles.inner}>{props.children}</View>
    </View>
  );
}

const CENTER = 58;

const styles = StyleSheet.create({
  root: { flex: 1 },
  slot: { flex: 1, overflow: 'hidden' },
  fill: { flex: 1 },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.two },
  placeholderText: { fontFamily: FontFamily.semibold, fontSize: 15 },
  bar: { borderTopWidth: Stroke, paddingTop: Spacing.one + 2, alignItems: 'center' },
  inner: { flexDirection: 'row', width: '100%', maxWidth: 560, alignSelf: 'center' },
  button: { flex: 1, alignItems: 'center', gap: 3, paddingVertical: Spacing.one },
  iconSlot: { height: 32, alignItems: 'center', justifyContent: 'center' },
  pill: { width: 48, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  /** Gleiche Höhe wie die anderen – der Knopf ragt nach OBEN hinaus, die Beschriftungen bleiben auf einer Linie. */
  centerSlot: { height: 32, alignItems: 'center', justifyContent: 'flex-end' },
  centerButton: {
    width: CENTER,
    height: CENTER,
    borderRadius: CENTER / 2,
    borderWidth: 4,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: -4,
    shadowColor: '#dd2a7b',
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  centerFocused: { transform: [{ scale: 1.06 }] },
  pressed: { opacity: 0.7 },
  label: { fontSize: 11 },
  badge: {
    position: 'absolute',
    top: -3,
    right: -2,
    minWidth: 19,
    height: 19,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: { color: '#ffffff', fontFamily: FontFamily.bold, fontSize: 10 },
  dot: { position: 'absolute', top: 0, right: 6, width: 11, height: 11, borderRadius: 6, borderWidth: 2, backgroundColor: '#f59e0b' },
});
