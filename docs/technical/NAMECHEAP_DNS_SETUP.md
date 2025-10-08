# Namecheap DNS Setup for Scani on Render

**Provider**: Namecheap DNS Management  
**Date**: October 9, 2025  
**Services**: Frontend + Backend on Render

---

## 🎯 What We'll Set Up

Using your domain `scani.xyz`, we'll configure:
- **Frontend**: `app.scani.xyz` → Scani app
- **Backend**: `api.scani.xyz` → API endpoints
- **Root** (optional): `scani.xyz` → Redirect to `app.scani.xyz`

---

## 📋 Step-by-Step Guide

### Phase 1: Add Custom Domains in Render (Get DNS Records)

#### Step 1A: Add Frontend Domain

1. **Go to Frontend Service**:

   - Open: https://dashboard.render.com/static/srv-d3j8p37diees73fl6q30
   - Or: Dashboard → "scani-frontend" service

2. **Navigate to Settings**:

   - Click the **"Settings"** tab at the top

3. **Add Custom Domain**:

   - Scroll down to **"Custom Domains"** section
   - Click **"Add Custom Domain"** button
   - Enter: `app.scani.xyz` (or `www.scani.xyz` if you prefer)
   - Click **"Save"**

4. **Copy DNS Records**:
   - Render will show you DNS records to add
   - **Write down or screenshot**:
     ```
     Type: CNAME
     Name: app (or www)
     Value: scani-frontend.onrender.com
     ```

#### Step 1B: Add Backend Domain

1. **Go to Backend Service**:

   - Open: https://dashboard.render.com/web/srv-d3j88295pdvs739osbig
   - Or: Dashboard → "scani-backend-217c" service

2. **Navigate to Settings**:

   - Click the **"Settings"** tab at the top

3. **Add Custom Domain**:

   - Scroll down to **"Custom Domains"** section
   - Click **"Add Custom Domain"** button
   - Enter: `api.scani.xyz`
   - Click **"Save"**

4. **Copy DNS Records**:
   - Render will show you DNS records to add
   - **Write down or screenshot**:
     ```
     Type: CNAME
     Name: api
     Value: scani-backend-217c.onrender.com
     ```

---

### Phase 2: Configure DNS in Namecheap

#### Step 2A: Access Namecheap DNS Management

1. **Log in to Namecheap**:

   - Go to: https://www.namecheap.com
   - Click **"Sign In"** (top right)
   - Enter your credentials

2. **Navigate to Domain List**:

   - Click **"Domain List"** in the left sidebar
   - Or go to: https://ap.www.namecheap.com/domains/list/

3. **Open DNS Management**:

   - Find your domain (e.g., `scani.xyz`)
   - Click **"Manage"** button next to it

4. **Access Advanced DNS**:
   - Click the **"Advanced DNS"** tab
   - You'll see the DNS records table

#### Step 2B: Add Frontend CNAME Record

1. **Click "Add New Record"**:

   - Find the **"Host Records"** section
   - Click **"Add New Record"** button

2. **Configure Frontend Record**:

   - **Type**: Select `CNAME Record` from dropdown
   - **Host**: Enter `app` (or `www` if you chose that)
   - **Value**: Enter `scani-frontend.onrender.com.` (note the trailing dot)
   - **TTL**: Select `Automatic` or `1 min` (for faster testing)
   - Click the **green checkmark** ✓ to save

3. **Visual Reference**:
   ```
   [CNAME Record ▼] | [app] | [scani-frontend.onrender.com.] | [Automatic ▼] [✓]
   ```

#### Step 2C: Add Backend CNAME Record

1. **Click "Add New Record"** again

2. **Configure Backend Record**:

   - **Type**: Select `CNAME Record` from dropdown
   - **Host**: Enter `api`
   - **Value**: Enter `scani-backend-217c.onrender.com.` (note the trailing dot)
   - **TTL**: Select `Automatic` or `1 min`
   - Click the **green checkmark** ✓ to save

3. **Visual Reference**:
   ```
   [CNAME Record ▼] | [api] | [scani-backend-217c.onrender.com.] | [Automatic ▼] [✓]
   ```

