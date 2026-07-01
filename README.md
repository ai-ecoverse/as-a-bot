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
[ai-aligned-gh](https://github.com/ai-ecoverse/ai-aligned-gh): a GitHub Actions
workflow in the target repo (dispatchable only by users with write access)
pre-signs a checksum-bound R2 PUT URL and registers it here; `gh image` polls
for it, uploads the file, and gets back a stable serve URL.

See **[docs/image-upload-design.md](docs/image-upload-design.md)** for the full
design and trust model.

### Endpoints

```bash
POST /image-upload/offer     # workflow registers a pre-signed URL (GitHub OIDC auth)
GET  /image-upload/status    # gh image polls: ?owner=&repo=&hash=&ext=
GET  /i/{owner}/{repo}/{hash}.{ext}   # serve the uploaded file (immutable)
```

### Repo setup

1. Copy [`templates/image-upload.yml`](templates/image-upload.yml) to
   `.github/workflows/image-upload.yml` in your repository.
2. Add Actions secrets: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY` (an R2 API token with object write on the bucket).

### Worker setup

```bash
wrangler r2 bucket create as-a-bot-images
wrangler deploy
```

## ⚙️ Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `GITHUB_CLIENT_ID` | GitHub App Client ID | Yes |
| `GITHUB_API` | GitHub API URL (default: https://api.github.com) | No |
| `IMAGE_OIDC_AUDIENCE` | OIDC audience for image upload offers (default: as-a-bot-images) | No |

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
