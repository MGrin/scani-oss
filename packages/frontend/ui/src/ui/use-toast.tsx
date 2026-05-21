import * as React from 'react';
import { Button } from './button';
import type { ToastActionElement, ToastProps } from './toast';

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

function showError(error: unknown, context?: string, options?: ToastOptions) {
  const message = error instanceof Error ? error.message : 'Unknown error';
  toast({
    title: 'Something went wrong',
    description: `${context ? `${context}: ` : ''}${message}`,
    variant: 'destructive',
    duration: options?.duration ?? DEFAULT_ERROR_DURATION,
    action: (
      <Button variant="outline" size="sm" onClick={() => console.error('Error details:', error)}>
        View Details
      </Button>
    ),
  });
}

function showSuccess(message: string, context?: string, options?: ToastOptions) {
  toast({
    title: context || 'Success',
    description: message,
    variant: 'default',
    duration: options?.duration ?? DEFAULT_TOAST_DURATION,
  });
}

export { showError, showSuccess, toast, useToast };
