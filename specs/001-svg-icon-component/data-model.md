# Phase 1: Data Model & Component Structure

**Feature**: SVG Icon Component with Registry  
**Date**: November 2, 2025  
**Status**: Complete

## Overview

This document defines the component structure, registry schema, and type system for the SVG icon component. There is no persistent data model (no database entities) - all structures are in-memory TypeScript types and runtime objects.

---

## Component Structure

### SvgIcon Component

**File**: `apps/mobile/src/components/SvgIcon/SvgIcon.tsx`

**Purpose**: Reusable component that renders SVG icons from the registry with configurable size, color, and optional gradient fills.

**Props Interface**:

```typescript
export interface SvgIconProps {
  /**
   * The name of the icon from the registry
   * @example "scani-logo"
   */
  name: SvgIconTypes;

  /**
   * An optional size for the icon. If not provided, defaults to 24.
   * @default 24
   */
  size?: number;

  /**
   * An optional tint color for the icon.
   * If not provided, uses theme.colors.text
   */
  color?: string;

  /**
   * An optional array of gradient colors for the icon.
   * If provided, the icon will be rendered with a gradient fill instead of solid color.
   * Requires at least 2 colors.
   * @example ["#667eea", "#764ba2"]
   */
  gradientColors?: string[];

  /**
   * Gradient start coordinates (default: { x: 0, y: 0 })
   * Only used when gradientColors is provided
   */
  gradientStart?: { x: number; y: number };

  /**
   * Gradient end coordinates (default: { x: 1, y: 1 })
   * Only used when gradientColors is provided
   */
  gradientEnd?: { x: number; y: number };

  /**
   * Style overrides for the SVG component itself
   */
  style?: StyleProp<ViewStyle>;

  /**
   * Style overrides for the icon container View
   */
  containerStyle?: StyleProp<ViewStyle>;
}
```

**Component Signature**:

```typescript
export const SvgIcon: FC<SvgIconProps>
```

**Behavior**:

1. **Icon Lookup**: Retrieves SVG component from registry using `name` prop
2. **Null Handling**: Returns `null` if icon name doesn't exist (graceful failure)
3. **Color Resolution**: Uses explicit `color` prop, falls back to `theme.colors.text`
4. **Gradient Rendering**: If `gradientColors` provided and non-empty:
   - Wraps icon in `MaskedView` with `LinearGradient` fill
   - Uses `gradientStart` and `gradientEnd` for gradient direction
5. **Solid Color Rendering**: Default path, renders SVG directly with color prop
6. **Sizing**: Applies `size` to both width and height of SVG (square aspect ratio)

**Error Handling**:

- Missing icon: Returns `null`, no error thrown
- Invalid size: React Native handles negative/NaN values (renders nothing)
- Invalid colors: SVG library falls back to black
- Empty gradientColors: Falls back to solid color rendering

---

## Registry Structure

### Icon Registry Object

**File**: `apps/mobile/src/components/SvgIcon/registry.ts`

**Purpose**: Centralized mapping of icon names to imported SVG components. Provides type safety for icon names throughout the app.

**Schema**:

```typescript
import ScaniLogo from "@/assets/images/scani-logo.svg";
// Future icons imported here

export const svgIconRegistry = {
  "scani-logo": ScaniLogo,
  // Future icon entries here
} as const;
```

**Type Export**:

```typescript
export type SvgIconTypes = keyof typeof svgIconRegistry;
// Resolves to: "scani-logo" | ... (future icon names)
```

**Properties**:

- **Const Assertion**: `as const` makes registry immutable and enables literal type inference
- **Key Format**: kebab-case strings for icon names (e.g., "scani-logo", "user-profile")
- **Value Type**: React component (SVG transformed by Metro)
- **Type Safety**: `SvgIconTypes` union type provides autocomplete and compile-time validation

**Validation Rules**:

1. Icon names MUST be unique within registry
2. Icon names SHOULD use kebab-case convention
3. SVG files MUST be optimized (use SVGO or similar tool)
4. SVG files SHOULD have viewBox attribute for proper scaling
5. SVG files MUST NOT contain hardcoded width/height attributes

**Growth Pattern**:

```typescript
// Adding new icon:
import NewIcon from "@/assets/icons/new-icon.svg";

export const svgIconRegistry = {
  "scani-logo": ScaniLogo,
  "new-icon": NewIcon, // ← Added here
} as const;

// Type automatically includes "new-icon" in union
```

---

## Type System

### SvgIconTypes (Union Type)

**Purpose**: Type-safe reference to valid icon names

**Generation**: Automatically derived from registry keys via `keyof typeof`

**Usage**:

```typescript
// In component props
interface MyComponentProps {
  icon: SvgIconTypes; // Only accepts valid icon names
}

// In function parameters
function renderIcon(name: SvgIconTypes) {
  return <SvgIcon name={name} />;
}

// Type checking
const validIcon: SvgIconTypes = "scani-logo"; // ✅ OK
const invalidIcon: SvgIconTypes = "nonexistent"; // ❌ TypeScript error
```

**Evolution**: Type automatically expands as new icons are added to registry

---

### SVG Component Type (from react-native-svg-transformer)

**Definition** (in types/svg.d.ts):

