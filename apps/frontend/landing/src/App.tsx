export function App() {
  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="max-w-xl text-center space-y-6">
        <h1 className="text-5xl font-semibold tracking-tight">Scani</h1>
        <p className="text-lg text-neutral-400">
          A personal wealth tracker for people who want one place to see every asset, across every
          institution, every chain.
        </p>
        <div className="flex items-center justify-center gap-4 pt-4">
          <a
            href="https://app.scani.xyz"
            className="inline-flex items-center rounded-full bg-white px-5 py-2.5 text-sm font-medium text-black transition hover:bg-neutral-200"
          >
            Open the app
          </a>
          <a
            href="https://github.com/MGrin/scani"
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center rounded-full border border-neutral-700 px-5 py-2.5 text-sm font-medium text-neutral-200 transition hover:bg-neutral-900"
          >
            GitHub
          </a>
        </div>
        <p className="pt-8 text-xs text-neutral-600">
          Still under active development. This landing is a placeholder.
        </p>
      </div>
    </main>
  );
}
