import { useEffect, useState } from 'react';
import { BREAKPOINTS } from '../lib/constants';

interface ResponsiveState {
  isMobile: boolean; // < 768px
  isTablet: boolean; // 768-1023px
  isDesktop: boolean; // >= 1024px
  width: number;
}

export function useResponsive(): ResponsiveState {
  const [state, setState] = useState<ResponsiveState>(() => {
    const w = typeof window !== 'undefined' ? window.innerWidth : 1024;
    return {
      isMobile: w < BREAKPOINTS.md,
      isTablet: w >= BREAKPOINTS.md && w < BREAKPOINTS.lg,
      isDesktop: w >= BREAKPOINTS.lg,
      width: w,
    };
  });

  useEffect(() => {
    const update = () => {
      const w = window.innerWidth;
      setState({
        isMobile: w < BREAKPOINTS.md,
        isTablet: w >= BREAKPOINTS.md && w < BREAKPOINTS.lg,
        isDesktop: w >= BREAKPOINTS.lg,
        width: w,
      });
    };

    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return state;
}
