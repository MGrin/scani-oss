# Scani UI Standardization System

This documentation outlines the comprehensive UI standardization system implemented for the Scani finance application, ensuring consistent typography, spacing, colors, and feedback messages throughout the application.

## Overview

The UI standardization system consists of three main components:

1. **Design System** (`design-system.ts`) - Core design tokens and utilities
2. **Feedback Components** (`feedback.tsx`) - Standardized UI feedback components  
3. **Demo Component** (`DesignSystemDemo.tsx`) - Interactive demonstration and usage examples

## Design System (`design-system.ts`)

### Core Features

#### Typography Scale
- **Font Sizes**: From 0.75rem (12px) to 4.5rem (72px) following a consistent scale
- **Font Families**: 
  - Sans-serif: Inter (primary interface)
  - Monospace: JetBrains Mono (account numbers, codes)
  - Display: Cal Sans (marketing, hero sections)
- **Font Weights**: Light (300) to Black (900)
- **Line Heights & Letter Spacing**: Optimized for readability

#### Spacing System
- **Consistent Scale**: From 1px to 384px following Tailwind CSS conventions
- **Component-Specific Tokens**: Pre-defined spacing for buttons, inputs, cards, modals
- **Utility Functions**: Easy access to spacing values

#### Color System
- **Semantic Colors**: Theme-aware colors using CSS custom properties
- **Status Colors**: Success (green), Error (red), Warning (amber), Info (blue)
- **Dark Mode Support**: All colors automatically adapt to light/dark themes

#### Component Specifications
- **Buttons**: Consistent heights, padding, and font sizes across different sizes
- **Inputs**: Matching button patterns for visual harmony
- **Cards**: Standardized padding and border radius options
- **Modals**: Flexible sizing from 320px to full viewport

#### Z-Index Scale
Organized layering system preventing z-index conflicts:
- Dropdown: 1000
- Modal Backdrop: 1040  
- Modal: 1050
- Tooltip: 1070
- Notification: 1080

### Utility Functions

```typescript
// Import design tokens
import { getSpacing, getFontSize, getDesignToken } from '@/styles/design-system';

// Use utility functions
const buttonHeight = getDesignToken('components.button.heights.default'); // "2.5rem"
const spacing = getSpacing('4'); // "1rem"
const fontSize = getFontSize('lg'); // "1.125rem"
```

### Message System

Standardized messages for all user interactions:

- **Success Messages**: ✅ with consistent formatting
- **Error Messages**: ❌ with helpful context
- **Warning Messages**: ⚠️ indicating caution needed
- **Info Messages**: ℹ️ providing helpful information
- **Confirmation Messages**: Clear questions for destructive actions

## Feedback Components (`feedback.tsx`)

### Available Components

#### Base Feedback Message
```typescript
<FeedbackMessage
  type="success" | "error" | "warning" | "info"
  variant="filled" | "outlined" | "subtle"
  title="Optional title"
  message="Your message here"
  dismissible={true}
  onDismiss={() => {}}
  actions={<Button>Action</Button>}
/>
```

#### Specific Message Types
```typescript
<SuccessMessage message="Operation completed!" />
<ErrorMessage message="Something went wrong" />
<WarningMessage message="Please review before proceeding" />
<InfoMessage message="Additional information" />
```

#### Status & Progress Components
```typescript
<StatusIndicator status="online" | "offline" | "syncing" | "error" showLabel />
<ProgressIndicator progress={75} variant="linear" | "circular" />
<LoadingMessage variant="inline" | "overlay" | "card" />
<EmptyState 
  title="No data found"
  message="Try adding some items"
  action={<Button>Add Item</Button>}
/>
```

#### Standardized Message Functions
```typescript
import { feedbackMessages } from '@/components/ui/feedback';

// Use pre-defined messages
const success = feedbackMessages.institutionCreated(); // { type: 'success', message: '✅ Institution created successfully' }
const error = feedbackMessages.networkError(); // { type: 'error', message: '❌ Network error - please check your connection' }
```

## Usage Guidelines

