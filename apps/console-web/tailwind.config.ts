import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: 'rgb(var(--brand-rgb) / <alpha-value>)',
          dim: 'rgb(var(--brand-deep) / <alpha-value>)',
          muted: 'rgb(var(--brand-rgb) / 0.08)',
          border: 'rgb(var(--brand-rgb) / 0.40)',
        },
        // CSS-variable-backed theme colors — shared Neurofunken foundation
        ink:     'rgb(var(--ink)     / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        panel:   'rgb(var(--panel)   / <alpha-value>)',
        rim:     'rgb(var(--rim)     / <alpha-value>)',
        dim:     'rgb(var(--dim)     / <alpha-value>)',
        success: '#22c55e',
        warning: '#f59e0b',
        danger:  '#ef4444',
      },
      fontFamily: {
        sans: ['Manrope Variable', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;
