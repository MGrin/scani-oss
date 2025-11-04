# Tasks: SVG Icon Component with Registry

**Input**: Design documents from `/specs/001-svg-icon-component/`  
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/, quickstart.md

**Tests**: Tests are included based on constitution requirement for 93%+ coverage (Principle II).

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Mobile app**: `apps/mobile/` at monorepo root
- Component files: `apps/mobile/src/components/SvgIcon/`
- Assets: `apps/mobile/assets/images/`
- Screen files: `apps/mobile/src/screens/`
- Tests: `apps/mobile/src/components/SvgIcon/__tests__/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization, dependencies, and Metro bundler configuration

- [x] T001 Install react-native-svg v15.12.0 in apps/mobile/package.json
- [x] T002 Install react-native-svg-transformer v1.5.0 (dev dependency) in apps/mobile/package.json
- [x] T003 [P] Install @react-native-masked-view/masked-view v0.3.4 in apps/mobile/package.json
- [x] T004 [P] Configure Metro bundler for SVG transformation in apps/mobile/metro.config.js
- [x] T005 [P] Create TypeScript SVG module declaration in apps/mobile/types/svg.d.ts
- [x] T006 Create SvgIcon component directory structure at apps/mobile/src/components/SvgIcon/

**Checkpoint**: Dependencies installed, Metro configured, project structure ready

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core component infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T007 Create icon registry file at apps/mobile/src/components/SvgIcon/registry.ts with empty registry object
- [x] T008 [P] Create SvgIconProps interface in apps/mobile/src/components/SvgIcon/SvgIcon.tsx
- [x] T009 [P] Create barrel export file at apps/mobile/src/components/SvgIcon/index.ts
- [x] T010 Implement base SvgIcon component with icon lookup logic in apps/mobile/src/components/SvgIcon/SvgIcon.tsx
- [x] T011 Implement null handling for missing icons in apps/mobile/src/components/SvgIcon/SvgIcon.tsx
- [x] T012 [P] Integrate useAppTheme hook for default color in apps/mobile/src/components/SvgIcon/SvgIcon.tsx
- [x] T013 Implement solid color rendering path in apps/mobile/src/components/SvgIcon/SvgIcon.tsx

**Checkpoint**: Foundation ready - basic component works with solid colors, user story implementation can now begin

---

## Phase 3: User Story 1 - Display Scani Logo on Login Screen (Priority: P1) 🎯 MVP

**Goal**: Display the Scani logo above the "Welcome to Scani" text on the login screen to establish brand identity

**Independent Test**: Launch app on iOS/Android, navigate to login screen, verify logo appears centered above welcome text, renders crisply at 96pt size

### Tests for User Story 1

> **NOTE: Write these tests FIRST, ensure they FAIL before implementation**

- [x] T014 [P] [US1] Create test file at apps/mobile/src/components/SvgIcon/__tests__/SvgIcon.test.tsx
- [x] T015 [P] [US1] Write unit test: "renders icon from registry" in apps/mobile/src/components/SvgIcon/__tests__/SvgIcon.test.tsx
- [x] T016 [P] [US1] Write unit test: "returns null for non-existent icon" in apps/mobile/src/components/SvgIcon/__tests__/SvgIcon.test.tsx
- [x] T017 [P] [US1] Write unit test: "applies custom size" in apps/mobile/src/components/SvgIcon/__tests__/SvgIcon.test.tsx
- [x] T018 [P] [US1] Write unit test: "applies custom color" in apps/mobile/src/components/SvgIcon/__tests__/SvgIcon.test.tsx
- [x] T019 [P] [US1] Write snapshot test for basic icon rendering in apps/mobile/src/components/SvgIcon/__tests__/SvgIcon.test.tsx

### Implementation for User Story 1

- [x] T020 [US1] Import scani-logo.svg in apps/mobile/src/components/SvgIcon/registry.ts
- [x] T021 [US1] Add "scani-logo" entry to svgIconRegistry object in apps/mobile/src/components/SvgIcon/registry.ts
- [x] T022 [US1] Export SvgIconTypes union type in apps/mobile/src/components/SvgIcon/registry.ts
- [x] T023 [US1] Create $staticLogoContainer style constant in apps/mobile/src/screens/LoginScreen.tsx
- [x] T024 [US1] Add SvgIcon import to EmailInputForm component in apps/mobile/src/screens/LoginScreen.tsx
- [x] T025 [US1] Add logo View with SvgIcon above "Welcome to Scani" text in apps/mobile/src/screens/LoginScreen.tsx
- [ ] T026 [US1] Verify logo displays correctly in light mode on iOS simulator
- [ ] T027 [US1] Verify logo displays correctly in dark mode on iOS simulator
- [ ] T028 [US1] Verify logo displays correctly on Android emulator
- [ ] T029 [US1] Run ESLint on modified files and fix any issues
- [ ] T030 [US1] Run TypeScript type check and fix any errors

**Checkpoint**: At this point, User Story 1 should be fully functional - logo appears on login screen with proper branding

---

## Phase 4: User Story 2 - Reusable Icon System (Priority: P2)

**Goal**: Establish scalable infrastructure for adding and using icons throughout the app

**Independent Test**: Add a test icon to registry, render it in a test screen, verify it displays with configurable size and color

### Tests for User Story 2

- [ ] T031 [P] [US2] Write unit test: "uses theme color as default" in apps/mobile/src/components/SvgIcon/__tests__/SvgIcon.test.tsx
- [ ] T032 [P] [US2] Write integration test: "icon lookup performance is O(1)" in apps/mobile/src/components/SvgIcon/__tests__/SvgIcon.test.tsx
- [ ] T033 [P] [US2] Write integration test: "multiple icon instances render independently" in apps/mobile/src/components/SvgIcon/__tests__/SvgIcon.test.tsx

### Implementation for User Story 2

- [ ] T034 [P] [US2] Implement size prop handling in apps/mobile/src/components/SvgIcon/SvgIcon.tsx
- [ ] T035 [P] [US2] Implement color prop handling with theme fallback in apps/mobile/src/components/SvgIcon/SvgIcon.tsx
- [ ] T036 [P] [US2] Implement style prop pass-through in apps/mobile/src/components/SvgIcon/SvgIcon.tsx
- [ ] T037 [P] [US2] Implement containerStyle prop handling in apps/mobile/src/components/SvgIcon/SvgIcon.tsx
- [ ] T038 [US2] Add JSDoc comments to SvgIconProps interface in apps/mobile/src/components/SvgIcon/SvgIcon.tsx
- [ ] T039 [US2] Add JSDoc comments to SvgIcon component in apps/mobile/src/components/SvgIcon/SvgIcon.tsx
- [ ] T040 [US2] Document registry extension process in quickstart.md (verify existing docs match implementation)
- [ ] T041 [US2] Verify type safety: test that invalid icon names produce TypeScript errors
- [ ] T042 [US2] Run all unit tests and verify 93%+ coverage for SvgIcon component

**Checkpoint**: At this point, User Story 2 should be complete - developers can easily add and use icons with full type safety

---

## Phase 5: User Story 3 - Theme-Aware Icon Colors (Priority: P3)

**Goal**: Icons automatically adapt colors to match current theme (light/dark mode) when no explicit color provided

**Independent Test**: Toggle between light and dark themes while viewing screens with icons, verify icons adapt colors appropriately

### Tests for User Story 3

- [ ] T043 [P] [US3] Write integration test: "icon color changes with theme" in apps/mobile/src/components/SvgIcon/__tests__/SvgIcon.test.tsx
- [ ] T044 [P] [US3] Write integration test: "explicit color overrides theme" in apps/mobile/src/components/SvgIcon/__tests__/SvgIcon.test.tsx
- [ ] T045 [P] [US3] Write unit test: "renders gradient when gradientColors provided" in apps/mobile/src/components/SvgIcon/__tests__/SvgIcon.test.tsx
- [ ] T046 [P] [US3] Write snapshot test for gradient rendering in apps/mobile/src/components/SvgIcon/__tests__/SvgIcon.test.tsx

### Implementation for User Story 3

- [ ] T047 [US3] Import MaskedView in apps/mobile/src/components/SvgIcon/SvgIcon.tsx
- [ ] T048 [US3] Import LinearGradient in apps/mobile/src/components/SvgIcon/SvgIcon.tsx
- [ ] T049 [US3] Implement gradient rendering path with MaskedView in apps/mobile/src/components/SvgIcon/SvgIcon.tsx
- [ ] T050 [US3] Implement gradientColors prop handling in apps/mobile/src/components/SvgIcon/SvgIcon.tsx
- [ ] T051 [US3] Implement gradientStart prop with default {x:0, y:0} in apps/mobile/src/components/SvgIcon/SvgIcon.tsx
- [ ] T052 [US3] Implement gradientEnd prop with default {x:1, y:1} in apps/mobile/src/components/SvgIcon/SvgIcon.tsx
- [ ] T053 [US3] Add conditional logic to choose solid vs gradient rendering in apps/mobile/src/components/SvgIcon/SvgIcon.tsx
- [ ] T054 [US3] Test gradient rendering with scani-logo on login screen
- [ ] T055 [US3] Verify theme transitions are smooth (<300ms) when toggling light/dark mode
- [ ] T056 [US3] Test gradient on both iOS and Android platforms
- [ ] T057 [US3] Run all tests and verify full test suite passes

**Checkpoint**: All user stories complete - icons support solid colors, gradients, and theme-aware rendering

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Code quality, documentation, and final validation

- [ ] T058 [P] Add usage examples to quickstart.md (verify existing examples are accurate)
- [ ] T059 [P] Update API contract documentation in contracts/SvgIcon.api.ts (verify matches implementation)
- [ ] T060 [P] Optimize scani-logo.svg with SVGO tool (if not already optimized)
- [ ] T061 Code cleanup: remove any console.logs or debug code from apps/mobile/src/components/SvgIcon/
- [ ] T062 Run Prettier on all modified files in apps/mobile/src/
- [ ] T063 Run ESLint with --fix on all modified files
- [ ] T064 Run full TypeScript type check for mobile workspace
- [ ] T065 [P] Verify no hardcoded colors/spacing in component (constitution compliance)
- [ ] T066 [P] Verify component follows Ignite patterns (constitution compliance)
- [ ] T067 Run full test suite and verify 93%+ coverage maintained
- [ ] T068 Manual testing: verify logo on login screen on 3+ device sizes
- [ ] T069 Manual testing: verify no performance regressions (app startup, screen transitions)
- [ ] T070 Update spec.md with "Implemented" status and link to component files
- [ ] T071 Git commit with descriptive message referencing feature 001

**Checkpoint**: Feature complete, tested, documented, and ready for code review/merge

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup (Phase 1) completion - BLOCKS all user stories
- **User Stories (Phase 3-5)**: All depend on Foundational (Phase 2) completion
  - User Story 1 (P1): Can start after Phase 2 - No dependencies on other stories
  - User Story 2 (P2): Can start after Phase 2 - Builds on US1 but independently testable
  - User Story 3 (P3): Can start after Phase 2 - Extends US2 functionality
- **Polish (Phase 6)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories
- **User Story 2 (P2)**: Can start after Foundational (Phase 2) - Extends basic component with props, independently testable
- **User Story 3 (P3)**: Can start after Foundational (Phase 2) - Adds gradient support, independently testable

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Registry updates before component usage
- Component implementation before integration
- Manual testing after automated tests pass
- Linting/type checking after implementation

### Parallel Opportunities

**Phase 1 (Setup)**: T001, T002, T003 can install in parallel; T004, T005, T006 can run in parallel after installs

**Phase 2 (Foundational)**: T008, T009, T012 can run in parallel

**User Story 1 Tests**: T014-T019 can all be written in parallel (different test cases)

**User Story 2 Implementation**: T034, T035, T036, T037 can run in parallel (different props)

**User Story 3 Tests**: T043-T046 can all be written in parallel

**Polish**: T058, T059, T060, T065, T066 can run in parallel

---

## Parallel Example: User Story 1

```bash
# Launch all tests for User Story 1 together:
T015: "Write unit test: renders icon from registry"
T016: "Write unit test: returns null for non-existent icon"
T017: "Write unit test: applies custom size"
T018: "Write unit test: applies custom color"
T019: "Write snapshot test for basic icon rendering"

