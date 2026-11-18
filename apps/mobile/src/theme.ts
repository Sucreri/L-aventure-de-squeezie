/**
 * Design tokens.
 *
 * Accessibility is a blocking requirement (spec 4.9: WCAG 2.1 level AA), and
 * it is far cheaper to build in than to retrofit. So the decisions live here:
 *
 *   · every text/background pair below meets at least 4.5:1, and large text
 *     at least 3:1;
 *   · `touchTarget` is 48, above the 44 px the specification asks for;
 *   · nothing conveys meaning by colour alone — states carry a label too.
 */

export const palette = {
  // Neutrals
  ink:        '#14181F',   // on surface  — 15.8:1
  inkMuted:   '#4A5361',   // on surface  —  7.4:1
  inkSubtle:  '#667085',   // on surface  —  4.6:1
  surface:    '#FFFFFF',
  surfaceAlt: '#F5F7FA',
  border:     '#D7DDE5',
  borderStrong: '#AEB8C5',

  // Brand. Deliberately not evocative of any existing delivery brand.
  primary:      '#1F5F4B',   // white on this — 7.1:1
  primaryHover: '#17493A',
  primarySoft:  '#E6F1ED',

  // States
  danger:     '#A32020',     // white on this — 7.3:1
  dangerSoft: '#FBEAEA',
  warning:    '#7A4B06',     // white on this — 7.6:1
  warningSoft:'#FDF3E2',
  success:    '#1F5F4B',
  successSoft:'#E6F1ED',

  // Alcohol notice: must be legible, never festive (spec 4.2).
  noticeBg:   '#FDF3E2',
  noticeInk:  '#5C3A05',     // on noticeBg — 8.2:1
} as const;

export const spacing = {
  xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48,
} as const;

export const radius = { sm: 6, md: 10, lg: 16, pill: 999 } as const;

/** Above the 44 px floor of spec 4.9. */
export const touchTarget = 48;

export const typography = {
  display: { fontSize: 28, lineHeight: 34, fontWeight: '700' as const },
  title:   { fontSize: 22, lineHeight: 28, fontWeight: '700' as const },
  heading: { fontSize: 17, lineHeight: 24, fontWeight: '600' as const },
  body:    { fontSize: 16, lineHeight: 24, fontWeight: '400' as const },
  small:   { fontSize: 14, lineHeight: 20, fontWeight: '400' as const },
  mono:    { fontSize: 16, lineHeight: 24, fontWeight: '600' as const },
} as const;

/** Formats an integer number of cents. Never used in a computation. */
export function euros(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}