#### Step 2D: (Optional) Add Root Domain Redirect

If you want `scani.xyz` to redirect to `app.scani.xyz`:

**Option A: URL Redirect Record (Easiest)**

1. **Click "Add New Record"**
2. **Configure**:
   - **Type**: Select `URL Redirect Record`
   - **Host**: Enter `@` (represents root domain)
   - **Value**: Enter `https://app.scani.xyz`
   - **Unmasked**: Select this option
   - **TTL**: Automatic
   - Click ✓

**Option B: Use Namecheap's Redirect Domain Feature**

1. Go to **"Domain"** tab (not Advanced DNS)
2. Find **"Redirect Domain"** section
3. Set redirect from `scani.xyz` → `https://app.scani.xyz`

#### Step 2E: Verify Your DNS Records

After adding records, your DNS table should look like:

```
Type          Host    Value                              TTL
─────────────────────────────────────────────────────────────────
CNAME Record  app     scani-frontend.onrender.com.       Automatic
CNAME Record  api     scani-backend-217c.onrender.com.   Automatic
URL Redirect  @       https://app.scani.xyz              Automatic
```

**⚠️ Important**: Make sure there are NO conflicting records:

- No A records for `app` or `api` hosts
- No other CNAME records for these hosts
- If they exist, delete them before adding new ones

---

### Phase 3: Wait for DNS Propagation

#### Step 3A: Save Changes

- Click **"Save All Changes"** button at the bottom of Namecheap DNS page
- Namecheap will confirm changes are saved

#### Step 3B: Wait for Propagation

- **Time**: Usually 5-30 minutes (can be up to 48 hours)
- **Namecheap is typically fast**: 10-15 minutes

#### Step 3C: Check DNS Propagation

**Using Online Tool**:

1. Go to: https://dnschecker.org
2. Check `app.scani.xyz` → Should point to `scani-frontend.onrender.com`
3. Check `api.scani.xyz` → Should point to `scani-backend-217c.onrender.com`

**Using Command Line**:

```bash
# Check frontend DNS
nslookup app.scani.xyz
# Should show: app.scani.xyz → scani-frontend.onrender.com

# Check backend DNS
nslookup api.scani.xyz
# Should show: api.scani.xyz → scani-backend-217c.onrender.com

# Alternative: use dig
dig app.scani.xyz CNAME
dig api.scani.xyz CNAME
```

---

### Phase 4: Verify in Render Dashboard

#### Step 4A: Check Domain Status

1. **Go to Frontend Service**:

   - https://dashboard.render.com/static/srv-d3j8p37diees73fl6q30
   - Click **Settings** → Scroll to **Custom Domains**
   - Status should change from "Verifying..." to **"Active"** ✅
   - SSL status should show **"Provisioned"** ✅

2. **Go to Backend Service**:
   - https://dashboard.render.com/web/srv-d3j88295pdvs739osbig
   - Click **Settings** → Scroll to **Custom Domains**
   - Status should show **"Active"** ✅
   - SSL status should show **"Provisioned"** ✅

#### Step 4B: SSL Certificate Provisioning

- **Automatic**: Render auto-provisions free SSL via Let's Encrypt
- **Time**: Usually 5-10 minutes after DNS verification
- **Status**: Check in Custom Domains section
- **No action needed**: Just wait for "Provisioned" status

---

### Phase 5: Update Application Configuration

#### Step 5A: Update Backend Environment Variables

1. **Go to Backend Service**:

   - https://dashboard.render.com/web/srv-d3j88295pdvs739osbig

2. **Navigate to Environment**:

   - Click **"Environment"** tab

3. **Update FRONTEND_URL**:

   - Find `FRONTEND_URL` variable
   - Click **Edit** (pencil icon)
   - Change value to: `https://app.scani.xyz`
   - Click **Save**

4. **Trigger Redeploy**:
   - After saving, backend will auto-redeploy
   - Or manually click **"Manual Deploy"** → **"Deploy latest commit"**

#### Step 5B: Update Frontend Environment Variables

