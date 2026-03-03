#!/bin/bash

# Check if GITHUB_TOKEN is set
if [ -z "$GITHUB_TOKEN" ]; then
    echo "Error: GITHUB_TOKEN environment variable not set"
    echo "Please set your GitHub personal access token:"
    echo "  export GITHUB_TOKEN=your_github_token"
    exit 1
fi

# Get the token
BODY='{"owner":"trieloff","repo":"as-a-bot"}'

echo "Getting installation token..."
response=$(curl -sS -X POST https://as-bot-worker.minivelos.workers.dev/token \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -d "$BODY")

TOKEN=$(echo "$response" | jq -r '.token')
echo "✅ Token obtained"

# Create a demo file using the GitHub API
echo ""
echo "Creating a demo file in the repository using the token..."

file_content=$(cat << 'CONTENT'
# Token Broker Demo

This file was created by the GitHub App using a token from the Cloudflare Worker token broker.

- Token obtained from: https://as-bot-worker.minivelos.workers.dev
- Created at: $(date -u +"%Y-%m-%d %H:%M:%S UTC")
- App ID: 1881227

This demonstrates that the token broker is working correctly and can facilitate GitHub App actions!
CONTENT
)

# Base64 encode the content
encoded_content=$(echo "$file_content" | base64 | tr -d '\n')

# Create the file via API
curl -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/ai-ecoverse/as-a-bot/contents/token-broker-demo.md" \
  -d "$(jq -n \
    --arg content "$encoded_content" \
    --arg message "demo: create file using token from broker [skip ci]" \
    '{message: $message, content: $content, branch: "terragon/github-app-token-broker-worker"}')" \
  -w "\nHTTP Status: %{http_code}\n" | jq '.content.name, .commit.message' 2>/dev/null || echo "Response received"
