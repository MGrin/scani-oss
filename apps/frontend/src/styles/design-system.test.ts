import { describe, expect, test } from 'bun:test';
import {
  colorSystem,
  cssClasses,
  designSystem,
  getBorderRadius,
  getCssCustomProperties,
  getDesignToken,
  getFontSize,
  getShadow,
  getSpacing,
  layoutSystem,
  messageSystem,
} from './design-system';

describe('Design System - Core Tokens', () => {
  test('typography scale contains expected sizes', () => {
    expect(designSystem.typography.sizes.xs).toBe('0.75rem');
    expect(designSystem.typography.sizes.sm).toBe('0.875rem');
    expect(designSystem.typography.sizes.base).toBe('1rem');
    expect(designSystem.typography.sizes.lg).toBe('1.125rem');
    expect(designSystem.typography.sizes.xl).toBe('1.25rem');
    expect(designSystem.typography.sizes['2xl']).toBe('1.5rem');
    expect(designSystem.typography.sizes['3xl']).toBe('1.875rem');
    expect(designSystem.typography.sizes['4xl']).toBe('2.25rem');
    expect(designSystem.typography.sizes['5xl']).toBe('3rem');
    expect(designSystem.typography.sizes['6xl']).toBe('3.75rem');
    expect(designSystem.typography.sizes['7xl']).toBe('4.5rem');
  });

  test('font families contain expected values', () => {
    expect(designSystem.typography.fonts.sans).toEqual(['Inter', 'system-ui', 'sans-serif']);
    expect(designSystem.typography.fonts.mono).toEqual([
      'JetBrains Mono',
      'Menlo',
      'Monaco',
      'Consolas',
      'monospace',
    ]);
    expect(designSystem.typography.fonts.display).toEqual([
      'Cal Sans',
      'Inter',
      'system-ui',
      'sans-serif',
    ]);
  });

  test('spacing scale follows consistent pattern', () => {
    expect(designSystem.spacing[0]).toBe('0');
    expect(designSystem.spacing[1]).toBe('0.25rem');
    expect(designSystem.spacing[2]).toBe('0.5rem');
    expect(designSystem.spacing[4]).toBe('1rem');
    expect(designSystem.spacing[8]).toBe('2rem');
    expect(designSystem.spacing[16]).toBe('4rem');
    expect(designSystem.spacing[32]).toBe('8rem');
    expect(designSystem.spacing[64]).toBe('16rem');
    expect(designSystem.spacing.px).toBe('1px');
  });

  test('border radius values are consistent', () => {
    expect(designSystem.borderRadius.none).toBe('0');
    expect(designSystem.borderRadius.sm).toBe('0.125rem');
    expect(designSystem.borderRadius.default).toBe('0.25rem');
    expect(designSystem.borderRadius.md).toBe('0.375rem');
    expect(designSystem.borderRadius.lg).toBe('0.5rem');
    expect(designSystem.borderRadius.xl).toBe('0.75rem');
    expect(designSystem.borderRadius['2xl']).toBe('1rem');
    expect(designSystem.borderRadius['3xl']).toBe('1.5rem');
    expect(designSystem.borderRadius.full).toBe('9999px');
  });

  test('shadow values are properly defined', () => {
    expect(designSystem.shadows.sm).toContain('0 1px 2px');
    expect(designSystem.shadows.default).toContain('0 1px 3px');
    expect(designSystem.shadows.md).toContain('0 4px 6px');
    expect(designSystem.shadows.lg).toContain('0 10px 15px');
    expect(designSystem.shadows.xl).toContain('0 20px 25px');
    expect(designSystem.shadows['2xl']).toContain('0 25px 50px');
    expect(designSystem.shadows.inner).toContain('inset');
    expect(designSystem.shadows.none).toBe('none');
  });

  test('z-index scale provides appropriate layering', () => {
    expect(designSystem.zIndex.auto).toBe('auto');
    expect(designSystem.zIndex[0]).toBe('0');
    expect(designSystem.zIndex.dropdown).toBe('1000');
    expect(designSystem.zIndex.sticky).toBe('1020');
    expect(designSystem.zIndex.fixed).toBe('1030');
    expect(designSystem.zIndex.modalBackdrop).toBe('1040');
    expect(designSystem.zIndex.modal).toBe('1050');
    expect(designSystem.zIndex.popover).toBe('1060');
    expect(designSystem.zIndex.tooltip).toBe('1070');
    expect(designSystem.zIndex.notification).toBe('1080');
    expect(designSystem.zIndex.max).toBe('9999');

    // Verify proper ordering
    expect(Number(designSystem.zIndex.dropdown)).toBeLessThan(Number(designSystem.zIndex.modal));
    expect(Number(designSystem.zIndex.modalBackdrop)).toBeLessThan(
      Number(designSystem.zIndex.modal)
    );
    expect(Number(designSystem.zIndex.modal)).toBeLessThan(Number(designSystem.zIndex.tooltip));
  });

  test('animation durations provide good UX timing', () => {
    expect(designSystem.animations.fastest).toBe('50ms');
    expect(designSystem.animations.fast).toBe('100ms');
    expect(designSystem.animations.normal).toBe('150ms');
    expect(designSystem.animations.slow).toBe('300ms');
    expect(designSystem.animations.slower).toBe('500ms');
    expect(designSystem.animations.slowest).toBe('1000ms');
  });

  test('breakpoints match common responsive patterns', () => {
    expect(designSystem.breakpoints.sm).toBe('640px');
    expect(designSystem.breakpoints.md).toBe('768px');
    expect(designSystem.breakpoints.lg).toBe('1024px');
    expect(designSystem.breakpoints.xl).toBe('1280px');
    expect(designSystem.breakpoints['2xl']).toBe('1536px');
  });
});

