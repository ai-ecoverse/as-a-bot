#!/bin/bash

# Check if GITHUB_TOKEN is set
if [ -z "$GITHUB_TOKEN" ]; then
    echo "Error: GITHUB_TOKEN environment variable not set"
    echo "Please set your GitHub personal access token:"
    echo "  export GITHUB_TOKEN=your_github_token"
    exit 1
fi

BODY='{"owner":"trieloff","repo":"as-a-bot"}'

echo "Getting installation token for ai-ecoverse/as-a-bot..."
response=$(curl -sS -X POST https://as-bot-worker.minivelos.workers.dev/token \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -d "$BODY")

echo "$response" | jq '.'

# Extract the token
TOKEN=$(echo "$response" | jq -r '.token')
if [ "$TOKEN" != "null" ] && [ -n "$TOKEN" ]; then
  echo ""
  echo "✅ Token obtained successfully!"
  echo "Token (first 10 chars): ${TOKEN:0:10}..."
  export GH_TOKEN="$TOKEN"
else
  echo ""
  echo "❌ Failed to get token"
  exit 1
fi
