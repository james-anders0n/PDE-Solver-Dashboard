# GitHub upload guide

This folder is a clean source snapshot of PDE Studio. It includes the current
dashboard code, tests, documentation, public assets, database/worker setup, and
economic-model services. Local secrets, installed dependencies, build output,
caches, logs, backups, and private working notes are excluded.

## Option 1: GitHub website

1. Create an empty repository on GitHub without adding a README, `.gitignore`,
   or license.
2. Upload the contents of this folder.

## Option 2: Git command line

Run these commands from this folder after creating an empty GitHub repository:

```bash
git remote add origin https://github.com/OWNER/REPOSITORY.git
git push -u origin main
```

## Local setup

```bash
npm ci
cp .env.example .env.local
npm run dev
```

On Windows PowerShell, use `Copy-Item .env.example .env.local` instead of `cp`.
Only fill in the environment values you need, and do not commit `.env.local`.
