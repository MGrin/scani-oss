# Feature Specification: SVG Icon Component with Registry

**Feature Branch**: `001-svg-icon-component`  
**Created**: November 2, 2025  
**Status**: Draft  
**Input**: User description: "let's introduce reusable SVGIcon component for our mobile app with icons registry. let's use it first to place assets/images/scani-logo.svg which will be 'scani-logo' in registry. we should place it above the 'Welcome to Scani' text in the login screen"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Display Scani Logo on Login Screen (Priority: P1)

When users open the login screen, they should see the Scani logo prominently displayed above the welcome message to establish brand identity and visual hierarchy.

**Why this priority**: This is the first touchpoint users have with the app and establishes brand recognition immediately. The logo placement improves visual design and professionalism of the login experience.

**Independent Test**: Can be fully tested by launching the app on both iOS and Android devices, navigating to the login screen, and verifying the Scani logo appears correctly above the "Welcome to Scani" text with proper sizing and positioning.

**Acceptance Scenarios**:

1. **Given** a user opens the app for the first time, **When** the login screen loads, **Then** the Scani logo is visible above the "Welcome to Scani" heading
2. **Given** the login screen is displayed, **When** user observes the logo, **Then** it renders crisply without pixelation on all device screen densities
3. **Given** the user has dark mode enabled, **When** viewing the login screen, **Then** the logo renders appropriately for the dark theme
4. **Given** the user has light mode enabled, **When** viewing the login screen, **Then** the logo renders appropriately for the light theme

---

### User Story 2 - Reusable Icon System for Future Features (Priority: P2)

Developers should be able to easily add and use SVG icons throughout the app by adding them to a centralized registry, enabling consistent icon usage across all screens.

**Why this priority**: While not immediately user-visible beyond the logo, this establishes the infrastructure for all future icon needs in the app. This prevents technical debt and enables rapid feature development.

**Independent Test**: Can be tested by adding a new test icon to the registry, importing and rendering it in a test screen, and verifying it displays correctly with configurable size and color properties.

**Acceptance Scenarios**:

1. **Given** a developer needs to add a new icon, **When** they add the SVG to the registry, **Then** the icon becomes immediately available throughout the app via the SvgIcon component
2. **Given** a developer uses an icon from the registry, **When** they specify a size prop, **Then** the icon renders at the specified dimensions
3. **Given** a developer uses an icon from the registry, **When** they specify a color prop, **Then** the icon renders in the specified color
4. **Given** a developer uses an icon from the registry, **When** they reference a non-existent icon name, **Then** the component handles the error gracefully without crashing

---

### User Story 3 - Theme-Aware Icon Colors (Priority: P3)

Icons should automatically adapt their colors to match the current theme (light/dark mode) when no explicit color is provided, ensuring visual consistency throughout the app.

**Why this priority**: Enhances user experience by ensuring icons maintain proper contrast and visibility across theme changes, but can be implemented after basic functionality is working.

**Independent Test**: Can be tested by toggling between light and dark themes while viewing screens with icons, verifying that icons without explicit color props adapt their colors appropriately.

**Acceptance Scenarios**:

1. **Given** an icon is displayed without a color prop, **When** the user switches from light to dark mode, **Then** the icon color adapts to maintain readability
2. **Given** an icon has an explicit color prop, **When** the user switches themes, **Then** the icon maintains the specified color regardless of theme
3. **Given** multiple icons are displayed on a screen, **When** the theme changes, **Then** all theme-aware icons update their colors simultaneously

---

### Edge Cases

- What happens when an SVG file is malformed or fails to load?
- How does the component handle very large or very small size values?
- What happens if the metro SVG transformer is not properly configured?
- How does the component behave when rendering multiple instances of the same icon on a single screen?
- What happens when a gradient color array is empty or contains invalid color values?
- How does the component handle SVG files with complex paths or animations that may not be supported?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Component MUST accept a `name` prop that references an icon key from the registry
- **FR-002**: Component MUST accept an optional `size` prop to control icon dimensions (default: 24)
- **FR-003**: Component MUST accept an optional `color` prop to override default icon color
- **FR-004**: Component MUST accept optional `gradientColors`, `gradientStart`, and `gradientEnd` props for gradient fills
- **FR-005**: Component MUST use theme color as default when no explicit color is provided
- **FR-006**: Component MUST handle non-existent icon names gracefully by rendering nothing (null)
- **FR-007**: Registry MUST export a TypeScript type representing valid icon names
- **FR-008**: Component MUST support style overrides via `style` and `containerStyle` props
- **FR-009**: Metro bundler MUST be configured to transform SVG files into React components
- **FR-010**: Scani logo MUST be registered as 'scani-logo' in the icon registry
- **FR-011**: Login screen MUST display the Scani logo above the "Welcome to Scani" text
- **FR-012**: Logo on login screen MUST be sized appropriately for mobile screens (between 80-120 points)
- **FR-013**: Component MUST support gradient fills via MaskedView and LinearGradient when gradientColors are provided

### Key Entities

- **SvgIcon Component**: Reusable React component that renders SVG icons from the registry with configurable properties (name, size, color, gradients, styles)
- **Icon Registry**: TypeScript object mapping icon names (strings) to imported SVG components, with exported type for type safety
- **SVG Assets**: Individual SVG files stored in assets/images directory that are transformed by metro into React components
- **Theme Integration**: Connection to app theme system to provide default colors and support light/dark mode

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can see the Scani logo on the login screen within 100ms of screen load
- **SC-002**: Icons render crisply without pixelation on all supported device screen densities (1x, 2x, 3x)
- **SC-003**: Developers can add a new icon to the app in under 2 minutes (add SVG file, update registry, use component)
- **SC-004**: Component renders successfully on both iOS and Android platforms without visual differences
- **SC-005**: Icon color transitions smoothly (under 300ms) when theme changes between light and dark modes
- **SC-006**: Component handles invalid icon names without crashing the app in 100% of cases
- **SC-007**: Logo placement on login screen improves visual hierarchy as confirmed by design review
