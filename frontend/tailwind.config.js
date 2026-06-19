/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Robinhood-inspired dark palette: pure black + elevated surfaces.
        bg: '#000000',
        'bg-2': '#0e0e0e',
        panel: '#0e0e0e',
        'panel-2': '#161616',
        border: 'rgba(255,255,255,0.08)',
        'border-2': 'rgba(255,255,255,0.14)',
        // Primary accent = Robinhood lime. Token name kept ("amber") so the
        // many existing `text-amber` / `btn-amber` / active-state usages
        // automatically pick up the new accent.
        amber: '#CCFF00',
        'amber-dim': '#a3cc00',
        // P&L semantics only.
        up: '#00C805',
        down: '#FF5000',
        muted: '#6B6B6B',
        'text-dim': '#A8A8A8',
        text: '#F5F5F5',
      },
      fontFamily: {
        // UI sans (Inter) — used app-wide via the body class.
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        // Reserve mono for NUMBERS only (the `.num` class).
        mono: ['"JetBrains Mono"', '"SF Mono"', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': '0.625rem',
      },
      borderRadius: {
        // Softer default radius so `rounded` reads as a Robinhood card.
        DEFAULT: '0.5rem',
      },
    },
  },
  plugins: [],
};
