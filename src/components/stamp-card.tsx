/**
 * Die Stempelkarte – das Sammelalbum der App.
 *
 * ## Der Stempel
 *
 * Ein Stempel ist eine kleine Belohnung, die man sich abgeholt hat. Er sieht
 * deshalb aus wie ein geprägtes Siegel aus Folie – **einfarbig Silber** (auf der
 * goldenen Karte Gold), nicht bunt:
 *
 *  - gezackter Rand mit Prägeschatten, darin eine erhabene Mitte mit Ringen,
 *  - feiner Glitzer; über den neuesten Stempel zieht ab und zu ein Lichtband,
 *  - ein Funkelstern am Rand blitzt auf.
 *
 * Damit die Karte lebt, gibt sie einen Takt vor (`BEAT_MS`): Bei jedem Schlag
 * funkelt genau EIN Stempel, bei jedem zweiten **pocht** einer kurz auf
 * (~4 %) und/oder sein **Stern dreht sich** hin und her (bis 65°). Nie alle
 * gleichzeitig – zehn Stempel mit eigenen Dauer-Animationen ließen die App
 * ruckeln (gemessen Okt. 2026).
 *
 * ## Wo er sitzt
 *
 * Ein Stempel ist größer als sein Feld (`STAMP_SCALE`) und ragt über den
 * gestrichelten Rand – aufgedrückt, nicht eingepasst. Kein Stempel sitzt gerade
 * und mittig: Jeder ist um bis zu 15 % seiner Größe in X und Y verschoben und
 * leicht gedreht. Die Lage ist zufällig, aber fest (sie hängt an der
 * Stempel-ID) – die Karte sieht beim Zurückkommen gleich aus.
 *
 * Der frischeste Stempel landet mit einem „Aufdrücken" (groß → klein).
 *
 * ## Eine Karte für alle Partner
 *
 * Es gibt EINE Stempelkarte je Konto; jeder Besuch bei irgendeinem Partner füllt
 * sie. Wo gestempelt wurde, steht im Verlauf (stamps.tsx) und im vorgelesenen
 * Text.
 *
 * Wer „Bewegung reduzieren" eingestellt hat, bekommt dieselbe Karte ohne
 * Funkeln, Pochen und Drehen.
 */
import { LinearGradient } from 'expo-linear-gradient';
import { memo, useEffect, useId, useMemo, useState, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Defs, LinearGradient as SvgLinearGradient, Path, Stop } from 'react-native-svg';

import { DecorCorner } from '@/components/seasonal-decor';
import { Icon } from '@/components/ui/icon';
import { Shimmer } from '@/components/ui/shimmer';
import { useStill } from '@/components/ui/motion-pause';
import { FontFamily, Night, Radius, Spacing, Stroke } from '@/constants/theme';
import { seeded, stampForBeat, stampPose, stampSize, starSwing } from '@/domain/stamp-scatter';
import type { StampCard as StampCardData, StampEntry } from '@/lib/api';

/** Felder, die der Server für die goldene Karte mitschickt (ältere Stände kennen sie nicht). */
type CardData = StampCardData & { golden?: boolean; cards_until_golden?: number };

/** Takt der Karte: so oft funkelt ein Stempel (groß bzw. klein auf der Startseite). */
const BEAT_MS = 2200;
const COMPACT_BEAT_MS = 3400;

/** Ruhe des Lichtbands zwischen zwei Durchzügen über den neuesten Stempel. */
const SHINE_REST_MS = 3200;

/** Vierzackiger Funkelstern in einer 24er-Box. */
const SPARKLE = 'M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z';

/**
 * Folie: Silber (Standard) oder Gold (goldene Karte). Je zwei Verläufe – außen
 * und die erhabene Mitte in Gegenrichtung –, das liest sich als Prägung.
 */