# All write to same file but different test cases - can be done in parallel by AI
```

## Parallel Example: User Story 2

```bash
# Launch all prop implementations together:
T034: "Implement size prop handling"
T035: "Implement color prop handling with theme fallback"
T036: "Implement style prop pass-through"
T037: "Implement containerStyle prop handling"

# All in same file but independent props - can be done sequentially or in parallel branches
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (~30 minutes)
2. Complete Phase 2: Foundational (~1 hour)
3. Complete Phase 3: User Story 1 (~1.5 hours)
4. **STOP and VALIDATE**: Test logo on login screen independently
5. Can deploy MVP with just logo on login screen

**MVP Delivers**: Brand identity on login screen with Scani logo

### Incremental Delivery

1. Setup + Foundational → Foundation ready (~1.5 hours)
2. Add User Story 1 → Test independently → Deploy/Demo (MVP!) (~1.5 hours total: 3 hours)
3. Add User Story 2 → Test independently → Deploy/Demo (~1 hour total: 4 hours)
4. Add User Story 3 → Test independently → Deploy/Demo (~1 hour total: 5 hours)
5. Polish → Final validation (~1 hour total: 6 hours)

**Total Time**: 4-6 hours for complete feature

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together (~1.5 hours)
2. Once Foundational is done:
   - Developer A: User Story 1 (logo on login screen)
   - Developer B: User Story 2 (prop system)
   - Developer C: User Story 3 (gradient support)
