# SVG Icon Component - Quickstart Guide

**Last Updated**: November 2, 2025  
**Version**: 1.0.0  
**Audience**: Mobile developers working on Scani app

## TL;DR

```typescript
import { SvgIcon } from "@/components/SvgIcon";

// Simple icon
<SvgIcon name="scani-logo" size={96} />

// With custom color
<SvgIcon name="scani-logo" size={48} color="#667eea" />

// With gradient
<SvgIcon
  name="scani-logo"
  size={120}
  gradientColors={["#667eea", "#764ba2"]}
/>
```

---

## Installation (Already Complete)

The component and dependencies are already installed in the mobile app:

✅ `react-native-svg` v15.12.0  
✅ `react-native-svg-transformer` v1.5.0  
✅ `@react-native-masked-view/masked-view` v0.3.4  
✅ `expo-linear-gradient` v14 (Expo SDK 54)  
✅ Metro configured for SVG imports  
✅ TypeScript declarations added

**No action needed** - ready to use immediately.

---

## Basic Usage

### 1. Import the Component

```typescript
import { SvgIcon } from "@/components/SvgIcon";
```

### 2. Render an Icon

```typescript
export const MyScreen: FC = () => {
  return (
    <View>
      <SvgIcon name="scani-logo" />
    </View>
  );
};
```

That's it! The icon renders with:
- Default size: 24 points
- Default color: from theme (`theme.colors.text`)
- Automatically adapts to light/dark mode

---

## Common Patterns

### Custom Size

```typescript
<SvgIcon name="scani-logo" size={48} />
<SvgIcon name="scani-logo" size={96} />
<SvgIcon name="scani-logo" size={120} />
```

**Tip**: Icons scale perfectly at any size - they're vectors!

### Custom Color

```typescript
// Hex color
<SvgIcon name="scani-logo" color="#667eea" />

// RGB color
<SvgIcon name="scani-logo" color="rgb(102, 126, 234)" />

// Theme color (access theme first)
const { theme } = useAppTheme();
<SvgIcon name="scani-logo" color={theme.colors.palette.primary500} />
```

### Gradient Fill

```typescript
<SvgIcon
  name="scani-logo"
  size={96}
  gradientColors={["#667eea", "#764ba2"]}
  gradientStart={{ x: 0, y: 0 }}    // Top-left
  gradientEnd={{ x: 1, y: 1 }}      // Bottom-right
/>
```

**Common Gradients**:

```typescript
// Horizontal (left to right)
gradientStart={{ x: 0, y: 0 }}
gradientEnd={{ x: 1, y: 0 }}

// Vertical (top to bottom)
gradientStart={{ x: 0, y: 0 }}
gradientEnd={{ x: 0, y: 1 }}

// Diagonal (default)
gradientStart={{ x: 0, y: 0 }}
gradientEnd={{ x: 1, y: 1 }}
```

### Container Styling

```typescript
<SvgIcon
  name="scani-logo"
  size={48}
  containerStyle={{
    marginBottom: 16,
    alignSelf: "center",
  }}
/>
```

### Icon in Button

```typescript
<Pressable onPress={handlePress} style={$button}>
  <SvgIcon name="scani-logo" size={24} color="#fff" />
  <Text style={$buttonText}>Sign In</Text>
</Pressable>
```

### Icon in List Item

```typescript
<View style={$listItem}>
  <SvgIcon name="scani-logo" size={32} />
  <View style={$content}>
    <Text>Account Name</Text>
    <Text>Details</Text>
  </View>
</View>
```

---

## Adding New Icons

### Step 1: Get the SVG File

