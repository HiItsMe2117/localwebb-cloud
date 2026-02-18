/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        terminal: {
          bg: '#050510', // Deep dark blue/black
          text: '#a4b9ef', // Light blue-ish white
          primary: '#4169E1', // Royal Blue
          dim: '#2b4a9c',
          border: '#4169E1',
          highlight: '#00ffff', // Cyan for high contrast
        }
      },
      fontFamily: {
        mono: ['"Courier New"', 'Courier', 'monospace'],
        sans: ['"Courier New"', 'Courier', 'monospace'], // Override sans to mono for this theme
      },
      boxShadow: {
        'glow': '0 0 10px rgba(65, 105, 225, 0.5)',
        'glow-strong': '0 0 20px rgba(65, 105, 225, 0.8)',
      },
      animation: {
        'cursor-blink': 'blink 1s step-end infinite',
      },
      keyframes: {
        blink: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0' },
        }
      }
    },
  },
  plugins: [],
}
