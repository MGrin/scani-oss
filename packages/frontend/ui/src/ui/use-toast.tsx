import * as React from 'react';
import { uiT } from '../i18n';
import { userFacingMessage } from '../lib/user-facing-error';
import { ToastAction, type ToastActionElement, type ToastProps } from './toast';

const TOAST_LIMIT = 1;
// Default time a toast stays visible before auto-dismiss (ms).
const DEFAULT_TOAST_DURATION = 5_000;
// Errors carry actionable info + a "View Details" action — give them longer.
const DEFAULT_ERROR_DURATION = 10_000;
// Delay between closing a toast and unmounting it. Must cover the
// `data-[state=closed]` exit animation in toast.tsx.
const TOAST_ANIMATION_DURATION = 300;

type ToasterToast = ToastProps & {
  id: string;
  title?: React.ReactNode;
  description?: React.ReactNode;
  action?: ToastActionElement;
  duration?: number;
};

const actionTypes = {
  ADD_TOAST: 'ADD_TOAST',
  UPDATE_TOAST: 'UPDATE_TOAST',
  DISMISS_TOAST: 'DISMISS_TOAST',
  REMOVE_TOAST: 'REMOVE_TOAST',
} as const;

let count = 0;

function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER;
  return count.toString();
}

type ActionType = typeof actionTypes;

type Action =
  | {
      type: ActionType['ADD_TOAST'];
      toast: ToasterToast;
    }
  | {
      type: ActionType['UPDATE_TOAST'];
      toast: Partial<ToasterToast>;
    }
  | {
      type: ActionType['DISMISS_TOAST'];
      toastId?: ToasterToast['id'];
    }
  | {
      type: ActionType['REMOVE_TOAST'];
      toastId?: ToasterToast['id'];
    };

interface State {
  toasts: ToasterToast[];
}

// Auto-dismiss timers: fire DISMISS_TOAST (flips the toast to `open: false`).
// Owned by our code so the lifecycle is deterministic — unlike Radix's own
// timer, which pauses on pointer-enter / window blur and can therefore leave
// a toast open forever on touch devices and installed PWAs.
const dismissTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
// Removal timers: fire REMOVE_TOAST after the close animation finishes.
const removeTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

const clearDismissTimeout = (toastId: string) => {
  const timeout = dismissTimeouts.get(toastId);
  if (timeout) {
    clearTimeout(timeout);
    dismissTimeouts.delete(toastId);
  }
};

const addToRemoveQueue = (toastId: string) => {
  if (removeTimeouts.has(toastId)) {
    return;
  }

  const timeout = setTimeout(() => {
    removeTimeouts.delete(toastId);
    dispatch({
      type: 'REMOVE_TOAST',
      toastId: toastId,
    });
  }, TOAST_ANIMATION_DURATION);

  removeTimeouts.set(toastId, timeout);
};

export const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case 'ADD_TOAST':
      return {
        ...state,
        toasts: [action.toast, ...state.toasts].slice(0, TOAST_LIMIT),
      };

    case 'UPDATE_TOAST':
      return {
        ...state,
        toasts: state.toasts.map((t) => (t.id === action.toast.id ? { ...t, ...action.toast } : t)),
      };

    case 'DISMISS_TOAST': {
      const { toastId } = action;

      // ! Side effects ! - This could be extracted into a dismissToast() action,
      // but I'll keep it here for simplicity
      if (toastId) {
        addToRemoveQueue(toastId);
      } else {
        state.toasts.forEach((toast) => {
          addToRemoveQueue(toast.id);
        });
      }

      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === toastId || toastId === undefined
            ? {
                ...t,
                open: false,
              }
            : t
        ),
      };
    }
    case 'REMOVE_TOAST':
      if (action.toastId === undefined) {
        return {
          ...state,
          toasts: [],
        };
      }
      return {
        ...state,
        toasts: state.toasts.filter((t) => t.id !== action.toastId),
      };
  }
};

const listeners: Array<(state: State) => void> = [];

let memoryState: State = { toasts: [] };

function dispatch(action: Action) {
  memoryState = reducer(memoryState, action);
  listeners.forEach((listener) => {
    listener(memoryState);
  });
}

type Toast = Omit<ToasterToast, 'id'>;

