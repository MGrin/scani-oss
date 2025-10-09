# Supabase Email Templates Configuration

## Overview

Scani uses two different authentication flows:
1. **Magic Link** (for browser/desktop users) - Sends clickable link
2. **Email OTP** (for PWA/mobile users) - Sends 6-digit code

Supabase requires **separate email templates** for each flow.

## Template Files

- **Magic Link**: `apps/backend/email-templates/magic-link.html`
- **Email OTP**: `apps/backend/email-templates/email-otp.html`

## Supabase Configuration

### Step 1: Access Email Templates

1. Go to [Supabase Dashboard](https://supabase.com/dashboard)
2. Select your project
3. Navigate to **Authentication** → **Email Templates**

### Step 2: Configure Magic Link Template

1. Select **"Magic Link"** from the template dropdown
2. Copy the contents of `apps/backend/email-templates/magic-link.html`
3. Paste into the template editor
4. Click **Save**

**Available Variables:**
- `{{ .ConfirmationURL }}` - The magic link URL
- `{{ .SiteURL }}` - Your app URL (e.g., https://app.scani.xyz)
- `{{ .Email }}` - User's email address
- `{{ .Token }}` - Not used in magic link template

### Step 3: Configure Email OTP Template

1. Select **"Email OTP"** from the template dropdown (or "Email Change" if OTP isn't available)
2. Copy the contents of `apps/backend/email-templates/email-otp.html`
3. Paste into the template editor
4. Click **Save**

**Available Variables:**
- `{{ .Token }}` - The 6-digit verification code
- `{{ .SiteURL }}` - Your app URL (e.g., https://app.scani.xyz)
- `{{ .Email }}` - User's email address
- `{{ .ConfirmationURL }}` - Not used in OTP template

## How It Works

### For Browser Users (Desktop):

1. User enters email on login page
2. App detects: **NOT running as PWA**
3. Calls: `supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: '...' } })`
4. Supabase sends: **Magic Link email** (using magic-link.html template)
5. User clicks link in email
6. Opens in browser and authenticates

### For PWA Users (Mobile):

1. User enters email in PWA
2. App detects: **Running as PWA**
3. Calls: `supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } })`
4. Supabase sends: **Email OTP** (using email-otp.html template)
5. User enters 6-digit code in PWA
6. App calls: `supabase.auth.verifyOtp({ email, token, type: 'email' })`
7. Authenticates within PWA (no browser redirect!)

## Testing Templates

### Test Magic Link (Browser)

1. Open app in regular browser tab (not PWA)
2. Go to sign-in page
3. Enter email
4. Check email - should see **clickable button/link**
5. Click link - should authenticate in browser

### Test Email OTP (PWA)

1. Install PWA on mobile device
2. Open installed PWA app
3. Go to sign-in page  
4. Enter email
5. Check email - should see **6-digit code** in large text
6. Enter code in PWA - should authenticate in app

## Template Customization

### Branding

Both templates use:
- **Colors**: Purple gradient (#667eea to #764ba2)
- **Logo**: "Scani" text logo
- **Font**: System fonts (-apple-system, etc.)

To customize:
1. Update colors in `<style>` section
2. Replace logo text with `<img>` tag if needed
3. Adjust footer links and content

### Mobile Optimization

Both templates are responsive:
- Mobile breakpoint: 600px
- Touch-friendly buttons
- Readable font sizes
- Proper spacing

### Security Features

Both templates include:
- Expiry information (1 hour for link, 10 minutes for code)
- Security warning
- Clear instructions
- "Don't share" messaging

## Troubleshooting

### Issue: Not receiving emails

**Check:**
1. Supabase dashboard → Authentication → Email Settings
2. Verify SMTP settings or email provider
3. Check spam/junk folder
4. Verify email rate limits

### Issue: Wrong template used

**Cause**: Supabase picks template based on auth method called

**Fix:**
- Magic link: Ensure `emailRedirectTo` is set
- Email OTP: Ensure `emailRedirectTo` is NOT set

### Issue: Variables not rendering

**Check:**
- Variable names are exact: `{{ .Token }}` not `{{ .token }}`
- Template is saved in correct slot (Magic Link vs Email OTP)
- No syntax errors in HTML

### Issue: Styling not working in email client

**Note:** Email clients have limited CSS support

**Best practices:**
- Use inline styles for critical styling
- Test in multiple clients (Gmail, Outlook, Apple Mail)
- Keep layout simple
- Use tables for complex layouts (if needed)

## Supabase Dashboard Quick Links

- **Email Templates**: Authentication → Email Templates
- **SMTP Settings**: Project Settings → Auth → SMTP Settings  
- **Rate Limits**: Project Settings → Auth → Rate Limits
- **Email Provider**: Project Settings → Auth → Email Provider

## Resources

- [Supabase Email Templates Docs](https://supabase.com/docs/guides/auth/auth-email-templates)
- [Email Template Variables](https://supabase.com/docs/guides/auth/auth-email-templates#template-variables)
- [Testing Email Templates](https://supabase.com/docs/guides/auth/auth-email-templates#testing)