1. **Go to Frontend Service**:

   - https://dashboard.render.com/static/srv-d3j8p37diees73fl6q30

2. **Navigate to Environment**:

   - Click **"Environment"** tab

3. **Update VITE_API_URL**:

   - Find `VITE_API_URL` variable
   - Click **Edit**
   - Change value to: `https://api.scani.xyz`
   - Click **Save**

4. **Trigger Redeploy**:
   - Frontend will auto-redeploy after env var change
   - Or manually deploy if needed

#### Step 5C: Update Supabase Configuration

1. **Go to Supabase Dashboard**:

   - https://supabase.com/dashboard
   - Select your Scani project

2. **Update Authentication Settings**:

   - Click **Authentication** → **URL Configuration**

3. **Update Site URL**:

   - Change from: `https://scani-frontend.onrender.com`
   - Change to: `https://app.scani.xyz`
   - Click **Save**

4. **Update Redirect URLs**:
   - Add: `https://app.scani.xyz/**`
   - Keep old URL if you want: `https://scani-frontend.onrender.com/**`
   - Click **Save**

---

### Phase 6: Test Everything

#### Step 6A: Test Frontend Access

1. **Open in Browser**:

   - Go to: `https://app.scani.xyz`
   - Should load your Scani app
   - Check for HTTPS padlock 🔒 (SSL working)
   - No certificate warnings

2. **Test HTTP Redirect**:
   - Try: `http://app.scani.xyz`
   - Should auto-redirect to HTTPS

#### Step 6B: Test Backend API

1. **Test Health Endpoint**:

   ```bash
   curl https://api.scani.xyz/health
   ```

   - Should return: `{"status":"ok","timestamp":"..."}`

2. **Open in Browser**:
   - Go to: `https://api.scani.xyz/health`
   - Should show JSON response
   - HTTPS padlock should be visible 🔒

#### Step 6C: Test Authentication Flow

1. **Go to Login**:

   - Visit: `https://app.scani.xyz`
   - Click login/signup

2. **Request Magic Link**:

   - Enter your email
   - Click "Send Magic Link"

3. **Check Email**:

   - Open the magic link email
   - Verify link points to: `https://app.scani.xyz/...`
   - Not `localhost` or `.onrender.com`

4. **Complete Login**:
   - Click the magic link
   - Should redirect to `https://app.scani.xyz`
   - Should complete authentication successfully
   - Check if you're logged in

#### Step 6D: Test API Communication

1. **Open Browser Console**:

   - Press F12 or Right-click → Inspect
   - Go to **Network** tab

2. **Perform Any Action**:

   - Create an account, add a transaction, etc.
   - Watch API calls in Network tab

3. **Verify**:
   - API calls should go to: `https://api.scani.xyz/trpc/...`
   - All should return 200 OK
   - No CORS errors

---

## ✅ Post-Setup Checklist

Go through this checklist to ensure everything is working:

- [ ] DNS records added in Namecheap
- [ ] `app.scani.xyz` resolves to `scani-frontend.onrender.com` (verify with nslookup)
- [ ] `api.scani.xyz` resolves to `scani-backend-217c.onrender.com` (verify with nslookup)
- [ ] Render shows "Active" status for frontend custom domain
- [ ] Render shows "Active" status for backend custom domain
- [ ] SSL certificates provisioned (shows "Provisioned" in Render)
- [ ] `https://app.scani.xyz` loads without SSL warnings
- [ ] `https://api.scani.xyz/health` returns JSON response
- [ ] Backend `FRONTEND_URL` updated to `https://app.scani.xyz`
- [ ] Frontend `VITE_API_URL` updated to `https://api.scani.xyz`
- [ ] Both services redeployed after env var updates
- [ ] Supabase Site URL updated to `https://app.scani.xyz`
- [ ] Supabase Redirect URLs includes `https://app.scani.xyz/**`
- [ ] Login flow works (magic link points to custom domain)
- [ ] Authentication completes successfully
- [ ] API calls work (no CORS errors)
- [ ] All features functional on custom domain

---

