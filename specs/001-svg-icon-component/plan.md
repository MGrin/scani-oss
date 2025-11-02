# Implementation Plan: SVG Icon Component with Registry

**Branch**: `001-svg-icon-component` | **Date**: November 2, 2025 | **Spec**: [spec.md](./spec.md)  
**Input**: Feature specification from `/specs/001-svg-icon-component/spec.md`

## Summary

Implement a reusable SVG icon component system for the Scani mobile app using React Native patterns from the betterplace-owner-app reference. The component will support configurable size, color, gradient fills, and theme integration. First usage: display the Scani logo above the "Welcome to Scani" text on the login screen. This establishes infrastructure for all future icon usage throughout the app.

**Technical Approach**: Create SvgIcon component with TypeScript registry pattern, configure Metro bundler with react-native-svg-transformer, implement gradient support via MaskedView and LinearGradient, integrate with Ignite theme system for default colors, and place scani-logo on login screen with proper sizing and positioning.

## Technical Context

**Language/Version**: TypeScript 5.9.2 (strict mode enabled)  
**Primary Dependencies**: 
- react-native-svg (v15.12.0 - latest compatible with Expo SDK 54)
- react-native-svg-transformer (v1.5.0)
- @react-native-masked-view/masked-view (v0.3.4 - for gradients)
- expo-linear-gradient (v14 - Expo SDK 54)

**Storage**: N/A (component renders in-memory)  
**Testing**: Jest v29.7.0 with @testing-library/react-native  
**Target Platform**: iOS 15+ and Android 13+ via Expo SDK 54 / React Native 0.81  
**Project Type**: Mobile (React Native with Expo) - monorepo structure at `apps/mobile/`  
**Performance Goals**: 
- Icon render time <16ms (60fps)
- Zero re-renders on theme change with proper memoization
- Bundle size impact <50KB for SVG transformer

**Constraints**:
- MUST follow Ignite theme system (no inline styles)
- MUST support both light and dark themes
- MUST use ThemedStyle pattern for all styling
- MUST handle missing icons gracefully (no crashes)
- Metro bundler requires configuration changes

**Scale/Scope**: 
- Initial: 1 icon (scani-logo), 1 usage location (login screen)
- Expected growth: 50+ icons across all app screens
- Component will be used 100+ times throughout app lifecycle

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### ✅ I. End-to-End Type Safety (NON-NEGOTIABLE)

- [x] TypeScript strict mode enabled in mobile app
- [x] Registry exports type `SvgIconTypes` for valid icon names
- [x] Component props fully typed with `SvgIconProps` interface
- [x] Color props typed as `string` (theme colors are strings)
- [x] Size prop typed as `number` with default value
- [x] Gradient arrays typed as `string[]`
- [x] No `any` types used

**Status**: ✅ COMPLIANT

### ✅ II. Testing Excellence (NON-NEGOTIABLE)

- [x] Component renders correctly with default props (unit test)
- [x] Component handles non-existent icon names (returns null - unit test)
- [x] Component respects size prop (snapshot test)
- [x] Component respects color prop (unit test)
- [x] Gradient rendering works when gradientColors provided (integration test)
- [x] Theme integration provides default color (integration test)
- [ ] E2E test for login screen logo display (deferred - manual testing acceptable)

**Status**: ✅ COMPLIANT (E2E deferred per constitution allowance)

### ✅ III. Security & Data Isolation (NON-NEGOTIABLE)

- [x] N/A - Component is UI-only, no data access or authentication

**Status**: ✅ COMPLIANT (not applicable)

### ✅ IV. Clean Architecture (MANDATORY)

**Mobile Component Organization:**

- [x] Component in `src/components/SvgIcon/SvgIcon.tsx`
- [x] Registry in `src/components/SvgIcon/registry.ts`
- [x] Barrel export in `src/components/SvgIcon/index.ts`
- [x] Self-contained with co-located registry
- [x] No external dependencies beyond theme and SVG libraries
- [x] Single responsibility: render SVG icons from registry