const FOIL = {
  silver: {
    outer: ['#ffffff', '#d7dce5', '#a7b1c0', '#eef1f6', '#b4bdca', '#f4f6fa'],
    inner: ['#bcc4d1', '#f7f8fb', '#aab3c2', '#e6e9ef'],
    ink: '#2a0c47',
    rim: 'rgba(255,255,255,0.95)',
    dash: 'rgba(42,12,71,0.32)',
  },
  gold: {
    outer: ['#fff6cf', '#f3cf5b', '#c99212', '#fbe6a0', '#d9a520', '#fff1b8'],
    inner: ['#d6a21c', '#fff3c4', '#c48c0d', '#f6d777'],
    ink: '#4a2c00',
    rim: 'rgba(255,248,214,0.95)',
    dash: 'rgba(74,44,0,0.35)',
  },
} as const;

type FoilKey = keyof typeof FOIL;

/** Gezackter Stempelrand in einer 100er-Box. */
function scallopPath(teeth = 22): string {
  const c = 50;
  const outer = 49;
  const inner = 44.5;
  let d = '';
  for (let i = 0; i < teeth * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = (Math.PI * i) / teeth - Math.PI / 2;
    d += `${i === 0 ? 'M' : 'L'}${(c + r * Math.cos(a)).toFixed(2)} ${(c + r * Math.sin(a)).toFixed(2)}`;
  }
  return `${d}Z`;
}

const SCALLOP = scallopPath();

/** Fester Glitzer je Stempel: kleine Punkte auf der Folie. */
function glitterFor(seed: number) {
  const next = seeded(seed * 31 + 7);
  return Array.from({ length: 14 }, () => {
    const a = next() * Math.PI * 2;
    const r = 8 + next() * 32;
    return { x: 50 + Math.cos(a) * r, y: 50 + Math.sin(a) * r, r: 0.5 + next() * 0.9, o: 0.35 + next() * 0.6 };
  });
}

/** Wo die zwei Funkelsterne am Rand sitzen – je Stempel anders, aber fest. */
function twinklesFor(seed: number) {
  const next = seeded(seed * 97 + 3);
  const first = next() * Math.PI * 2;
  // Der zweite gegenüber, mit etwas Streuung – nie beide an derselben Ecke.
  const second = first + Math.PI * (0.75 + next() * 0.5);
  return [first, second].map((a) => ({ x: 0.5 + Math.cos(a) * 0.46, y: 0.5 + Math.sin(a) * 0.46 }));
}

/**
 * Ein Funkelstern, der einmal aufblitzt, sobald `trigger` eine neue Zahl ist.
 * Kein eigener Dauertakt: Welcher Stempel gerade funkelt, bestimmt die Karte.
 */
function Twinkle({ x, y, s, trigger, reduced }: { x: number; y: number; s: number; trigger?: number; reduced: boolean }) {
  // Nur bei „Bewegung reduzieren" steht ein ruhiger Stern da. `reduced` heißt auch
  // „Seite ruht" (useStill) – ein Stempel, der so entstand, zeigte sonst noch lange
  // nach dem Zurückkommen einen eingefrorenen Stern.
  const reduceMotion = useReducedMotion();
  const t = useSharedValue(0);
  useEffect(() => {
    t.set(reduceMotion ? 0.7 : 0);
  }, [reduceMotion, t]);

  useEffect(() => {
    if (reduced || trigger === undefined) return;
    t.set(withSequence(withTiming(1, { duration: 480, easing: Easing.out(Easing.quad) }), withTiming(0, { duration: 820, easing: Easing.in(Easing.quad) })));
  }, [reduced, trigger, t]);

  const style = useAnimatedStyle(() => ({
    opacity: t.value,
    transform: [{ scale: interpolate(t.value, [0, 1], [0.3, 1.1]) }, { rotate: `${interpolate(t.value, [0, 1], [0, 60])}deg` }],
  }));

  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: x, top: y, width: s, height: s }, style]}>
      <Svg width={s} height={s} viewBox="0 0 24 24">
        <Path d={SPARKLE} fill="#ffffff" />
      </Svg>
    </Animated.View>
  );
}

