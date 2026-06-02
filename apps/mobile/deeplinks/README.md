# Deep-link domain verification (handoff)

Universal/App-Link verification requires serving these files from the production
domain and filling in two values that aren't in this repo:

- `apple-app-site-association` → serve at
  `https://app.scani.xyz/.well-known/apple-app-site-association`
  (`Content-Type: application/json`, **no redirect**, **no `.json` extension**).
  Replace `TEAMID` with the Apple Developer **Team ID**.
- `assetlinks.json` → serve at
  `https://app.scani.xyz/.well-known/assetlinks.json`.
  Replace `REPLACE_WITH_SIGNING_CERT_SHA256` with the **release signing cert's
  SHA-256 fingerprint** (`keytool -list -v -keystore <release.keystore>`).

Serving is owned by whoever controls `app.scani.xyz` (a private/infra change —
not part of this OSS repo). The mobile side is already wired:
- iOS: `applinks:app.scani.xyz` in `ios/iosApp/iosApp.entitlements`; `.onOpenURL`
  routes via the shared `DeepLinks.parse`.
- Android: `autoVerify` intent-filter for `app.scani.xyz` in the manifest;
  `MainActivity` parses the launch URI via `DeepLinks.parse`.

Until both files are served + filled, links open the browser instead of the app;
in-app routing (`DeepLinks.parse`) already handles any URL the OS hands us.
