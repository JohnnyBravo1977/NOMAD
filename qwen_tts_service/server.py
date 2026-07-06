import asyncio
import base64
import hashlib
import io
import logging
import os
import queue
import tempfile
import threading
import time
from dataclasses import dataclass
from typing import AsyncGenerator, Optional

import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

from faster_qwen3_tts import FasterQwen3TTS

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("qwen_tts_service")

CUSTOM_MODEL_PATH = os.environ.get(
    "QWEN_TTS_CUSTOM_MODEL",
    "/models/Qwen3-TTS-12Hz-1.7B-CustomVoice",
)
CLONE_MODEL_PATH = os.environ.get(
    "QWEN_TTS_BASE_MODEL",
    "/models/Qwen3-TTS-12Hz-1.7B-Base",
)
VOICE_DESIGN_MODEL_PATH = os.environ.get(
    "QWEN_TTS_VOICE_DESIGN_MODEL",
    "/models/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
)
DEVICE = os.environ.get("QWEN_TTS_DEVICE", "cuda")
WARMUP_TEXT = os.environ.get("QWEN_TTS_WARMUP_TEXT", "Hello, I'm Quinn.")
DEFAULT_LANGUAGE = os.environ.get("QWEN_TTS_LANGUAGE", "English")
CACHE_TTL_SECONDS = int(os.environ.get("QWEN_TTS_CACHE_TTL_SECONDS", "600"))
DEFAULT_SPEAKER = os.environ.get("QWEN_TTS_DEFAULT_SPEAKER", "Ryan")

app = FastAPI(title="Project NOMAD Qwen TTS")


class SpeakRequest(BaseModel):
    text: str
    engine: str = "custom_voice"
    speaker: Optional[str] = None
    language: str = DEFAULT_LANGUAGE
    instruct: Optional[str] = None
    gender: Optional[str] = None
    description: Optional[str] = None
    delivery: Optional[str] = None
    modelSize: str = "1.7B"
    referenceAudioBase64: Optional[str] = None
    referenceAudioFilename: Optional[str] = None
    referenceText: Optional[str] = None


@dataclass
class CacheEntry:
    audio_bytes: bytes
    expires_at: float


_lock = threading.RLock()
_custom_model: Optional[FasterQwen3TTS] = None
_clone_model: Optional[FasterQwen3TTS] = None
_voice_design_model: Optional[FasterQwen3TTS] = None
_speakers: list[str] = []
_cache: dict[str, CacheEntry] = {}


def _speaker_name_matches(candidate: str, expected: str) -> bool:
    return candidate.strip().lower() == expected.strip().lower()


def _resolve_default_speaker() -> str:
    if not _speakers:
        return DEFAULT_SPEAKER
    exact = next((speaker for speaker in _speakers if _speaker_name_matches(speaker, DEFAULT_SPEAKER)), None)
    if exact:
        return exact
    return _speakers[0]


def _resolve_requested_speaker(requested: Optional[str]) -> str:
    if not _speakers:
        return requested or DEFAULT_SPEAKER
    if requested:
        matched = next((speaker for speaker in _speakers if _speaker_name_matches(speaker, requested)), None)
        if matched:
            return matched
    return _resolve_default_speaker()


def _prune_cache() -> None:
    now = time.time()
    expired = [key for key, value in _cache.items() if value.expires_at <= now]
    for key in expired:
      _cache.pop(key, None)
    if len(_cache) > 128:
        oldest_keys = sorted(_cache.items(), key=lambda item: item[1].expires_at)[: len(_cache) - 128]
        for key, _ in oldest_keys:
            _cache.pop(key, None)


def _to_wav_bytes(audio: np.ndarray, sample_rate: int) -> bytes:
    audio = np.asarray(audio, dtype=np.float32).flatten()
    buf = io.BytesIO()
    sf.write(buf, audio, sample_rate, format="WAV")
    return buf.getvalue()


def _to_pcm16_bytes(audio: np.ndarray) -> bytes:
    audio = np.asarray(audio, dtype=np.float32).flatten()
    return np.clip(audio * 32768.0, -32768, 32767).astype(np.int16).tobytes()


def _load_model(model_path: str) -> FasterQwen3TTS:
    logger.info("Loading FasterQwen3TTS model from %s", model_path)
    return FasterQwen3TTS.from_pretrained(
        model_path,
        device=DEVICE,
        dtype=torch.float16,
        attn_implementation="sdpa",
        max_seq_len=2048,
    )


