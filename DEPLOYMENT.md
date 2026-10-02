# SPARK ADMIN - PRODUCTION DEPLOYMENT GUIDE (SINGLE-PROCESS)

This document provides complete, production-grade deployment instructions for **Spark Admin** on a Linux VPS (e.g., Ubuntu 22.04 LTS / Debian 12).

---

## 1. PRODUCTION ARCHITECTURE & KNOWN LIMITATIONS

> [!IMPORTANT]
> **CLASSIFICATION: READY FOR SINGLE-PROCESS PRODUCTION**
>
> - **Session Store:** Uses in-memory session management (`MemoryStore`).
> - **Brute-Force Protection:** Uses process-local in-memory rate limiting (`Map`).
> - **Execution Model:** STRICTLY SINGLE NODE.JS PROCESS.
>
> **UNSUPPORTED IN THIS VERSION:**
> - Multiple Node.js worker processes (e.g., PM2 cluster mode `instances: max` or `instances: 2+`).
> - Horizontally scaled multi-container clusters behind a round-robin load balancer without sticky sessions and a shared store.
>
> Running multiple instances concurrently will cause session disconnection / login loss and fragmented rate limiting. If horizontal scaling is required in the future, migrate `express-session` to Redis or MySQL (`express-mysql-session`) and rate limiting to Redis.

---

## 2. SERVER PREREQUISITES

- **Operating System:** Ubuntu 22.04 LTS or Debian 12 (x86_64 or arm64)
- **Compute:** Minimum 1 vCPU, 2 GB RAM (4 GB recommended for PDF/Excel generation under peak load)
- **Disk:** 20 GB+ NVMe/SSD storage
- **Firewall (UFW):** Ports 22 (SSH), 80 (HTTP), 443 (HTTPS) open; Port 3000 (Node.js) and 3306 (MySQL) **BLOCKED** from public access.

---

## 3. SYSTEM PACKAGES & RUNTIME SETUP

### 3.1. System Update & Essential Tools
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw nginx certbot python3-certbot-nginx logrotate
```

### 3.2. Install Node.js 24 LTS
```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # Should output v24.x.x
npm -v    # Should output v10.x.x
```

### 3.3. Create Dedicated Non-Root System User
For security, the application must run under a dedicated, unprivileged system user:
```bash
sudo useradd --system --shell /bin/bash --create-home --home-dir /opt/spark-admin sparkadmin
```

---

## 4. MYSQL 8 DATABASE CONFIGURATION

### 4.1. Install MySQL Server
```bash
sudo apt install -y mysql-server
sudo systemctl enable mysql
sudo systemctl start mysql
```

### 4.2. Secure Installation
Run the security script:
```bash
sudo mysql_secure_installation
```

### 4.3. Create Database & Dedicated Least-Privilege User
Do **NOT** connect the application as the MySQL `root` user in production.

Log in to MySQL as administrator:
```bash
sudo mysql
```

Execute the following SQL statements (replace `YOUR_STRONG_DB_PASSWORD` with a strong 32+ character random password):
```sql
-- 1. Create production database with UTF-8 support
CREATE DATABASE spark_admin_prod CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 2. Create dedicated non-root application user bound to localhost
CREATE USER 'spark_app_user'@'localhost' IDENTIFIED BY 'YOUR_STRONG_DB_PASSWORD';

-- 3. Grant necessary DML and DDL privileges on production database
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, INDEX, REFERENCES ON spark_admin_prod.* TO 'spark_app_user'@'localhost';

-- 4. Apply privileges
FLUSH PRIVILEGES;
EXIT;
```

---

## 5. APPLICATION DEPLOYMENT PROCEDURE

### 5.1. Clone Repository & Permissions
```bash
# Clone to application home directory
cd /opt/spark-admin
sudo -u sparkadmin git clone <YOUR_GIT_REPO_URL> /opt/spark-admin/app-source
cd /opt/spark-admin/app-source

# Or extract release tarball:
# sudo -u sparkadmin tar -xzf spark-admin-release.tar.gz -C /opt/spark-admin/app-source
```

### 5.2. Configure Environment Variables
Copy the production template to `.env`:
```bash
sudo -u sparkadmin cp .env.production.example .env
sudo chmod 600 .env
sudo chown sparkadmin:sparkadmin .env
```

Edit `/opt/spark-admin/app-source/.env`:
```bash
sudo nano .env
```

Ensure the following variables are configured:
```ini
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
TRUST_PROXY=true
REQUEST_BODY_LIMIT=2mb

