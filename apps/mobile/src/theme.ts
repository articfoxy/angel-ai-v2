/**
 * Angel AI v2 — Design System
 *
 * Inspired by Linear, Arc, and Apple's HIG.
 * Dark-first, with refined contrast, generous spacing,
 * and a restrained accent palette.
 */

export const colors = {
  // Backgrounds
  bg: '#050507',
  surface: '#111113',
  surfaceRaised: '#19191d',
  surfaceHover: '#222228',

  // Accent
  primary: '#7c7fff',
  primaryHover: '#9b9eff',
  primaryMuted: 'rgba(124, 127, 255, 0.15)',
  primaryBorder: 'rgba(124, 127, 255, 0.25)',

  // Semantic
  success: '#34d399',
  successMuted: 'rgba(52, 211, 153, 0.15)',
  warning: '#fbbf24',
  warningMuted: 'rgba(251, 191, 36, 0.15)',
  danger: '#f87171',
  dangerMuted: 'rgba(248, 113, 113, 0.15)',
  info: '#38bdf8',
  infoMuted: 'rgba(56, 189, 248, 0.15)',

  // Text
  text: '#ececf1',
  textSecondary: '#8e8ea0',
  textTertiary: '#6e6e82',

  // Structure
  border: 'rgba(255, 255, 255, 0.10)',
  borderSubtle: 'rgba(255, 255, 255, 0.07)',
  divider: 'rgba(255, 255, 255, 0.05)',
  overlay: 'rgba(0, 0, 0, 0.6)',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const fontSize = {
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 22,
  xxl: 32,
  hero: 40,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 9999,
} as const;

/** Shared shadow presets */
export const shadows = {
  sm: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 3,
    elevation: 2,
  },
  md: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 4,
  },
  glow: (color: string) => ({
    shadowColor: color,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 16,
    elevation: 6,
  }),
} as const;