1. Export SVG from design tool (Figma, Sketch, etc.)
2. Optimize with [SVGO](https://jakearchibald.github.io/svgomg/)
3. Ensure SVG has `viewBox` attribute
4. Remove hardcoded `width` and `height` attributes

**Good SVG**:
```svg
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M..." />
</svg>
```

**Bad SVG**:
```svg
<svg width="24" height="24" xmlns="http://www.w3.org/2000/svg">
  <!-- Missing viewBox, has hardcoded size -->
</svg>
```

### Step 2: Add to Assets

Place SVG file in one of:
- `apps/mobile/assets/images/` (for logos, illustrations)
- `apps/mobile/assets/icons/` (for UI icons)

Example:
```bash
apps/mobile/assets/icons/user-profile.svg
```

### Step 3: Update Registry

Edit `apps/mobile/src/components/SvgIcon/registry.ts`:

```typescript
import ScaniLogo from "@/assets/images/scani-logo.svg";
import UserProfile from "@/assets/icons/user-profile.svg"; // ← New import

export const svgIconRegistry = {
  "scani-logo": ScaniLogo,
  "user-profile": UserProfile, // ← New entry
} as const;

export type SvgIconTypes = keyof typeof svgIconRegistry;
```

### Step 4: Use the New Icon

```typescript
<SvgIcon name="user-profile" size={48} />
```

**Type Safety**: TypeScript now knows about "user-profile" - you'll get autocomplete!

---

## Integration Examples

### Login Screen Logo (Already Implemented)

```typescript
// apps/mobile/src/screens/LoginScreen.tsx

const EmailInputForm: FC<EmailInputFormProps> = ({ ... }) => {
  return (
    <>
      {/* Logo above welcome text */}
      <View style={$staticLogoContainer}>
        <SvgIcon name="scani-logo" size={96} />
      </View>

      {/* Welcome heading */}
      <Text preset="heading" tx="auth:welcome" style={$staticTitle} />
      
      {/* Rest of form... */}
    </>
  );
};

const $staticLogoContainer: ViewStyle = {
  alignItems: "center",
  marginBottom: 24,
};
```

### Tab Bar Icons (Future Enhancement)

```typescript
// apps/mobile/src/app/(tabs)/_layout.tsx

<Tabs.Screen
  name="index"
  options={{
    title: "Home",
    tabBarIcon: ({ color, size }) => (
      <SvgIcon name="home" size={size} color={color} />
    ),
  }}
/>
```

### Empty State Illustrations (Future Enhancement)

```typescript
<View style={$emptyState}>
  <SvgIcon name="empty-list" size={120} color={theme.colors.palette.neutral400} />
  <Text tx="holdings:emptyState" />
</View>
```

---

## Troubleshooting

### Icon Not Displaying

**Problem**: Component renders but no icon visible

**Solutions**:
1. Check icon name is in registry: `console.log(Object.keys(svgIconRegistry))`
2. Verify SVG file exists at import path
3. Check Metro bundler reloaded (shake device → "Reload")
4. Clear Metro cache: `yarn start --clear`

### TypeScript Error: Icon Name Not Found

**Problem**: `Type '"my-icon"' is not assignable to type 'SvgIconTypes'`

**Solution**: Icon not in registry. Add to `registry.ts` first.

### Icon Pixelated/Blurry

**Problem**: Icon looks pixelated on high-DPI screens

**Solution**: 
- SVGs should never pixelate - check SVG is valid
- Verify Metro transformer is working (SVG imported as component, not image)
- Check SVG has `viewBox` attribute

### Gradient Not Showing

**Problem**: Icon renders solid color even with `gradientColors` prop

**Solutions**:
1. Check `gradientColors` array has at least 2 colors
2. Verify `@react-native-masked-view/masked-view` is installed
3. Check `expo-linear-gradient` is available (part of Expo SDK 54)
4. Android: Ensure `edgeToEdgeEnabled` in `app.json`

### Theme Color Not Applied

**Problem**: Icon doesn't use theme color in dark mode

**Solution**:
- Don't pass explicit `color` prop if you want theme color
- Component automatically uses `theme.colors.text` as default

---

## Best Practices

### ✅ DO

- Use default size (24) for inline icons
- Use larger sizes (48-120) for decorative icons
- Let theme handle colors (no explicit color prop)
- Optimize SVG files before adding to project
- Use kebab-case for icon names
- Group related icons (e.g., "user-profile", "user-settings")

### ❌ DON'T

- Don't inline styles - use `containerStyle` prop
- Don't hardcode colors if theme color works
- Don't add huge SVG files (>50KB) - optimize first
- Don't use icon names with spaces or special characters
- Don't edit SVG files manually - use design tools

---

## Performance Tips

1. **Static Sizes**: If size never changes, use constant:
   ```typescript
   const ICON_SIZE = 48;
   <SvgIcon name="scani-logo" size={ICON_SIZE} />
   ```

2. **Avoid Inline Functions**: Don't create objects in render:
   ```typescript
   // ❌ Bad - creates new object every render
   <SvgIcon name="scani-logo" containerStyle={{ margin: 8 }} />
   
   // ✅ Good - stable reference
   const $iconContainer: ViewStyle = { margin: 8 };
   <SvgIcon name="scani-logo" containerStyle={$iconContainer} />
   ```

3. **Memoize Gradient Props**: If gradient values computed:
   ```typescript
   const gradientColors = useMemo(() => [color1, color2], [color1, color2]);
   <SvgIcon name="scani-logo" gradientColors={gradientColors} />
   ```

---

## Testing

### Unit Test Example

```typescript
import { render } from "@testing-library/react-native";
import { SvgIcon } from "@/components/SvgIcon";

describe("SvgIcon", () => {
  it("renders scani-logo", () => {
    const { container } = render(<SvgIcon name="scani-logo" />);
    expect(container).toBeTruthy();
  });

  it("applies custom size", () => {
    const { getByTestId } = render(
      <SvgIcon name="scani-logo" size={100} />
    );
    // Assert on rendered SVG dimensions
  });
});
```

### Snapshot Test Example

```typescript
it("matches snapshot", () => {
  const tree = renderer
    .create(<SvgIcon name="scani-logo" size={48} color="#667eea" />)
    .toJSON();
  expect(tree).toMatchSnapshot();
});
```

---

## API Reference

For complete API documentation, see [SvgIcon.api.ts](./contracts/SvgIcon.api.ts)

**Quick Reference**:

| Prop | Type | Default | Required | Description |
|------|------|---------|----------|-------------|
| `name` | `SvgIconTypes` | - | ✅ | Icon name from registry |
| `size` | `number` | `24` | ❌ | Icon size (width & height) |
| `color` | `string` | `theme.colors.text` | ❌ | Icon color |
| `gradientColors` | `string[]` | `undefined` | ❌ | Gradient colors array |
| `gradientStart` | `{x, y}` | `{x:0, y:0}` | ❌ | Gradient start point |
| `gradientEnd` | `{x, y}` | `{x:1, y:1}` | ❌ | Gradient end point |
| `style` | `StyleProp<ViewStyle>` | `undefined` | ❌ | SVG style overrides |
| `containerStyle` | `StyleProp<ViewStyle>` | `undefined` | ❌ | Container style overrides |

---

## Support

**Questions?**
- Check [data-model.md](./data-model.md) for component structure
- Check [research.md](./research.md) for technology decisions
- Check [plan.md](./plan.md) for implementation details

**Found a bug?**
- Check existing issues in repository
- Include device, OS version, and SVG file if relevant

**Need a feature?**
- Document use case and proposed API
- Check if it aligns with constitution principles

---

## What's Next?

After implementing the basic component:

1. **Add More Icons**: Build up icon library (home, user, settings, etc.)
2. **Accessibility**: Add accessibility labels and roles
3. **Animation**: Support animated SVGs with react-native-reanimated
4. **Icon Packs**: Group icons by category (navigation, actions, social)
5. **Storybook**: Add to component library showcase (if implemented)

---

**Happy Icon Building!** 🎨

