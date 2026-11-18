/**
 * Shared building blocks.
 *
 * Accessibility is handled here rather than screen by screen: every pressable
 * is at least 48 px high, every input has a visible label tied to it, errors
 * are announced, and nothing relies on colour alone to carry meaning.
 */

import React from 'react';
import {
  View, Text, Pressable, TextInput, ActivityIndicator, ScrollView,
  StyleSheet, type ViewStyle, type TextStyle,
} from 'react-native';
import { palette, spacing, radius, touchTarget, typography } from '../theme';

export function Screen({ children, scroll = true }: {
  children: React.ReactNode; scroll?: boolean;
}) {
  const content = (
    <View style={styles.screenInner}>{children}</View>
  );
  return scroll
    ? <ScrollView style={styles.screen} contentContainerStyle={styles.screenContent}>
        {content}
      </ScrollView>
    : <View style={[styles.screen, styles.screenContent]}>{content}</View>;
}

export function Title({ children, level = 1 }: { children: React.ReactNode; level?: 1 | 2 | 3 }) {
  const style = level === 1 ? typography.display
    : level === 2 ? typography.title : typography.heading;
  return (
    <Text
      accessibilityRole="header"
      style={[style, { color: palette.ink, marginBottom: spacing.sm }]}
    >
      {children}
    </Text>
  );
}

export function Body({ children, muted = false, style }: {
  children: React.ReactNode; muted?: boolean; style?: TextStyle;
}) {
  return (
    <Text style={[typography.body, { color: muted ? palette.inkMuted : palette.ink }, style]}>
      {children}
    </Text>
  );
}

export function Small({ children, muted = true }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <Text style={[typography.small, { color: muted ? palette.inkSubtle : palette.ink }]}>
      {children}
    </Text>
  );
}

export function Button({ label, onPress, variant = 'primary', disabled, loading, accessibilityHint }: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
  accessibilityHint?: string;
}) {
  const isDisabled = disabled || loading;

  const background =
    variant === 'primary' ? palette.primary
    : variant === 'danger' ? palette.danger
    : variant === 'secondary' ? palette.surface
    : 'transparent';

  const textColor =
    variant === 'primary' || variant === 'danger' ? palette.surface : palette.primary;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      aria-disabled={!!isDisabled}
      aria-busy={!!loading}
      disabled={isDisabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: background, opacity: isDisabled ? 0.55 : pressed ? 0.85 : 1 },
        variant === 'secondary' && { borderWidth: 1.5, borderColor: palette.primary },
      ]}
    >
      {loading
        ? <ActivityIndicator color={textColor} />
        : <Text style={[typography.heading, { color: textColor }]}>{label}</Text>}
    </Pressable>
  );
}

export function Field({ label, value, onChangeText, placeholder, hint, error, keyboardType, autoCapitalize }: {
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
  hint?: string;
  error?: string | null;
  keyboardType?: 'default' | 'email-address' | 'numeric' | 'phone-pad';
  autoCapitalize?: 'none' | 'sentences' | 'words';
}) {
  return (
    <View style={{ marginBottom: spacing.lg }}>
      <Text
        nativeID={`label-${label}`}
        style={[typography.small, { color: palette.ink, fontWeight: '600', marginBottom: spacing.xs }]}
      >
        {label}
      </Text>

      {hint ? <Small>{hint}</Small> : null}

      <TextInput
        accessibilityLabel={label}
        accessibilityLabelledBy={`label-${label}`}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={palette.inkSubtle}
        keyboardType={keyboardType ?? 'default'}
        autoCapitalize={autoCapitalize ?? 'sentences'}
        style={[
          styles.input,
          { borderColor: error ? palette.danger : palette.borderStrong },
          hint ? { marginTop: spacing.xs } : null,
        ]}
      />

      {error ? (
        <Text
          accessibilityRole="alert"
          style={[typography.small, { color: palette.danger, marginTop: spacing.xs }]}
        >
          {/* A symbol as well as the colour: meaning never rests on colour alone. */}
          ⚠ {error}
        </Text>
      ) : null}
    </View>
  );
}