def _ensure_custom_model() -> None:
    global _custom_model, _speakers
    with _lock:
        if _custom_model is None:
            _custom_model = _load_model(CUSTOM_MODEL_PATH)
            speakers = _custom_model.model.get_supported_speakers() or []
            _speakers = sorted({str(s) for s in speakers})


def _ensure_voice_design_model() -> None:
    global _voice_design_model
    with _lock:
        if _voice_design_model is None:
            _voice_design_model = _load_model(VOICE_DESIGN_MODEL_PATH)


def _ensure_clone_model() -> None:
    global _clone_model
    with _lock:
        if _clone_model is None:
            _clone_model = _load_model(CLONE_MODEL_PATH)


def _warm_models() -> None:
    try:
        _ensure_custom_model()
        if _custom_model and _speakers:
            logger.info("Warming custom voice model with speaker %s", _speakers[0])
            _custom_model.generate_custom_voice(
                text=WARMUP_TEXT,
                speaker=_speakers[0],
                language=DEFAULT_LANGUAGE,
                instruct="",
                max_new_tokens=256,
                do_sample=False,
                top_k=50,
                top_p=1.0,
                repetition_penalty=1.0,
            )
    except Exception:
        logger.exception("Model warmup failed")


def _cache_key(request: SpeakRequest) -> str:
    payload = "|".join(
        [
            request.text.strip(),
            request.engine,
            request.speaker or "",
            request.language,
            request.instruct or "",
            request.gender or "",
            request.description or "",
            request.delivery or "",
            request.modelSize,
            request.referenceText or "",
            request.referenceAudioFilename or "",
            request.referenceAudioBase64 or "",
        ]
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _build_voice_design_instruction(request: SpeakRequest) -> str:
    gender = request.gender if request.gender in {"male", "female"} else "human"
    description = (request.description or "warm, natural speaking voice").strip()
    base = (
        f"Create a distinctly recognizable {gender} voice with these traits: {description}. "
        "Keep the requested accent, cadence, and vocal character clearly audible while staying natural and easy to understand."
    )
    if request.delivery and request.delivery.strip() and request.delivery.strip().lower() != "auto":
        return f"{base} Deliver this line with a {request.delivery.strip()} emotional tone."
    if request.instruct and request.instruct.strip():
        return f"{base} {request.instruct.strip()}"
    return base


def _build_custom_voice_instruction(request: SpeakRequest) -> Optional[str]:
    if request.engine == "voice_clone":
        explicit = (request.instruct or "").strip()
        return explicit or None

    instructions: list[str] = []
    if request.delivery and request.delivery.strip() and request.delivery.strip().lower() != "auto":
        instructions.append(f"Speak with a {request.delivery.strip()} emotional tone.")
    if request.instruct and request.instruct.strip():
        instructions.append(request.instruct.strip())
    if not instructions:
        return None
    return " ".join(instructions)


def _write_reference_audio_to_tempfile(request: SpeakRequest) -> str:
    if not request.referenceAudioBase64:
        raise HTTPException(status_code=422, detail="Reference audio is required for cloned voices.")

    try:
        audio_bytes = base64.b64decode(request.referenceAudioBase64, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=422, detail="Reference audio payload was invalid.") from exc

    try:
        audio, sample_rate = sf.read(io.BytesIO(audio_bytes), dtype="float32", always_2d=False)
    except Exception as exc:
        raise HTTPException(status_code=422, detail="Reference audio could not be decoded.") from exc

    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim > 1:
        audio = np.mean(audio, axis=1, dtype=np.float32)

    with tempfile.NamedTemporaryFile(delete=False, suffix=".wav") as temp_file:
        sf.write(temp_file, audio, sample_rate, format="WAV")
        temp_file.flush()
        return temp_file.name


def _max_new_tokens_for_text(text: str) -> int:
    length = len(text.strip())
    if length <= 60:
        return 160
    if length <= 120:
        return 224
    if length <= 220:
        return 320
    if length <= 360:
        return 448
    return 640


def _stream_chunk_size_for_text(text: str) -> int:
    length = len(text.strip())
    if length <= 120:
        return 2
    if length <= 260:
        return 3
    return 4


def _synthesize_sync(request: SpeakRequest) -> tuple[bytes, str]:
    _ensure_custom_model()
    key = _cache_key(request)
    _prune_cache()
    cached = _cache.get(key)
    if cached and cached.expires_at > time.time():
        return cached.audio_bytes, "audio/wav"

    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=422, detail="Speech text is required.")
    max_new_tokens = _max_new_tokens_for_text(text)

    with _lock:
        if request.engine == "voice_design":
            _ensure_voice_design_model()
            if _voice_design_model is None:
                raise HTTPException(status_code=503, detail="Voice design model is not loaded.")
            audio_list, sr = _voice_design_model.generate_voice_design(
                text=text,
                instruct=_build_voice_design_instruction(request),
                language=request.language or DEFAULT_LANGUAGE,
                max_new_tokens=max_new_tokens,
                do_sample=False,
                top_k=50,
                top_p=1.0,
                repetition_penalty=1.0,
            )
        elif request.engine == "voice_clone":
            _ensure_clone_model()
            if _clone_model is None:
                raise HTTPException(status_code=503, detail="Voice clone model is not loaded.")
            ref_text = (request.referenceText or "").strip()
            if not ref_text:
                raise HTTPException(status_code=422, detail="Reference transcript is required for cloned voices.")
            temp_path = _write_reference_audio_to_tempfile(request)
            try:
                audio_list, sr = _clone_model.generate_voice_clone(
                    text=text,
                    language=request.language or DEFAULT_LANGUAGE,
                    ref_audio=temp_path,
                    ref_text=ref_text,
                    instruct=_build_custom_voice_instruction(request),
                    max_new_tokens=max_new_tokens,
                    do_sample=False,
                    top_k=50,
                    top_p=1.0,
                    repetition_penalty=1.0,
                    xvec_only=False,
                )
            finally:
                try:
                    os.unlink(temp_path)
                except OSError:
                    pass
        else:
            if _custom_model is None:
                raise HTTPException(status_code=503, detail="Custom voice model is not loaded.")
            speaker = _resolve_requested_speaker(request.speaker)
            audio_list, sr = _custom_model.generate_custom_voice(
                text=text,
                speaker=speaker,
                language=request.language or DEFAULT_LANGUAGE,
                instruct=_build_custom_voice_instruction(request),
                max_new_tokens=max_new_tokens,
                do_sample=False,
                top_k=50,
                top_p=1.0,
                repetition_penalty=1.0,
            )

    audio = audio_list[0] if audio_list else np.zeros(1, dtype=np.float32)
    wav_bytes = _to_wav_bytes(audio, sr)
    _cache[key] = CacheEntry(audio_bytes=wav_bytes, expires_at=time.time() + CACHE_TTL_SECONDS)
    return wav_bytes, "audio/wav"