describe('Design System - Component Tokens', () => {
  test('button specifications provide consistent sizing', () => {
    expect(designSystem.components.button.heights.sm).toBe('2rem');
    expect(designSystem.components.button.heights.default).toBe('2.5rem');
    expect(designSystem.components.button.heights.lg).toBe('3rem');
    expect(designSystem.components.button.heights.xl).toBe('3.5rem');

    expect(designSystem.components.button.padding.sm).toBe('0.5rem 0.75rem');
    expect(designSystem.components.button.padding.default).toBe('0.5rem 1rem');
    expect(designSystem.components.button.padding.lg).toBe('0.75rem 1.5rem');
    expect(designSystem.components.button.padding.xl).toBe('1rem 2rem');
  });

  test('input specifications match button patterns', () => {
    expect(designSystem.components.input.heights.sm).toBe('2rem');
    expect(designSystem.components.input.heights.default).toBe('2.5rem');
    expect(designSystem.components.input.heights.lg).toBe('3rem');

    expect(designSystem.components.input.padding.sm).toBe('0.375rem 0.75rem');
    expect(designSystem.components.input.padding.default).toBe('0.5rem 0.75rem');
    expect(designSystem.components.input.padding.lg).toBe('0.75rem 1rem');
  });

  test('card specifications provide consistent padding', () => {
    expect(designSystem.components.card.padding.sm).toBe('1rem');
    expect(designSystem.components.card.padding.default).toBe('1.5rem');
    expect(designSystem.components.card.padding.lg).toBe('2rem');
    expect(designSystem.components.card.padding.xl).toBe('3rem');
  });

  test('modal sizes provide flexible options', () => {
    expect(designSystem.components.modal.sizes.xs).toBe('20rem');
    expect(designSystem.components.modal.sizes.sm).toBe('24rem');
    expect(designSystem.components.modal.sizes.default).toBe('32rem');
    expect(designSystem.components.modal.sizes.lg).toBe('42rem');
    expect(designSystem.components.modal.sizes.xl).toBe('48rem');
    expect(designSystem.components.modal.sizes.full).toBe('100vw');
  });
});