export function Checkbox({ label, description, checked, onToggle, required }: {
  label: string; description?: string; checked: boolean;
  onToggle: (next: boolean) => void; required?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      // React Native Web does not emit aria-checked from accessibilityState,
      // and a role="checkbox" without it is invalid ARIA: a screen reader
      // cannot tell whether the box is ticked (WCAG 2.1 — 4.1.2 Name, Role,
      // Value). So the attribute is set explicitly for the web renderer; the
      // native renderer ignores it and uses accessibilityState above.
      aria-checked={checked}
      accessibilityLabel={label}
      accessibilityHint={description}
      onPress={() => onToggle(!checked)}
      style={styles.checkboxRow}
    >
      <View style={[
        styles.checkboxBox,
        checked && { backgroundColor: palette.primary, borderColor: palette.primary },
      ]}>
        {checked ? <Text style={styles.checkboxTick}>✓</Text> : null}
      </View>

      <View style={{ flex: 1 }}>
        <Text style={[typography.body, { color: palette.ink }]}>
          {label}{required ? <Text style={{ color: palette.danger }}> *</Text> : null}
        </Text>
        {description ? <Small>{description}</Small> : null}
      </View>
    </Pressable>
  );
}

export function Card({ children, tone = 'default' }: {
  children: React.ReactNode; tone?: 'default' | 'notice' | 'danger' | 'success';
}) {
  const background =
    tone === 'notice' ? palette.noticeBg
    : tone === 'danger' ? palette.dangerSoft
    : tone === 'success' ? palette.successSoft
    : palette.surface;

  const border =
    tone === 'notice' ? '#E6C98A'
    : tone === 'danger' ? '#E8A9A9'
    : tone === 'success' ? '#A9CFC1'
    : palette.border;

  return (
    <View style={[styles.card, { backgroundColor: background, borderColor: border }]}>
      {children}
    </View>
  );
}

/**
 * The alcohol notice (spec 5 and 4.2). Always shows the degree, never a
 * celebratory framing, and carries the health warning when one is given.
 */
export function AlcoholNotice({ notice, healthWarning }: {
  notice: string; healthWarning?: string | null;
}) {
  return (
    <Card tone="notice">
      <Text style={[typography.small, { color: palette.noticeInk, fontWeight: '600' }]}>
        {notice}
      </Text>
      {healthWarning ? (
        <Text style={[typography.small, { color: palette.noticeInk, marginTop: spacing.xs }]}>
          {healthWarning}
        </Text>
      ) : null}
    </Card>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <View accessibilityRole="alert" style={[styles.card, styles.errorBanner]}>
      <Text style={[typography.body, { color: palette.danger, fontWeight: '600' }]}>
        ⚠ {message}
      </Text>
    </View>
  );
}

export function Row({ left, right, strong = false }: {
  left: string; right: string; strong?: boolean;
}) {
  const style = strong
    ? { ...typography.heading, color: palette.ink }
    : { ...typography.body, color: palette.inkMuted };

  return (
    <View style={styles.row}>
      <Text style={style}>{left}</Text>
      <Text style={[style, { fontVariant: ['tabular-nums'] }]}>{right}</Text>
    </View>
  );
}

export function Divider({ style }: { style?: ViewStyle }) {
  return <View style={[styles.divider, style]} />;
}

export function Loading({ label = 'Chargement…' }: { label?: string }) {
  return (
    <View style={styles.loading} accessibilityRole="progressbar" accessibilityLabel={label}>
      <ActivityIndicator color={palette.primary} size="large" />
      <Text style={[typography.body, { color: palette.inkMuted, marginTop: spacing.md }]}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: palette.surfaceAlt },
  screenContent: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  screenInner: { maxWidth: 640, width: '100%', alignSelf: 'center' },

  button: {
    minHeight: touchTarget,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    marginTop: spacing.sm,
  },

  input: {
    minHeight: touchTarget,
    borderWidth: 1.5,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    backgroundColor: palette.surface,
    color: palette.ink,
    fontSize: typography.body.fontSize,
  },

  checkboxRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    minHeight: touchTarget,
    paddingVertical: spacing.sm,
  },
  checkboxBox: {
    width: 26, height: 26, borderRadius: radius.sm,
    borderWidth: 2, borderColor: palette.borderStrong,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: palette.surface, marginTop: 2,
  },
  checkboxTick: { color: palette.surface, fontSize: 16, fontWeight: '700', lineHeight: 18 },

  card: {
    borderWidth: 1, borderRadius: radius.lg,
    padding: spacing.lg, marginBottom: spacing.md,
  },
  errorBanner: { backgroundColor: palette.dangerSoft, borderColor: '#E8A9A9' },

  row: {
    flexDirection: 'row', justifyContent: 'space-between',
    alignItems: 'center', paddingVertical: spacing.xs, gap: spacing.md,
  },
  divider: { height: 1, backgroundColor: palette.border, marginVertical: spacing.md },
  loading: { padding: spacing.xxxl, alignItems: 'center' },
});
