# CodeLive — AI Pair Programmer

> **Real-time voice + vision coding assistant powered by Gemini Live API**
> Gemini Live Agent Challenge submission — UI Navigator category

CodeLive watches your screen, listens to your voice, and responds like a senior engineer sitting next to you. Ask it to spot bugs, explain code, or suggest refactors — all hands-free, in real time.

---

## Demo

[4-minute demo video link]

---

## Architecture

```
Browser (Next.js)
  ├── getDisplayMedia()  →  JPEG frames (2fps)  ─┐
  └── getUserMedia()     →  PCM audio (16kHz)   ─┤
                                                  ↓
                                    FastAPI Backend (Cloud Run)
                                         WebSocket relay
                                                  ↓
                                    Gemini 2.0 Flash Live API
                                    (BidiGenerateContent)
                                                  ↓
                               ┌──────────────────────────────┐
                               │  Audio response (24kHz PCM)  │
                               │  Text transcript             │
                               │  Code action JSON            │
                               └──────────────────────────────┘
                                                  ↑
                                    FastAPI streams back
                                                  ↑
                               Browser plays audio + shows fixes
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| AI Model | Gemini 2.0 Flash Live (`gemini-2.0-flash-live-001`) |
| AI SDK | Google GenAI Python SDK (`google-genai`) |
| Backend | Python FastAPI + WebSockets |
| Hosting | Google Cloud Run |
| Frontend | Next.js 15 + TypeScript |
| IaC | Terraform + `deploy.sh` |

---

## Local Setup

### Prerequisites
- Python 3.12+
- Node.js 18+
- [Gemini API key](https://aistudio.google.com/app/apikey)

### 1. Backend

```bash
cd backend
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# Set your API key
export GOOGLE_API_KEY=your_key_here

# Run the backend
python main.py
# → FastAPI running at http://localhost:8080
```

### 2. Frontend

```bash
cd frontend
npm install

# Point frontend to local backend
echo "NEXT_PUBLIC_WS_URL=ws://localhost:8080/ws/session" > .env.local

npm run dev
# → Next.js running at http://localhost:3000
```

Open `http://localhost:3000`, click **Start Session**, allow screen capture and microphone, then start talking.

---

## Deploy to Google Cloud

### Quick deploy (one command)

```bash
export GCP_PROJECT=your-gcp-project-id
export GOOGLE_API_KEY=your-gemini-api-key
chmod +x infra/deploy.sh
./infra/deploy.sh
```

The script will:
1. Enable Cloud Run + Artifact Registry APIs
2. Build and push the Docker image via Cloud Build
3. Deploy to Cloud Run (publicly accessible, scales to zero)
4. Print your `NEXT_PUBLIC_WS_URL` to use in the frontend

### Terraform (alternative)

```bash
cd infra
terraform init
terraform apply \
  -var="project_id=your-project" \
  -var="google_api_key=your-key"
```

### Frontend deployment (Vercel)

```bash
cd frontend
npx vercel --prod
# Set NEXT_PUBLIC_WS_URL to your Cloud Run WSS URL
```

---

## How It Works

1. **Screen capture**: `getDisplayMedia()` captures the screen as a video stream; a canvas grabs a JPEG frame every 2 seconds
2. **Audio capture**: `getUserMedia()` captures microphone as raw PCM (16kHz, 16-bit, mono) — Gemini's required format
3. **WebSocket relay**: Both streams are base64-encoded and sent via WebSocket to the FastAPI backend
4. **Gemini Live session**: The backend opens a `BidiGenerateContent` session with Gemini and forwards media chunks in real time
5. **Response handling**: Gemini returns PCM audio (played immediately) and text (displayed as transcript + parsed for code actions)
6. **Interruption**: Gemini Live supports mid-sentence interruption — just start talking to stop the agent and redirect it

---

## Project Structure

```
codelive/
├── backend/
│   ├── main.py          # FastAPI app + Gemini Live relay
│   ├── requirements.txt
│   └── Dockerfile
├── frontend/
│   └── src/app/
│       ├── page.tsx     # Main UI with screen capture + audio
│       └── layout.tsx
├── infra/
│   ├── main.tf          # Terraform IaC
│   └── deploy.sh        # One-command Cloud Run deploy
└── README.md
```

---

## Google Cloud Services Used

- **Cloud Run** — hosts the FastAPI backend, auto-scales to zero
- **Artifact Registry** — stores Docker images
- **Cloud Build** — builds Docker images from source

---

## Submission Checklist

- [x] Uses Gemini 2.0 Flash Live API (mandatory)
- [x] Uses Google GenAI Python SDK (mandatory)
- [x] Backend hosted on Google Cloud Run (mandatory)
- [x] Multimodal inputs: screen video frames + audio (mandatory)
- [x] Handles real-time interruption via Gemini Live
- [x] Architecture diagram (above)
- [x] `deploy.sh` + `main.tf` for automated Cloud deployment (bonus)
- [ ] Demo video < 4 minutes (record this!)
- [ ] GCP console deployment proof recording (record this!)
- [ ] Blog post with #GeminiLiveAgentChallenge (bonus)
- [ ] GDG profile link (bonus)

---

## Built for

[Gemini Live Agent Challenge](https://geminilivechallenge.devpost.com/) — UI Navigator category
