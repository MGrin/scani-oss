# Scani Mobile (Kotlin Multiplatform)

Native iOS (SwiftUI) and Android (Jetpack Compose) apps sharing a Kotlin
business-logic module (`shared/`).

## Layout

- `shared/` — KMP module holding cross-platform Kotlin: today just a
  platform-aware `Greeting` (an `expect`/`actual` scaffold). It will grow to own
  the business logic, networking, local data, and sync that both apps call.
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

## Networking

`shared/` talks to the backend's tRPC API over a small hand-written Ktor client
(`shared/src/commonMain/kotlin/xyz/scani/mobile/shared/network/`):

- `TrpcClient.query<T>(procedure, input?)` — `GET /trpc/<procedure>`, unwraps the
  tRPC `{result:{data}}` envelope, throws `TrpcException` on the `{error}` shape.
- Per-procedure APIs (e.g. `SystemApi.ping()`) expose typed models.
- The HTTP engine is **injected** — the apps supply a platform engine
  (Darwin on iOS, OkHttp/Android on Android); tests supply Ktor `MockEngine`.
  Platform-engine wiring in the app modules is deferred to the first feature that makes a live network call.

Models are hand-maintained against `apps/backend/api/openapi/scani-openapi.json`
(the spec↔router contract is CI-checked on the backend). A spike found no KMP
OpenAPI generator that fits the tRPC-shaped spec without a GPL / Arrow / crash
cost; codegen can be revisited as the surface grows.

## Notes

- This is **OSS-eligible** source — author changes against `MGrin/scani-oss`
  first (the OSS repo is upstream; private merges down from it).
- **Not a Bun workspace** — it's a Gradle project and is intentionally excluded
  from the root `package.json` workspaces.
- **Test layout:** KMP fixes test source sets at `src/commonTest`, `src/androidHostTest`,
  etc., so these tests do not follow the monorepo's TypeScript `tests/`-next-to-`src/`
  convention — the Gradle/KMP toolchain owns the layout.
- The `shared` module's Android side uses Google's AGP-9
  `com.android.kotlin.multiplatform.library` plugin (the modern replacement for
  `com.android.library` + `androidTarget {}`, which errors on AGP 9).
- `ios/project.yml`'s framework pre-build script sets
  `basedOnDependencyAnalysis: false` **intentionally** — it always re-runs the
  (fast, cached) Gradle `embedAndSignAppleFrameworkForXcode` task so the linked
  `Shared.framework` never goes stale. Don't flip it to `true`.
