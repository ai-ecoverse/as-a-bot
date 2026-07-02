# GitHub App Token Broker for ai-aligned-gh

[![99% Vibe_Coded](https://img.shields.io/badge/99%25-Vibe_Coded-ff69b4?style=for-the-badge&logo=claude&logoColor=white)](https://github.com/ai-ecoverse/vibe-coded-badge-action)

A minimal Cloudflare Worker that provides user-to-server GitHub tokens via device flow for `ai-aligned-gh`. 

**Key Feature**: Actions appear as the user (with app badge), not as "app/as-a-bot".

## 🎯 Problem Solved

- ❌ **Without this worker**: PRs show `app/as-a-bot` as author
- ✅ **With this worker**: PRs show `username` + app badge as author

## 🚀 Quick Start

### Prerequisites

1. **GitHub App with Device Flow enabled**:
   - Go to your GitHub App settings
   - Check ✅ "Enable Device Flow"
   - Note the Client ID

2. **Cloudflare Workers account**

### Deploy

```bash
# Clone and install
git clone https://github.com/ai-ecoverse/as-a-bot
cd as-a-bot
npm install

# Configure
wrangler secret put GITHUB_CLIENT_ID  # Enter your GitHub App Client ID

# Deploy
wrangler deploy
```

## 🔌 API Endpoints

Only two endpoints needed for device flow:

### Start Device Flow
```bash
POST /user-token/start
Body: {"scopes": "repo"}

Response:
{
  "device_code": "...",
  "user_code": "ABCD-1234",
  "verification_uri": "https://github.com/login/device",
  "expires_in": 900,
  "interval": 5
}
```

### Poll for Token
```bash
POST /user-token/poll
Body: {"device_code": "..."}

Response:
{
  "access_token": "ghu_...",  # User-to-server token
  "token_type": "bearer",
  "expires_at": "...",
  "scope": "repo"
}
```

## 🔧 Integration with ai-aligned-gh

`ai-aligned-gh` will automatically use this worker to get properly attributed tokens:

```bash
# Configure ai-aligned-gh with your worker URL
export AS_A_BOT_WORKER_URL="https://your-worker.workers.dev"

# Use ai-aligned-gh normally - it handles the device flow
ai-aligned-gh pr create --title "My PR" --body "Properly attributed!"
```

## 📝 Manual Testing

```bash
# Start device flow
RESPONSE=$(curl -sS -X POST https://your-worker.workers.dev/user-token/start \
  -H "Content-Type: application/json" \
  -d '{"scopes": "repo"}')

# Extract values
USER_CODE=$(echo $RESPONSE | jq -r .user_code)
DEVICE_CODE=$(echo $RESPONSE | jq -r .device_code)

# Show instructions
echo "1. Go to: https://github.com/login/device"
echo "2. Enter code: $USER_CODE"
echo "3. Then run: curl -X POST https://your-worker.workers.dev/user-token/poll -d '{\"device_code\":\"$DEVICE_CODE\"}'"
```

## 🔍 Verify Attribution

Create a test issue to verify proper attribution:

```bash
# Get token from device flow
TOKEN="ghu_..."  # Your user-to-server token

# Create issue
curl -X POST https://api.github.com/repos/OWNER/REPO/issues \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Test", "body": "Should show me as author with app badge"}'
```

**Expected**: Issue shows your username + app badge, NOT "app/as-a-bot"

## 🖼️ Image Uploads (`gh image`)

`gh` cannot attach images to PRs or issues ([cli/cli#12960](https://github.com/cli/cli/issues/12960)),
which is a real limitation for coding agents. This worker doubles as an upload
broker for the `gh image` command in
[ai-aligned-gh](https://github.com/ai-ecoverse/ai-aligned-gh): a secret-free
GitHub Actions workflow in the target repo (dispatchable only by users with
write access, and **committed automatically when the app is installed**)
proves repository identity via OIDC; the worker mints a checksum-bound
pre-signed R2 PUT URL; `gh image` polls for it, uploads the file, and gets
back a stable serve URL. Uploads are kept for 90 days — re-running
`gh image` on the same file renews the same URL.

See **[docs/image-upload-design.md](docs/image-upload-design.md)** for the full
design and trust model.

### Endpoints

```bash
POST /webhook                # app installation events: auto-install the workflow
POST /image-upload/offer     # workflow requests a pre-signed URL (GitHub OIDC auth)
GET  /image-upload/status    # gh image polls: ?owner=&repo=&hash=&ext=
GET  /i/{owner}/{repo}/{hash}.{ext}   # serve the uploaded file (immutable, 90-day TTL)
```

### Repo setup

Install the [as-a-bot app](https://github.com/apps/as-a-bot) on the repository.
The workflow is committed automatically; no secrets or variables are needed.

### Worker setup

Deployment is CI-driven: every push to `main` runs the tests, syncs worker
secrets, and deploys (`.github/workflows/deploy.yml`). Set these **Actions
secrets** on this repo once:

| Actions secret | Purpose |
|----------------|---------|
| `CLOUDFLARE_TOKEN` | API token with Workers Scripts edit (deploy) |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 S3 credential (pre-signing only) |
| `GITHUB_WEBHOOK_SECRET` | App webhook secret — same value as in the app settings |

One-time infrastructure (already provisioned for the canonical deployment):

```bash
wrangler r2 bucket create as-a-bot-images
wrangler r2 bucket lifecycle add as-a-bot-images --name expire-uploads --expire-days 90
```

The GitHub App needs its webhook pointed at `/webhook` (with
`GITHUB_WEBHOOK_SECRET`) and **Contents + Workflows (Read & write)**
repository permissions for the auto-install. Installation events are
delivered to GitHub Apps automatically.

## ⚙️ Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `GITHUB_CLIENT_ID` | GitHub App Client ID | Yes |
| `GITHUB_API` | GitHub API URL (default: https://api.github.com) | No |
| `IMAGE_OIDC_AUDIENCE` | OIDC audience for image upload offers (default: as-a-bot-images) | No |
| `R2_ACCOUNT_ID` / `R2_BUCKET` | R2 coordinates for image uploads | For gh image |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 S3 credentials (secret; pre-signing only) | For gh image |
| `GITHUB_WEBHOOK_SECRET` | App webhook secret (secret; for /webhook) | For auto-install |

## 🏗️ Architecture

```
ai-aligned-gh
     ↓
[Device Flow Start] → User authorizes on GitHub
     ↓
[Device Flow Poll] → Receives user-to-server token
     ↓
GitHub API calls show proper user attribution
```

## Related Projects

Part of the **[AI Ecoverse](https://github.com/ai-ecoverse/.github)** - a comprehensive ecosystem of tools for AI-assisted development:

- **[yolo](https://github.com/ai-ecoverse/yolo)** - AI CLI launcher with worktree isolation
- **[ai-aligned-git](https://github.com/ai-ecoverse/ai-aligned-git)** - Git wrapper for safe AI commit practices
- **[ai-aligned-gh](https://github.com/ai-ecoverse/ai-aligned-gh)** - GitHub CLI wrapper for proper AI attribution
- **[vibe-coded-badge-action](https://github.com/ai-ecoverse/vibe-coded-badge-action)** - Badge showing AI-generated code percentage
- **[gh-workflow-peek](https://github.com/ai-ecoverse/gh-workflow-peek)** - Smarter GitHub Actions log filtering
- **[upskill](https://github.com/ai-ecoverse/gh-upskill)** - Install Claude/Agent skills from other repositories

## 📄 License

Apache 2.0
