export default {
  plugins: {
    // postcss-import inlines `@import` directives BEFORE Tailwind
    // processes the file, so the design-system tokens we pull from
    // `@scani/ui/styles/globals.css` (which uses `@layer base`) resolve
    // against the `@tailwind base` directive in this file. Without it,
    // Next.js's CSS pipeline treats each imported file as a separate
    // module and PostCSS errors with "@layer base used but no matching
    // @tailwind base directive". Other apps (app, cloud, landing) use
    // Vite, which inlines @imports natively.
    'postcss-import': {},
    tailwindcss: {},
    autoprefixer: {},
  },
};