/**
 * Der Takt der Karte als kleiner Speicher, dem jeder Stempel selbst zuhört
 * (`useTurn`): Bei einem Schlag rendert nur der Stempel neu, der gerade dran ist.
 * Lag der Takt als Zustand in der Karte, zeichnete jeder Schlag die ganze Karte
 * neu – 35 Bausteine, gemessen Okt. 2026 als Ruckler mitten im Scrollen.
 */
type CardBeat = { subscribe: (listener: () => void) => () => void; current: () => number; tick: () => void };

function createBeat(): CardBeat {
  let value = 0;
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    current: () => value,
    tick() {
      value += 1;
      for (const listener of listeners) listener();
    },
  };
}

const NO_BEAT: CardBeat = { subscribe: () => () => {}, current: () => 0, tick: () => {} };

/** Bei jedem Schlag funkelt genau ein Stempel … */
const sparkleAt = (beat: number, count: number) => stampForBeat(beat, count);
/** … und bei jedem zweiten pocht einer oder dreht seinen Stern. */
const actAt = (beat: number, count: number) => (beat % 2 === 0 ? stampForBeat(beat * 31 + 7, count) : -1);

/** Der Schlag, bei dem Stempel `index` gerade dran ist – sonst `undefined`. */
function useTurn(beat: CardBeat, index: number, count: number, pick: (beat: number, count: number) => number): number | undefined {
  const turn = useSyncExternalStore(
    beat.subscribe,
    () => {
      const now = beat.current();
      return now > 0 && pick(now, count) === index ? now : 0;
    },
    () => 0,
  );
  return turn > 0 ? turn : undefined;
}

/**
 * Ein gefülltes Feld: der Folien-Stempel. Gemerkt (`memo`) und am Takt der Karte
 * selbst lauschend: Bei einem Schlag rendert nur der Stempel neu, der dran ist.
 */