describe('Design System - Utility Functions', () => {
  test('getSpacing returns correct spacing values', () => {
    expect(getSpacing('0')).toBe('0');
    expect(getSpacing('4')).toBe('1rem');
    expect(getSpacing('8')).toBe('2rem');
    expect(getSpacing('px')).toBe('1px');
  });

  test('getFontSize returns correct typography sizes', () => {
    expect(getFontSize('xs')).toBe('0.75rem');
    expect(getFontSize('sm')).toBe('0.875rem');
    expect(getFontSize('base')).toBe('1rem');
    expect(getFontSize('lg')).toBe('1.125rem');
    expect(getFontSize('2xl')).toBe('1.5rem');
  });

  test('getShadow returns correct shadow values', () => {
    expect(getShadow('sm')).toContain('0 1px 2px');
    expect(getShadow('default')).toContain('0 1px 3px');
    expect(getShadow('none')).toBe('none');
  });

  test('getBorderRadius returns correct border radius values', () => {
    expect(getBorderRadius('none')).toBe('0');
    expect(getBorderRadius('sm')).toBe('0.125rem');
    expect(getBorderRadius('default')).toBe('0.25rem');
    expect(getBorderRadius('lg')).toBe('0.5rem');
    expect(getBorderRadius('full')).toBe('9999px');
  });

  test('getDesignToken navigates object path correctly', () => {
    expect(getDesignToken('typography.sizes.base')).toBe('1rem');
    expect(getDesignToken('spacing.4')).toBe('1rem');
    expect(getDesignToken('shadows.md')).toContain('0 4px 6px');
    expect(getDesignToken('components.button.heights.default')).toBe('2.5rem');
  });

  test('getDesignToken handles invalid paths', () => {
    // Mock console.warn to check if it's called
    const originalWarn = console.warn;
    let warnMessage = '';
    console.warn = (message: string) => {
      warnMessage = message;
    };

    expect(getDesignToken('invalid.path.here')).toBeUndefined();
    expect(warnMessage).toContain('Design token not found: invalid.path.here');

    // Restore original console.warn
    console.warn = originalWarn;
  });

  test('getCssCustomProperties generates correct CSS variables', () => {
    const properties = getCssCustomProperties();

    expect(properties).toHaveProperty('--primary');
    expect(properties).toHaveProperty('--primary-foreground');
    expect(properties).toHaveProperty('--secondary');
    expect(properties).toHaveProperty('--background');
    expect(properties).toHaveProperty('--foreground');
    expect(properties).toHaveProperty('--destructive');
    expect(properties).toHaveProperty('--success');
    expect(properties).toHaveProperty('--warning');
    expect(properties).toHaveProperty('--info');

    // Check that values match semantic color system
    expect(properties['--primary']).toBe(colorSystem.semantic.primary);
    expect(properties['--background']).toBe(colorSystem.semantic.background);
  });
});

describe('CSS Classes Utilities', () => {
  test('text utilities contain correct font sizes', () => {
    expect(cssClasses.text.xs.fontSize).toBe('0.75rem');
    expect(cssClasses.text.base.fontSize).toBe('1rem');
    expect(cssClasses.text.lg.fontSize).toBe('1.125rem');
    expect(cssClasses.text['2xl'].fontSize).toBe('1.5rem');
  });

  test('spacing utilities provide consistent values', () => {
    expect(cssClasses.spacing['4'].padding).toBe('1rem');
    expect(cssClasses.spacing['4'].margin).toBe('1rem');
    expect(cssClasses.spacing['4'].gap).toBe('1rem');
    expect(cssClasses.spacing['8'].padding).toBe('2rem');
  });

  test('shadow utilities map correctly', () => {
    expect(cssClasses.shadow.sm.boxShadow).toContain('0 1px 2px');
    expect(cssClasses.shadow.default.boxShadow).toContain('0 1px 3px');
    expect(cssClasses.shadow.lg.boxShadow).toContain('0 10px 15px');
  });
});

describe('Message System', () => {
  test('success messages are consistently formatted', () => {
    expect(messageSystem.success.create.institution).toMatch(/^✅.*successfully$/);
    expect(messageSystem.success.create.account).toMatch(/^✅.*successfully$/);
    expect(messageSystem.success.update.settings).toMatch(/^✅.*successfully$/);
    expect(messageSystem.success.delete.transaction).toMatch(/^✅.*successfully$/);
  });

  test('error messages have appropriate tone', () => {
    expect(messageSystem.error.network).toMatch(/^❌/);
    expect(messageSystem.error.server).toMatch(/^❌/);
    expect(messageSystem.error.validation).toMatch(/^❌/);
    expect(messageSystem.error.create.institution).toMatch(/^❌.*Failed/);
  });

  test('warning messages indicate caution', () => {
    expect(messageSystem.warning.unsavedChanges).toMatch(/^⚠️/);
    expect(messageSystem.warning.dataLoss).toMatch(/^⚠️/);
    expect(messageSystem.warning.irreversible).toMatch(/^⚠️/);
    expect(messageSystem.warning.duplicateName).toMatch(/^⚠️/);
  });

  test('info messages provide helpful context', () => {
    expect(messageSystem.info.loading).toMatch(/^ℹ️/);
    expect(messageSystem.info.syncing).toMatch(/^ℹ️/);
    expect(messageSystem.info.offline).toMatch(/^ℹ️/);
    expect(messageSystem.info.noData).toMatch(/^ℹ️/);
  });

  test('confirmation messages ask clear questions', () => {
    expect(messageSystem.confirmation.delete.institution).toMatch(/^Are you sure/);
    expect(messageSystem.confirmation.delete.account).toMatch(/^Are you sure/);
    expect(messageSystem.confirmation.discard).toMatch(/^Are you sure/);
    expect(messageSystem.confirmation.reset).toMatch(/^Are you sure/);
  });
});