function toast({ duration, ...props }: Toast) {
  const id = genId();
  const resolvedDuration = duration ?? DEFAULT_TOAST_DURATION;

  const update = (props: ToasterToast) =>
    dispatch({
      type: 'UPDATE_TOAST',
      toast: { ...props, id },
    });
  const dismiss = () => {
    clearDismissTimeout(id);
    dispatch({ type: 'DISMISS_TOAST', toastId: id });
  };

  // TOAST_LIMIT is 1 — the toast we're adding evicts any current one. Clear
  // the evicted toast's pending auto-dismiss timer so it can't fire later.
  for (const existing of memoryState.toasts) {
    clearDismissTimeout(existing.id);
  }

  dispatch({
    type: 'ADD_TOAST',
    toast: {
      ...props,
      id,
      duration: resolvedDuration,
      open: true,
      onOpenChange: (open: boolean) => {
        if (!open) dismiss();
      },
    },
  });

  // Code-owned auto-dismiss. `duration: 0` / `Infinity` keeps the toast sticky.
  if (Number.isFinite(resolvedDuration) && resolvedDuration > 0) {
    const timeout = setTimeout(() => {
      dismissTimeouts.delete(id);
      dispatch({ type: 'DISMISS_TOAST', toastId: id });
    }, resolvedDuration);
    dismissTimeouts.set(id, timeout);
  }

  return {
    id: id,
    dismiss,
    update,
  };
}

function useToast() {
  const [state, setState] = React.useState<State>(memoryState);

  React.useEffect(() => {
    listeners.push(setState);
    return () => {
      const index = listeners.indexOf(setState);
      if (index > -1) {
        listeners.splice(index, 1);
      }
    };
  }, []);

  return {
    ...state,
    toast,
    dismiss: (toastId?: string) => {
      if (toastId) {
        clearDismissTimeout(toastId);
      } else {
        for (const t of memoryState.toasts) clearDismissTimeout(t.id);
      }
      dispatch({ type: 'DISMISS_TOAST', toastId });
    },
  };
}

interface ToastOptions {
  duration?: number;
}

/**
 * `uiT` rather than `useTranslation`: these are called from mutation callbacks,
 * outside React and outside any render, so there is no hook to hang them off —
 * which is the reason `@scani/ui`'s i18next instance is initialised eagerly at
 * module load rather than behind a provider (see `../i18n`).
 *
 * `context` is still an English string supplied by the caller, and stays one.
 * It is a noun phrase spliced into `{{context}}: {{message}}` beside a raw
 * server error, so translating it alone produces a French fragment in front of
 * an English one. Retiring it means giving `showError` a key instead of a
 * phrase at ~30 call sites, which is SC-235's restructuring, not this wiring.
 */
function showError(error: unknown, context?: string, options?: ToastOptions) {
  // Only a message somebody wrote for a reader (SC-311). This is the DEFAULT
  // error surface — ~130 call sites — so `error.message` here meant every
  // assertion in v3 and every dependency's diagnostic was a user-facing,
  // untranslatable string. `userFacingMessage` also fixes the opposite half:
  // a plain string used to fall through to "Unknown error", silently
  // discarding eight call sites' deliberate, already-translated copy.
  const message = userFacingMessage(error) ?? uiT('ui.toast.unknownError');
  toast({
    title: uiT('ui.toast.errorTitle'),
    description: context ? uiT('ui.toast.detail', { context, message }) : message,
    variant: 'destructive',
    duration: options?.duration ?? DEFAULT_ERROR_DURATION,
    // `ToastAction`, not `<Button variant="outline">`. The outline button
    // paints `bg-background` and takes its text colour from the toast, which
    // is `text-destructive-foreground` — white on white in the light theme and
    // near-black on near-black in v3's dark theme, i.e. a blank rectangle with
    // an accessible name and no visible label (SC-64). `ToastAction` is
    // transparent and carries the `group-[.destructive]` rules that solve its
    // border and hover against the destructive surface.
    action: (
      <ToastAction
        altText={uiT('ui.toast.viewDetailsAlt')}
        onClick={() => console.error('Error details:', error)}
      >
        {uiT('ui.toast.viewDetails')}
      </ToastAction>
    ),
  });
}

function showSuccess(message: string, context?: string, options?: ToastOptions) {
  toast({
    title: context || uiT('ui.toast.successTitle'),
    description: message,
    variant: 'default',
    duration: options?.duration ?? DEFAULT_TOAST_DURATION,
  });
}

export { showError, showSuccess, toast, useToast };