export const HoloStamp = memo(function HoloStamp({
  size,
  index,
  entry,
  fresh = false,
  foil = 'silver',
  beat = NO_BEAT,
  count = 0,
  shine = false,
}: {
  size: number;
  index: number;
  entry?: StampEntry | null;
  /** Gerade verdient – landet mit einem Aufdrücken. */
  fresh?: boolean;
  foil?: FoilKey;
  /** Takt der Karte: ist dieser Stempel dran, funkelt, pocht oder dreht er sich einmal. */
  beat?: CardBeat;
  /** Wie viele Stempel auf der Karte sind (unter ihnen wählt der Takt). */
  count?: number;
  /** Lichtband über die Folie – nur für den neuesten Stempel der großen Karte. */
  shine?: boolean;
}) {
  // Steht still bei „Bewegung reduzieren" UND solange die Seite nicht vorn ist (motion-pause.tsx).
  const reduced = useStill();
  /** Jede neue Zahl: einmal funkeln. */
  const sparkle = useTurn(beat, index, count, sparkleAt);
  /** Jede neue Zahl: einmal aufpochen und/oder den Stern drehen. */
  const act = useTurn(beat, index, count, actAt);
  const seed = entry?.id ?? index + 1;
  const pose = useMemo(() => stampPose(seed), [seed]);
  const glitter = useMemo(() => glitterFor(seed), [seed]);
  const sparks = useMemo(() => twinklesFor(seed), [seed]);
  const look = FOIL[foil];
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const outerId = `stamp-o-${uid}`;
  const innerId = `stamp-i-${uid}`;

  const land = useSharedValue(fresh && !reduced ? 0 : 1);
  const pulse = useSharedValue(0);
  const star = useSharedValue(0);

  useEffect(() => {
    if (!fresh || reduced) return;
    land.set(0);
    land.set(withDelay(180, withSpring(1, { damping: 11, stiffness: 180, mass: 0.7 })));
  }, [fresh, reduced, land]);

  // Aufpochen und/oder den Stern hin und her drehen – wann, bestimmt die Karte (`act`).
  useEffect(() => {
    if (reduced || act === undefined) return;
    const roll = Math.random();
    if (roll < 0.62) {
      const swing = starSwing(Math.random(), Math.random());
      const back = -swing * (0.2 + Math.random() * 0.35);
      const ease = Easing.inOut(Easing.quad);
      star.set(
        withSequence(
          withTiming(swing, { duration: 420 + Math.abs(swing) * 5, easing: ease }),
          withTiming(back, { duration: 520, easing: ease }),
          withSpring(0, { damping: 8, stiffness: 110, mass: 0.6 }),
        ),
      );
    }
    if (roll >= 0.45) {
      pulse.set(withSequence(withTiming(1, { duration: 150, easing: Easing.out(Easing.quad) }), withTiming(0, { duration: 460, easing: Easing.inOut(Easing.quad) })));
    }
  }, [reduced, act, star, pulse]);

  const dx = pose.dx * size;
  const dy = pose.dy * size;
  const tilt = pose.tilt;

  const stampStyle = useAnimatedStyle(() => ({
    opacity: interpolate(land.value, [0, 0.3, 1], [0, 1, 1]),
    transform: [
      { translateX: dx },
      { translateY: dy },
      { scale: interpolate(land.value, [0, 1], [1.9, 1]) * (1 + pulse.value * 0.045) },
      { rotate: `${interpolate(land.value, [0, 1], [tilt - 28, tilt])}deg` },
    ],
  }));

  const starStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${star.value}deg` }, { scale: 1 + pulse.value * 0.06 }] }));

  // Abwechselnd an einer der zwei festen Stellen am Rand funkeln.
  const spark = sparks[(sparkle ?? 0) % 2];
  const sparkSize = sparkSizeFor(size, (sparkle ?? 0) % 2 === 0 ? 0.26 : 0.2);

  return (
    <Animated.View
      style={[{ width: size, height: size }, stampStyle]}
      accessible
      accessibilityLabel={`Stempel ${index + 1}${entry?.partner ? ` von ${entry.partner.name}` : ''}`}>
      {/* Prägeschatten, Folie, erhabene Mitte, Ringe, Glitzer. */}
      <Svg width={size} height={size} viewBox="0 0 100 100" style={StyleSheet.absoluteFill}>
        <Defs>
          <SvgLinearGradient id={outerId} x1="0" y1="0" x2="1" y2="1">
            {look.outer.map((c, i) => (
              <Stop key={c + i} offset={i / (look.outer.length - 1)} stopColor={c} />
            ))}
          </SvgLinearGradient>
          <SvgLinearGradient id={innerId} x1="1" y1="0" x2="0" y2="1">
            {look.inner.map((c, i) => (
              <Stop key={c + i} offset={i / (look.inner.length - 1)} stopColor={c} />
            ))}
          </SvgLinearGradient>
        </Defs>
        <Path d={SCALLOP} fill="rgba(10,2,22,0.5)" transform="translate(1.6 2.6)" />
        <Path d={SCALLOP} fill={`url(#${outerId})`} stroke={look.rim} strokeWidth={1.4} />
        <Circle cx={50} cy={50} r={39} fill="none" stroke={look.dash} strokeWidth={1.2} strokeDasharray="1.6 3.2" />
        <Circle cx={50} cy={50} r={33} fill={`url(#${innerId})`} />
        <Circle cx={50} cy={50} r={33} fill="none" stroke="#ffffff" strokeOpacity={0.9} strokeWidth={1.6} />
        <Circle cx={50} cy={50} r={30.5} fill="none" stroke={look.dash} strokeWidth={0.8} />
        {glitter.map((g, i) => (
          <Circle key={i} cx={g.x} cy={g.y} r={g.r} fill="#ffffff" opacity={g.o} />
        ))}
      </Svg>
      {/* Lichtband über die Folie: zieht durch, ruht, zieht wieder durch. */}
      {reduced || !shine ? null : (
        <View pointerEvents="none" style={[styles.holoClip, { width: size, height: size, borderRadius: size / 2 }]}>
          <Shimmer color="rgba(255,255,255,0.75)" radius={size / 2} durationMs={1600} restMs={SHINE_REST_MS} />
        </View>
      )}
      {/* Der Stern in der Mitte – dreht sich ab und zu hin und her. */}
      <View style={styles.center} pointerEvents="none">
        <Animated.View style={starStyle}>
          <Svg width={size * 0.4} height={size * 0.4} viewBox="0 0 24 24">
            <Path d={SPARKLE} fill="#ffffff" opacity={0.85} transform="translate(-0.5 -0.6)" />
            <Path d={SPARKLE} fill={look.ink} />
            <Path d="M12 5.2l1 3.6" stroke="#ffffff" strokeOpacity={0.55} strokeWidth={1} strokeLinecap="round" />
          </Svg>
        </Animated.View>
      </View>
      <Twinkle x={spark.x * size - sparkSize / 2} y={spark.y * size - sparkSize / 2} s={sparkSize} trigger={sparkle} reduced={reduced} />
    </Animated.View>
  );
});

