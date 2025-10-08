# Scani Production URLs - Quick Reference

**Created**: October 8, 2025  
**Deployment**: Render + Supabase

---

## 🌐 Live URLs

### Frontend (Static Site)
- **URL**: https://scani-frontend.onrender.com
- **Dashboard**: https://dashboard.render.com/static/srv-d3j8p37diees73fl6q30
- **Service ID**: srv-d3j8p37diees73fl6q30

### Backend (Web Service)
- **URL**: https://scani-backend-217c.onrender.com
- **Dashboard**: https://dashboard.render.com/web/srv-d3j88295pdvs739osbig
- **Service ID**: srv-d3j88295pdvs739osbig
- **Health Check**: https://scani-backend-217c.onrender.com/health

### Database
- **Provider**: Supabase PostgreSQL
- **Dashboard**: https://supabase.com/dashboard

### Source Code
- **Repository**: https://github.com/MGrin/scani
- **Branch**: main

---

## ⚙️ Configuration Checklist

### Supabase Settings
- [ ] **Site URL**: `https://scani-frontend.onrender.com`
- [ ] **Redirect URLs**: `https://scani-frontend.onrender.com/**`
- [ ] **Redirect URLs** (dev): `http://localhost:5173/**`

### Backend Environment Variables
- [ ] `FRONTEND_URL=https://scani-frontend.onrender.com`
- [ ] `SUPABASE_URL` - set
- [ ] `SUPABASE_ANON_KEY` - set
- [ ] `SUPABASE_SERVICE_ROLE_KEY` - set
- [ ] `DATABASE_URL` - set
- [ ] All API keys configured

### Frontend Environment Variables
- [ ] `VITE_SUPABASE_URL` - set
- [ ] `VITE_SUPABASE_ANON_KEY` - set
- [ ] `VITE_API_URL=https://scani-backend-217c.onrender.com`

---

## 🔧 Common Tasks

### View Logs
```bash
# Backend logs
https://dashboard.render.com/web/srv-d3j88295pdvs739osbig/logs

# Frontend logs
https://dashboard.render.com/static/srv-d3j8p37diees73fl6q30/logs
```

### Trigger Manual Deploy
```bash
# From Render Dashboard
1. Click "Manual Deploy" button
2. Select "Clear build cache & deploy"

# Or push to GitHub
git push origin main  # Auto-deploys both services
```

### Update Environment Variables
```bash
# Backend: https://dashboard.render.com/web/srv-d3j88295pdvs739osbig/env-groups
# Frontend: https://dashboard.render.com/static/srv-d3j8p37diees73fl6q30/env-groups

# After updating, manually redeploy the service
```

### Run Database Migrations
```bash
# Locally against production DB
bun run db:migrate

# Or use Supabase SQL Editor
https://supabase.com/dashboard → SQL Editor
```

---

## 🚨 Troubleshooting

### Magic Link Goes to Localhost
**Fix**: Update Supabase Site URL (see SUPABASE_REDIRECT_FIX.md)

### CORS Errors
**Fix**: Update `FRONTEND_URL` in backend env vars

### Build Failures
**Check**:
1. GitHub Actions (if configured)
2. Render build logs
3. Dependencies (bun.lock)

### Service Won't Start
**Check**:
1. Backend health check: `/health`
2. Environment variables
3. Database connectivity

---

## 📊 Service Status

### Free Tier Limits
- **Frontend**: Unlimited bandwidth (static)
- **Backend**: 750 hours/month (auto-sleeps after 15 min inactivity)
- **Database**: 500 MB (Supabase free tier)

### Performance
- **Build Time**: ~2-3 seconds
- **Backend Startup**: ~5 seconds (cold start)
- **Frontend Deploy**: ~30 seconds

---

## 📝 Notes

- Backend auto-sleeps on free tier (15-30 second cold start)
- Frontend served via CDN (always fast)
- Database migrations must be run manually
- Both services auto-deploy on push to `main` branch

---

**Last Updated**: October 8, 2025
