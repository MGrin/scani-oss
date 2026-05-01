import type { ReactNode } from 'react';

export function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="mb-3">
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
        {description ? <p className="text-xs text-neutral-400 mt-0.5">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}
