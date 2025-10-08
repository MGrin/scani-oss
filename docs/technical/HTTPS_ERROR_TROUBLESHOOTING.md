# HTTPS Error Troubleshooting for scani.xyz

**Issue**: SSL handshake failure when accessing `https://app.scani.xyz` or `https://api.scani.xyz`  
**Date**: October 9, 2025  
**Status**: DNS working ✅, SSL not provisioned yet ⏳

---

## ✅ What's Working

DNS is correctly configured and propagated:
```
app.scani.xyz → scani-frontend.onrender.com ✓
api.scani.xyz → scani-backend-217c.onrender.com ✓
```

---

## ❌ The Problem

**SSL Error**: `SSL routines:ST_CONNECT:sslv3 alert handshake failure`

**What this means**: Render hasn't provisioned the SSL certificate yet, or there's a configuration issue.

---

## 🔍 Diagnosis Steps

### Step 1: Check Custom Domain Status in Render

You need to verify the custom domains were added correctly:

#### Frontend Service
1. Go to: https://dashboard.render.com/static/srv-d3j8p37diees73fl6q30
2. Click **"Settings"** tab
3. Scroll to **"Custom Domains"** section
4. Check if `app.scani.xyz` is listed
5. Check the status:
   - ✅ **"Active"** with SSL "Provisioned" = Good
   - ⏳ **"Verifying..."** = Wait 10-30 more minutes
   - ❌ **"Failed"** or not listed = Need to add/re-add domain

#### Backend Service
1. Go to: https://dashboard.render.com/web/srv-d3j88295pdvs739osbig
2. Click **"Settings"** tab
3. Scroll to **"Custom Domains"** section
4. Check if `api.scani.xyz` is listed
5. Check the status (same as above)

---

## 🛠️ Solutions

### Solution 1: Domains Not Added in Render

If the custom domains are **not listed** in Render:

1. **Add Frontend Domain**:
   - Go to frontend service settings
   - Custom Domains → **Add Custom Domain**
   - Enter: `app.scani.xyz`
   - Click **Save**

2. **Add Backend Domain**:
   - Go to backend service settings
   - Custom Domains → **Add Custom Domain**
   - Enter: `api.scani.xyz`
   - Click **Save**

3. **Wait 10-30 minutes** for SSL to provision

### Solution 2: SSL Still Provisioning

If domains show **"Verifying..."**:

**This is normal!** SSL provisioning takes time:
- **First verification**: 5-30 minutes after DNS propagates
- **SSL issuance**: Additional 5-10 minutes

**What to do**: 
- ✅ Wait patiently
- ✅ Check back in 30 minutes
- ✅ DNS is working, so SSL will come
- ❌ Don't remove/re-add yet (will reset the timer)

### Solution 3: SSL Failed to Provision

If domains show **"Failed"** or still verifying after 60 minutes:

#### Option A: Remove and Re-add
1. In Render service settings → Custom Domains
2. Click the **X** or **Remove** next to the domain
3. Wait 5 minutes
4. **Add it back** (Custom Domains → Add Custom Domain)
5. Enter the domain again
6. Wait 30 minutes for new SSL attempt

#### Option B: Check for Conflicting DNS Records
1. Go to Namecheap DNS management
2. Check for conflicting records:
   - Multiple CNAME records for `app` or `api`
   - A records for `app` or `api`
   - CAA records blocking Let's Encrypt
3. Delete any conflicts
4. Wait 15 minutes for DNS to clear
5. Try removing/re-adding domain in Render

### Solution 4: Check for DNS Conflicts

Verify your Namecheap DNS has ONLY these records:

```
Type: CNAME    Host: app    Value: scani-frontend.onrender.com.
Type: CNAME    Host: api    Value: scani-backend-217c.onrender.com.
```

**Remove any**:
- A records for `app` or `api`
- Other CNAME records for these hosts
- Proxy/CDN settings (must be DNS only)

---

## 🕐 Timeline

Normal SSL provisioning timeline:

1. **DNS added**: Immediate
2. **DNS propagated**: 10-30 minutes (✅ Already done)
3. **Render verifies DNS**: 5-15 minutes
4. **Let's Encrypt issues SSL**: 5-10 minutes
5. **Total from DNS**: 20-55 minutes

**Current status**: DNS is good, waiting for SSL

---

## 📝 What You Should Do Now

### Immediate Actions

1. **Check Render Dashboard**:
   - Visit both service settings pages
   - Verify `app.scani.xyz` and `api.scani.xyz` are listed
   - Note the status (Active/Verifying/Failed)

2. **If domains are NOT listed**:
   - Add them now (see Solution 1)
   - Wait 30 minutes

3. **If domains show "Verifying..."**:
   - This is normal
   - Wait 30 more minutes
   - Check back periodically

4. **If domains show "Failed"**:
   - Remove and re-add (see Solution 3A)
   - Check DNS for conflicts (see Solution 3B)

### What NOT to Do

- ❌ Don't keep removing/re-adding domains (resets timer)
- ❌ Don't change DNS records (they're correct)
- ❌ Don't panic - SSL provisioning takes time
- ❌ Don't access via HTTPS yet (wait for SSL)

### Temporary Workaround

While waiting for SSL, you can test via the `.onrender.com` URLs:
- Frontend: https://scani-frontend.onrender.com
- Backend: https://scani-backend-217c.onrender.com/health

These already have SSL and should work immediately.

---

## ✅ Success Indicators

You'll know SSL is ready when:

1. **Render Dashboard**: 
   - Custom domains show **"Active"** ✅
   - SSL shows **"Provisioned"** ✅

2. **Command Line**:
   ```bash
   curl -I https://app.scani.xyz
   # Should return: HTTP/2 200 (or 301/302)
   # Not: SSL handshake error
   ```

3. **Browser**:
   - `https://app.scani.xyz` loads without warnings
   - 🔒 Padlock icon appears
   - Certificate valid (issued by Let's Encrypt)

---

## 🔄 Next Steps After SSL Works

Once SSL is provisioned:

1. **Update Backend Environment Variable**:
   ```bash
   FRONTEND_URL=https://app.scani.xyz
   ```

2. **Update Frontend Environment Variable**:
   ```bash
   VITE_API_URL=https://api.scani.xyz
   ```

3. **Update Supabase Settings**:
   - Site URL: `https://app.scani.xyz`
   - Redirect URLs: `https://app.scani.xyz/**`

4. **Redeploy Both Services**

5. **Test Everything**:
   - Login flow
   - API calls
   - All features

---

## 📞 Current Status Summary

**What's Working**: ✅
- DNS resolution (app.scani.xyz → Render)
- DNS resolution (api.scani.xyz → Render)
- Render services are running
- .onrender.com URLs have SSL

**What's Pending**: ⏳
- SSL certificate provisioning for custom domains
- Waiting for Let's Encrypt to issue certificates

**What You Need to Do**: 
1. Check Render dashboard for custom domain status
2. If not added, add them now
3. If verifying, wait patiently (30 min)
4. If failed, remove and re-add

**Expected resolution**: 30-60 minutes from now

---

## 🚨 Still Having Issues?

If after 60 minutes you still have SSL errors:

1. **Screenshot the Custom Domains section** in Render
2. **Screenshot your Namecheap DNS records**
3. **Check Render service logs** for any SSL-related errors
4. **Try the .onrender.com URLs** to verify services work
5. **Consider opening Render support ticket** (if on paid plan)

---

**Last updated**: October 9, 2025  
**DNS Status**: ✅ Working  
**SSL Status**: ⏳ Pending provisioning
