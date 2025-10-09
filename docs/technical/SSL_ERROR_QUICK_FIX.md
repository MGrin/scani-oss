# Quick Fix: ERR_SSL_VERSION_OR_CIPHER_MISMATCH for scani.xyz

**Current Issue**: `ERR_SSL_VERSION_OR_CIPHER_MISMATCH` when accessing `https://app.scani.xyz`  
**Quick Answer**: Custom domain not added in Render dashboard yet

---

## 🎯 The Cause

You've correctly configured DNS in Namecheap, but **you also need to add the custom domain in Render's dashboard**. Just having DNS isn't enough - Render needs to know about your custom domain to provision SSL.

**Proof**: `https://scani-frontend.onrender.com` works fine (SSL is good), but `https://app.scani.xyz` fails (no SSL).

---

## ✅ The Fix (5 minutes)

### Step 1: Add Custom Domain in Render Frontend

1. **Open Render Dashboard**:
   - Go to: https://dashboard.render.com/static/srv-d3j8p37diees73fl6q30
   - Or: Dashboard → Select "scani-frontend"

2. **Go to Settings**:
   - Click the **"Settings"** tab at the top

3. **Add Custom Domain**:
   - Scroll down to **"Custom Domains"** section
   - Click **"Add Custom Domain"** button
   - Enter: `app.scani.xyz`
   - Click **"Save"**

4. **Verify**:
   - You should see `app.scani.xyz` listed
   - Status will show "Verifying..."
   - This is normal!

### Step 2: Add Custom Domain in Render Backend

1. **Open Backend Service**:
   - Go to: https://dashboard.render.com/web/srv-d3j88295pdvs739osbig
   - Or: Dashboard → Select "scani-backend-217c"

2. **Go to Settings → Custom Domains**

3. **Add Domain**:
   - Click **"Add Custom Domain"**
   - Enter: `api.scani.xyz`
   - Click **"Save"**

### Step 3: Wait for SSL Provisioning

After adding the domains, Render will:
1. ✅ Verify DNS (instant - already done)
2. ⏳ Request SSL from Let's Encrypt (5-10 min)
3. ⏳ Install SSL certificate (5-10 min)
4. ✅ Update status to "Active" with "SSL: Provisioned"

**Total wait time**: 20-30 minutes

---

## 🕐 What to Expect

### Immediate (0-2 minutes)
- Custom domain appears in dashboard
- Status: "Verifying..."
- SSL: Not yet

### After 10-15 minutes
- Status may still show "Verifying..."
- This is normal - SSL takes time
- Don't panic, don't remove/re-add

### After 20-30 minutes
- Status: "Active" ✅
- SSL: "Provisioned" ✅
- `https://app.scani.xyz` works!
- No more SSL errors

---

## 🔍 How to Check Progress

### In Render Dashboard

**Frontend Service**: https://dashboard.render.com/static/srv-d3j8p37diees73fl6q30
- Settings → Custom Domains
- Look for `app.scani.xyz`
- Check status:
  - ⏳ "Verifying..." = Wait
  - ✅ "Active" + "SSL: Provisioned" = Ready!
  - ❌ "Failed" = Remove and re-add

**Backend Service**: https://dashboard.render.com/web/srv-d3j88295pdvs739osbig
- Same process for `api.scani.xyz`

### Using Command Line

```bash
# Test SSL connection
curl -I https://app.scani.xyz

# If still waiting for SSL:
# curl: (35) SSL handshake failure

# When SSL is ready:
# HTTP/2 200
```

---

## ✅ Success Criteria

You'll know it's working when:

1. **Render Dashboard Shows**:
   - `app.scani.xyz` - Status: Active, SSL: Provisioned ✅
   - `api.scani.xyz` - Status: Active, SSL: Provisioned ✅

2. **Browser Test**:
   ```
   https://app.scani.xyz
   ```
   - Loads without errors
   - Shows 🔒 padlock icon
   - No certificate warnings

3. **Command Line Test**:
   ```bash
   curl -I https://app.scani.xyz
   # Returns: HTTP/2 200
   
   curl https://api.scani.xyz/health
   # Returns: {"status":"ok",...}
   ```

---

## 🚨 What If It's Taking Too Long?

### After 30 Minutes Still "Verifying..."

1. **Remove the domain**:
   - Render → Service Settings → Custom Domains
   - Click X or Remove next to the domain
   
2. **Wait 5 minutes**

3. **Add it back**:
   - Same process as above
   - This resets the SSL provisioning

### After 60 Minutes Still Not Working

**Check for these issues**:

1. **DNS Conflicts in Namecheap**:
   - Go to Namecheap → Advanced DNS
   - Verify ONLY these records exist:
     ```
     CNAME  app  scani-frontend.onrender.com.
     CNAME  api  scani-backend-217c.onrender.com.
     ```
   - Delete any A records for `app` or `api`
   - Delete any other CNAME records for these hosts

2. **CAA Records Blocking Let's Encrypt**:
   - In Namecheap Advanced DNS
   - Check for CAA records
   - If exists, ensure Let's Encrypt is allowed
   - Or remove CAA records entirely

3. **Render Service Issues**:
   - Check service is running (not suspended)
   - Check no maintenance mode
   - Try accessing via `.onrender.com` to verify service works

---

## 🎯 Bottom Line

**Current State**:
- ✅ DNS: Working perfectly
- ✅ Services: Running fine on `.onrender.com`
- ❌ SSL: Not provisioned for custom domain yet

**What You Need to Do**:
1. Add `app.scani.xyz` in Render frontend service settings
2. Add `api.scani.xyz` in Render backend service settings
3. Wait 30 minutes for SSL to provision
4. Test `https://app.scani.xyz`

**Why This Happens**:
- Namecheap DNS tells the internet where to route traffic
- Render custom domains tell Render to provision SSL
- Both are needed for HTTPS to work

**Time Required**:
- Adding domains: 2 minutes
- Waiting for SSL: 30 minutes
- Total: ~32 minutes

---

## 📞 Need More Help?

See the complete troubleshooting guide:
**`docs/technical/HTTPS_ERROR_TROUBLESHOOTING.md`**

---

**Last Updated**: October 9, 2025  
**Status**: Waiting for custom domains to be added in Render  
**Next Step**: Add domains in Render dashboard, then wait
