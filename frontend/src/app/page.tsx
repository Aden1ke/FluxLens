"use client";

import { useEffect, useRef, useState, useCallback } from "react";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8080/ws/session";

// Audio config — must match backend expectations
const MIC_SAMPLE_RATE = 16000;
const GEMINI_SAMPLE_RATE = 24000; // Gemini outputs 24kHz PCM

type SessionStatus = "idle" | "connecting" | "live" | "error";

interface CodeAction {
  type: "code_action";
  file: string;
  issue: string;
  fix: string;
}

interface TranscriptEntry {
  role: "agent" | "system";
  text: string;
  timestamp: string;
}

export default function Home() {
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [codeActions, setCodeActions] = useState<CodeAction[]>([]);
  const [isCapturingScreen, setIsCapturingScreen] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const frameIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playbackQueueRef = useRef<ArrayBuffer[]>([]);
  const isPlayingRef = useRef(false);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  const addTranscript = useCallback((role: "agent" | "system", text: string) => {
    setTranscript((prev) => [
      ...prev,
      { role, text, timestamp: new Date().toLocaleTimeString() },
    ]);
  }, []);

  // Play PCM audio from Gemini (24kHz, 16-bit, mono)
  const playAudioChunk = useCallback(async (base64Data: string) => {
    const ctx = audioContextRef.current;
    if (!ctx) return;

    const raw = atob(base64Data);
    const pcm = new Int16Array(raw.length / 2);
    for (let i = 0; i < pcm.length; i++) {
      pcm[i] = (raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8));
    }
    const float32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      float32[i] = pcm[i] / 32768.0;
    }

    const buffer = ctx.createBuffer(1, float32.length, GEMINI_SAMPLE_RATE);
    buffer.copyToChannel(float32, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start();
  }, []);

  // Start screen capture
  const startScreenCapture = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 2, width: 1280, height: 720 },
        audio: false,
      });
      screenStreamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setIsCapturingScreen(true);

      stream.getVideoTracks()[0].addEventListener("ended", () => {
        setIsCapturingScreen(false);
      });
    } catch (e) {
      addTranscript("system", "Screen capture cancelled or denied.");
    }
  }, [addTranscript]);

  // Stop screen capture
  const stopScreenCapture = useCallback(() => {
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    setIsCapturingScreen(false);
  }, []);

  // Capture a single JPEG frame and send to backend
  const captureAndSendFrame = useCallback(() => {
    const ws = wsRef.current;
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !canvas || !video) return;
    if (video.videoWidth === 0) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(video, 0, 0);

    // Compress to JPEG at 80% quality and send as base64
    const dataUrl = canvas.toDataURL("image/jpeg", 0.8);
    const base64 = dataUrl.split(",")[1];
    ws.send(JSON.stringify({ type: "frame", data: base64 }));
  }, []);

  // Start microphone capture and stream PCM to backend
  const startMicrophone = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: MIC_SAMPLE_RATE,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    micStreamRef.current = stream;

    const ctx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE });
    audioContextRef.current = ctx;

    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processorRef.current = processor;

    processor.onaudioprocess = (e) => {
      if (isMuted) return;
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const float32 = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        pcm16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
      }
      const bytes = new Uint8Array(pcm16.buffer);
      const base64 = btoa(String.fromCharCode(...bytes));
      ws.send(JSON.stringify({ type: "audio", data: base64 }));
    };

    source.connect(processor);
    processor.connect(ctx.destination);
  }, [isMuted]);

  // Connect to backend WebSocket and start session
  const startSession = useCallback(async () => {
    setError(null);
    setStatus("connecting");
    setTranscript([]);
    setCodeActions([]);

    try {
      await startScreenCapture();
      await startMicrophone();

      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        setStatus("live");
        addTranscript("system", "Session started — CodeLive is watching your screen.");
        // Send frames every 2 seconds
        frameIntervalRef.current = setInterval(captureAndSendFrame, 2000);
      };

      ws.onmessage = async (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === "audio") {
          await playAudioChunk(msg.data);
        } else if (msg.type === "text") {
          setTranscript((prev) => {
            const last = prev[prev.length - 1];
            if (last?.role === "agent") {
              return [...prev.slice(0, -1), { ...last, text: last.text + msg.data }];
            }
            return [...prev, { role: "agent", text: msg.data, timestamp: new Date().toLocaleTimeString() }];
          });
        } else if (msg.type === "action") {
          setCodeActions((prev) => [msg.data, ...prev.slice(0, 9)]);
        } else if (msg.type === "turn_complete") {
          // Agent finished speaking — ready for next input
        } else if (msg.type === "error") {
          setError(msg.data);
          setStatus("error");
        }
      };

      ws.onerror = () => {
        setError("WebSocket connection failed. Is the backend running?");
        setStatus("error");
      };

      ws.onclose = () => {
        if (status === "live") setStatus("idle");
      };
    } catch (e: any) {
      setError(e.message);
      setStatus("error");
    }
  }, [startScreenCapture, startMicrophone, captureAndSendFrame, playAudioChunk, addTranscript, status]);

  // Stop everything
  const endSession = useCallback(() => {
    if (frameIntervalRef.current) clearInterval(frameIntervalRef.current);
    wsRef.current?.send(JSON.stringify({ type: "end" }));
    wsRef.current?.close();
    wsRef.current = null;
    processorRef.current?.disconnect();
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    audioContextRef.current?.close();
    stopScreenCapture();
    setStatus("idle");
    addTranscript("system", "Session ended.");
  }, [stopScreenCapture, addTranscript]);

  const statusColor = {
    idle: "#888",
    connecting: "#f59e0b",
    live: "#22c55e",
    error: "#ef4444",
  }[status];

  return (
    <main style={{ minHeight: "100vh", background: "#0f0f0f", color: "#e5e5e5", fontFamily: "monospace", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <header style={{ borderBottom: "1px solid #222", padding: "14px 24px", display: "flex", alignItems: "center", gap: 16 }}>
        <span style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-0.5px" }}>CodeLive</span>
        <span style={{ fontSize: 12, color: "#666" }}>AI pair programmer that sees your screen</span>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: statusColor, display: "inline-block" }} />
          <span style={{ fontSize: 12, color: "#888", textTransform: "uppercase" }}>{status}</span>
        </div>
      </header>

      <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
        {/* Left: Screen preview */}
        <div style={{ width: 420, borderRight: "1px solid #222", display: "flex", flexDirection: "column", padding: 16, gap: 12 }}>
          <div style={{ fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 1 }}>Screen Preview</div>

          <div style={{ background: "#1a1a1a", borderRadius: 8, border: "1px solid #222", aspectRatio: "16/9", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", position: "relative" }}>
            <video
              ref={videoRef}
              muted
              style={{ width: "100%", height: "100%", objectFit: "contain", display: isCapturingScreen ? "block" : "none" }}
            />
            {!isCapturingScreen && (
              <div style={{ textAlign: "center", color: "#444" }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>🖥</div>
                <div style={{ fontSize: 13 }}>No screen captured</div>
              </div>
            )}
          </div>

          <canvas ref={canvasRef} style={{ display: "none" }} />

          {/* Controls */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {status === "idle" || status === "error" ? (
              <button
                onClick={startSession}
                style={{ padding: "12px 0", background: "#22c55e", color: "#000", border: "none", borderRadius: 6, fontWeight: 600, cursor: "pointer", fontSize: 14 }}
              >
                Start Session
              </button>
            ) : (
              <button
                onClick={endSession}
                style={{ padding: "12px 0", background: "#ef4444", color: "#fff", border: "none", borderRadius: 6, fontWeight: 600, cursor: "pointer", fontSize: 14 }}
              >
                End Session
              </button>
            )}

            {status === "live" && (
              <button
                onClick={() => setIsMuted((m) => !m)}
                style={{ padding: "10px 0", background: "transparent", color: isMuted ? "#ef4444" : "#888", border: "1px solid #333", borderRadius: 6, cursor: "pointer", fontSize: 13 }}
              >
                {isMuted ? "🔇 Muted — click to unmute" : "🎤 Mic active"}
              </button>
            )}
          </div>

          {error && (
            <div style={{ background: "#1f0000", border: "1px solid #4a0000", borderRadius: 6, padding: 12, fontSize: 12, color: "#ef4444" }}>
              {error}
            </div>
          )}

          {/* Suggested prompts */}
          {status === "live" && (
            <div>
              <div style={{ fontSize: 11, color: "#555", marginBottom: 8, textTransform: "uppercase", letterSpacing: 1 }}>Try saying</div>
              {[
                "What bug do you see on my screen?",
                "Review this component for accessibility issues",
                "How would you refactor this code?",
                "Explain what this function does",
              ].map((p) => (
                <div key={p} style={{ fontSize: 12, color: "#555", padding: "6px 0", borderBottom: "1px solid #1a1a1a" }}>{p}</div>
              ))}
            </div>
          )}
        </div>

        {/* Center: Transcript */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 1, borderBottom: "1px solid #1a1a1a" }}>
            Live Transcript
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            {transcript.length === 0 && (
              <div style={{ color: "#333", fontSize: 13, marginTop: 40, textAlign: "center" }}>
                Start a session and speak — CodeLive will respond here.
              </div>
            )}
            {transcript.map((entry, i) => (
              <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <span style={{ fontSize: 11, color: "#444", minWidth: 60, paddingTop: 2 }}>{entry.timestamp}</span>
                <span style={{ fontSize: 12, color: entry.role === "agent" ? "#22c55e" : "#555", minWidth: 50 }}>
                  {entry.role === "agent" ? "Agent" : "System"}
                </span>
                <span style={{ fontSize: 13, color: "#ccc", lineHeight: 1.6 }}>{entry.text}</span>
              </div>
            ))}
            <div ref={transcriptEndRef} />
          </div>
        </div>

        {/* Right: Code Actions */}
        <div style={{ width: 320, borderLeft: "1px solid #222", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", fontSize: 11, color: "#555", textTransform: "uppercase", letterSpacing: 1, borderBottom: "1px solid #1a1a1a" }}>
            Code Actions
          </div>
          <div style={{ flex: 1, overflowY: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 12 }}>
            {codeActions.length === 0 && (
              <div style={{ color: "#333", fontSize: 12, marginTop: 20, textAlign: "center" }}>
                Code fixes will appear here
              </div>
            )}
            {codeActions.map((action, i) => (
              <div key={i} style={{ background: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 6, padding: 12 }}>
                <div style={{ fontSize: 11, color: "#888", marginBottom: 6 }}>{action.file || "unknown file"}</div>
                <div style={{ fontSize: 12, color: "#f59e0b", marginBottom: 8 }}>{action.issue}</div>
                <pre style={{ fontSize: 11, color: "#86efac", background: "#0d1f0d", padding: 10, borderRadius: 4, overflow: "auto", margin: 0, whiteSpace: "pre-wrap" }}>
                  {action.fix}
                </pre>
              </div>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
