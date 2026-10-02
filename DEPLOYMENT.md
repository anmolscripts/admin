# Spark Admin Production Deployment Guide

> **Official Documentation Location:**
> The comprehensive, production-grade deployment guide has been consolidated into:
> [docs/DEPLOYMENT.md](file:///c:/Users/User/Documents/project/admin/docs/DEPLOYMENT.md)

---

## Quick Reference Summary

- **Target OS:** Ubuntu 24.04 LTS / Ubuntu 22.04 LTS / Debian 12 (64-bit)
- **Runtime:** Node.js 24 LTS (`v24.x`), npm 10+
- **Database:** MySQL 8.0+ or MariaDB 10.6+
- **Service Management:** `systemd` (`spark-admin.service`)
- **Reverse Proxy:** Nginx with Let's Encrypt TLS (Certbot)
- **Execution Architecture:** Single Node.js process (in-memory sessions and rate limiting)

### Essential Production Commands

```bash
# 1. Install production dependencies
npm ci --omit=dev

# 2. Deploy database migrations
npx prisma migrate deploy

# 3. Generate Prisma client
npx prisma generate

# 4. Start production server
npm start

# 5. Check service health
curl -s http://127.0.0.1:3000/health
```

For the complete, step-by-step installation instructions including MySQL least-privilege users, systemd unit files, Nginx reverse proxy configuration, automated daily backups, and zero-downtime update procedures, please consult the authoritative guide at:

👉 [docs/DEPLOYMENT.md](file:///c:/Users/User/Documents/project/admin/docs/DEPLOYMENT.md)
