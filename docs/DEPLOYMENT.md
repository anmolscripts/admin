# SPARK ADMIN - PRODUCTION DEPLOYMENT GUIDE (SINGLE-PROCESS)

This document provides complete, production-grade deployment instructions for **Spark Admin** on a Linux VPS (e.g., Ubuntu 24.04 LTS / Ubuntu 22.04 LTS / Debian 12).

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

- **Operating System:** Ubuntu 24.04 LTS, Ubuntu 22.04 LTS, or Debian 12 (x86_64 or arm64)
- **Compute:** Minimum 1 vCPU, 2 GB RAM (4 GB recommended for PDF/Excel generation under peak load)
- **Disk:** 20 GB+ NVMe/SSD storage
- **Firewall (UFW):** Ports 22 (SSH), 80 (HTTP), 443 (HTTPS) open; Port 3000 (Node.js) and 3306 (MySQL) **BLOCKED** from public access.

---

## 3. SYSTEM PACKAGES & RUNTIME SETUP

### 3.1. System Update & Essential Tools
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw nginx certbot python3-certbot-nginx logrotate chromium-browser
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

> [!NOTE]
> **Build Architecture:** Spark Admin does not require a frontend compilation/build step.
> Production readiness is achieved through dependency installation, Prisma migration, Prisma client generation, production seed, configuration validation and smoke verification.

### 5.0. Automated Deployment via Production Installer (Recommended)
You can perform steps 5.2 through 5.5 in a single command using the automated production installer:

```bash
cd /opt/spark-admin/app
sudo -u sparkadmin npm run prod:install
```

The automated installer prompts for production database credentials and initial OWNER admin credentials, configures `.env`, creates the production database if needed, runs migrations, generates Prisma Client, seeds ONLY production system/master data, verifies all zero-demo invariants, and executes read-only smoke verification.

---

### 5.1. Clone Repository & Permissions
Switch to the application directory as root, clone the project, and assign ownership:
```bash
cd /opt/spark-admin
sudo -u sparkadmin git clone <YOUR_GIT_REPOSITORY_URL> app
cd /opt/spark-admin/app
```

### 5.2. Install Production Dependencies (Manual)
Run `npm ci` with `--omit=dev` to ensure clean, reproducible dependency installation:
```bash
sudo -u sparkadmin npm ci --omit=dev
```

### 5.3. Configure Production Environment File
Copy the production environment template:
```bash
sudo -u sparkadmin cp .env.production.example .env
```

Set strict file permissions so only `sparkadmin` and `root` can read the file:
```bash
sudo chown sparkadmin:sparkadmin .env
sudo chmod 600 .env
```

Edit `.env` using your editor of choice:
```bash
sudo nano .env
```

Ensure all variables are populated:
```ini
NODE_ENV=production
PORT=3000

# MySQL Credentials
DATABASE_HOST=localhost
DATABASE_PORT=3306
DATABASE_USER=spark_app_user
DATABASE_PASSWORD=YOUR_STRONG_DB_PASSWORD
DATABASE_NAME=spark_admin_prod
DATABASE_URL="mysql://spark_app_user:YOUR_STRONG_DB_PASSWORD@localhost:3306/spark_admin_prod"

# Session Security (Generate via: openssl rand -hex 32)
SESSION_SECRET=YOUR_GENERATED_64_CHAR_HEX_SECRET

# Initial Seed Credentials (used only once for bootstrap)
SEED_ADMIN_PASSWORD=YOUR_GENERATED_INITIAL_ADMIN_PASSWORD
```

### 5.4. Apply Database Migrations
Deploy all forward-only Prisma migrations to the production database:
```bash
sudo -u sparkadmin npx prisma migrate deploy
```

Generate the Prisma Client matching the target architecture:
```bash
sudo -u sparkadmin npx prisma generate
```

Verify migration status:
```bash
sudo -u sparkadmin npx prisma migrate status
```

### 5.5. Initial Database Seed (First Deployment Only)
Run the seed process to provision system metadata and master data:
```bash
sudo -u sparkadmin node prisma/seed.js
```

**Production Seed Policy (`NODE_ENV=production`):**
- **System RBAC Bootstrap:** Seeds all 56 permissions and default roles (`OWNER`, `ADMIN`, `STAFF`, `VIEWER`).
- **Initial Administrator:** Creates the initial admin account (`admin@email.com` or `SEED_ADMIN_EMAIL`) assigned the `OWNER` role, using the strong password provided in `SEED_ADMIN_PASSWORD`. (If admin already exists, preserves credentials and updates role to `OWNER`).
- **Master Data:** Seeds the 13 predefined unit entries (`PCS`, `m`, `unit`, `Hours`, etc.) and 21 standard catalog items.
- **Strictly Excluded:** Zero business profile, zero clients, zero quotations, zero invoices, zero payments, zero revisions, zero activity logs, zero demo users.
*Note: The business profile is created/configured by the owner directly through the web UI on first access. After initial bootstrap, you can remove `SEED_ADMIN_PASSWORD` from `.env` or leave it inert.*

---

## 6. SYSTEMD SERVICE CONFIGURATION

Create a systemd unit file to manage the Node.js process:
```bash
sudo nano /etc/systemd/system/spark-admin.service
```

