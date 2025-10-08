# Fix Supabase Magic Link Redirect to Production URL

## Issue
Supabase magic link emails are redirecting to `localhost:5173` instead of the production frontend URL.

## Root Cause
Supabase stores the **Site URL** and **Redirect URLs** in the project's authentication configuration. These were set to localhost during development and need to be updated for production deployment.

## Solution

### Step 1: Get Your Production Frontend URL
Your frontend should be deployed on Render at a URL like:
- `https://scani-frontend.onrender.com` (or similar)

### Step 2: Update Supabase Authentication Settings

1. **Go to Supabase Dashboard**
   - Navigate to: https://supabase.com/dashboard
   - Select your Scani project

2. **Open Authentication Settings**
   - In the left sidebar, click **Authentication**
   - Click **URL Configuration**

3. **Update Site URL**
   - Find the **Site URL** field
   - Change from: `http://localhost:5173`
   - Change to: `https://your-frontend-url.onrender.com`
   - Example: `https://scani-frontend.onrender.com`

4. **Update Redirect URLs**
   - Find the **Redirect URLs** section
   - Add your production URL to the allowed list:
     ```
     https://your-frontend-url.onrender.com/**
     ```
   - Keep localhost for local development (optional):
     ```
     http://localhost:5173/**
     ```
   
5. **Save Changes**
   - Click **Save** at the bottom of the page
   - Changes take effect immediately

### Step 3: Verify the Fix

1. **Request a new magic link**
   - Go to your production login page
   - Enter your email
   - Click "Send Magic Link"

2. **Check your email**
   - Open the magic link email
   - Hover over the link (don't click yet)
   - Verify the URL shows your production domain
   - Example: `https://your-frontend-url.onrender.com/auth/callback?token=...`

3. **Test the login**
   - Click the magic link
   - Should redirect to production, not localhost
   - Should complete authentication successfully

## Additional Configuration (Optional)

### Email Templates
If you want to customize the magic link email:

1. **Go to Authentication → Email Templates**
2. **Select "Magic Link"**
3. **Edit the template** (the `{{ .SiteURL }}` variable will use your Site URL)
4. **Save**

### Multiple Environments
To support both development and production:

**Redirect URLs** (add both):
```
http://localhost:5173/**
http://localhost:3000/**
https://your-staging-url.onrender.com/**
https://your-production-url.onrender.com/**
```

**Site URL** should be your primary production URL.

## Troubleshooting

### Problem: Still redirecting to localhost
**Solution**: 
- Clear your browser cache
- Request a NEW magic link (old ones cache the redirect)
- Wait 1-2 minutes for Supabase changes to propagate

### Problem: "Invalid redirect URL" error
**Solution**:
- Verify the URL in Redirect URLs ends with `/**`
- Check for typos in the domain
- Ensure protocol matches (http vs https)

### Problem: Magic link doesn't work at all
**Solution**:
- Check that your frontend has `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` env vars
- Verify the backend has `SUPABASE_URL` and `SUPABASE_ANON_KEY`
- Check browser console for errors

## Environment Variables Reference

Your Render services should have these environment variables:

### Frontend (Static Site)
```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGc...your-anon-key...
VITE_API_URL=https://your-backend-url.onrender.com
```

### Backend (Web Service)
```bash
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=eyJhbGc...your-anon-key...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGc...your-service-role-key...
FRONTEND_URL=https://your-frontend-url.onrender.com
```

The `FRONTEND_URL` is used for CORS configuration, not for Supabase redirects.

## Status
- Issue: Magic link redirects to localhost
- Action Required: Update Supabase dashboard settings
- Location: Supabase Dashboard → Authentication → URL Configuration
- Time to Fix: ~2 minutes

## Next Steps After Fix

1. ✅ Update Supabase Site URL
2. ✅ Update Supabase Redirect URLs
3. ✅ Test magic link in production
4. ✅ Verify authentication flow works end-to-end
5. 📝 Document your production URLs for future reference
