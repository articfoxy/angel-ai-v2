/**
 * Angel AI v2 — Design System
 *
 * Warm, companion-feel dark palette. The app should feel like a private
 * notebook you keep beside your bed, not a cold enterprise tool. Backgrounds
 * lean deep warm near-black; accents are a single Claude-leaning terracotta
 * orange used sparingly; text is cream-white, never pure white.
 *
 * Typography pairs a system sans for body with a serif display face for
 * hero moments (session title, section headings, quotes) so the product
 * reads like a book rather than a dashboard.
 */
import { Platform } from 'react-native';

// ─── Color ──────────────────────────────────────────────────────────────────

export const colors = {
  // Backgrounds — warm near-blacks. Never pure #000.
  bg: '#0E0C0A',
  surface: '#17140F',
  surfaceRaised: '#201B15',
  surfaceHover: '#2A241C',

  // Primary accent — Claude-leaning terracotta. One hero color, used sparingly.
  primary: '#D97757',
  primaryHover: '#E8886A',
  primaryMuted: 'rgba(217, 119, 87, 0.14)',
  primaryBorder: 'rgba(217, 119, 87, 0.32)',

  // Semantic — all warm-biased. No neon greens, no scary reds.
  success: '#8AB583',          // muted sage
  successMuted: 'rgba(138, 181, 131, 0.14)',
  warning: '#E0A857',          // warm amber
  warningMuted: 'rgba(224, 168, 87, 0.14)',
  danger: '#D27760',           // brick terracotta
  dangerMuted: 'rgba(210, 119, 96, 0.14)',
  info: '#8EA6C4',             // dusk blue
  infoMuted: 'rgba(142, 166, 196, 0.14)',

  // Text — warm cream, not stark white.
  text: '#F3EAD9',             // primary (cream)
  textSecondary: '#B5A895',    // softened (warm tan)
  textTertiary: '#8A7F6F',     // dim (deeper tan)

  // Structural — subtle, warm.
  border: 'rgba(243, 234, 217, 0.09)',
  borderSubtle: 'rgba(243, 234, 217, 0.06)',
  divider: 'rgba(243, 234, 217, 0.05)',
  overlay: 'rgba(14, 12, 10, 0.72)',

  // Speaker palette — muted, harmonious. Avoid Cyber-rainbow.
  speakerOwner: '#D97757',     // the user = primary accent
  speakerA: '#8AB583',         // sage
  speakerB: '#E0A857',         // amber
  speakerC: '#8EA6C4',         // dusk blue
  speakerD: '#C18FB8',         // mauve
  speakerE: '#D27760',         // terracotta
} as const;

// ─── Spacing ────────────────────────────────────────────────────────────────
// Generous scale — the app should breathe, not crowd.

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 56,
  huge: 80,
} as const;

// ─── Radius ─────────────────────────────────────────────────────────────────
// Softer corners. The app is warm, not sharp.

export const radius = {
  sm: 8,
  md: 14,
  lg: 20,
  xl: 28,
  full: 9999,
} as const;

// ─── Typography ─────────────────────────────────────────────────────────────

/** Type scale — slightly larger than the old one so the app reads well at
 *  arm's length and gives proper rhythm when paired with a serif display. */
export const fontSize = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 18,
  xl: 24,
  xxl: 34,
  hero: 48,
} as const;

/** Font families. iOS has Georgia and Iowan Old Style built in — either
 *  works as a serif display face. Android falls back to its system serif. */
export const fontFamily = {
  sans: Platform.select({
    ios: 'System',
    android: 'sans-serif',
    default: 'System',
  }),
  /** Display face for hero titles, pull quotes, section headings. */
  serif: Platform.select({
    ios: 'Iowan Old Style',
    android: 'serif',
    default: 'serif',
  }),
  /** Mono — code output, worker logs. Keep distinct from body. */
  mono: Platform.select({
    ios: 'Menlo',
    android: 'monospace',
    default: 'monospace',
  }),
} as const;

/** Line-height helpers. Serif wants more leading than sans. */
export const lineHeight = {
  tight: 1.15,
  snug: 1.3,
  normal: 1.5,
  relaxed: 1.65,
} as const;

/** Reusable type presets. Spread into `style` to stay consistent. */
export const type = {
  hero: {
    fontFamily: fontFamily.serif,
    fontSize: fontSize.hero,
    lineHeight: fontSize.hero * lineHeight.tight,
    color: colors.text,
    letterSpacing: -0.8,
  },
  display: {
    fontFamily: fontFamily.serif,
    fontSize: fontSize.xxl,
    lineHeight: fontSize.xxl * lineHeight.tight,
    color: colors.text,
    letterSpacing: -0.4,
  },
  title: {
    fontFamily: fontFamily.serif,
    fontSize: fontSize.xl,
    lineHeight: fontSize.xl * lineHeight.snug,
    color: colors.text,
    letterSpacing: -0.2,
  },
  body: {
    fontFamily: fontFamily.sans,
    fontSize: fontSize.md,
    lineHeight: fontSize.md * lineHeight.normal,
    color: colors.text,
    fontWeight: '400' as const,
  },
  bodyLg: {
    fontFamily: fontFamily.sans,
    fontSize: fontSize.lg,
    lineHeight: fontSize.lg * lineHeight.normal,
    color: colors.text,
    fontWeight: '400' as const,
  },
  caption: {
    fontFamily: fontFamily.sans,
    fontSize: fontSize.sm,
    lineHeight: fontSize.sm * lineHeight.normal,
    color: colors.textSecondary,
    fontWeight: '400' as const,
  },
  label: {
    fontFamily: fontFamily.sans,
    fontSize: fontSize.xs,
    lineHeight: fontSize.xs * lineHeight.snug,
    color: colors.textSecondary,
    fontWeight: '600' as const,
    letterSpacing: 0.6,
    textTransform: 'uppercase' as const,
  },
  mono: {
    fontFamily: fontFamily.mono,
    fontSize: fontSize.sm,
    lineHeight: fontSize.sm * lineHeight.snug,
    color: colors.text,
  },
} as const;

// ─── Shadows ────────────────────────────────────────────────────────────────
// Warm shadows — the light source is candle-lit, not fluorescent.

export const shadows = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.25,
    shadowRadius: 2,
    elevation: 1,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.28,
    shadowRadius: 10,
    elevation: 3,
  },
  lg: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.32,
    shadowRadius: 18,
    elevation: 6,
  },
  glow: (color: string) => ({
    shadowColor: color,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 5,
  }),
} as const;

// ─── Durations ──────────────────────────────────────────────────────────────
// Timings used across animations. Deliberate > twitchy.

export const duration = {
  fast: 160,
  normal: 240,
  slow: 400,
  hero: 800,
} as const;