/** Kantenlänge eines Funkelsterns als Anteil der Stempelgröße. */
function sparkSizeFor(size: number, share: number): number {
  return Math.round(size * share);
}

/**
 * Ein leeres Feld: gestrichelter Kreis mit Nummer. Das letzte zeigt das Geschenk.
 *
 * Bleibt auch unter einem Stempel liegen (`underStamp`): Der Stempel landet
 * versetzt darauf, und man sieht das Feld darunter – so fühlt es sich an wie
 * gestempelt und nicht wie „ausgefüllt“.
 */
const EmptySlot = memo(function EmptySlot({ size, number, reward, underStamp = false }: { size: number; number: number; reward: boolean; underStamp?: boolean }) {
  return (
    <View
      style={[styles.empty, { width: size, height: size, borderRadius: size / 2 }, reward && styles.emptyReward]}
      accessible={!underStamp}
      accessibilityElementsHidden={underStamp}
      importantForAccessibility={underStamp ? 'no-hide-descendants' : 'auto'}
      accessibilityLabel={reward ? `Feld ${number}: hier gibt es die Credits` : `Feld ${number}, noch frei`}>
      {reward ? <Icon name="gift" size={size * 0.38} color="#fff1a8" /> : <Text style={[styles.number, { fontSize: size * 0.3 }]}>{number}</Text>}
    </View>
  );
});

/**
 * Die ganze Karte: zwei Reihen à fünf Felder auf dem Lila des Club-Auftritts.
 * Kompakt (Startseite) eine Reihe mit Kopf und deutlichem „Ansehen ›" – die
 * Karte ist dort ein Knopf, und das muss man sehen.
 */
