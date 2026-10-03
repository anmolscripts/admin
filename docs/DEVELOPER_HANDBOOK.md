# New Developer Onboarding Handbook

Welcome to the **Spark Admin** engineering team. This handbook provides the exact, end-to-end setup procedure required to get a clean local development environment running in under 10 minutes.

---

## Prerequisites & Supported Environments

- **Operating System:** Linux (Ubuntu/Debian), macOS (Apple Silicon or Intel), or Windows 10/11.
- **Node.js:** Node.js 24 LTS (`v24.x`). Check with `node -v`.
- **Package Manager:** npm 10+ (`npm -v`).
- **Database:** MySQL 8.0+ or MariaDB 10.6+ running on `localhost:3306`.
- **Browser:** Google Chrome or Chromium (required for PDF export generation).

---

## Step-by-Step Onboarding Procedure

### 1. Clone the Repository
```bash
git clone <repository-url>
cd admin
```

### 2. Verify Active Branch
```bash
git checkout main
git pull origin main
```

### 3. Verify Node 24 Runtime
If using `nvm` (Node Version Manager):
```bash
# Linux / macOS
nvm install 24
nvm use 24

# Windows (nvm-windows)
nvm install 24.0.0
nvm use 24.0.0
```
Verify versions:
```bash
node -v   # Expected: v24.x.x
npm -v    # Expected: 10.x.x
```

### 4. Install Dependencies
```bash
npm install
```
*Note: This installs Express 5, Prisma ORM 7, bcrypt, EJS, and dev tools without modifying package-lock.json.*

### 5. Create `.env` Configuration File
```bash
# Linux / macOS
cp .env.example .env

# Windows PowerShell
Copy-Item .env.example .env
```

### 6. Configure Local MySQL Database
Open your MySQL terminal or client and provision a dedicated database:
```sql
CREATE DATABASE IF NOT EXISTS spark_admin CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

### 7. Populate `.env` with Your Credentials
Open `.env` in your editor and configure the connection parameters:
```ini
PORT=3000
NODE_ENV=development

DATABASE_HOST=localhost
DATABASE_PORT=3306
DATABASE_USER=root
DATABASE_PASSWORD=your_actual_mysql_password
DATABASE_NAME=spark_admin
DATABASE_URL="mysql://root:your_actual_mysql_password@localhost:3306/spark_admin"

SESSION_SECRET=dev-session-secret-change-in-production-min32chars
SEED_ADMIN_PASSWORD=local-dev-password-123
TEST_ADMIN_PASSWORD=local-dev-password-123
```
*Note: `TEST_ADMIN_PASSWORD` (or `SEED_ADMIN_PASSWORD`) is strictly required by automated test scripts and browser QA verification suites. The runner will throw an error if no admin password is provided in environment variables.*

### 8. Run Prisma Migrations & Client Generation
Apply all forward-only migrations and generate the Prisma Client:
```bash
# 1. Apply migrations
npx prisma migrate deploy

# 2. Generate client
npx prisma generate

# 3. Verify status
npx prisma migrate status
```

### 9. Seed Development Data
Seed the local admin account, RBAC roles, permissions, predefined units, master items, and (in development mode) sample documents:
```bash
npm run prisma:seed
```
*Output will confirm:*
- Admin account: `admin@email.com` (assigned `OWNER` role)
- System roles (`OWNER`, `ADMIN`, `STAFF`, `VIEWER`) and 56-permission dictionary
- 13 Predefined measurement units (`PCS`, `m`, `unit`, `Hours`, `Project`, etc.)
- 21 Standard industrial catalog items
- Sample quotations, active invoices, sample clients, and development business profile (when in development mode).
*(In production, `NODE_ENV=production` strictly seeds only system RBAC and master data; business profile and demo documents are completely omitted).*

### 10. Start the Development Server
```bash
npm run dev
```
The server will start on [http://localhost:3000](http://localhost:3000) with nodemon auto-restart enabled.

### 11. Open and Verify in Browser
- Open [http://localhost:3000/login](http://localhost:3000/login).
- Log in with:
  - **Email:** `admin@email.com`
  - **Password:** The password set in `SEED_ADMIN_PASSWORD` in your `.env`.
- You should land on the Executive Dashboard with seeded metrics.

### 12. Run the Full Test Suite
In a separate terminal, execute the automated test runner:
```bash
npm test
```
All tests must pass cleanly.

---

## Daily Development Workflow

### 13. Create a Feature Branch
Always branch off the latest `main`:
```bash
git checkout main
git pull origin main
git checkout -b feature/your-feature-name
```
Branch naming conventions:
- `feature/...`: New business capabilities.
- `fix/...`: Bug fixes and corrections.
- `docs/...`: Documentation and guides.
- `chore/...`: Build scripts, dependencies, or formatting.

### 14. Implement Your Feature
- Follow the guidelines in [docs/CODING_STANDARDS.md](file:///c:/Users/User/Documents/project/admin/docs/CODING_STANDARDS.md).
- Place business logic in services (`app/services/`), not controllers or routes.
- Respect the frozen core contracts in [docs/CORE_CONTRACTS.md](file:///c:/Users/User/Documents/project/admin/docs/CORE_CONTRACTS.md).
- **Authorization Pattern:** Protect all routes and controllers using RBAC middleware:
  - Route middleware: `requirePermission('MODULE', 'ACTION')`
  - Service-level checks: `await rbacService.hasPermission(userId, module, action)`
  - Protect mutations with atomic activity logs: `await activityService.log({ ... }, tx)`
  - Never allow self-modification of roles/permissions or delegation escalation beyond current user privileges.

### 15. Adding Database Migrations (If Schema Changes)
If your feature requires a database schema change:
1. Edit `prisma/schema.prisma`.
2. Format the schema:
   ```bash
   npx prisma format
   ```
3. Create and apply the migration:
   ```bash
   npx prisma migrate dev --name describe_your_change
   ```
4. Regenerate the Prisma Client:
   ```bash
   npx prisma generate
   ```
5. Commit the generated SQL migration file along with your code.

### 16. Test Your Changes
Run focused tests during development:
```bash
node --test tests/rbac_team_activity.test.js
node --test tests/documents.test.js
```
Then run the entire suite before committing (all 353 tests across 59 suites must pass naturally with exit code 0):
```bash
npm test
npx prisma validate
git diff --check
```

### 17. Atomic Commits
Keep commits focused and write descriptive imperative commit messages:
```bash
git add app/services/your.service.js tests/your.test.js
git commit -m "feat: add client search filtering by city"
```

### 18. Rebase Before Pull Request
```bash
git checkout main
git pull origin main
git checkout feature/your-feature-name
git rebase main
```

### 19. Submit Pull Request
Verify the PR checklist in [docs/DEVELOPMENT_WORKFLOW.md](file:///c:/Users/User/Documents/project/admin/docs/DEVELOPMENT_WORKFLOW.md) before requesting review.
