/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0b0d',
        'bg-2': '#0d1117',
        panel: '#12141a',
        'panel-2': '#171a21',
        border: '#1f2530',
        'border-2': '#2a3140',
        amber: '#f7a01d',
        'amber-dim': '#b8770f',
        up: '#1bcf6b',
        down: '#ff4d4d',
        muted: '#5c6675',
        'text-dim': '#8b94a3',
        text: '#c9d1da',
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"SF Mono"', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': '0.625rem',
      },
    },
  },
  plugins: [],
};
