#!/bin/bash
# deploy.sh — Build and deploy backend to Cloud Run in one command
# Usage: GCP_PROJECT=your-project GOOGLE_API_KEY=your-key ./deploy.sh

set -e

PROJECT=${GCP_PROJECT:?Set GCP_PROJECT}
REGION=${REGION:-us-central1}
IMAGE="$REGION-docker.pkg.dev/$PROJECT/codelive/backend:latest"

echo "🔧 Enabling APIs..."
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  --project "$PROJECT"

echo "📦 Creating Artifact Registry repo (if not exists)..."
gcloud artifacts repositories create codelive \
  --repository-format=docker \
  --location="$REGION" \
  --project "$PROJECT" 2>/dev/null || true

echo "🐳 Building and pushing Docker image..."
cd "$(dirname "$0")/../backend"
gcloud builds submit --tag "$IMAGE" --project "$PROJECT"

echo "🚀 Deploying to Cloud Run..."
gcloud run deploy codelive-backend \
  --image "$IMAGE" \
  --region "$REGION" \
  --platform managed \
  --allow-unauthenticated \
  --set-env-vars "GOOGLE_API_KEY=${GOOGLE_API_KEY:?Set GOOGLE_API_KEY}" \
  --memory 512Mi \
  --cpu 1 \
  --min-instances 0 \
  --max-instances 10 \
  --project "$PROJECT"

echo ""
echo "✅ Deployed! Backend URL:"
gcloud run services describe codelive-backend \
  --region "$REGION" \
  --project "$PROJECT" \
  --format "value(status.url)"
echo ""
echo "Set this as NEXT_PUBLIC_WS_URL in your frontend (replace https with wss):"
URL=$(gcloud run services describe codelive-backend --region "$REGION" --project "$PROJECT" --format "value(status.url)")
echo "NEXT_PUBLIC_WS_URL=${URL/https/wss}/ws/session"
