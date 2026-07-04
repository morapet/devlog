# devlog on Google Cloud Run (with Litestream)

Cloud Run gives you a free HTTPS URL (`https://devlog-….run.app`) and
scale-to-zero pricing that lands in the free tier for single-user use. The
catch: instances have an **ephemeral filesystem**, and devlog stores
everything in one SQLite file. This recipe solves that the canonical way —
[Litestream](https://litestream.io) streams every write to a Cloud Storage
bucket and restores the DB when a fresh instance boots.

Set `DEVLOG_PASSWORD` — the URL is public.

## Prerequisites

- A Google Cloud project with billing enabled (usage here fits the
  always-free tier; GCS costs cents).
- The published image `ghcr.io/morapet/devlog:latest` must be **public**
  and contain the auth feature (post-PR-#1 `main`).

Everything below runs in [Cloud Shell](https://shell.cloud.google.com) —
nothing to install locally.

## Deploy

```bash
REGION=europe-west1
BUCKET=$GOOGLE_CLOUD_PROJECT-devlog

git clone --depth 1 https://github.com/morapet/devlog.git
cd devlog/deploy/cloud-run

# 1. Bucket for the replicated database
gcloud storage buckets create gs://$BUCKET --location=$REGION

# 2. Let Cloud Run's service account read/write it
PROJECT_NUMBER=$(gcloud projects describe $GOOGLE_CLOUD_PROJECT --format='value(projectNumber)')
gcloud storage buckets add-iam-policy-binding gs://$BUCKET \
    --member=serviceAccount:$PROJECT_NUMBER-compute@developer.gserviceaccount.com \
    --role=roles/storage.objectAdmin

# 3. Build + deploy (Cloud Build picks up the Dockerfile in this directory)
gcloud run deploy devlog \
    --source . \
    --region $REGION \
    --allow-unauthenticated \
    --max-instances 1 \
    --memory 512Mi \
    --set-env-vars "LITESTREAM_REPLICA_URL=gcs://$BUCKET/devlog,DEVLOG_PASSWORD=$(openssl rand -base64 24)"
```

The deploy prints the service URL. Open it, sign in (the password is in
the service's env vars: Cloud Run console → devlog → Revisions →
Variables), and on the iPhone: Share → **Add to Home Screen**.

## CI/CD from GitHub Actions

`.github/workflows/deploy-cloud-run.yml` redeploys on every push to `main`
(and on demand from the Actions tab). It builds the image from source in CI
and pushes it to Artifact Registry — Cloud Run can't pull from GHCR. The
job only activates when the `GCP_PROJECT` repo variable exists, so nothing
happens on forks or before you finish this setup.

One-time GCP setup (Cloud Shell; assumes the bucket from the Deploy section
above already exists):

```bash
REGION=europe-west1
DEPLOYER=devlog-deployer@$GOOGLE_CLOUD_PROJECT.iam.gserviceaccount.com
PROJECT_NUMBER=$(gcloud projects describe $GOOGLE_CLOUD_PROJECT --format='value(projectNumber)')

gcloud services enable run.googleapis.com artifactregistry.googleapis.com

# Image repository
gcloud artifacts repositories create devlog --repository-format=docker --location=$REGION

# Deployer service account: push images, deploy the service, act as the runtime SA
gcloud iam service-accounts create devlog-deployer
gcloud projects add-iam-policy-binding $GOOGLE_CLOUD_PROJECT \
    --member=serviceAccount:$DEPLOYER --role=roles/run.admin
gcloud projects add-iam-policy-binding $GOOGLE_CLOUD_PROJECT \
    --member=serviceAccount:$DEPLOYER --role=roles/artifactregistry.writer
gcloud iam service-accounts add-iam-policy-binding \
    $PROJECT_NUMBER-compute@developer.gserviceaccount.com \
    --member=serviceAccount:$DEPLOYER --role=roles/iam.serviceAccountUser

# Key for GitHub (paste the file's contents into the GCP_SA_KEY secret)
gcloud iam service-accounts keys create devlog-deployer-key.json --iam-account=$DEPLOYER
cat devlog-deployer-key.json
```

Then in GitHub → repo **Settings → Secrets and variables → Actions**:

| Kind | Name | Value |
|---|---|---|
| Variable | `GCP_PROJECT` | your project id |
| Variable | `GCP_REGION` | optional, defaults to `europe-west1` |
| Variable | `DEVLOG_BUCKET` | the GCS bucket name from the Deploy section |
| Secret | `GCP_SA_KEY` | the JSON key file's contents |
| Secret | `DEVLOG_PASSWORD` | your login password |

Delete `devlog-deployer-key.json` from Cloud Shell after pasting it. (The
key is long-lived; if you ever want keyless auth, the workflow's `auth`
step also supports Workload Identity Federation.)

## The fine print

- **`--max-instances 1` is mandatory.** SQLite has one writer; two Cloud
  Run instances would fork the database. Don't raise it.
- **Durability**: Litestream replicates asynchronously (sub-second lag).
  If an instance is killed mid-write, the last moments of work can be
  lost — fine for a personal tracker, but know the trade-off.
- **Cold starts**: after idle, the first request takes a few seconds
  (container boot + DB restore). `--min-instances 1` removes that but
  costs real money; scale-to-zero is the sensible default here.
- **End-of-workday auto-pause** only runs while an instance is warm. If
  you rely on it, add a Cloud Scheduler job that hits the service URL
  once shortly after your workday ends — the wake-up runs the check:
  `gcloud scheduler jobs create http devlog-autostop --schedule "5 18 * * *" --uri https://YOUR-URL.run.app/health`
- **Backups beyond the live replica**: turn on [object versioning]
  (`gcloud storage buckets update gs://$BUCKET --versioning`) for
  point-in-time safety nets.
- **Updating**: re-run the `gcloud run deploy` command after pulling the
  latest repo (it rebuilds against the current `ghcr.io` image).
