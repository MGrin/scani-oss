# PWA Authentication Redirect Issue - Fix Guide

## Problem

When users click magic link emails from the PWA on their phone, they get redirected to the default browser instead of staying in the PWA app.

## Why This Happens

**This is expected behavior** on iOS and Android due to security restrictions:

1. **Email clients always open links in the default browser** (Safari on iOS, Chrome on Android)
2. **PWAs cannot intercept external links** without proper deep linking setup
3. **Universal Links (iOS) and App Links (Android)** require server-side configuration and verification

## Solutions

### Solution 1: User Education (Current State)

**Status**: ✅ Implemented

The PWA Auth Bridge component detects when authentication happens in the browser and guides users back to the PWA.

**How it works**:
1. User opens PWA and requests magic link
2. Email arrives, user clicks link
3. Link opens in browser (expected)
4. Auth succeeds in browser
5. App detects PWA is installed
6. Shows "Open Scani App" button
7. User taps button to return to PWA
8. Session is shared via Supabase cookies

**Limitations**:
- Requires one extra tap from user
- Session sharing relies on browser cookies
- Not ideal UX but works reliably

### Solution 2: Universal Links / App Links (Advanced)

**Status**: ⚠️ Requires Server Configuration

For links to open directly in PWA, you need to configure Universal Links (iOS) and App Links (Android).

#### Requirements

1. **HTTPS with valid SSL certificate** ✅ (app.scani.xyz has this)
2. **Proper `.well-known` files** ✅ (Already created)
3. **Files served at root domain** ⚠️ (Needs verification)
4. **Correct MIME types** ⚠️ (Needs verification)
5. **Apple/Google verification** ❌ (Not yet done)

#### Step 1: Verify `.well-known` Files Are Accessible

Test that these URLs return the correct files:

```bash
# For iOS Universal Links
curl -I https://app.scani.xyz/.well-known/apple-app-site-association

# Expected:
# HTTP/2 200
# content-type: application/json (or application/pkcs7-mime)

# For Android App Links
curl -I https://app.scani.xyz/.well-known/assetlinks.json

# Expected:
# HTTP/2 200
# content-type: application/json
```

If these don't return 200, your server isn't serving the files correctly.

#### Step 2: Configure Server Headers

Your server (Render) needs to serve these files with correct headers:

**For Nginx** (if you have access):
```nginx
location /.well-known/apple-app-site-association {
    default_type application/json;
    add_header Content-Type application/json;
    add_header Access-Control-Allow-Origin *;
}

location /.well-known/assetlinks.json {
    default_type application/json;
    add_header Content-Type application/json;
    add_header Access-Control-Allow-Origin *;
}
```

**For Static Sites on Render**:
Add a `render.yaml` configuration or use headers configuration in your deployment settings.

#### Step 3: Update Apple App Site Association

The current file uses wildcard `appIDs: ["*"]` which won't work. You need actual app IDs:

**For PWA** (since you don't have native app):
```json
{
  "applinks": {
    "apps": [],
    "details": [
      {
        "appID": "TEAMID.com.scani.app",
        "paths": ["/auth/callback", "/auth/*"]
      }
    ]
  },
  "webcredentials": {
    "apps": ["TEAMID.com.scani.app"]
  }
}
```

**Note**: PWAs don't have traditional app IDs, so universal links may not work as expected. This is primarily for native apps.

#### Step 4: Test Universal Links

Use Apple's validator:
```bash
# iOS Universal Links Validator
curl -I https://app.scani.xyz/.well-known/apple-app-site-association
```

Or use: https://search.developer.apple.com/appsearch-validation-tool/

### Solution 3: Alternative Auth Flow (Recommended)

Instead of relying on email links to open in PWA, modify the auth flow:

#### Option A: In-App Magic Code

1. User requests auth in PWA
2. Email contains a **6-digit code** instead of link
3. User enters code in PWA
4. Auth completes without leaving app

**Implementation**:
```typescript
// In AuthContext
const authenticateWithCode = async (email: string) => {
  // Use Supabase OTP with code instead of email link
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      // Don't send email link, send code
    }
  });
};
```

#### Option B: QR Code Auth

1. User opens PWA on phone
2. Scans QR code from desktop/email
3. Auth completes in PWA without browser redirect

### Solution 4: Deep Link Improvements

Even without full Universal Links, we can improve the deep linking:

#### Use Custom URL Scheme

Add a custom scheme to manifest.json:

```json
{
  "protocol_handlers": [
    {
      "protocol": "web+scani",
      "url": "/auth/callback?token=%s"
    }
  ]
}
```

Then modify auth emails to use: `web+scani://auth/callback?token=...`

**Note**: This requires browser support and may not work on all platforms.

## Current Recommendation

**For immediate use**: Stick with Solution 1 (PWA Auth Bridge)

**Reasons**:
1. ✅ Works reliably across all platforms
2. ✅ No server configuration required
3. ✅ Session sharing via Supabase works well
4. ✅ Only requires one extra tap from user
5. ✅ Better than auth failing completely

**For future improvement**: Consider Solution 3A (Magic Code)

**Reasons**:
1. ✅ No browser redirect needed
2. ✅ Better UX for mobile users
3. ✅ More secure (code expires quickly)
4. ✅ Industry standard (many banking apps use this)

## Testing the Current Implementation

1. **Install PWA on phone** (iOS Safari or Android Chrome)
2. **Open PWA** and go to sign in
3. **Enter email** and request magic link
4. **Check email** on phone
5. **Click link** - it will open in browser (expected)
6. **Verify auth succeeds** in browser
7. **See "Open Scani App" button**
8. **Tap button** to return to PWA
9. **Verify you're signed in** in PWA

## Troubleshooting

### Issue: Session not shared between browser and PWA

**Cause**: Supabase cookies not shared across contexts

**Fix**: 
- Ensure same domain for both browser and PWA
- Check cookie settings in Supabase dashboard
- Verify HTTPS is enabled

### Issue: "Open Scani App" button doesn't work

**Cause**: Deep link not configured or PWA not installed

**Fix**:
- Verify PWA is actually installed (check home screen)
- Try using direct URL: `https://app.scani.xyz/`
- On iOS: Hold link, select "Open in Scani"

### Issue: Always opens in browser, never detects PWA

**Cause**: PWA detection logic not working

**Check**:
1. Open browser console
2. Run: `window.matchMedia('(display-mode: standalone)').matches`
3. Should return `true` in PWA, `false` in browser

## Next Steps

1. **Test current implementation** on real devices
2. **Gather user feedback** on auth flow
3. **Consider implementing magic code** if users find current flow cumbersome
4. **Monitor Supabase auth logs** for any failures
5. **Document the flow** in user onboarding

## References

- [iOS Universal Links](https://developer.apple.com/ios/universal-links/)
- [Android App Links](https://developer.android.com/training/app-links)
- [PWA Deep Linking](https://web.dev/pwa-url-handler/)
- [Supabase Auth Docs](https://supabase.com/docs/guides/auth)
- [Web App Manifest Protocol Handlers](https://developer.mozilla.org/en-US/docs/Web/Manifest/protocol_handlers)
