# SvgIcon Component

A reusable SVG icon component with automatic registry using Vite's `import.meta.glob` for type-safe icon imports.

## Features

- **Auto-registry**: Automatically imports all SVG files from `src/assets/icons/svg/`
- **Type-safe**: Icon names are fully typed and autocompleted
- **Theme-aware**: Supports `currentColor` for automatic theme integration
- **Flexible styling**: Supports custom colors, sizes, and Tailwind classes
- **Zero configuration**: Just drop SVG files in the folder and use them

## Installation

The component is already set up. To use it, simply import:

```tsx
import { SvgIcon } from "@/components/ui/SvgIcon";
```

## Usage

### Basic Usage

```tsx
<SvgIcon name="scani-logo" />
```

### Custom Size

```tsx
<SvgIcon name="scani-logo" size={32} />
```

### Custom Color

```tsx
<SvgIcon name="scani-logo" color="#3B82F6" />
```

### Tailwind Class Names

```tsx
<SvgIcon name="scani-logo" className="text-primary" />
```

### Theme-Aware (Inherit Parent Color)

```tsx
<div className="text-foreground">
  <SvgIcon name="scani-logo" />
</div>
```

### All Props

```tsx
<SvgIcon
  name="scani-logo"
  size={24}
  color="#3B82F6"
  className="text-primary"
  style={{ marginRight: "8px" }}
/>
```

## Adding New Icons

1. Add your SVG file to `src/assets/icons/svg/`
2. Name it with kebab-case: `my-icon.svg`
3. Use it immediately: `<SvgIcon name="my-icon" />`

**That's it!** The registry automatically detects and imports new icons.

## Props

| Prop        | Type            | Default          | Description                                      |
| ----------- | --------------- | ---------------- | ------------------------------------------------ |
| `name`      | `SvgIconTypes`  | required         | Icon identifier (auto-typed from available SVGs) |
| `size`      | `number`        | `24`             | Icon size in pixels                              |
| `color`     | `string`        | `'currentColor'` | Icon color (CSS color value)                     |
| `className` | `string`        | `''`             | Additional CSS classes                           |
| `style`     | `CSSProperties` | `undefined`      | Inline styles                                    |

## Examples

See `SvgIcon.example.tsx` for comprehensive usage examples.

## Technical Details

### How it Works

1. **Registry Generation**: `registry.ts` uses Vite's `import.meta.glob` to auto-import all SVG files with `?react` suffix
2. **Type Extraction**: TypeScript extracts icon names as union type `SvgIconTypes`
3. **Component Rendering**: `SvgIcon.tsx` looks up the icon component from the registry and renders it

### File Structure

```
src/components/ui/SvgIcon/
├── registry.ts         # Auto-generated icon registry
├── SvgIcon.tsx         # Main component
├── index.ts            # Barrel export
├── SvgIcon.example.tsx # Usage examples
└── README.md           # This file

src/assets/icons/svg/
└── scani-logo.svg      # Icon files
```

### Dependencies

- `vite-plugin-svgr`: Enables SVG imports as React components
- Configured in `vite.config.ts`

## Best Practices

1. **Use `currentColor` for theme support**: Let the icon inherit color from parent
2. **Prefer Tailwind classes**: Use `className="text-primary"` over `color="#xxx"`
3. **Name icons consistently**: Use kebab-case (e.g., `user-profile.svg`)
4. **Optimize SVGs**: Clean up unnecessary attributes before adding to the registry
5. **Set viewBox**: Ensure SVGs have proper viewBox for scaling

## Differences from Mobile Version

1. **No gradient support**: Simplified for web (use CSS if needed)
2. **Uses `currentColor`**: Inherits color from parent by default
3. **Vite's `import.meta.glob`**: Instead of manual registry
4. **Tailwind integration**: Native `className` support
5. **No ThemedStyle**: Uses standard React patterns