export function StampCard({
  card,
  freshIndex = null,
  compact = false,
  style,
}: {
  card: StampCardData;
  /** Welches Feld gerade verdient wurde (0-basiert) – für das Aufdrücken. */
  freshIndex?: number | null;
  /** Kompakt für die Startseite: eine Reihe, kleinere Felder, Pfeil zum Öffnen. */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const data = card as CardData;
  const golden = data.golden === true;
  const fields = card.fields;
  const slotSize = compact ? 27 : 54;
  const foil: FoilKey = golden ? 'gold' : 'silver';
  // Zwei feste Reihen (kompakt: eine). Mit flexWrap allein passten auf Handys ab 390 pt
  // Breite sechs Felder in die erste Reihe – die Stempel lagen dort übereinander und
  // unten blieben vier (gesehen Okt. 2026 im Reel).
  const perRow = compact ? fields : Math.ceil(fields / 2);
  const rows = Array.from({ length: Math.ceil(fields / perRow) }, (_, r) =>
    Array.from({ length: Math.min(perRow, fields - r * perRow) }, (_, k) => r * perRow + k),
  );

  // EIN Takt für die ganze Karte: Bei jedem Schlag funkelt genau ein Stempel, bei
  // jedem zweiten pocht einer. Vorher hatte jeder Stempel eigene Dauer-Glitzer,
  // ein eigenes Lichtband und einen eigenen Zeitgeber – zehn Stempel waren
  // dreißig gleichzeitige Animationen, und die Seite ruckelte. Der Takt ist kein
  // Zustand der Karte: Die Stempel hören ihm selbst zu (`useTurn`).
  const still = useStill();
  const filledCount = card.filled;
  const [beat] = useState(createBeat);
  useEffect(() => {
    if (still || filledCount === 0) return;
    const timer = setInterval(beat.tick, compact ? COMPACT_BEAT_MS : BEAT_MS);
    return () => clearInterval(timer);
  }, [still, filledCount, compact, beat]);

  return (
    <View style={[styles.card, compact && styles.cardCompact, golden && styles.cardGolden, style]}>
      <LinearGradient colors={[...Night.gradient]} start={{ x: 0.1, y: 0 }} end={{ x: 0.9, y: 1 }} style={StyleSheet.absoluteFill} />
      {/* Hintergrund-Glitzer wie im Logo – nur dort, wo kein Text steht (oben links liegt der Titel). */}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <View style={[styles.dot, { bottom: 6, left: '47%', backgroundColor: '#ffffff' }]} />
        <View style={[styles.dot, { top: '72%', right: 6, backgroundColor: Night.sparkle }]} />
        <View style={[styles.dot, styles.dotSmall, { top: 8, right: '34%', backgroundColor: '#ffffff' }]} />
      </View>

      {compact ? (
        <View style={styles.compactHead}>
          <View style={[styles.compactBadge, golden && styles.compactBadgeGold]}>
            <Icon name="stamp" size={15} color={golden ? '#3b2600' : '#ffffff'} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.compactTitle} numberOfLines={1}>
              {golden ? 'Goldene Stempelkarte' : 'Deine Stempelkarte'}
            </Text>
            <Text style={styles.compactText} numberOfLines={1}>
              <Text style={styles.compactStrong}>
                {card.filled}/{card.fields}
              </Text>{' '}
              · noch {card.remaining} bis {card.reward_credits} Credits
            </Text>
          </View>
          {/* Sichtbarer Pfeil: Die Karte ist ein Knopf. */}
          <View style={styles.open}>
            <Text style={styles.openText}>Ansehen</Text>
            <Icon name="chevron-right" size={14} color={Night.deep} />
          </View>
        </View>
      ) : (
        <View style={styles.head}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{golden ? 'Goldene Stempelkarte' : 'Deine Stempelkarte'}</Text>
            <Text style={styles.subtitle}>
              {card.remaining === card.fields && card.completed_cards === 0
                ? `Jeder Besuch bei einem Partner zählt – ${card.fields} Stempel = ${card.reward_credits} Credits.`
                : `Noch ${card.remaining} bis ${card.reward_credits} Credits`}
            </Text>
            <View style={styles.everywhere}>
              <Icon name="sparkles" size={12} color={golden ? '#ffd24a' : Night.sparkle} />
              <Text style={[styles.everywhereText, golden && { color: '#ffd24a' }]}>
                {golden ? 'Goldene Karte – mehr Credits zur Belohnung' : 'Eine Karte für alle Partner'}
              </Text>
            </View>
          </View>
          <DecorCorner corner="inline" size={20} />
          {card.completed_cards > 0 ? (
            <View style={styles.cardsDone}>
              <Icon name="trophy" size={14} color="#fff1a8" />
              <Text style={styles.cardsDoneText}>{card.completed_cards}× voll</Text>
            </View>
          ) : null}
        </View>
      )}

      <View style={[styles.grid, compact && styles.gridCompact]}>
        {rows.map((row, r) => (
          <View key={r} style={styles.row}>
            {row.map((i) => {
              const filled = i < card.filled;
              return (
                // Gestempelte Felder liegen oben: Der Stempel ist größer als sein Feld
                // und überdeckt den Rand des Nachbarn – nicht umgekehrt.
                <View key={i} style={[styles.slot, filled && styles.slotStamped, { width: slotSize, height: slotSize }]}>
                  <EmptySlot size={slotSize} number={i + 1} reward={i === fields - 1} underStamp={filled} />
                  {filled ? (
                    <View style={styles.stampOnTop} pointerEvents="none">
                      <HoloStamp
                        size={stampSize(slotSize)}
                        index={i}
                        entry={card.stamps[i] ?? null}
                        fresh={freshIndex === i}
                        foil={foil}
                        beat={beat}
                        count={filledCount}
                        shine={!compact && i === filledCount - 1}
                      />
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        ))}
      </View>

    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Radius.panel,
    borderWidth: Stroke,
    borderColor: 'rgba(255,255,255,0.18)',
    overflow: 'hidden',
    padding: Spacing.three,
    gap: Spacing.three,
  },
  cardCompact: { padding: Spacing.three, gap: Spacing.two + 2 },
  cardGolden: { borderColor: '#f5c542', borderWidth: 2 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.two },
  title: { color: '#ffffff', fontFamily: FontFamily.bold, fontSize: 20 },
  subtitle: { color: Night.textMuted, fontFamily: FontFamily.medium, fontSize: 14, marginTop: 2 },
  cardsDone: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  cardsDoneText: { color: '#fff1a8', fontFamily: FontFamily.bold, fontSize: 12 },
  grid: { gap: Spacing.three, paddingBottom: Spacing.one },
  gridCompact: { gap: 0, paddingBottom: 0 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  slot: { alignItems: 'center', justifyContent: 'center' },
  slotStamped: { zIndex: 1 },
  /** Der Stempel liegt über dem Feld – mit seinem eigenen Versatz (stamp-scatter.ts). */
  stampOnTop: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  holoClip: { overflow: 'hidden', position: 'absolute' },
  center: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  everywhere: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    marginTop: Spacing.two,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  everywhereText: { color: Night.sparkle, fontFamily: FontFamily.bold, fontSize: 11.5 },
  empty: {
    borderWidth: 1.6,
    borderStyle: 'dashed',
    borderColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  emptyReward: { borderColor: 'rgba(255,241,168,0.7)', backgroundColor: 'rgba(255,241,168,0.08)' },
  number: { color: 'rgba(255,255,255,0.45)', fontFamily: FontFamily.bold },
  dot: { position: 'absolute', width: 5, height: 5, borderRadius: 3, opacity: 0.7 },
  dotSmall: { width: 3, height: 3, borderRadius: 2 },
  compactHead: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
  compactBadge: { width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(255,255,255,0.14)', alignItems: 'center', justifyContent: 'center' },
  compactBadgeGold: { backgroundColor: '#f5c542' },
  compactTitle: { color: '#ffffff', fontFamily: FontFamily.bold, fontSize: 15 },
  compactText: { color: Night.textMuted, fontFamily: FontFamily.medium, fontSize: 12.5 },
  compactStrong: { color: '#ffffff', fontFamily: FontFamily.bold },
  open: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    backgroundColor: '#ffffff',
    borderRadius: 999,
    paddingLeft: 10,
    paddingRight: 6,
    paddingVertical: 5,
  },
  openText: { color: Night.deep, fontFamily: FontFamily.bold, fontSize: 12.5 },
});
