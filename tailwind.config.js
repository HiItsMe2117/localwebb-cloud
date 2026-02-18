/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        ios: {
          bg: '#000000',
          surface1: '#1C1C1E',
          surface2: '#2C2C2E',
          surface3: '#3A3A3C',
          separator: 'rgba(84,84,88,0.65)',
          blue: '#007AFF',
          green: '#30D158',
          red: '#FF453A',
          orange: '#FF9F0A',
          label: 'rgba(255,255,255,1)',
          label2: 'rgba(235,235,245,0.6)',
          label3: 'rgba(235,235,245,0.3)',
          fill: 'rgba(120,120,128,0.36)',
        },
        brand: {
          primary: '#007AFF',
          secondary: '#6366f1',
          accent: '#30D158',
        }
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Display', 'SF Pro Text', 'Helvetica Neue', 'Helvetica', 'Arial', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