Paste the following configuration:
```ini
[Unit]
Description=Spark Admin Quotation & Invoice Management Application
Documentation=https://github.com/your-org/spark-admin
After=network.target mysql.service
Wants=mysql.service

[Service]
Type=simple
User=sparkadmin
Group=sparkadmin
WorkingDirectory=/opt/spark-admin/app
EnvironmentFile=/opt/spark-admin/app/.env
ExecStart=/usr/bin/node app/server.js

# Restart policy
Restart=always
RestartSec=5s

# Security sandboxing
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

# Resource limits
LimitNOFILE=65535
MemoryMax=1.5G

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=spark-admin

[Install]
WantedBy=multi-user.target
```

Reload systemd daemon, enable, and start the service:
```bash
sudo systemctl daemon-reload
sudo systemctl enable spark-admin
sudo systemctl start spark-admin
```

Verify service status:
```bash
sudo systemctl status spark-admin
```

Check live logs:
```bash
journalctl -u spark-admin -f
```

---

## 7. NGINX REVERSE PROXY & SSL (TLS) CONFIGURATION

### 7.1. Nginx Site Configuration
Create an Nginx server block configuration:
```bash
sudo nano /etc/nginx/sites-available/spark-admin.conf
```

Paste the following block (replace `yourdomain.com` with your actual domain):
```nginx
# Rate limiting zone for login requests
limit_req_zone $binary_remote_addr zone=spark_login:10m rate=5r/m;

server {
    listen 80;
    listen [::]:80;
    server_name yourdomain.com www.yourdomain.com;

    # Redirect all HTTP to HTTPS
    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name yourdomain.com www.yourdomain.com;

    # SSL Certificate paths (managed by Certbot)
    # ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;

    # SSL Security Configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:10m;
    ssl_session_tickets off;

    # Security Headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains; preload" always;

    # Max body size for file uploads
    client_max_body_size 10M;

    # Static asset caching
    location /assets/ {
        alias /opt/spark-admin/app/assets/;
        expires 7d;
        add_header Cache-Control "public, no-transform";
        access_log off;
    }

    # Nginx-level rate limit for login endpoint
    location = /login {
        limit_req zone=spark_login burst=3 nodelay;
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Main reverse proxy location
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeouts for PDF generation
        proxy_read_timeout 60s;
        proxy_connect_timeout 60s;
    }
}
```

Enable site and test configuration:
```bash
sudo ln -s /etc/nginx/sites-available/spark-admin.conf /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 7.2. Obtain Free Let's Encrypt SSL Certificate
```bash
sudo certbot --nginx -d yourdomain.com -d www.yourdomain.com
```
*Certbot will automatically install the certificate and configure auto-renewal via cron.*

---

## 8. BACKUP & RESTORE PROCEDURES

### 8.1. Automated Daily Database Backup Script
Create a backup directory:
```bash
sudo mkdir -p /var/backups/spark-admin
sudo chown root:root /var/backups/spark-admin
sudo chmod 700 /var/backups/spark-admin
```

Create backup script:
```bash
sudo nano /usr/local/bin/backup-spark-admin.sh
```

Paste:
```bash
#!/bin/bash
set -eo pipefail

BACKUP_DIR="/var/backups/spark-admin"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
DB_NAME="spark_admin_prod"
BACKUP_FILE="${BACKUP_DIR}/${DB_NAME}_${TIMESTAMP}.sql.gz"

# Dump database and compress
mysqldump --single-transaction --quick --routines --triggers "${DB_NAME}" | gzip > "${BACKUP_FILE}"
chmod 600 "${BACKUP_FILE}"

# Keep only last 14 days of backups
find "${BACKUP_DIR}" -type f -name "*.sql.gz" -mtime +14 -delete

echo "[$(date)] Backup completed successfully: ${BACKUP_FILE}"
```

Make executable and add to crontab:
```bash
sudo chmod +x /usr/local/bin/backup-spark-admin.sh
# Add to crontab:
(sudo crontab -l 2>/dev/null; echo "0 2 * * * /usr/local/bin/backup-spark-admin.sh >> /var/log/spark-backup.log 2>&1") | sudo crontab -
```

### 8.2. Database Restoration Procedure
In the event of data corruption or disaster recovery:
```bash
# 1. Stop application to prevent writes
sudo systemctl stop spark-admin

# 2. Decompress and restore specific backup
gunzip < /var/backups/spark-admin/spark_admin_prod_20261001_020000.sql.gz | mysql -u root -p spark_admin_prod

# 3. Restart application
sudo systemctl start spark-admin
```

---

## 9. ZERO-DOWNTIME UPDATE / ROLLBACK WORKFLOW

### 9.1. Applying an Update
```bash
cd /opt/spark-admin/app

# 1. Fetch latest code
sudo -u sparkadmin git fetch origin
sudo -u sparkadmin git checkout main
sudo -u sparkadmin git pull origin main

# 2. Install production dependencies
sudo -u sparkadmin npm ci --omit=dev

# 3. Apply any new migrations
sudo -u sparkadmin npx prisma migrate deploy

# 4. Regenerate Prisma Client
sudo -u sparkadmin npx prisma generate

# 5. Restart application service
sudo systemctl restart spark-admin

# 6. Verify health endpoint
curl -s http://127.0.0.1:3000/health | grep '"status":"ok"'
```

### 9.2. Rolling Back a Release
```bash
cd /opt/spark-admin/app
sudo -u sparkadmin git checkout <PREVIOUS_STABLE_COMMIT_HASH>
sudo -u sparkadmin npm ci --omit=dev
sudo -u sparkadmin npx prisma generate
sudo systemctl restart spark-admin
```
