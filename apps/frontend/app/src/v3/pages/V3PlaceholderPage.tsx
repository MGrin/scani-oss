import { UiVersionSwitch } from '../components/UiVersionSwitch';

/**
 * The only v3 route until the first real surface lands. It exists so the
 * shell, the switch and the `/v3` mount can ship — and be verified in
 * production — before any of the redesign does.
 */
export function V3PlaceholderPage() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 px-4 py-16 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">The new Scani is being built</h1>
      <p className="text-muted-foreground">
        Nothing lives here yet. Screens will land one at a time; the classic interface keeps working
        throughout.
      </p>
      <UiVersionSwitch
        variant="row"
        className="w-auto justify-center border border-border px-3 py-2 text-sm"
      />
    </div>
  );
}
