interface ErrorPanelProps {
  service: string;
  error: string;
}

export function ErrorPanel({ service, error }: ErrorPanelProps) {
  return (
    <div className="rounded-lg border border-red-900/60 bg-red-950/30 p-4">
      <div className="text-sm font-semibold text-red-300">{service} — failed to load</div>
      <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-red-200/80">{error}</pre>
    </div>
  );
}
