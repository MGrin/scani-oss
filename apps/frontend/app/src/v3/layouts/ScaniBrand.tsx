import { ScaniLogo } from '@scani/ui/components/ScaniLogo';
import { buildIdentity } from '@scani/ui/lib/build-identity';
import { Button } from '@scani/ui/ui/button';
import { PeekSheet } from '@scani/ui/v3/components/PeekSheet';
import type { PeekFact, PeekSection } from '@scani/ui/v3/lib/peek';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

export function ScaniBrand() {
  const { t } = useTranslation();
  const { coreBuild: build, commit } = buildIdentity();
  const [open, setOpen] = useState(false);
  const releaseVersion =
    typeof __SCANI_RELEASE_VERSION__ === 'undefined' ? null : __SCANI_RELEASE_VERSION__;
  const productVersion = build?.productVersion ?? releaseVersion;
  const release = productVersion ? `v${productVersion}` : t('v3.brand.development');
  // Build facts, not a form: the peek's read-only sheet rather than a centred
  // dialog (SC-1413). `break-all` because a commit and a fingerprint are one
  // long unbroken token each.
  const facts: PeekFact[] = [
    { label: t('v3.brand.coreRelease'), value: release },
    {
      label: t('v3.brand.build'),
      value: <span className="break-all">{commit ?? t('v3.brand.development')}</span>,
    },
  ];
  // The note says the pending changes are "shown below", so they follow it.
  const pending: PeekSection[] = build
    ? [
        {
          title: t('v3.brand.pendingSection'),
          facts: [
            { label: t('v3.brand.pending'), value: build.pendingChangeCount },
            {
              label: t('v3.brand.fingerprint'),
              value: <span className="break-all">{build.coreFingerprint}</span>,
            },
          ],
        },
      ]
    : [];
  return (
    <div className="flex min-w-0 items-center gap-2">
      <ScaniLogo className="size-7 shrink-0" />
      <span className="text-title">Scani</span>
      <Button
        variant="ghost"
        size="sm"
        className="px-1 text-caption text-muted-foreground"
        aria-label={t('v3.brand.details')}
        onClick={() => setOpen(true)}
      >
        {release}
      </Button>
      <PeekSheet
        open={open}
        onOpenChange={setOpen}
        noun={t('v3.brand.details')}
        spec={{
          title: t('v3.brand.details'),
          primary: facts,
          // Two sentences, so the body rather than the one-line subtitle.
          content: (
            <p className="text-caption text-muted-foreground">{t('v3.brand.baselineNote')}</p>
          ),
          sections: pending,
        }}
      />
    </div>
  );
}
