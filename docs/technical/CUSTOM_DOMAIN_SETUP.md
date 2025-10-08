# Custom Domain Setup for Scani on Render

**Created**: October 9, 2025  
**Services**: Frontend (Static Site) + Backend (Web Service)

---

## 🌐 Current URLs

- **Frontend**: `https://scani-frontend.onrender.com`
- **Backend**: `https://scani-backend-217c.onrender.com`

---

## 📋 Prerequisites

1. **Own a domain** (e.g., `scani.app`, `scani.io`, etc.)
2. **Access to DNS provider** (Cloudflare, GoDaddy, Namecheap, etc.)
3. **Render services deployed** ✅ (already done)

---

## 🎯 Recommended Domain Structure

### Option 1: Separate Subdomains (Recommended)

- **Frontend**: `app.scani.com` or `www.scani.com`
- **Backend**: `api.scani.com`
- **Root**: `scani.com` → redirects to `app.scani.com`

### Option 2: Root + API Subdomain

- **Frontend**: `scani.com`
- **Backend**: `api.scani.com`

### Option 3: All Subdomains

- **Frontend**: `app.scani.com`
- **Backend**: `api.scani.com`

---

## 🔧 Setup Instructions

### Step 1: Add Custom Domain to Render Services

#### Frontend (Static Site)

1. **Go to Render Dashboard**

   - Navigate to: https://dashboard.render.com/static/srv-d3j8p37diees73fl6q30
   - Or go to: https://dashboard.render.com → Select "scani-frontend"

2. **Open Settings**

   - Click the **Settings** tab

3. **Add Custom Domain**

   - Scroll to **Custom Domains** section
   - Click **Add Custom Domain**
   - Enter your domain (e.g., `app.scani.com` or `www.scani.com`)
   - Click **Save**

4. **Get DNS Records**
   - Render will show you the DNS records to add
   - **For subdomains** (app.scani.com, www.scani.com):
     ```
     Type: CNAME
     Name: app (or www)
     Value: scani-frontend.onrender.com
     ```
   - **For root domain** (scani.com):
     ```
     Type: A
     Name: @ (or leave blank)
     Value: [IP address shown by Render]
     ```

#### Backend (Web Service)

1. **Go to Render Dashboard**

   - Navigate to: https://dashboard.render.com/web/srv-d3j88295pdvs739osbig
   - Or go to: https://dashboard.render.com → Select "scani-backend-217c"

2. **Open Settings**

   - Click the **Settings** tab

3. **Add Custom Domain**

   - Scroll to **Custom Domains** section
   - Click **Add Custom Domain**
   - Enter your domain (e.g., `api.scani.com`)
   - Click **Save**

4. **Get DNS Records**
   - Render will show you the DNS records to add
   - **For API subdomain**:
     ```
     Type: CNAME
     Name: api
     Value: scani-backend-217c.onrender.com
     ```

### Step 2: Configure DNS at Your Provider

#### For Cloudflare (Recommended)

1. **Log in to Cloudflare**

   - Go to: https://dash.cloudflare.com
   - Select your domain

2. **Add DNS Records**

   - Click **DNS** in the left menu
   - Click **Add record**

3. **Add Frontend Record**

   ```
   Type: CNAME
   Name: app (or www)
   Target: scani-frontend.onrender.com
   Proxy status: Proxied (orange cloud) - IMPORTANT: Turn OFF for Render
   TTL: Auto
   ```

   ⚠️ **Important**: Set proxy to **DNS only** (gray cloud) for Render SSL to work

4. **Add Backend Record**

   ```
   Type: CNAME
   Name: api
   Target: scani-backend-217c.onrender.com
   Proxy status: DNS only (gray cloud)
   TTL: Auto
   ```

5. **Add Root Domain Redirect** (Optional)
   - If you want `scani.com` → `app.scani.com`
   - Use Cloudflare Page Rules or redirect

#### For Other DNS Providers (GoDaddy, Namecheap, etc.)

1. **Log in to your DNS provider**
2. **Find DNS Management / DNS Records section**
3. **Add the records shown by Render**
   - Frontend: CNAME from `app` to `scani-frontend.onrender.com`
   - Backend: CNAME from `api` to `scani-backend-217c.onrender.com`

### Step 3: Wait for DNS Propagation

- **DNS propagation time**: 5 minutes to 48 hours (usually 15-30 minutes)
- **Check DNS propagation**: https://dnschecker.org
- **Render SSL provisioning**: Automatic after DNS propagates

### Step 4: Verify Custom Domains

1. **Check DNS Resolution**

   ```bash
   # Check frontend
   nslookup app.scani.com
   # Should show: scani-frontend.onrender.com

   # Check backend
   nslookup api.scani.com
   # Should show: scani-backend-217c.onrender.com
   ```

2. **Test HTTPS**

   - Visit: `https://app.scani.com`
   - Visit: `https://api.scani.com/health`
   - Both should have valid SSL certificates (Render auto-provisions)

3. **Check Render Dashboard**
   - Go to service settings
   - Custom domain should show **"Active"** with green checkmark
   - SSL certificate should show **"Provisioned"**

---

## ⚙️ Update Application Configuration

