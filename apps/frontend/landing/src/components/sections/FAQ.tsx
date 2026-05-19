import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import { type QA, QAS } from '../../data/faq';
import { useRevealOnScroll } from '../../hooks/useRevealOnScroll';

function FaqItem({ qa, isOpen, onToggle }: { qa: QA; isOpen: boolean; onToggle: () => void }) {
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        className="flex w-full items-center justify-between gap-6 py-5 text-left"
      >
        <span className="text-sm font-medium">{qa.q}</span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
            isOpen ? 'rotate-180' : ''
          }`}
        />
      </button>
      {isOpen && (
        <div className="pb-5 pr-10 text-sm leading-relaxed text-muted-foreground">{qa.a}</div>
      )}
    </div>
  );
}

export function FAQ() {
  const [openIdx, setOpenIdx] = useState<number | null>(0);
  const ref = useRevealOnScroll<HTMLElement>();
  return (
    <section
      ref={ref}
      data-reveal="section"
      className="border-b border-border/60 bg-background py-12 sm:py-20 lg:py-28"
    >
      <div className="mx-auto max-w-3xl px-6">
        <div className="text-center">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">FAQ</p>
          <h2 className="mt-3 text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
            Things people ask first.
          </h2>
        </div>
        <div className="mt-12 rounded-xl border border-border bg-card px-6">
          {QAS.map((qa, i) => (
            <FaqItem
              key={qa.q}
              qa={qa}
              isOpen={openIdx === i}
              onToggle={() => setOpenIdx(openIdx === i ? null : i)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
