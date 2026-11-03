/**
 * Der Gruppen-Chat.
 *
 * ## Nachfragen statt zuhören
 *
 * Das Backend hat keine offene Verbindung. Dieser Screen fragt deshalb alle
 * {@link POLL_MS} nach dem, was **nach** der höchsten bekannten ID kam – nur
 * solange er im Vordergrund ist, mit Cursor, und nie zwei Abrufe gleichzeitig.
 *
 * ## Angebote teilen
 *
 * Eine Nachricht kann ein Angebot tragen („Wollen wir das machen?"). Die Karte
 * im Verlauf öffnet das Angebot – mit der Gruppengröße schon eingestellt.
 */
import { Image } from 'expo-image';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type ScrollViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { MascotEmpty, MascotError } from '@/components/mascot';
import { ReportSheet } from '@/components/report-sheet';
import { Icon } from '@/components/ui/icon';
import { OptionsSheet, type SheetOption } from '@/components/ui/options-sheet';
import { FontFamily, MaxContentWidth, Radius, Spacing, Stroke } from '@/constants/theme';
import { MAX_MESSAGE_LENGTH, groupByDay, highestId, showsAuthor, validateDraft } from '@/domain/chat';
import { formatCredits, formatEuro } from '@/domain/club';
import { formatClock } from '@/domain/date-format';
import { useKeyboardInset } from '@/hooks/use-keyboard-inset';
import { useTheme } from '@/hooks/use-theme';
import { useNow } from '@/hooks/use-now';
import { ApiError, api, errorMessage, type ChatMessage, type ChatRoom } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { confirmAction, notifyUser } from '@/lib/confirm';
import * as feedback from '@/lib/feedback';
import { useMarket } from '@/lib/market-context';

/** Abstand zwischen zwei Nachfragen nach neuen Nachrichten. */
const POLL_MS = 4000;