### 1. Import Design Tokens

```typescript
import { designSystem, colorSystem, messageSystem } from '@/styles/design-system';
```

### 2. Use Consistent Spacing

```typescript
// Good - using design system spacing
<div className="p-4 mb-6"> // Uses spacing scale values

// Avoid - arbitrary values
<div className="p-3 mb-5"> // Non-standard spacing
```

### 3. Apply Consistent Typography

```typescript
// Good - using typography scale
<h1 className="text-2xl font-semibold">Title</h1>
<p className="text-base">Body text</p>

// Reference design tokens programmatically
const headingStyle = {
  fontSize: designSystem.typography.sizes['2xl'],
  fontWeight: designSystem.typography.weights.semibold
};
```

### 4. Use Status Colors

```typescript
// Good - using semantic colors
<div className={colorSystem.status.success.bg}>
  <span className={colorSystem.status.success.text}>Success!</span>
</div>
```

### 5. Implement Consistent Feedback

```typescript
// Good - using standardized components
<SuccessMessage message={feedbackMessages.institutionCreated().message} />

// Good - using confirmation messages
const message = getConfirmationMessage('delete', 'institution', 'Chase Bank');
```

## Testing

Comprehensive test suites ensure design system consistency:

- **Design System Tests** (`design-system.test.ts`): Validates all design tokens and utilities
- **Feedback Component Tests** (`feedback.test.tsx`): Tests all feedback components and interactions

Run tests with:
```bash
bun test apps/frontend/src/styles/design-system.test.ts
bun test apps/frontend/src/components/ui/feedback.test.tsx
```

## Demo Component

The `DesignSystemDemo.tsx` component provides:

- **Interactive Documentation**: See all design tokens in action
- **Usage Examples**: Copy-paste code examples
- **Component Showcase**: All feedback components with different states
- **Form Examples**: Real-world usage patterns

Access the demo by importing and rendering:
```typescript
import DesignSystemDemo from '@/components/examples/DesignSystemDemo';
```

## Integration with Existing Codebase

### 1. Replace Hardcoded Values
Replace magic numbers and arbitrary styles with design tokens:

```typescript
// Before
<button style={{ padding: '8px 16px', fontSize: '14px' }}>

// After  
<button style={{ 
  padding: designSystem.components.button.padding.default,
  fontSize: designSystem.components.button.fontSize.default 
}}>
```

### 2. Standardize Message Handling
Replace custom messages with standardized ones:

```typescript
// Before
toast.success("Institution was created successfully!");

// After
const message = feedbackMessages.institutionCreated();
toast.success(message.message);
```

### 3. Use Consistent Colors
Replace custom color definitions:

```typescript
// Before
<Alert className="bg-green-100 text-green-800">

// After
<Alert className={`${colorSystem.status.success.bg} ${colorSystem.status.success.text}`}>
```

## Benefits

1. **Consistency**: Uniform look and feel across the entire application
2. **Maintainability**: Centralized design decisions easy to update
3. **Developer Experience**: Clear guidelines and reusable components
4. **Accessibility**: Built-in color contrast and semantic markup
5. **Scalability**: New components automatically inherit design standards
6. **Testing**: Comprehensive coverage ensures reliability

## File Structure

```
apps/frontend/src/
├── styles/
│   ├── design-system.ts          # Core design tokens and utilities
│   ├── design-system.test.ts     # Design system tests
│   └── README.md                 # This documentation
├── components/
│   ├── ui/
│   │   ├── feedback.tsx          # Feedback components
│   │   └── feedback.test.tsx     # Feedback component tests
│   └── examples/
│       └── DesignSystemDemo.tsx  # Interactive demo
```

## Next Steps

1. **Gradual Migration**: Replace existing components with design system components
2. **Team Training**: Ensure all developers understand the system
3. **Documentation Updates**: Keep design system docs current
4. **Performance Monitoring**: Watch for any performance impacts
5. **User Feedback**: Collect feedback on consistency improvements

This UI standardization system provides the foundation for a consistent, maintainable, and scalable user interface across the entire Scani application.