3. Stories complete and integrate independently (~2 hours parallel)
4. Team completes Polish together (~1 hour)

**Parallel Time**: 4.5 hours total (vs 6 hours sequential)

---

## Task Summary

**Total Tasks**: 71

**Breakdown by Phase**:
- Phase 1 (Setup): 6 tasks
- Phase 2 (Foundational): 7 tasks (BLOCKS all stories)
- Phase 3 (User Story 1 - P1): 17 tasks (includes 6 tests)
- Phase 4 (User Story 2 - P2): 12 tasks (includes 3 tests)
- Phase 5 (User Story 3 - P3): 15 tasks (includes 4 tests)
- Phase 6 (Polish): 14 tasks

**Parallel Tasks**: 24 tasks marked [P] can run in parallel within their phase

**Test Coverage**: 13 test tasks ensuring 93%+ coverage (constitution requirement)

**Story Independence**: Each user story can be completed and tested independently after Phase 2

**MVP Scope**: Phases 1-3 deliver minimal viable feature (logo on login screen)

---

## Format Validation

✅ All tasks follow required format: `- [ ] [ID] [P?] [Story?] Description with file path`

✅ All Setup/Foundational tasks have NO story label

✅ All User Story tasks have appropriate [US1]/[US2]/[US3] labels

✅ All Polish tasks have NO story label

✅ All parallelizable tasks marked with [P]

✅ All task IDs sequential (T001-T071)

✅ All tasks include exact file paths

---

## Notes

- [P] tasks = different files or independent changes, no blocking dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Verify tests fail before implementing (TDD approach)
- Commit after each logical group of tasks
- Stop at any checkpoint to validate story independently
- Constitution compliance verified throughout (type safety, testing, Ignite patterns, theme system)