```typescript
declare module "*.svg" {
  import React from "react";
  import { SvgProps } from "react-native-svg";
  const content: React.FC<SvgProps>;
  export default content;
}
```

**Purpose**: Tells TypeScript that .svg files export React components

**Props** (from react-native-svg):

```typescript
interface SvgProps {
  width?: number | string;
  height?: number | string;
  color?: string;
  style?: StyleProp<ViewStyle>;
  // ... many more SVG-specific props
}
```

---

## Component Relationships

```
SvgIcon Component
    │
    ├─→ svgIconRegistry (imports)
    │       │
    │       └─→ SVG Files (transformed by Metro)
    │
    ├─→ useAppTheme (theme integration)
    │       │
    │       └─→ theme.colors.text (default color)
    │
    ├─→ MaskedView (conditional, gradient path)
    │       │
    │       └─→ LinearGradient (gradient fill)
    │
    └─→ View (container for solid color path)
            │
            └─→ SVG Component (actual icon)
```

---

## File Structure

```
apps/mobile/src/components/SvgIcon/
├── index.ts                 # Barrel export
│   └── Exports: SvgIcon, svgIconRegistry, SvgIconTypes
│
├── SvgIcon.tsx             # Component implementation
│   ├── Imports: svgIconRegistry, SvgIconTypes
│   ├── Imports: useAppTheme (for theme.colors.text)
│   ├── Imports: MaskedView, LinearGradient (gradient support)
│   └── Exports: SvgIcon component, SvgIconProps interface
│
└── registry.ts             # Icon registry
    ├── Imports: All SVG files (e.g., scani-logo.svg)
    └── Exports: svgIconRegistry object, SvgIconTypes type
```

---

## Style Constants

Component uses static styles (no themed styles needed for initial implementation):

```typescript
// No styles defined - component uses inline layout-only styles
// Container styling delegated to containerStyle prop
// SVG styling delegated to style prop
```

**Rationale**: Component is a pass-through wrapper. Layout and styling controlled by parent components via props.

---

## Validation Schema

**Not applicable** - component has no form validation or user input. Props are validated by TypeScript at compile time.

---

## State Management

**Component State**: None - fully controlled by props (stateless functional component)

**Global State**: None - no Redux, Context, or other state management needed

**Derived State**: 
- Icon component lookup: `const IconComponent = svgIconRegistry[name]`
- Effective color: `const iconColor = color ?? theme.colors.text`

---

## Performance Characteristics

**Memory**:
- Registry: ~1KB per 10 icons (just object references)
- Rendered icon: ~5-10KB per instance (native view + SVG data)
- Total: Negligible for 50-100 icons across app

**Render Time**:
- Icon lookup: O(1) constant time (object property access)
- First render: 5-15ms (native view creation)
- Re-renders: <1ms if props unchanged (React.memo not needed due to stable props)

**Bundle Size**:
- Component code: ~2KB
- Each SVG: 1-5KB (depends on complexity)
- Libraries: ~120KB total (react-native-svg + dependencies)

---

## Testing Strategy

**Unit Tests** (Jest + React Native Testing Library):

```typescript
describe("SvgIcon", () => {
  it("renders icon from registry", () => {
    const { getByTestId } = render(
      <SvgIcon name="scani-logo" size={48} />
    );
    expect(getByTestId("svg-icon")).toBeTruthy();
  });

  it("returns null for non-existent icon", () => {
    const { container } = render(
      <SvgIcon name={"invalid" as SvgIconTypes} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("applies custom size", () => {
    const { getByTestId } = render(
      <SvgIcon name="scani-logo" size={100} />
    );
    const icon = getByTestId("svg-icon");
    expect(icon.props.width).toBe(100);
    expect(icon.props.height).toBe(100);
  });

  it("applies custom color", () => {
    const { getByTestId } = render(
      <SvgIcon name="scani-logo" color="#ff0000" />
    );
    const icon = getByTestId("svg-icon");
    expect(icon.props.color).toBe("#ff0000");
  });

  it("uses theme color as default", () => {
    // Test with theme context provider
  });

  it("renders gradient when gradientColors provided", () => {
    // Test MaskedView and LinearGradient presence
  });
});
```

**Snapshot Tests**:
- Solid color rendering
- Gradient rendering
- Different sizes

**Integration Tests**:
- Theme integration (color changes with theme)
- Login screen integration (logo displays correctly)

---

## Migration Path

**Phase 1** (Current): Single icon (scani-logo)  
**Phase 2**: Add 5-10 common icons (user, settings, home, etc.)  
**Phase 3**: Full icon library (50+ icons)

**Backward Compatibility**: Adding new icons is non-breaking. Existing icon names never change.

**Deprecation**: If icon needs to be removed, mark as deprecated in JSDoc, remove after 2+ releases.

---

## Appendix: Example SVG File

**apps/mobile/assets/images/scani-logo.svg** (already exists):

```svg
<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <!-- SVG paths for Scani logo -->
  <!-- Note: No hardcoded width/height attributes -->
  <!-- Note: viewBox ensures proper scaling -->
</svg>
```

**Optimization**: Run through SVGO before committing to remove unnecessary metadata.

---

**Phase 1 Data Model Status**: ✅ **COMPLETE**