**Status**: ✅ COMPLIANT

### ✅ V. Monorepo Discipline (MANDATORY)

- [x] Feature lives in `apps/mobile/` workspace
- [x] Dependencies added to `apps/mobile/package.json`
- [x] Metro config changes scoped to mobile app
- [x] No cross-app imports (component is mobile-only)
- [x] Asset paths use `@/` alias for mobile workspace

**Status**: ✅ COMPLIANT

### ✅ VI. Code Quality Standards (MANDATORY)

**Naming Conventions:**

- [x] Component file: `SvgIcon.tsx` (PascalCase)
- [x] Registry file: `registry.ts` (camelCase)
- [x] Component name: `SvgIcon` (PascalCase)
- [x] Registry object: `svgIconRegistry` (camelCase)
- [x] Type export: `SvgIconTypes` (PascalCase)
- [x] Style constants: `$container`, `$icon` ($ prefix + camelCase)

**Linting:**

- [x] ESLint with Expo config will pass
- [x] No emoji in code
- [x] Prettier formatting applied

**Status**: ✅ COMPLIANT

### ✅ VII. Observability & Error Tracking (MANDATORY)

- [x] Console logging in development only (`if (__DEV__)`)
- [x] No sensitive data logged
- [x] Sentry: Component failures caught by error boundary (app-level)
- [ ] Optional: Add Reactotron logging for icon renders in dev mode

**Status**: ✅ COMPLIANT (Reactotron logging optional enhancement)

### ✅ VIII. Performance & Scalability (MANDATORY)

**Mobile Performance:**

- [x] Static styles used where possible (not themed unless needed)
- [x] Memoization considered for theme-dependent styles
- [x] No inline arrow functions in render
- [x] SVG components lazy-loaded via registry lookup
- [x] Gradient path uses MaskedView (performant native view)
- [x] New Architecture compatible (no deprecated APIs)

**Status**: ✅ COMPLIANT

### ✅ IX. React Native & Mobile Development (MANDATORY)

**Expo Configuration:**

- [x] Compatible with Expo SDK 54 and React Native 0.81
- [x] Works with New Architecture enabled
- [x] No breaking changes to Expo Router or other core systems
- [x] Metro transformer configuration follows Expo patterns

**Ignite Theming System:**

- [x] All styles use `ThemedStyle<ViewStyle>` pattern
- [x] Component uses `useAppTheme()` hook for theme access
- [x] Default color from `theme.colors.text`
- [x] Supports light and dark themes via theme tokens
- [x] No hardcoded colors (except when explicit color prop provided)
- [x] No hardcoded spacing values

**Component Patterns:**

- [x] Follows Ignite component structure (props interface, FC type)
- [x] Uses `forwardRef` if needed (not needed for this component)
- [x] Supports style overrides via `style` and `containerStyle` props
- [x] Self-contained with co-located registry
- [x] Graceful error handling (renders null for missing icons)

**Internationalization:**

- [x] N/A - Component is icon-only, no user-facing text

**Storage & Persistence:**

- [x] N/A - Component is stateless

**Status**: ✅ COMPLIANT

### Summary

**Overall Compliance**: ✅ **PASS** - All applicable constitution principles are satisfied

**Violations**: None

**Justifications**: N/A

## Project Structure

### Documentation (this feature)

```text
specs/001-svg-icon-component/
├── spec.md              # Feature specification
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (technology decisions)
├── data-model.md        # Phase 1 output (component structure)
├── quickstart.md        # Phase 1 output (usage guide)
├── contracts/           # Phase 1 output (component API)
│   └── SvgIcon.api.ts  # Component API contract
├── checklists/          # Quality validation
│   └── requirements.md # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit.tasks - NOT created yet)
```

### Source Code (repository root)