async def _stream_custom_voice(request: SpeakRequest) -> AsyncGenerator[bytes, None]:
    _ensure_custom_model()
    if _custom_model is None:
        raise HTTPException(status_code=503, detail="Custom voice model is not loaded.")

    speaker = _resolve_requested_speaker(request.speaker)

    q: queue.Queue[object] = queue.Queue()
    done = object()
    text = request.text.strip()
    max_new_tokens = _max_new_tokens_for_text(text)
    chunk_size = _stream_chunk_size_for_text(text)

    def producer():
        try:
            with _lock:
                for chunk, _sr, _timing in _custom_model.generate_custom_voice_streaming(
                    text=text,
                    speaker=speaker,
                    language=request.language or DEFAULT_LANGUAGE,
                    instruct=_build_custom_voice_instruction(request),
                    chunk_size=chunk_size,
                    max_new_tokens=max_new_tokens,
                    do_sample=False,
                    top_k=50,
                    top_p=1.0,
                    repetition_penalty=1.0,
                ):
                    q.put(_to_pcm16_bytes(chunk))
        except Exception as exc:
            q.put(exc)
        finally:
            q.put(done)

    threading.Thread(target=producer, daemon=True).start()
    loop = asyncio.get_event_loop()
    while True:
        item = await loop.run_in_executor(None, q.get)
        if item is done:
            break
        if isinstance(item, Exception):
            raise item
        yield item


async def _stream_voice_design(request: SpeakRequest) -> AsyncGenerator[bytes, None]:
    _ensure_voice_design_model()
    if _voice_design_model is None:
        raise HTTPException(status_code=503, detail="Voice design model is not loaded.")

    q: queue.Queue[object] = queue.Queue()
    done = object()
    text = request.text.strip()
    max_new_tokens = _max_new_tokens_for_text(text)
    chunk_size = _stream_chunk_size_for_text(text)

    def producer():
        try:
            with _lock:
                for chunk, _sr, _timing in _voice_design_model.generate_voice_design_streaming(
                    text=text,
                    instruct=_build_voice_design_instruction(request),
                    language=request.language or DEFAULT_LANGUAGE,
                    chunk_size=chunk_size,
                    max_new_tokens=max_new_tokens,
                    do_sample=False,
                    top_k=50,
                    top_p=1.0,
                    repetition_penalty=1.0,
                ):
                    q.put(_to_pcm16_bytes(chunk))
        except Exception as exc:
            q.put(exc)
        finally:
            q.put(done)

    threading.Thread(target=producer, daemon=True).start()
    loop = asyncio.get_event_loop()
    while True:
        item = await loop.run_in_executor(None, q.get)
        if item is done:
            break
        if isinstance(item, Exception):
            raise item
        yield item