describe('Color System', () => {
  test('semantic colors use CSS custom properties', () => {
    expect(colorSystem.semantic.primary).toBe('hsl(var(--primary))');
    expect(colorSystem.semantic.background).toBe('hsl(var(--background))');
    expect(colorSystem.semantic.destructive).toBe('hsl(var(--destructive))');
    expect(colorSystem.semantic.success).toBe('hsl(var(--success))');
  });

  test('status colors provide appropriate variants', () => {
    const statusTypes = ['success', 'error', 'warning', 'info'] as const;

    statusTypes.forEach((type) => {
      const status = colorSystem.status[type];
      expect(status).toHaveProperty('bg');
      expect(status).toHaveProperty('text');
      expect(status).toHaveProperty('border');
      expect(status).toHaveProperty('icon');

      // Check that background colors follow dark mode pattern
      expect(status.bg).toMatch(/bg-\\w+-\\d+.*dark:bg-\\w+-\\d+/);
      expect(status.text).toMatch(/text-\\w+-\\d+.*dark:text-\\w+-\\d+/);
      expect(status.border).toMatch(/border-\\w+-\\d+.*dark:border-\\w+-\\d+/);
    });
  });

  test('status colors use semantic color names', () => {
    expect(colorSystem.status.success.bg).toContain('green');
    expect(colorSystem.status.error.bg).toContain('red');
    expect(colorSystem.status.warning.bg).toContain('amber');
    expect(colorSystem.status.info.bg).toContain('blue');
  });
});

describe('Layout System', () => {
  test('container sizes follow responsive pattern', () => {
    expect(layoutSystem.container.sm).toBe('max-w-screen-sm');
    expect(layoutSystem.container.md).toBe('max-w-screen-md');
    expect(layoutSystem.container.lg).toBe('max-w-screen-lg');
    expect(layoutSystem.container.xl).toBe('max-w-screen-xl');
    expect(layoutSystem.container['2xl']).toBe('max-w-screen-2xl');
    expect(layoutSystem.container.full).toBe('max-w-full');
  });

  test('grid columns provide common layouts', () => {
    expect(layoutSystem.grid.cols1).toBe('grid-cols-1');
    expect(layoutSystem.grid.cols2).toBe('grid-cols-2');
    expect(layoutSystem.grid.cols3).toBe('grid-cols-3');
    expect(layoutSystem.grid.cols4).toBe('grid-cols-4');
    expect(layoutSystem.grid.cols6).toBe('grid-cols-6');
    expect(layoutSystem.grid.cols12).toBe('grid-cols-12');
  });

  test('gap utilities provide consistent spacing', () => {
    expect(layoutSystem.gaps.none).toBe('gap-0');
    expect(layoutSystem.gaps.sm).toBe('gap-2');
    expect(layoutSystem.gaps.default).toBe('gap-4');
    expect(layoutSystem.gaps.md).toBe('gap-6');
    expect(layoutSystem.gaps.lg).toBe('gap-8');
    expect(layoutSystem.gaps.xl).toBe('gap-12');
  });
});

describe('Design System Integration', () => {
  test('spacing values align across different scales', () => {
    // Button padding should use spacing scale values
    const buttonPadding = designSystem.components.button.padding.default; // '0.5rem 1rem'
    expect(buttonPadding).toContain(designSystem.spacing[2]); // 0.5rem
    expect(buttonPadding).toContain(designSystem.spacing[4]); // 1rem
  });

  test('font sizes maintain readable hierarchy', () => {
    const sizes = Object.values(designSystem.typography.sizes).map((size) => parseFloat(size));

    // Each size should be larger than the previous
    for (let i = 1; i < sizes.length; i++) {
      expect(sizes[i]).toBeGreaterThan(sizes[i - 1]);
    }
  });

  test('component tokens reference base tokens', () => {
    // Button heights should align with spacing scale where reasonable
    expect(designSystem.components.button.heights.sm).toBe('2rem'); // 32px = spacing[8]
    expect(designSystem.components.button.heights.default).toBe('2.5rem'); // 40px = spacing[10]
  });

  test('shadow and border radius work together harmoniously', () => {
    // Default shadow should pair well with default border radius
    expect(designSystem.shadows.default).toBeDefined();
    expect(designSystem.borderRadius.default).toBeDefined();
    expect(designSystem.borderRadius.default).not.toBe('0');
    expect(designSystem.shadows.default).not.toBe('none');
  });
});