export default function ChatScreen() {
  const params = useLocalSearchParams<{ group: string; title?: string; people?: string }>();
  const groupId = Number(params.group) || 0;
  const router = useRouter();
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardInset();
  const { token } = useAuth();
  const { refreshGroups } = useMarket();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [room, setRoom] = useState<ChatRoom | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Senden oder Löschen ging schief – steht direkt über der Eingabe, nicht oben im Verlauf. */
  const [actionError, setActionError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [menuFor, setMenuFor] = useState<ChatMessage | null>(null);
  const [reporting, setReporting] = useState<{ id: number; label: string } | null>(null);

  const scrollRef = useRef<ScrollViewInstance>(null);
  const cursor = useRef(0);
  const polling = useRef(false);

  const remember = useCallback((incoming: ChatMessage[]) => {
    if (incoming.length === 0) return;
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      const fresh = incoming.filter((m) => !seen.has(m.id));
      return fresh.length === 0 ? prev : [...prev, ...fresh].sort((a, b) => a.id - b.id);
    });
    cursor.current = Math.max(cursor.current, highestId(incoming));
  }, []);

  const loadFirst = useCallback(async () => {
    if (!token || !groupId) return;
    setError(null);
    try {
      const res = await api.messages(token, groupId);
      setRoom(res.room);
      setMessages(res.data);
      cursor.current = highestId(res.data);
      if (res.data.length > 0) api.markRead(token, groupId, cursor.current).catch(() => {});
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? 'Diesen Chat gibt es nicht mehr.' : 'Der Chat ließ sich nicht laden.');
    }
    setLoading(false);
  }, [token, groupId]);

  const pollOnce = useCallback(async () => {
    if (!token || !groupId || polling.current) return;
    polling.current = true;
    try {
      const res = await api.messages(token, groupId, { after: cursor.current });
      if (res.data.length > 0) {
        remember(res.data);
        api.markRead(token, groupId, highestId(res.data)).catch(() => {});
      }
      setRoom(res.room);
    } catch {
      // Ein fehlgeschlagener Tick bleibt still.
    }
    polling.current = false;
  }, [token, groupId, remember]);

  useFocusEffect(
    useCallback(() => {
      loadFirst();
      const timer = setInterval(pollOnce, POLL_MS);
      return () => {
        clearInterval(timer);
        // Gelesen ist gelesen: Zahl an der Gruppe und in der Leiste gleich mitziehen.
        void refreshGroups();
      };
    }, [loadFirst, pollOnce, refreshGroups]),
  );

  async function onSend() {
    if (!token || sending) return;
    const check = validateDraft(draft);
    if (!check.ok) {
      if (check.error) setActionError(check.error);
      return;
    }
    setSending(true);
    setActionError(null);
    const text = draft.trim();
    setDraft('');
    try {
      const res = await api.sendMessage(token, groupId, { body: text });
      remember([res.data]);
      feedback.tapped();
    } catch (err) {
      feedback.failed();
      setDraft(text);
      setActionError(errorMessage(err, 'Die Nachricht ging nicht raus.'));
    }
    setSending(false);
  }

  const menuOptions = useMemo<SheetOption[]>(() => {
    const m = menuFor;
    if (!m) return [];
    const options: SheetOption[] = [];
    if (m.is_mine || room?.can_moderate) {
      options.push({
        key: 'delete',
        label: 'Nachricht löschen',
        icon: 'trash',
        destructive: true,
        onPress: async () => {
          if (!token) return;
          if (!(await confirmAction('Nachricht löschen', 'Sie verschwindet für alle im Chat.', 'Löschen', true))) return;
          try {
            await api.deleteMessage(token, m.id);
            setMessages((prev) => prev.filter((row) => row.id !== m.id));
          } catch (err) {
            setActionError(errorMessage(err, 'Löschen hat nicht geklappt.'));
          }
        },
      });
    }
    if (!m.is_mine) {
      options.push({ key: 'report', label: 'Melden', icon: 'flag', destructive: true, onPress: () => setReporting({ id: m.id, label: m.body || m.shared?.title || 'Nachricht' }) });
      options.push({
        key: 'block',
        label: `${m.user.name ?? 'Person'} blockieren`,
        icon: 'ban',
        destructive: true,
        onPress: async () => {
          if (!token) return;
          if (!(await confirmAction('Blockieren?', 'Du siehst die Nachrichten dieser Person nicht mehr. Aufheben kannst du das in den Einstellungen.', 'Blockieren', true))) return;
          try {
            await api.blockUser(token, m.user.id);
            setMessages((prev) => prev.filter((row) => row.user.id !== m.user.id));
          } catch (err) {
            await notifyUser('Hat nicht geklappt', errorMessage(err));
          }
        },
      });
    }
    return options;
  }, [menuFor, room?.can_moderate, token]);

  const now = useNow();
  const sections = useMemo(() => groupByDay(messages, now), [messages, now]);
  const title = room?.title ?? params.title ?? 'Gruppe';
  const canSend = validateDraft(draft).ok;

  return (
    <View style={[styles.screen, { backgroundColor: colors.backgroundElement }]}>
      <Stack.Screen
        options={{
          headerShown: true,
          title,
          headerRight: () => (
            <Pressable
              onPress={() => router.push({ pathname: '/group/[id]', params: { id: String(groupId) } })}
              accessibilityRole="button"
              accessibilityLabel="Gruppe ansehen"
              hitSlop={10}>
              <Icon name="users" size={22} color={colors.text} />
            </Pressable>
          ),
        }}
      />
      <View style={styles.frame}>
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.tint} />
          </View>
        ) : (
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={styles.list}
            showsVerticalScrollIndicator={false}
            keyboardShouldPersistTaps="handled"
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}>
            {error ? <MascotError detail={error} onRetry={loadFirst} /> : null}

            {messages.length === 0 && !error ? (
              <View style={styles.empty}>
                <MascotEmpty mood="cheer" size={88} gesture="wave">
                  <Text style={[styles.emptyTitle, { color: colors.text }]}>Noch nichts geschrieben.</Text>
                  <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                    Schreib den ersten Satz – oder teile ein Angebot aus „Entdecken“ in diese Runde.
                  </Text>
                </MascotEmpty>
              </View>
            ) : null}

            {sections.map((section) => (
              <View key={section.label} style={styles.section}>
                <View style={styles.dayRow}>
                  <View style={[styles.dayLine, { backgroundColor: colors.border }]} />
                  <Text style={[styles.day, { color: colors.textSecondary }]}>{section.label}</Text>
                  <View style={[styles.dayLine, { backgroundColor: colors.border }]} />
                </View>
                {section.messages.map((message, index) => (
                  <MessageRow
                    key={message.id}
                    message={message}
                    withAuthor={showsAuthor(message, section.messages[index - 1] ?? null)}
                    onLongPress={() => setMenuFor(message)}
                    onOpenShared={(offerId) =>
                      router.push({ pathname: '/offer/[id]', params: { id: String(offerId), group: String(groupId), ...(params.people ? { people: params.people } : {}) } })
                    }
                  />
                ))}
              </View>
            ))}
          </ScrollView>
        )}

        <View style={{ paddingBottom: insets.bottom + keyboard + Spacing.two }}>
          {actionError ? (
            <View style={styles.actionError} accessibilityLiveRegion="polite">
              <Icon name="warning" size={16} color="#d97706" />
              <Text style={[styles.actionErrorText, { color: colors.text }]}>{actionError}</Text>
            </View>
          ) : null}
          <View style={[styles.inputBar, { backgroundColor: colors.background, borderColor: colors.border }]}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Nachricht schreiben"
              placeholderTextColor={colors.textSecondary}
              multiline
              maxLength={MAX_MESSAGE_LENGTH}
              editable={!sending}
              style={[styles.input, { color: colors.text }]}
              accessibilityLabel="Nachricht schreiben"
            />
            <Pressable
              onPress={onSend}
              disabled={sending || !canSend}
              accessibilityRole="button"
              accessibilityLabel="Senden"
              hitSlop={8}
              style={({ pressed }) => [styles.sendButton, { backgroundColor: canSend ? colors.tint : colors.backgroundSelected }, pressed && styles.pressed]}>
              {sending ? <ActivityIndicator size="small" color="#ffffff" /> : <Icon name="send" size={18} color={canSend ? '#ffffff' : colors.textSecondary} />}
            </Pressable>
          </View>
        </View>
      </View>

      <OptionsSheet visible={menuFor !== null} title={menuFor?.body?.slice(0, 60)} options={menuOptions} onClose={() => setMenuFor(null)} />
      <ReportSheet target={reporting ? { type: 'message', id: reporting.id, label: reporting.label } : null} onClose={() => setReporting(null)} />
    </View>
  );
}

