
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        carrot: {
          DEFAULT: '#FF6F0F',
          50: '#FFF2E8',
          100: '#FFE5D6',
          200: '#FFC6A8',
          300: '#FFA579',
          400: '#FF8B4E',
          500: '#FF6F0F',
          600: '#E9630D',
          700: '#C8540B',
          800: '#A14608',
          900: '#733205'
        }
      },
      borderRadius: {
        '2xl': '1rem'
      },
      boxShadow: {
        soft: '0 10px 30px rgba(0,0,0,0.08)'
      }
    },
  },
  plugins: [],
}
