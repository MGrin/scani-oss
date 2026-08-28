/**
 * Shared Tailwind preset consumed by apps/frontend/app and apps/frontend/cloud.
 *
 * Design-token philosophy: every color is HSL driven by a CSS variable in
 * `src/styles/globals.css`, so ThemeContext can swap light/dark simply by
 * flipping the `data-theme` attribute on `<html>`. Keyframes live here so
 * both SPAs animate identically.
 *
 * Apps still provide their own `content` glob because preset merging only
 * extends (it can't replace) — each app's config should spread this preset
 * and add its own `content: [...]`.
 */

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: {
        '2xl': '1400px',
      },
    },
    extend: {
      colors: {
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        primary: {
          DEFAULT: 'hsl(var(--primary))',
          foreground: 'hsl(var(--primary-foreground))',
        },
        secondary: {
          DEFAULT: 'hsl(var(--secondary))',
          foreground: 'hsl(var(--secondary-foreground))',
        },
        destructive: {
          DEFAULT: 'hsl(var(--destructive))',
          foreground: 'hsl(var(--destructive-foreground))',
        },
        muted: {
          DEFAULT: 'hsl(var(--muted))',
          foreground: 'hsl(var(--muted-foreground))',
        },
        accent: {
          DEFAULT: 'hsl(var(--accent))',
          foreground: 'hsl(var(--accent-foreground))',
        },
        popover: {
          DEFAULT: 'hsl(var(--popover))',
          foreground: 'hsl(var(--popover-foreground))',
        },
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // 1-5 exist in v2's globals.css; 6-8 and `other` are v3-only and
        // resolve to nothing outside [data-ui="v3"], like the surface ramp
        // below. v3 re-solves 1-5 in place — same slots, theme-stable hues.
        chart: {
          1: 'hsl(var(--chart-1))',
          2: 'hsl(var(--chart-2))',
          3: 'hsl(var(--chart-3))',
          4: 'hsl(var(--chart-4))',
          5: 'hsl(var(--chart-5))',
          6: 'hsl(var(--chart-6))',
          7: 'hsl(var(--chart-7))',
          8: 'hsl(var(--chart-8))',
          other: 'hsl(var(--chart-other))',
        },
        // v3 tokens (src/styles/v3-tokens.css). Defined only under
        // [data-ui="v3"], so these utilities resolve to nothing outside the v3
        // tree and cannot regress v2. `neutral` shadows Tailwind's default
        // gray scale — verified unused across every app and package.
        'surface-0': 'hsl(var(--surface-0))',
        'surface-1': 'hsl(var(--surface-1))',
        'surface-2': 'hsl(var(--surface-2))',
        'surface-hover': 'hsl(var(--surface-hover))',
        // `border-strong` is the WCAG 1.4.11 border (control edges). Plain
        // `border-border` is the decorative hairline and is deliberately
        // below 3:1 — see the note in v3-tokens.css.
        'border-strong': 'hsl(var(--border-strong))',
        gain: 'hsl(var(--gain))',
        loss: 'hsl(var(--loss))',
        neutral: 'hsl(var(--neutral))',
        interactive: {
          DEFAULT: 'hsl(var(--interactive))',
          foreground: 'hsl(var(--interactive-foreground))',
        },
      },
      // v3 type faces (src/styles/v3-fonts.css, named in src/styles/v3-tokens.css).
      // Each var's fallback is verbatim Tailwind's own default stack, and the
      // vars exist only under [data-ui="v3"] — so `font-sans` and preflight's
      // `html { font-family }` resolve to exactly what they resolved to before
      // in v2, cloud, landing and admin. `display` is the numeral face: the
      // brief's position is that a finance app's display type is a figure, so
      // the hero is set in mono, and `text-display` must be paired with
      // `font-display` for the size role and the face to agree.
      fontFamily: {
        sans: 'var(--font-sans, ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji")',
        mono: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace)',
        display:
          'var(--font-display, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace)',
      },
      // The six type roles from the v3 brief. Each carries its own weight and
      // tracking so `text-display` is the whole treatment, not just a size.
      fontSize: {
        display: [
          'var(--text-display-size)',
          {
            lineHeight: 'var(--text-display-line)',
            letterSpacing: 'var(--text-display-tracking)',
            fontWeight: 'var(--text-display-weight)',
          },
        ],
        title: [
          'var(--text-title-size)',
          {
            lineHeight: 'var(--text-title-line)',
            letterSpacing: 'var(--text-title-tracking)',
            fontWeight: 'var(--text-title-weight)',
          },
        ],
        body: [
          'var(--text-body-size)',
          {
            lineHeight: 'var(--text-body-line)',
            letterSpacing: 'var(--text-body-tracking)',
            fontWeight: 'var(--text-body-weight)',
          },
        ],
        label: [
          'var(--text-label-size)',
          {
            lineHeight: 'var(--text-label-line)',
            letterSpacing: 'var(--text-label-tracking)',
            fontWeight: 'var(--text-label-weight)',
          },
        ],
        caption: [
          'var(--text-caption-size)',
          {
            lineHeight: 'var(--text-caption-line)',
            letterSpacing: 'var(--text-caption-tracking)',
            fontWeight: 'var(--text-caption-weight)',
          },
        ],
      },
      // The seventh role, `numeric`, is a treatment rather than a size — it
      // inherits whatever the surrounding role set. `tracking-numeric` is the
      // part of it that needs a utility; the face and figure widths are
      // `font-mono tabular-nums`. Applied by `<Numeric>` (V3-07), not by hand.
      letterSpacing: {
        numeric: 'var(--text-numeric-tracking)',
      },
      // `min-h-tap` / `min-w-tap` — the 44×44 hit area. Exposed as minimums
      // rather than in `spacing` so it cannot be used as a padding or gap.
      minHeight: {
        tap: 'var(--tap-target)',
      },
      minWidth: {
        tap: 'var(--tap-target)',
      },
      borderRadius: {
        lg: 'var(--radius)',
        md: 'calc(var(--radius) - 2px)',
        sm: 'calc(var(--radius) - 4px)',
      },
      // v3 elevation, same var-with-verbatim-default trick as fontFamily
      // above: `--elevation-*` exists only under [data-ui="v3"], so
      // `shadow-sm` / `shadow-md` resolve to exactly Tailwind's own defaults
      // in v2, cloud, landing and admin. Inside v3 they become the tuned
      // pair, which is what gives a white card on a white page an edge —
      // there is no lightness left to spend on it.
      boxShadow: {
        sm: 'var(--elevation-1, 0 1px 2px 0 rgb(0 0 0 / 0.05))',
        md: 'var(--elevation-2, 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1))',
      },
      keyframes: {
        'accordion-down': {
          from: { height: 0 },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: 0 },
        },
        // A keyframe is not mirrored by `dir` (SC-766). `translateX(-100%)`
        // means the same displacement in Arabic as in English, so SC-760's
        // conversion of the markup to logical properties moved the bar's
        // ANCHOR to `start-0` and left its SWEEP running left-to-right —
        // anchored at the reading edge and travelling away from it.
        //
        // The counterpart is the X-negation, not a re-timing: these keyframes
        // are palindromes in time (0% and 100% are equal), so
        // `animation-direction: reverse` yields the identical sweep and fixes
        // nothing. `rtl-animation-axis.test.ts` asserts the negation pairwise.
        'loading-bar': {
          '0%': { transform: 'translateX(-100%)' },
          '50%': { transform: 'translateX(200%)' },
          '100%': { transform: 'translateX(-100%)' },
        },
        'loading-bar-rtl': {
          '0%': { transform: 'translateX(100%)' },
          '50%': { transform: 'translateX(-200%)' },
          '100%': { transform: 'translateX(100%)' },
        },
        'fade-in': {
          from: { opacity: 0 },
          to: { opacity: 1 },
        },
        'fade-in-up': {
          from: { opacity: 0, transform: 'translateY(10px)' },
          to: { opacity: 1, transform: 'translateY(0)' },
        },
        'scale-in': {
          from: { opacity: 0, transform: 'scale(0.95)' },
          to: { opacity: 1, transform: 'scale(1)' },
        },
        'pulse-subtle': {
          '0%, 100%': { opacity: 1 },
          '50%': { opacity: 0.8 },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'loading-bar': 'loading-bar 2.8s ease-in-out infinite',
        'loading-bar-rtl': 'loading-bar-rtl 2.8s ease-in-out infinite',
        'fade-in': 'fade-in 0.2s ease-out',
        'fade-in-up': 'fade-in-up 0.3s ease-out',
        'scale-in': 'scale-in 0.2s ease-out',
        'pulse-subtle': 'pulse-subtle 2s ease-in-out infinite',
      },
      transitionDuration: {
        250: '250ms',
        350: '350ms',
        // v3 motion tokens — collapse to 0ms under prefers-reduced-motion.
        fast: 'var(--motion-fast)',
        base: 'var(--motion-base)',
        slow: 'var(--motion-slow)',
      },
      transitionTimingFunction: {
        'bounce-in': 'cubic-bezier(0.68, -0.55, 0.265, 1.55)',
        emphasized: 'var(--motion-ease)',
        spring: 'var(--motion-ease-spring)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