## 🚨 Common Issues & Solutions

### Issue 1: DNS Not Resolving After 30 Minutes

**Symptoms**: `nslookup app.scani.xyz` shows no results or old IP

**Solutions**:

1. Check Namecheap DNS records are saved (click "Save All Changes")
2. Verify no conflicting A records exist for the same host
3. Check host value is correct: `app` (not `app.scani.xyz`)
4. Check value has trailing dot: `scani-frontend.onrender.com.`
5. Try flushing your local DNS cache:

   ```bash
   # macOS
   sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder

   # Windows
   ipconfig /flushdns

   # Linux
   sudo systemd-resolve --flush-caches
   ```

### Issue 2: SSL Certificate Not Provisioning

**Symptoms**: Render shows "Verifying..." or "Failed" for SSL

**Solutions**:

1. Ensure DNS is fully propagated (check dnschecker.org)
2. Wait 30 minutes after DNS propagation
3. Remove and re-add custom domain in Render
4. Check for no CAA records blocking Let's Encrypt in Namecheap

### Issue 3: "This site can't be reached" Error

**Symptoms**: Browser shows connection error

**Solutions**:

1. DNS not propagated yet → Wait 30 more minutes
2. Check DNS with `nslookup` → Verify it points to Render
3. Check Render service is running (not suspended)
4. Try accessing via `.onrender.com` URL to verify service works

### Issue 4: CORS Errors After Domain Change

**Symptoms**: Browser console shows CORS policy errors

**Solutions**:

1. Update backend `FRONTEND_URL` to custom domain
2. Redeploy backend service
3. Clear browser cache and cookies
4. Try in incognito/private window

### Issue 5: Magic Links Still Going to Old URL

**Symptoms**: Email links point to `.onrender.com` or `localhost`

**Solutions**:

1. Update Supabase Site URL to custom domain
2. Request a NEW magic link (old ones cached)
3. Clear Supabase cache (wait 5 minutes or restart browser)
4. Check Redirect URLs includes custom domain with `/**`

### Issue 6: Namecheap Shows "Cannot Add Record" Error

**Symptoms**: Error when trying to save CNAME

**Solutions**:

1. Check for conflicting records (delete old A/CNAME for same host)
2. Ensure trailing dot in value: `.onrender.com.`
3. Host should be just `app` or `api`, not full domain
4. Check you're in "Advanced DNS" tab, not basic

---

## 📝 Quick Reference

### Your Services

- **Frontend ID**: srv-d3j8p37diees73fl6q30
- **Backend ID**: srv-d3j88295pdvs739osbig

### DNS Records to Add in Namecheap

```
Type: CNAME    Host: app    Value: scani-frontend.onrender.com.
Type: CNAME    Host: api    Value: scani-backend-217c.onrender.com.
```

### Environment Variables to Update

```bash
# Backend
FRONTEND_URL=https://app.scani.xyz

# Frontend
VITE_API_URL=https://api.scani.xyz
```

### Supabase Settings to Update

```
Site URL: https://app.scani.xyz
Redirect URLs: https://app.scani.xyz/**
```

---

## ⏱️ Timeline

- **Add DNS records**: 5 minutes
- **DNS propagation**: 10-30 minutes (Namecheap is fast)
- **SSL provisioning**: 5-10 minutes after DNS verified
- **Update configs**: 5 minutes
- **Redeploy services**: 3-5 minutes
- **Total time**: ~30-60 minutes

---

## 🎉 Success Criteria

You'll know everything is working when:

1. ✅ `https://app.scani.xyz` loads your app with HTTPS
2. ✅ `https://api.scani.xyz/health` returns JSON
3. ✅ Login magic link points to `app.scani.xyz`
4. ✅ Authentication works end-to-end
5. ✅ No CORS or SSL errors
6. ✅ All app features work on custom domain

---

**Ready to start?** Just replace `scani.xyz` with your actual domain throughout this guide!

**Questions?** The most common hang-up is DNS propagation time - be patient and use `nslookup` or dnschecker.org to verify before troubleshooting.

**Last updated**: October 9, 2025
