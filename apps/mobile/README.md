# Scani Mobile (Kotlin Multiplatform)

Native iOS (SwiftUI) and Android (Jetpack Compose) apps sharing a Kotlin
business-logic module (`shared/`).

## Layout

- `shared/` — KMP module (logic, networking, data, sync). The only place
  business logic lives; both apps call the same use-cases.
- `android/` — Jetpack Compose application.
- `ios/` — SwiftUI application. The Xcode project is **generated** by XcodeGen
  from `ios/project.yml` (and git-ignored); it consumes `shared` as an embedded
  framework.

## Toolchain

- **JDK 17** — `brew install openjdk@17` (required by AGP 9.2). Set
  `JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home`.
- **Android SDK** — `brew install --cask android-commandlinetools`, then
  `sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"`
  and accept licenses (`sdkmanager --licenses`). Set `ANDROID_HOME`.
- **Xcode 26+** and **XcodeGen** (`brew install xcodegen`) for iOS.

Dependency versions are pinned in `gradle/libs.versions.toml`
(Kotlin 2.3.0 · AGP 9.2.0 · Gradle 9.5.1 · compileSdk 36 · Compose BOM 2026.05.01).

## Build

```bash
# Shared unit tests on the Android host (JVM).
# On macOS you can run every target's tests with: ./gradlew :shared:allTests
./gradlew :shared:testAndroidHostTest

# Android debug APK
./gradlew :android:assembleDebug

# iOS (from ios/) — regenerate the project, then build for the simulator
cd ios && xcodegen generate
xcodebuild -project iosApp.xcodeproj -scheme iosApp \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' build
```

## Notes

- This is **OSS-eligible** source — author changes against `MGrin/scani-oss`
  first (the OSS repo is upstream; private merges down from it).
- **Not a Bun workspace** — it's a Gradle project and is intentionally excluded
  from the root `package.json` workspaces.
- The `shared` module's Android side uses Google's AGP-9
  `com.android.kotlin.multiplatform.library` plugin (the modern replacement for
  `com.android.library` + `androidTarget {}`, which errors on AGP 9).
- `ios/project.yml`'s framework pre-build script sets
  `basedOnDependencyAnalysis: false` **intentionally** — it always re-runs the
  (fast, cached) Gradle `embedAndSignAppleFrameworkForXcode` task so the linked
  `Shared.framework` never goes stale. Don't flip it to `true`.
