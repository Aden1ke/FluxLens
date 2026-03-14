"""
CodeLive Backend — FastAPI + Gemini Live API WebSocket relay
Handles bidirectional audio/vision streaming between browser and Gemini
"""
import asyncio
import base64
import json
import logging
import os
from typing import AsyncGenerator

import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="CodeLive API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

GEMINI_MODEL = "gemini-2.0-flash-live-001"
GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "")

SYSTEM_PROMPT = """You are CodeLive, an expert pair programmer who can SEE the user's screen in real time.

Your personality:
- Concise and direct — no fluff
- You speak like a senior engineer reviewing code with a colleague
- You notice bugs, accessibility issues, performance problems, and code smells

Your capabilities:
- You receive live screen frames showing the user's IDE, browser, or terminal
- You receive audio from the user's microphone
- You can be interrupted at any time — immediately stop and listen

Your output format:
- Speak naturally in response to voice
- When you identify a code issue, say WHERE it is (file, line if visible), WHAT the problem is, and HOW to fix it
- After speaking, output a JSON block for the frontend to parse:
  {"type": "code_action", "file": "filename", "issue": "description", "fix": "corrected code snippet"}
- If no code action needed, skip the JSON block

Stay focused on what you can SEE on screen. Do not hallucinate code you cannot see."""


def get_gemini_config() -> types.LiveConnectConfig:
    return types.LiveConnectConfig(
        response_modalities=["AUDIO", "TEXT"],
        system_instruction=types.Content(
            parts=[types.Part(text=SYSTEM_PROMPT)],
            role="user",
        ),
        speech_config=types.SpeechConfig(
            voice_config=types.VoiceConfig(
                prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Aoede")
            )
        ),
    )


@app.get("/health")
async def health():
    return {"status": "ok", "model": GEMINI_MODEL}


@app.websocket("/ws/session")
async def websocket_session(websocket: WebSocket):
    """
    Main WebSocket endpoint. Browser connects here and we relay to Gemini Live API.

    Message protocol (browser → server):
      {"type": "audio", "data": "<base64 PCM 16kHz mono>"}
      {"type": "frame", "data": "<base64 JPEG screenshot>"}
      {"type": "text",  "data": "user typed message"}
      {"type": "end"}

    Message protocol (server → browser):
      {"type": "audio",  "data": "<base64 PCM 24kHz>"}
      {"type": "text",   "data": "transcript chunk"}
      {"type": "action", "data": {code_action object}}
      {"type": "turn_complete"}
      {"type": "error",  "data": "message"}
    """
    await websocket.accept()
    logger.info("Client connected")

    client = genai.Client(api_key=GOOGLE_API_KEY)

    try:
        async with client.aio.live.connect(
            model=GEMINI_MODEL, config=get_gemini_config()
        ) as session:
            logger.info("Gemini Live session opened")

            # Run send and receive loops concurrently
            await asyncio.gather(
                _browser_to_gemini(websocket, session),
                _gemini_to_browser(session, websocket),
            )

    except WebSocketDisconnect:
        logger.info("Client disconnected")
    except Exception as e:
        logger.error(f"Session error: {e}")
        try:
            await websocket.send_json({"type": "error", "data": str(e)})
        except Exception:
            pass


async def _browser_to_gemini(websocket: WebSocket, session) -> None:
    """Forward browser messages to Gemini Live session."""
    while True:
        try:
            raw = await websocket.receive_text()
            msg = json.loads(raw)
            msg_type = msg.get("type")

            if msg_type == "audio":
                # Raw PCM audio from microphone (16kHz, 16-bit, mono)
                audio_bytes = base64.b64decode(msg["data"])
                await session.send(
                    input=types.LiveClientRealtimeInput(
                        media_chunks=[
                            types.Blob(data=audio_bytes, mime_type="audio/pcm;rate=16000")
                        ]
                    )
                )

            elif msg_type == "frame":
                # JPEG screenshot frame
                frame_bytes = base64.b64decode(msg["data"])
                await session.send(
                    input=types.LiveClientRealtimeInput(
                        media_chunks=[
                            types.Blob(data=frame_bytes, mime_type="image/jpeg")
                        ]
                    )
                )

            elif msg_type == "text":
                # Text message (typed input or system event)
                await session.send(input=msg["data"], end_of_turn=True)

            elif msg_type == "end":
                logger.info("Client signaled end of turn")
                break

        except WebSocketDisconnect:
            break
        except Exception as e:
            logger.error(f"browser→gemini error: {e}")
            break


async def _gemini_to_browser(session, websocket: WebSocket) -> None:
    """Forward Gemini responses back to the browser."""
    text_buffer = ""

    async for response in session.receive():
        try:
            # Audio response
            if response.data:
                audio_b64 = base64.b64encode(response.data).decode()
                await websocket.send_json({"type": "audio", "data": audio_b64})

            # Text / transcript response
            if response.text:
                text_buffer += response.text
                await websocket.send_json({"type": "text", "data": response.text})

                # Check if text contains a code action JSON block
                if '{"type": "code_action"' in text_buffer:
                    try:
                        start = text_buffer.index('{"type": "code_action"')
                        end = text_buffer.index("}", start) + 1
                        action_json = text_buffer[start:end]
                        action = json.loads(action_json)
                        await websocket.send_json({"type": "action", "data": action})
                        text_buffer = ""
                    except (ValueError, json.JSONDecodeError):
                        pass  # Incomplete JSON, wait for more chunks

            # Turn complete signal
            if response.server_content and response.server_content.turn_complete:
                await websocket.send_json({"type": "turn_complete"})
                text_buffer = ""

        except WebSocketDisconnect:
            break
        except Exception as e:
            logger.error(f"gemini→browser error: {e}")
            break


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8080, reload=True)