async def _stream_voice_clone(request: SpeakRequest) -> AsyncGenerator[bytes, None]:
    _ensure_clone_model()
    if _clone_model is None:
        raise HTTPException(status_code=503, detail="Voice clone model is not loaded.")

    ref_text = (request.referenceText or "").strip()
    if not ref_text:
        raise HTTPException(status_code=422, detail="Reference transcript is required for cloned voices.")

    q: queue.Queue[object] = queue.Queue()
    done = object()
    text = request.text.strip()
    max_new_tokens = _max_new_tokens_for_text(text)
    chunk_size = _stream_chunk_size_for_text(text)
    temp_path = _write_reference_audio_to_tempfile(request)

    def producer():
        try:
            with _lock:
                for chunk, _sr, _timing in _clone_model.generate_voice_clone_streaming(
                    text=text,
                    language=request.language or DEFAULT_LANGUAGE,
                    ref_audio=temp_path,
                    ref_text=ref_text,
                    instruct=_build_custom_voice_instruction(request),
                    chunk_size=chunk_size,
                    max_new_tokens=max_new_tokens,
                    do_sample=False,
                    top_k=50,
                    top_p=1.0,
                    repetition_penalty=1.0,
                    xvec_only=False,
                ):
                    q.put(_to_pcm16_bytes(chunk))
        except Exception as exc:
            q.put(exc)
        finally:
            try:
                os.unlink(temp_path)
            except OSError:
                pass
            q.put(done)

    threading.Thread(target=producer, daemon=True).start()
    loop = asyncio.get_event_loop()
    while True:
        item = await loop.run_in_executor(None, q.get)
        if item is done:
            break
        if isinstance(item, Exception):
            raise item
        yield item


@app.on_event("startup")
async def startup_event() -> None:
    await asyncio.to_thread(_warm_models)


@app.get("/health")
async def health() -> dict:
    try:
        _ensure_custom_model()
        return {
            "status": "ok",
            "available": True,
            "speakers": _speakers,
            "defaultSpeaker": _resolve_default_speaker(),
            "defaultModelSize": "1.7B",
        }
    except Exception as error:
        logger.exception("Health check failed")
        return {
            "status": "error",
            "available": False,
            "error": str(error),
            "speakers": _speakers,
            "defaultSpeaker": DEFAULT_SPEAKER,
            "defaultModelSize": "1.7B",
        }


@app.get("/voices")
async def voices() -> dict:
    _ensure_custom_model()
    return {
        "available": True,
        "speakers": _speakers,
        "defaultSpeaker": _resolve_default_speaker(),
        "defaultModelSize": "1.7B",
    }


@app.post("/speak")
async def speak(request: SpeakRequest):
    try:
        wav_bytes, content_type = await asyncio.to_thread(_synthesize_sync, request)
    except HTTPException:
        raise
    except Exception as error:
        logger.exception("Speech generation failed")
        raise HTTPException(status_code=500, detail=str(error)) from error

    filename = f"quinn_{int(time.time() * 1000)}.wav"
    return Response(
        content=wav_bytes,
        media_type=content_type,
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


@app.post("/speak/stream")
async def speak_stream(request: SpeakRequest):
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=422, detail="Speech text is required.")

    try:
        generator = (
            _stream_voice_design(request)
            if request.engine == "voice_design"
            else _stream_voice_clone(request)
            if request.engine == "voice_clone"
            else _stream_custom_voice(request)
        )
    except HTTPException:
        raise
    except Exception as error:
        logger.exception("Speech stream initialization failed")
        raise HTTPException(status_code=500, detail=str(error)) from error

    return StreamingResponse(
        generator,
        media_type="application/octet-stream",
        headers={
            "X-Audio-Format": "pcm_s16le",
            "X-Audio-Sample-Rate": "24000",
            "X-Audio-Channels": "1",
            "Cache-Control": "no-store",
        },
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
