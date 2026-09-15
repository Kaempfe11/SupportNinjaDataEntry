# SKDLA Case Workflow

Case management system for dental lab RX processing. Support Ninja scrapes 3Shape, cases flow through teams via FIFO assignment, and quality is reviewed automatically against ABS.

## Setup (3 steps)

### 1. Register a Microsoft App (Azure Portal)

1. Go to [Azure Portal → App Registrations](https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)
2. Click **New registration**
3. Name: `SKDLA Case Workflow`
4. Supported account types: **Accounts in any organizational directory (Any Azure AD directory - Multitenant) and personal Microsoft accounts**
   - This is what allows Support Ninja and external users to sign in
5. Redirect URI: Select **Web** and enter:
   ```
   https://asdunkqodixbhbohxtuq.supabase.co/auth/v1/callback
   ```
6. Click **Register**
7. Copy the **Application (client) ID**
8. Go to **Certificates & secrets** → **New client secret** → Copy the **Value**

### 2. Configure Supabase Auth

1. Go to [Supabase Dashboard](https://supabase.com/dashboard/project/asdunkqodixbhbohxtuq/auth/providers)
2. Under **Auth → Providers**, find **Azure (Microsoft)**
3. Toggle it **ON**
4. Paste the **Client ID** and **Client Secret** from step 1
5. Set the **Azure Tenant URL** to:
   ```
   https://login.microsoftonline.com/common
   ```
   (Using `common` allows any Microsoft account, not just one tenant)
6. Save

Then go to **Auth → URL Configuration**:
- Add your Vercel URL to **Redirect URLs**:
  ```
  https://your-app.vercel.app/**
  ```

### 3. Deploy to Vercel

1. Push to GitHub:
   ```bash
   git init
   git add .
   git commit -m "SKDLA Case Workflow v1"
   git remote add origin https://github.com/YOUR_ORG/skdla-workflow.git
   git push -u origin main
   ```

2. Connect to Vercel:
   - Go to [vercel.com](https://vercel.com) → **New Project** → Import your GitHub repo
   - Framework: **Other**

3. Add environment variables in Vercel (**Settings → Environment Variables**):
   - `SUPABASE_URL` = `https://asdunkqodixbhbohxtuq.supabase.co`
   - `SUPABASE_ANON_KEY` = your anon/public key from [Supabase Dashboard → Settings → API](https://supabase.com/dashboard/project/asdunkqodixbhbohxtuq/settings/api)

4. Redeploy (Vercel runs `node build.js` which injects the env vars into the HTML at build time)

**Do NOT hardcode secrets in `index.html`.** The placeholders `YOUR_SUPABASE_URL` and `YOUR_SUPABASE_ANON_KEY` are replaced automatically by `build.js` during the Vercel build step.

## Access Control

The app uses a self-service access request flow:

1. **Known users** (pre-created in `workflow_users` table): Sign in with Microsoft → matched by email → instant access
2. **New users**: Sign in with Microsoft → shown "Request Access" form → submit with name/team/reason → admin approves from Admin tab

Scott Kaempfe is pre-created as admin. First sign-in links the Microsoft account automatically.

## Architecture

- **Frontend**: Single HTML file with build step (`build.js` injects env vars → `dist/index.html`)
- **Backend**: Supabase (Postgres + Auth + RLS)
- **Auth**: Microsoft OAuth via Supabase Auth
- **Hosting**: Vercel (static)

All business logic runs client-side. Row Level Security on Supabase ensures only authenticated, approved users can read/write workflow data.