# Generate a strong 64-character secret using: openssl rand -hex 32
SESSION_SECRET=<64_CHARACTER_RANDOM_SECRET>
SESSION_COOKIE_NAME=spark.sid
SESSION_MAX_AGE_HOURS=8

BCRYPT_SALT_ROUNDS=12

DATABASE_HOST=localhost
DATABASE_PORT=3306
DATABASE_USER=spark_app_user
DATABASE_PASSWORD=YOUR_STRONG_DB_PASSWORD
DATABASE_NAME=spark_admin_prod
DATABASE_URL="mysql://spark_app_user:YOUR_STRONG_DB_PASSWORD@localhost:3306/spark_admin_prod"
```

### 5.3. Install Production Dependencies
Run `npm ci --omit=dev` to ensure reproducible, deterministic dependency installation:
```bash
sudo -u sparkadmin npm ci --omit=dev
```

### 5.4. Generate Prisma Client
```bash
sudo -u sparkadmin npx prisma generate
```

### 5.5. Execute Production Database Migrations
> [!WARNING]
> In production, **ONLY** run `npx prisma migrate deploy`.
> **NEVER** run `npx prisma migrate dev` or `npx prisma db push` in production, as they can reset data.

```bash
sudo -u sparkadmin npx prisma migrate deploy
```

Verify migration status:
```bash
sudo -u sparkadmin npx prisma migrate status
```

### 5.6. Initial Database Seed (First Deployment Only)
If seeding initial admin account:
1. Temporarily append `SEED_ADMIN_PASSWORD=InitialSecurePass123!` to `.env`.
2. Run seed:
   ```bash
   sudo -u sparkadmin node prisma/seed.js
   ```
3. Remove or clear `SEED_ADMIN_PASSWORD` from `.env`.
4. Immediately log in and change the administrator password.

---

## 6. SYSTEMD SERVICE CONFIGURATION (PROCESS MANAGER)

Create the systemd service unit file:
```bash
sudo nano /etc/systemd/system/spark-admin.service
```

Paste the following configuration:
```ini
[Unit]
Description=Spark Admin Quotation & Invoice Management Application
After=network.target mysql.service
Wants=mysql.service

[Service]
Type=simple
User=sparkadmin
Group=sparkadmin
WorkingDirectory=/opt/spark-admin/app-source
ExecStart=/usr/bin/node app/server.js
Restart=always
RestartSec=5s
Environment=NODE_ENV=production

# Security hardening flags
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=read-only

# Resource limits
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
```

Enable and start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable spark-admin
sudo systemctl start spark-admin
```

Verify status:
```bash
sudo systemctl status spark-admin
```

---

## 7. HEALTH CHECK VERIFICATION

Verify the local health endpoint via HTTP:
```bash
curl -i http://127.0.0.1:3000/health
```

Expected response:
```http
HTTP/1.1 200 OK
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
Referrer-Policy: strict-origin-when-cross-origin
Content-Type: application/json; charset=utf-8

{"status":"ok","timestamp":"2026-10-02T...","uptime":5,"database":"connected"}
```

---

## 8. NGINX REVERSE PROXY CONFIGURATION

Create an Nginx server configuration:
```bash
sudo nano /etc/nginx/sites-available/spark-admin
```

Paste the configuration (replace `example.com` with your actual domain):
```nginx
server {
    listen 80;
    listen [::]:80;
    server_name example.com www.example.com;

    # Maximum upload size for document logos / attachments
    client_max_body_size 10M;

    # Gzip compression
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml application/json application/javascript application/rss+xml application/atom+xml image/svg+xml;

    # Static assets caching (served directly by Nginx for high performance)
    location /assets/ {
        alias /opt/spark-admin/app-source/assets/;
        expires 30d;
        add_header Cache-Control "public, no-transform";
        access_log off;
    }

    # Proxy all traffic to Node.js backend
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # Standard proxy headers
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket support (if needed)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        # Timeouts for heavy PDF/Excel generation
        proxy_connect_timeout 60s;
        proxy_send_timeout 120s;
        proxy_read_timeout 120s;
        send_timeout 120s;

        # Buffer settings
        proxy_buffers 8 16k;
        proxy_buffer_size 32k;
    }
}
```

