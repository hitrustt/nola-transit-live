/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0d1b2a',
        bayou: '#154c52',
        brass: '#d6a23d',
        sand: '#efe2c7',
        slate: '#2b3440',
      },
      boxShadow: {
        panel: '0 18px 45px rgba(5, 15, 26, 0.28)',
      },
      backgroundImage: {
        grain:
          'radial-gradient(circle at 20% 20%, rgba(255,255,255,0.12), transparent 30%), radial-gradient(circle at 80% 10%, rgba(214,162,61,0.18), transparent 30%), linear-gradient(135deg, rgba(13,27,42,0.97), rgba(21,76,82,0.96))',
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'sans-serif'],
        body: ['"Source Sans 3"', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
