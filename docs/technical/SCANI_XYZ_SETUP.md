# Scani.xyz - DNS Configuration Quick Reference

**Domain**: scani.xyz  
**Provider**: Namecheap  
**Date**: October 9, 2025

---

## 🎯 Your Custom Domains

- **Frontend**: `app.scani.xyz` → Scani application
- **Backend**: `api.scani.xyz` → API server
- **Root** (optional): `scani.xyz` → Redirect to `app.scani.xyz`

---

## 📋 Step-by-Step Setup

### Step 1: Add Custom Domains in Render

1. **Frontend Service**:

   - URL: https://dashboard.render.com/static/srv-d3j8p37diees73fl6q30
   - Settings → Custom Domains → Add: `app.scani.xyz`

2. **Backend Service**:
   - URL: https://dashboard.render.com/web/srv-d3j88295pdvs739osbig
   - Settings → Custom Domains → Add: `api.scani.xyz`

### Step 2: Add DNS Records in Namecheap

**Log in**: https://www.namecheap.com  
**Domain List** → Manage `scani.xyz` → **Advanced DNS**

Add these records:

```
Type: CNAME    Host: app    Value: scani-frontend.onrender.com.        TTL: Automatic
Type: CNAME    Host: api    Value: scani-backend-217c.onrender.com.    TTL: Automatic
Type: URL      Host: @      Value: https://app.scani.xyz               TTL: Automatic
   Redirect                 (Unmasked redirect)
```

**⚠️ Important**:

- Include the trailing dot in CNAME values: `.onrender.com.`
- Host is just `app` or `api`, not the full domain
- Delete any conflicting A or CNAME records first

### Step 3: Wait for DNS (10-30 minutes)

Check propagation:

```bash
nslookup app.scani.xyz
nslookup api.scani.xyz
```

Or use: https://dnschecker.org

### Step 4: Update Environment Variables

**Backend** (srv-d3j88295pdvs739osbig):

```bash
FRONTEND_URL=https://app.scani.xyz
```

**Frontend** (srv-d3j8p37diees73fl6q30):

```bash
VITE_API_URL=https://api.scani.xyz
```

**Supabase** (https://supabase.com/dashboard):

- Site URL: `https://app.scani.xyz`
- Redirect URLs: Add `https://app.scani.xyz/**`

### Step 5: Redeploy Services

Render will auto-redeploy after env var changes, or manually deploy both services.

### Step 6: Test

- Visit: `https://app.scani.xyz` ✓
- Visit: `https://api.scani.xyz/health` ✓
- Test login with magic link ✓

---

## ✅ Checklist

- [ ] Added `app.scani.xyz` in Render frontend service
- [ ] Added `api.scani.xyz` in Render backend service
- [ ] Added CNAME record: `app` → `scani-frontend.onrender.com.`
- [ ] Added CNAME record: `api` → `scani-backend-217c.onrender.com.`
- [ ] Added URL redirect: `@` → `https://app.scani.xyz`
- [ ] Clicked "Save All Changes" in Namecheap
- [ ] DNS propagated (verified with nslookup)
- [ ] Render shows "Active" status for both domains
- [ ] SSL certificates provisioned automatically
- [ ] Updated backend FRONTEND_URL
- [ ] Updated frontend VITE_API_URL
- [ ] Updated Supabase Site URL
- [ ] Updated Supabase Redirect URLs
- [ ] Both services redeployed
- [ ] `https://app.scani.xyz` loads correctly
- [ ] `https://api.scani.xyz/health` returns JSON
- [ ] Login works with magic link
- [ ] No CORS or SSL errors

---

## 🔗 Quick Links

### Render Services

- Frontend: https://dashboard.render.com/static/srv-d3j8p37diees73fl6q30
- Backend: https://dashboard.render.com/web/srv-d3j88295pdvs739osbig

### DNS Management

- Namecheap: https://ap.www.namecheap.com/domains/list/
- Direct to scani.xyz: https://ap.www.namecheap.com/Domains/DomainControlPanel/scani.xyz/advancedns

### Supabase

- Dashboard: https://supabase.com/dashboard
- Auth Settings: Authentication → URL Configuration

### Testing Tools

- DNS Checker: https://dnschecker.org
- SSL Test: https://www.ssllabs.com/ssltest/

---

## 📝 Your Production URLs

**After setup complete**:

- Application: `https://app.scani.xyz`
- API: `https://api.scani.xyz`
- Health Check: `https://api.scani.xyz/health`
- Root (redirect): `https://scani.xyz` → `https://app.scani.xyz`

---

## 🚨 Troubleshooting

**DNS not resolving?**

```bash
# Flush local DNS cache (macOS)
sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder

# Check DNS
nslookup app.scani.xyz
dig app.scani.xyz CNAME
```

**SSL not provisioning?**

- Wait 30 minutes after DNS propagates
- Check Render shows "Active" status first
- SSL auto-provisions after DNS verified

**CORS errors?**

- Verify backend FRONTEND_URL is `https://app.scani.xyz`
- Redeploy backend service
- Clear browser cache

**Magic link wrong URL?**

- Update Supabase Site URL to `https://app.scani.xyz`
- Request a NEW magic link (old ones are cached)

---

## ⏱️ Timeline

- Add domains in Render: 5 minutes
- Add DNS records: 5 minutes
- DNS propagation: 10-30 minutes
- SSL provisioning: 5-10 minutes
- Update configs: 5 minutes
- Testing: 5 minutes
- **Total: ~45-60 minutes**

---

**For detailed instructions, see**: `docs/technical/NAMECHEAP_DNS_SETUP.md`

**Last updated**: October 9, 2025