Enable site configuration and verify syntax:
```bash
sudo ln -s /etc/nginx/sites-available/spark-admin /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

---

## 9. TLS / SSL CONFIGURATION (HTTPS)

Obtain and configure a trusted Let's Encrypt certificate:
```bash
sudo certbot --nginx -d example.com -d www.example.com
```

Select the option to automatically redirect all HTTP traffic to HTTPS (301 Moved Permanently).

Verify automatic certificate renewal:
```bash
sudo systemctl status certbot.timer
sudo certbot renew --dry-run
```

---

## 10. DATABASE BACKUP & RESTORE PROCEDURES

### 10.1. Manual Backup Command
```bash
# Create backups directory
sudo mkdir -p /var/backups/spark-admin
sudo chown root:root /var/backups/spark-admin
sudo chmod 700 /var/backups/spark-admin

# Execute consistent transactional backup
mysqldump --defaults-file=/etc/mysql/debian.cnf \
  --single-transaction \
  --quick \
  --triggers \
  --routines \
  spark_admin_prod | gzip > /var/backups/spark-admin/spark_admin_$(date +%Y%m%d_%H%M%S).sql.gz
```

### 10.2. Automated Nightly Backup Cron Job
Create `/etc/cron.daily/spark-admin-backup`:
```bash
sudo nano /etc/cron.daily/spark-admin-backup
```

Add the script:
```bash
#!/bin/bash
set -euo pipefail

BACKUP_DIR="/var/backups/spark-admin"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/spark_admin_${TIMESTAMP}.sql.gz"
RETENTION_DAYS=14

mkdir -p "${BACKUP_DIR}"

# Consistent backup
mysqldump --defaults-file=/etc/mysql/debian.cnf \
  --single-transaction \
  --quick \
  --triggers \
  --routines \
  spark_admin_prod | gzip > "${BACKUP_FILE}"

# Enforce secure permissions
chmod 600 "${BACKUP_FILE}"

# Delete backups older than retention policy
find "${BACKUP_DIR}" -type f -name "spark_admin_*.sql.gz" -mtime +${RETENTION_DAYS} -delete
```

Make executable:
```bash
sudo chmod +x /etc/cron.daily/spark-admin-backup
```

### 10.3. Restore Procedure
To restore from a backup:
```bash
# 1. Stop the application service to prevent concurrent writes
sudo systemctl stop spark-admin

# 2. Decompress and restore into database
gunzip < /var/backups/spark-admin/spark_admin_20261002_120000.sql.gz | mysql --defaults-file=/etc/mysql/debian.cnf spark_admin_prod

# 3. Restart application service
sudo systemctl start spark-admin

# 4. Verify health endpoint
curl -f http://127.0.0.1:3000/health
```

---

## 11. APPLICATION UPDATE & RESTART PROCEDURE

To deploy a new release:
```bash
cd /opt/spark-admin/app-source

# 1. Fetch latest changes
sudo -u sparkadmin git fetch origin
sudo -u sparkadmin git checkout tags/v1.0.1 # or git pull

# 2. Update dependencies
sudo -u sparkadmin npm ci --omit=dev

# 3. Generate Prisma client & apply migrations
sudo -u sparkadmin npx prisma generate
sudo -u sparkadmin npx prisma migrate deploy

# 4. Restart service
sudo systemctl restart spark-admin

# 5. Verify health
curl -f http://127.0.0.1:3000/health
```

---

## 12. ROLLBACK PROCEDURE

If a deployment fails:
```bash
cd /opt/spark-admin/app-source

# 1. Revert to previous release tag / commit
sudo -u sparkadmin git checkout tags/v1.0.0

# 2. Restore previous dependencies
sudo -u sparkadmin npm ci --omit=dev
sudo -u sparkadmin npx prisma generate

# 3. If database migration needs rollback, restore previous backup:
# gunzip < /var/backups/spark-admin/pre_deploy_backup.sql.gz | mysql ...

# 4. Restart application
sudo systemctl restart spark-admin

# 5. Check logs & health
sudo systemctl status spark-admin
curl -f http://127.0.0.1:3000/health
```

---

## 13. LOG MONITORING & LOGROTATE

Monitor live application logs:
```bash
sudo journalctl -u spark-admin -f
```

View recent errors:
```bash
sudo journalctl -u spark-admin -p err -n 50
```