After custom domains are active, update these configurations:

### 1. Update Backend Environment Variable

In Render backend service settings:

```bash
FRONTEND_URL=https://app.scani.com
# (or whatever your frontend domain is)
```

### 2. Update Frontend Environment Variable

In Render frontend service settings:

```bash
VITE_API_URL=https://api.scani.com
# (or whatever your backend domain is)
```

### 3. Update Supabase Settings

1. **Go to Supabase Dashboard**: https://supabase.com/dashboard
2. **Authentication → URL Configuration**
3. **Update Site URL**:
   ```
   https://app.scani.com
   ```
4. **Update Redirect URLs** (add your custom domain):
   ```
   https://app.scani.com/**
   ```

### 4. Trigger Redeploy

After updating environment variables:

1. Go to Render Dashboard
2. Click **Manual Deploy** on both services
3. Select **Clear build cache & deploy**

---

## 🔒 SSL Certificates

### Automatic SSL (Render Handles This)

- **Free SSL**: Render provides free SSL via Let's Encrypt
- **Auto-renewal**: Certificates auto-renew every 90 days
- **HTTPS enforcement**: Automatic (HTTP → HTTPS redirect)

### SSL Status Check

- Go to service settings in Render
- Check **Custom Domains** section
- Status should show: "Active" with SSL certificate provisioned

---

## 🚨 Troubleshooting

### Issue: Custom domain not working

**Causes**:

1. DNS records not added correctly
2. DNS not propagated yet
3. Cloudflare proxy enabled (must be DNS only)

**Solutions**:

1. Double-check DNS records match what Render shows
2. Wait 30 minutes for propagation
3. Use `nslookup` or `dig` to verify DNS
4. Check Render dashboard for error messages

### Issue: SSL certificate not provisioning

**Causes**:

1. DNS not pointing to Render yet
2. Cloudflare proxy enabled
3. DNS propagation not complete

**Solutions**:

1. Verify DNS with `nslookup`
2. Turn off Cloudflare proxy (gray cloud)
3. Wait for DNS propagation
4. Render auto-provisions SSL after DNS is verified

### Issue: "Invalid Host header" error

**Cause**: Custom domain added to Render but env vars not updated

**Solution**:

1. Update `FRONTEND_URL` in backend
2. Update `VITE_API_URL` in frontend
3. Redeploy both services

### Issue: CORS errors after domain change

**Cause**: Backend `FRONTEND_URL` not updated

**Solution**:

1. Update backend `FRONTEND_URL` to your custom domain
2. Redeploy backend service

---

## 📝 Post-Setup Checklist

After custom domains are configured:

- [ ] DNS records added at provider
- [ ] DNS propagated (check with dnschecker.org)
- [ ] Custom domains show "Active" in Render
- [ ] SSL certificates provisioned
- [ ] `FRONTEND_URL` updated in backend env vars
- [ ] `VITE_API_URL` updated in frontend env vars
- [ ] Supabase Site URL updated
- [ ] Supabase Redirect URLs updated
- [ ] Both services redeployed
- [ ] Frontend accessible via custom domain
- [ ] Backend API accessible via custom domain
- [ ] Login flow works with magic links
- [ ] HTTPS working on both domains

---

## 💰 Pricing Notes

### Render Custom Domains

- **Free tier**: Custom domains included
- **SSL certificates**: Free (Let's Encrypt)
- **Bandwidth**: Same as service plan

### DNS Provider

- **Domain registration**: ~$10-15/year (varies by TLD)
- **DNS hosting**: Usually free with domain registration
- **Cloudflare**: Free tier includes DNS

---

## 🎯 Recommended Setup

For a production-ready setup, I recommend:

1. **Domain structure**:

   - `app.scani.com` → Frontend (Static Site)
   - `api.scani.com` → Backend (Web Service)
   - `scani.com` → Redirect to `app.scani.com`

2. **DNS provider**: Cloudflare (free tier)

   - Fast DNS propagation
   - Free SSL (though Render provides it anyway)
   - DDoS protection (if you enable proxy later)
   - Analytics

3. **SSL**: Use Render's automatic SSL
   - Free
   - Auto-renewing
   - No configuration needed

---

## 📚 Additional Resources

- **Render Custom Domains**: https://render.com/docs/custom-domains
- **Render SSL**: https://render.com/docs/tls
- **DNS Checker**: https://dnschecker.org
- **SSL Checker**: https://www.ssllabs.com/ssltest/

---

## 🔄 Next Steps

1. **Choose your domain names**:

   - Frontend: `_______________`
   - Backend: `_______________`

2. **Add custom domains in Render Dashboard**:

   - Frontend: https://dashboard.render.com/static/srv-d3j8p37diees73fl6q30
   - Backend: https://dashboard.render.com/web/srv-d3j88295pdvs739osbig

3. **Get DNS records from Render**

4. **Add DNS records at your provider**

5. **Wait for DNS propagation** (15-30 min)

6. **Update environment variables**

7. **Update Supabase settings**

8. **Test everything**

---

**Status**: Ready for custom domain configuration  
**Time to complete**: 30-60 minutes (mostly waiting for DNS)  
**Last updated**: October 9, 2025