```text
apps/mobile/
├── src/
│   ├── components/
│   │   └── SvgIcon/                    # [NEW] Icon component
│   │       ├── index.ts                # Barrel export
│   │       ├── SvgIcon.tsx             # Component implementation
│   │       └── registry.ts             # Icon registry
│   ├── screens/
│   │   └── LoginScreen.tsx             # [MODIFIED] Add logo
│   ├── theme/
│   │   ├── context.tsx                 # [EXISTING] Theme provider
│   │   └── types.ts                    # [EXISTING] ThemedStyle types
│   └── i18n/
│       ├── en.ts                       # [NO CHANGE] No text needed
│       └── ru.ts                       # [NO CHANGE] No text needed
├── assets/
│   └── images/
│       └── scani-logo.svg              # [EXISTING] Already staged
├── metro.config.js                     # [MODIFIED] Add SVG transformer
├── package.json                        # [MODIFIED] Add dependencies
└── bun.lock                            # [MODIFIED] Lock file update
```

**Structure Decision**: Mobile-only feature using existing `apps/mobile/` workspace. Component follows Ignite pattern of self-contained components with barrel exports. Registry pattern matches betterplace-owner-app reference implementation. Metro configuration change is required for SVG transformation.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

No violations - table intentionally left empty.

---

## Phase Completion Status

### ✅ Phase 0: Research & Technology Decisions (COMPLETE)

**Artifacts Created**:
- [research.md](./research.md) - Technology decisions and best practices

**Key Decisions**:
- react-native-svg-transformer v1.5.0 for Metro bundler
- react-native-svg v15.12.0 (Expo SDK 54 compatible)
- MaskedView + LinearGradient for gradient support
- TypeScript registry pattern for type-safe icon names
- Static styles preferred for performance

**Status**: All technical unknowns resolved ✅

---

### ✅ Phase 1: Design & Contracts (COMPLETE)

**Artifacts Created**:
- [data-model.md](./data-model.md) - Component structure and registry schema
- [contracts/SvgIcon.api.ts](./contracts/SvgIcon.api.ts) - Component API contract
- [quickstart.md](./quickstart.md) - Developer usage guide
- `.cursor/rules/specify-rules.mdc` - Updated agent context (via script)

**Design Highlights**:
- SvgIcon component with full TypeScript safety
- Icon registry with exported union type (SvgIconTypes)
- Support for solid colors and gradient fills
- Theme integration for default colors
- Graceful error handling (null for missing icons)

**Status**: Design artifacts complete, ready for implementation ✅

---

### ⏸️ Phase 2: Task Breakdown (PENDING)

**Next Command**: Run `/speckit.tasks` to generate implementation task breakdown

**Expected Output**: `tasks.md` with step-by-step implementation checklist

**Status**: Awaiting user to run next command

---

## Implementation Readiness

**Prerequisites Complete**:
- ✅ Feature specification validated (spec.md)
- ✅ Constitution compliance verified
- ✅ Technology research complete
- ✅ Component design finalized
- ✅ API contract documented
- ✅ Developer guide written
- ✅ Agent context updated

**Ready to Implement**: YES

**Estimated Implementation Time**: 2-3 hours

**Estimated Testing Time**: 1-2 hours

**Total Feature Completion**: 4-6 hours

---

## Plan Summary

This plan provides complete technical guidance for implementing a reusable SVG icon component system in the Scani mobile app. The component follows Ignite patterns, integrates with the theme system, and provides type-safe icon usage throughout the app.

**First Deliverable**: Scani logo displayed on login screen above "Welcome to Scani" text

**Foundation for Future**: Scalable icon system supporting 50+ icons across the entire app

**Technology Stack**: React Native 0.81, Expo SDK 54, react-native-svg, Metro transformer

**Architecture**: Clean component pattern with centralized registry and full TypeScript safety

---

**Plan Version**: 1.0.0  
**Last Updated**: November 2, 2025  
**Status**: Phase 0-1 Complete, Ready for Phase 2 Task Breakdown
