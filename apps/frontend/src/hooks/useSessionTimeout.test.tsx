import { describe, expect, it } from 'bun:test';
import { act, renderHook } from '@testing-library/react';
import { useSessionTimeout } from './useSessionTimeout';

describe('useSessionTimeout', () => {
  it('should initialize with active session', () => {
    const { result } = renderHook(() => useSessionTimeout());

    expect(result.current.isActive).toBe(true);
    expect(result.current.showWarning).toBe(false);
    expect(result.current.remainingTime).toBe(30 * 60); // 30 minutes default
    expect(typeof result.current.extendSession).toBe('function');
    expect(typeof result.current.logout).toBe('function');
    expect(typeof result.current.formatRemainingTime).toBe('function');
  });

  it('should handle custom configuration', () => {
    const config = {
      timeoutMinutes: 15,
      warningMinutes: 3,
      checkIntervalSeconds: 10,
      activities: ['click', 'keydown'],
    };

    const { result } = renderHook(() => useSessionTimeout(config));

    expect(result.current.config).toEqual(config);
    expect(result.current.remainingTime).toBe(15 * 60);
  });

  it('should logout manually', () => {
    const { result } = renderHook(() => useSessionTimeout());

    expect(result.current.isActive).toBe(true);

    act(() => {
      result.current.logout();
    });

    expect(result.current.isActive).toBe(false);
    expect(result.current.remainingTime).toBe(0);
    expect(result.current.showWarning).toBe(false);
  });

  it('should format remaining time correctly', () => {
    const { result } = renderHook(() => useSessionTimeout({ timeoutMinutes: 5 }));

    // Check initial format (5 minutes = 300 seconds)
    expect(result.current.formatRemainingTime()).toBe('5m 0s');
  });

  it('should extend session when requested', () => {
    const { result } = renderHook(() => useSessionTimeout({ timeoutMinutes: 5 }));

    // Extend session should reset warning state
    act(() => {
      result.current.extendSession();
    });

    expect(result.current.remainingTime).toBe(5 * 60);
    expect(result.current.showWarning).toBe(false);
  });

  it('should provide warning message when appropriate', () => {
    const { result } = renderHook(() =>
      useSessionTimeout({ timeoutMinutes: 10, warningMinutes: 5 })
    );

    // Initially no warning
    expect(result.current.warningMessage).toBeNull();
  });
});