function MessageRow({
  message,
  withAuthor,
  onLongPress,
  onOpenShared,
}: {
  message: ChatMessage;
  withAuthor: boolean;
  onLongPress: () => void;
  onOpenShared: (offerId: number) => void;
}) {
  const colors = useTheme();
  const mine = message.is_mine;
  const ink = mine ? '#ffffff' : colors.text;
  const shared = message.shared;

  return (
    <View style={[styles.messageWrap, mine ? styles.messageMine : styles.messageTheirs]}>
      {withAuthor && !mine ? <Text style={[styles.author, { color: colors.textSecondary }]}>{message.user.name}</Text> : null}
      <Pressable
        onLongPress={onLongPress}
        delayLongPress={350}
        // Bewusst ohne role="button": Im Web würde daraus ein <button>, und die
        // geteilte Angebotskarte darin ist selbst einer (verschachtelt = ungültig).
        accessibilityHint="Lang drücken für Optionen"
        accessibilityActions={[{ name: 'longpress', label: 'Optionen' }]}
        onAccessibilityAction={(e) => {
          if (e.nativeEvent.actionName === 'longpress') onLongPress();
        }}
        style={({ pressed }) => pressed && styles.pressed}>
        <View style={[styles.bubble, mine ? { backgroundColor: colors.tint, borderColor: colors.tint } : { backgroundColor: colors.background, borderColor: colors.border }]}>
          {shared ? (
            <Pressable
              onPress={shared.offer_id ? () => onOpenShared(shared.offer_id!) : undefined}
              disabled={!shared.offer_id}
              accessibilityRole="button"
              accessibilityLabel={`Angebot ${shared.title}`}
              style={({ pressed }) => [
                styles.sharedCard,
                { backgroundColor: mine ? 'rgba(255,255,255,0.16)' : colors.backgroundElement, borderColor: mine ? 'rgba(255,255,255,0.3)' : colors.border },
                pressed && styles.pressed,
              ]}>
              {shared.image_url ? <Image source={{ uri: shared.image_url }} style={styles.sharedImage} contentFit="cover" /> : null}
              <View style={{ flex: 1 }}>
                <Text style={[styles.sharedTitle, { color: ink }]} numberOfLines={2}>
                  {shared.title}
                </Text>
                <Text style={[styles.sharedMeta, { color: mine ? 'rgba(255,255,255,0.85)' : colors.textSecondary }]} numberOfLines={1}>
                  {shared.offer_id
                    ? [shared.partner_name, shared.price_cents !== null ? formatEuro(shared.price_cents) : shared.price_credits !== null ? `${formatCredits(shared.price_credits)} Credits` : null]
                        .filter(Boolean)
                        .join(' · ')
                    : 'Dieses Angebot gibt es nicht mehr'}
                </Text>
              </View>
              {shared.offer_id ? <Icon name="chevron-right" size={18} color={ink} /> : null}
            </Pressable>
          ) : null}
          {message.body ? <Text style={[styles.body, { color: ink }]}>{message.body}</Text> : null}
          <Text style={[styles.time, { color: ink }]}>{formatClock(message.created_at)}</Text>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  frame: { flex: 1, width: '100%', maxWidth: MaxContentWidth, alignSelf: 'center', paddingHorizontal: Spacing.three },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { gap: Spacing.three, paddingVertical: Spacing.three, flexGrow: 1 },
  empty: { paddingTop: Spacing.five },
  emptyTitle: { fontFamily: FontFamily.bold, fontSize: 17 },
  emptyText: { fontFamily: FontFamily.medium, fontSize: 14, textAlign: 'center' },
  section: { gap: Spacing.one },
  dayRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.three, paddingVertical: Spacing.two },
  dayLine: { flex: 1, height: Stroke },
  day: { fontFamily: FontFamily.semibold, fontSize: 12 },
  messageWrap: { maxWidth: '86%' },
  messageMine: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  messageTheirs: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  author: { paddingHorizontal: Spacing.two, paddingBottom: 2, fontFamily: FontFamily.semibold, fontSize: 12 },
  bubble: { borderWidth: Stroke, borderRadius: Radius.card, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two, gap: Spacing.one },
  body: { fontFamily: FontFamily.regular, fontSize: 15, lineHeight: 21 },
  sharedCard: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two, borderWidth: Stroke, borderRadius: Radius.field, padding: Spacing.two, minWidth: 220 },
  sharedImage: { width: 48, height: 48, borderRadius: 8 },
  sharedTitle: { fontFamily: FontFamily.bold, fontSize: 14 },
  sharedMeta: { fontFamily: FontFamily.medium, fontSize: 12 },
  time: { alignSelf: 'flex-end', fontSize: 11, opacity: 0.75, fontFamily: FontFamily.regular },
  inputBar: { flexDirection: 'row', alignItems: 'flex-end', gap: Spacing.two, paddingHorizontal: Spacing.three, paddingVertical: Spacing.two, borderWidth: Stroke, borderRadius: Radius.card },
  input: { flex: 1, fontSize: 15, fontFamily: FontFamily.regular, maxHeight: 96, paddingVertical: Spacing.two },
  sendButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  actionError: { flexDirection: 'row', alignItems: 'center', gap: Spacing.one, paddingHorizontal: Spacing.two, paddingBottom: Spacing.one },
  actionErrorText: { flex: 1, fontFamily: FontFamily.medium, fontSize: 13 },
  pressed: { opacity: 0.7 },
});
