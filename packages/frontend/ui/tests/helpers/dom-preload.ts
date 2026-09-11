import { GlobalRegistrator } from '@happy-dom/global-registrator';

/**
 * The DOM for `*.dom.tsx` specs, preloaded ONLY into the child process
 * `dom-specs.ts` starts (SC-801). Never add this to the root `test` script:
 * see `dom-specs.ts` for why the DOM has to exist before any module loads,
 * and why that cannot be true inside the main run.
 */
GlobalRegistrator.register();
// React warns on every update outside `act` unless this is set.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
