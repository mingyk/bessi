#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${CLOUD_RUN_REGION:-us-west1}"
SERVICE="${CLOUD_RUN_SERVICE:-galbi-voice}"

if [[ -f .env ]]; then
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    name="${line%%=*}"
    value="${line#*=}"
    name="${name#export }"
    name="${name%"${name##*[![:space:]]}"}"
    if [[ -z "${!name:-}" ]]; then
      export "$name=$value"
    fi
  done < .env
fi

if [[ -z "${OPENAI_API_KEY:-}" ]]; then
  echo "OPENAI_API_KEY is missing"
  exit 1
fi

VARS="OPENAI_API_KEY=${OPENAI_API_KEY}"
if [[ -n "${TWILIO_AUTH_TOKEN:-}" ]]; then
  VARS="${VARS},TWILIO_AUTH_TOKEN=${TWILIO_AUTH_TOKEN}"
fi
if [[ -n "${TWILIO_PUBLIC_BASE_URL:-}" ]]; then
  VARS="${VARS},TWILIO_PUBLIC_BASE_URL=${TWILIO_PUBLIC_BASE_URL}"
fi

gcloud run deploy "$SERVICE" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --timeout 3600 \
  --min-instances 1 \
  --max-instances 3 \
  --session-affinity \
  --set-env-vars "$VARS"

URL="$(gcloud run services describe "$SERVICE" --region "$REGION" --format='value(status.url)')"
echo
echo "Service: $URL"
echo "Twilio voice webhook (HTTP POST): $URL/voice"
echo "If TWILIO_PUBLIC_BASE_URL was empty, set it to $URL and deploy once more."
