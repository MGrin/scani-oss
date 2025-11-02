/**
 * SVG Icon Component API Contract
 * 
 * This file defines the public API contract for the SvgIcon component.
 * Changes to this contract constitute breaking changes and require version bump.
 * 
 * @module SvgIcon
 * @version 1.0.0
 */

import type { FC } from "react";
import type { StyleProp, ViewStyle } from "react-native";

/**
 * Valid icon names from the registry.
 * This type is automatically generated from the registry object.
 * 
 * @example "scani-logo"
 * 
 * Current icons:
 * - "scani-logo": Scani application logo
 * 
 * @see registry.ts for complete list
 */
export type SvgIconTypes = keyof typeof svgIconRegistry;

/**
 * Component props for SvgIcon.
 * 
 * @interface SvgIconProps
 */
export interface SvgIconProps {
  /**
   * The name of the icon from the registry.
   * Type-safe - only accepts valid icon names.
   * 
   * @required
   * @example "scani-logo"
   */
  name: SvgIconTypes;

  /**
   * Size of the icon in points (both width and height).
   * 
   * @optional
   * @default 24
   * @example 48
   */
  size?: number;

  /**
   * Color to apply to the icon.
   * Accepts any valid CSS color string.
   * 
   * @optional
   * @default theme.colors.text
   * @example "#667eea"
   * @example "rgb(102, 126, 234)"
   */
  color?: string;

  /**
   * Array of colors for gradient fill.
   * When provided, icon will render with gradient instead of solid color.
   * Requires at least 2 colors for valid gradient.
   * 
   * @optional
   * @example ["#667eea", "#764ba2"]
   */
  gradientColors?: string[];

  /**
   * Starting point for gradient (normalized coordinates).
   * 
   * @optional
   * @default { x: 0, y: 0 }
   * @example { x: 0, y: 0 } // Top-left
   * @example { x: 0.5, y: 0 } // Top-center
   */
  gradientStart?: { x: number; y: number };

  /**
   * Ending point for gradient (normalized coordinates).
   * 
   * @optional
   * @default { x: 1, y: 1 }
   * @example { x: 1, y: 1 } // Bottom-right
   * @example { x: 1, y: 0 } // Top-right (horizontal gradient)
   */
  gradientEnd?: { x: number; y: number };

  /**
   * Style overrides for the SVG component itself.
   * 
   * @optional
   * @example { opacity: 0.8 }
   */
  style?: StyleProp<ViewStyle>;

  /**
   * Style overrides for the container View wrapping the icon.
   * 
   * @optional
   * @example { marginRight: 8 }
   */
  containerStyle?: StyleProp<ViewStyle>;
}

/**
 * SvgIcon functional component.
 * Renders an SVG icon from the registry with configurable size, color, and gradients.
 * 
 * @component
 * @param props - Component props
 * @returns React element or null if icon not found
 * 
 * @example
 * // Basic usage with default size and theme color
 * <SvgIcon name="scani-logo" />
 * 
 * @example
 * // Custom size and color
 * <SvgIcon name="scani-logo" size={96} color="#667eea" />
 * 
 * @example
 * // Gradient fill
 * <SvgIcon
 *   name="scani-logo"
 *   size={120}
 *   gradientColors={["#667eea", "#764ba2"]}
 *   gradientStart={{ x: 0, y: 0 }}
 *   gradientEnd={{ x: 1, y: 1 }}
 * />
 * 
 * @example
 * // With container styling
 * <SvgIcon
 *   name="scani-logo"
 *   size={48}
 *   containerStyle={{ marginBottom: 16 }}
 * />
 */
export const SvgIcon: FC<SvgIconProps>;

/**
 * Icon registry object mapping icon names to SVG components.
 * Do not import directly - use SvgIcon component instead.
 * 
 * @internal
 */
export const svgIconRegistry: Record<string, React.FC<any>>;

/**
 * Behavioral Contracts
 * ====================
 * 
 * 1. NULL HANDLING
 *    - When icon name doesn't exist in registry: Returns null (no crash)
 *    - When icon name is undefined: TypeScript error (compile-time safety)
 * 
 * 2. COLOR RESOLUTION
 *    - Priority: Explicit color prop > theme.colors.text
 *    - Gradient path: color prop ignored when gradientColors provided
 *    - Invalid color: SVG library defaults to black (no crash)
 * 
 * 3. SIZE HANDLING
 *    - Negative size: Renders nothing (React Native behavior)
 *    - Zero size: Renders nothing
 *    - NaN: Renders nothing
 *    - Fractional size: Allowed, React Native handles sub-pixel rendering
 * 
 * 4. GRADIENT VALIDATION
 *    - Empty gradientColors array: Falls back to solid color path
 *    - Single color in array: Linear gradient treats as solid color
 *    - No gradientStart/End: Uses defaults ({ x: 0, y: 0 } to { x: 1, y: 1 })
 * 
 * 5. PERFORMANCE
 *    - Icon lookup: O(1) constant time
 *    - Re-renders: Only when props change
 *    - Memory: Stable - registry doesn't grow at runtime
 * 
 * 6. ACCESSIBILITY
 *    - No explicit accessibility props (future enhancement)
 *    - Icons are decorative by default
 *    - For semantic icons, wrap in accessible parent
 * 
 * 7. THEME INTEGRATION
 *    - Subscribes to theme context for default color
 *    - Theme changes trigger re-render only if using default color
 *    - Explicit color prop bypasses theme
 */

/**
 * Breaking Change Policy
 * ======================
 * 
 * MAJOR version bump required for:
 * - Removing or renaming props
 * - Changing default behavior
 * - Removing icons from registry
 * - Changing component return type
 * 
 * MINOR version bump required for:
 * - Adding new optional props
 * - Adding new icons to registry
 * - Performance optimizations (backward compatible)
 * 
 * PATCH version bump required for:
 * - Bug fixes
 * - Documentation updates
 * - Internal refactoring (no API changes)
 */

/**
 * Error Handling
 * ==============
 * 
 * The component is designed to NEVER throw errors:
 * 
 * 1. Missing icon: Returns null
 * 2. Invalid props: React Native handles gracefully
 * 3. Theme not available: Falls back to black
 * 4. Gradient libraries not available: Falls back to solid color
 * 
 * TypeScript provides compile-time safety for:
 * - Invalid icon names
 * - Missing required props
 * - Type mismatches
 */

/**
 * Registry Extension Guidelines
 * =============================
 * 
 * When adding new icons:
 * 
 * 1. Add SVG file to apps/mobile/assets/images/ or assets/icons/
 * 2. Optimize with SVGO (remove unnecessary attributes)
 * 3. Ensure viewBox attribute exists
 * 4. Remove hardcoded width/height attributes
 * 5. Import in registry.ts
 * 6. Add to svgIconRegistry object with kebab-case key
 * 7. SvgIconTypes type updates automatically
 * 8. Document new icon in this file's SvgIconTypes JSDoc
 * 
 * Example:
 * 
 * ```typescript
 * // registry.ts
 * import NewIcon from "@/assets/icons/new-icon.svg";
 * 
 * export const svgIconRegistry = {
 *   "scani-logo": ScaniLogo,
 *   "new-icon": NewIcon, // ← Add here
 * } as const;
 * ```
 */

/**
 * Version History
 * ===============
 * 
 * 1.0.0 (November 2, 2025)
 * - Initial implementation
 * - Support for solid color icons
 * - Support for gradient fills via MaskedView
 * - Theme integration for default color
 * - First icon: scani-logo
 */

