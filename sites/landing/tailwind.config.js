// Tailwind da página comercial. Recompile com: npm run landing:css  (ou /caminho/tailwindcss -c sites/landing/tailwind.config.js -i sites/landing/landing.src.css -o app/landing.css --minify)
module.exports = {
  content: ['./app/landing.html', './app/legal.html', './sites/landing.mjs'],
  theme: {
    extend: {
      colors: { marinho: '#0F172A', esmeralda: { DEFAULT: '#059669', escuro: '#047857' }, claro: '#F8FAFC' },
      fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'] },
    },
  },
};
