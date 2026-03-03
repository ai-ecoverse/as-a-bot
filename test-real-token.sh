#!/bin/bash
SECRET="$GITHUB_TOKEN"
BODY='{"owner":"trieloff","repo":"as-a-bot"}'

echo "Testing token generation for ai-ecoverse/as-a-bot..."
curl -X POST https://as-bot-worker.minivelos.workers.dev/token \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -d "$BODY" \
  -w "\n\nHTTP Status: %{http_code}\n" 2>/dev/null | jq '.'
