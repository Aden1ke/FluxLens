terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
  }
}

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "google_api_key" {
  description = "Gemini API key"
  type        = string
  sensitive   = true
}

variable "region" {
  description = "GCP region"
  default     = "us-central1"
}

provider "google" {
  project = var.project_id
  region  = var.region
}

# Enable required APIs
resource "google_project_service" "run" {
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "artifact_registry" {
  service            = "artifactregistry.googleapis.com"
  disable_on_destroy = false
}

# Artifact Registry for Docker images
resource "google_artifact_registry_repository" "codelive" {
  location      = var.region
  repository_id = "codelive"
  format        = "DOCKER"
  depends_on    = [google_project_service.artifact_registry]
}

# Cloud Run service
resource "google_cloud_run_v2_service" "backend" {
  name     = "codelive-backend"
  location = var.region
  depends_on = [google_project_service.run]

  template {
    containers {
      image = "${var.region}-docker.pkg.dev/${var.project_id}/codelive/backend:latest"

      env {
        name  = "GOOGLE_API_KEY"
        value = var.google_api_key
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }

    scaling {
      min_instance_count = 0
      max_instance_count = 10
    }
  }
}

# Allow unauthenticated access (public demo)
resource "google_cloud_run_v2_service_iam_member" "public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.backend.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "backend_url" {
  value       = google_cloud_run_v2_service.backend.uri
  description = "Backend WebSocket URL — use wss://<this>/ws/session in your frontend"
}
