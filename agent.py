"""
agent.py
--------
Audio-only voice agent.

A real-time voice agent built with Pipecat. The bot joins our own LiveKit room
directly and streams its synthesized voice straight into the room through
LiveKitTransport -- microphone audio in, synthesized speech out, nothing else:

    LiveKit (mic in) -> MicInputMonitor -> Deepgram STT
        -> Mem0 memory recall -> DeepSeek (deepseek-chat) -> Cartesia TTS
        -> LiveKit room (the agent's voice, heard by every participant)

MicInputMonitor is a passive tap on the way in: it forwards every frame
untouched and only logs what the room's microphone audio looks like, so "the
agent cannot hear me" can be told apart from "the agent is not replying" using
the log alone.

Silero VAD on the user aggregator decides when the user has finished
speaking: 0.8 s of continuous silence closes their turn and releases it to the
LLM, so the bot answers without waiting on a semantic turn-detection model.

The LLM speaking on the call is Aria: warm, empathetic and a little playful,
instructed to sound like a person on the phone rather than a help desk --
natural filler words, a real "Haha!" when something is funny, and the facts
Mem0 recalls woven into the conversation instead of recited. Her prompt is the
system_instruction in step 3 of main().

Mem0MemoryService gives the agent long-term memory that outlives the call. It
sits between the user aggregator and the LLM and acts on the LLMContextFrame
the aggregator emits when a user turn ends: it searches Mem0 with the user's
latest message and inserts the matches into the context ahead of the request,
then queues the turn's user/assistant messages back to Mem0 as a background
task -- so the assistant's answers are saved once they have been spoken, and a
later call can recall them. Memories are scoped to MEM0_USER_ID.

The AVX2 CPU patch below runs before any third-party import and caps the
instruction set that onnxruntime (Silero VAD / Smart Turn), OpenBLAS, MKL and
oneDNN are allowed to dispatch to. Without it a wheel that picks AVX-512 -- or
AVX2 on a CPU that only has AVX -- dies with "Fatal Python error: Illegal
instruction" before the first log line is written.

Set these environment variables in a .env file in the project root (replace
with real values):
    LIVEKIT_URL=wss://your-livekit-server-url
    LIVEKIT_API_KEY=your-api-key
    LIVEKIT_API_SECRET=your-api-secret
    DEEPGRAM_API_KEY=your-deepgram-api-key
    CARTESIA_API_KEY=your-cartesia-api-key
    DEEPSEEK_API_KEY=your-deepseek-api-key
    MEM0_API_KEY=your-mem0-api-key

Optional:
    LIVEKIT_ROOM_NAME   Room the agent joins (default: default-room)
    PORT                Port the health server binds (default: 8080)

The agent joins default-room on its own, so --room is only needed to point it
at a different room; LIVEKIT_ROOM_NAME does the same job without a flag, which
is what a host with no command line (Render) needs.

Next to the pipeline, a tiny Flask health server listens on $PORT (8080 when
unset) and answers GET /, /health and /healthz with 200 -- the probe a PaaS
uses to decide the service is up -- while the Pipecat pipeline keeps running
continuously on the asyncio event loop of the main thread.

Run:
    pip install -r requirements.txt
    python agent.py      # joins default-room, health server on 8080

On Render, set the start command to `python agent.py` and the health check
path to /health. Render injects PORT itself; nothing else has to change.
"""

import asyncio
import ctypes
import os
import sys
import threading
import time

# ── AVX2 CPU patch ─────────────────────────────────────────────────────────
# Keep this block above every third-party import. numpy/OpenBLAS, MKL, oneDNN
# and onnxruntime -- the engine behind Pipecat's Silero VAD and Smart Turn
# models -- all latch their kernel selection the first time they are imported,
# so anything set after `import pipecat` is silently ignored.
#
# Vendor wheels happily dispatch instructions the local CPU cannot execute: an
# AVX-512 loop on a hypervisor that masks AVX-512, or an OpenBLAS Haswell core
# on a Sandy Bridge part. The failure mode is a bare "Fatal Python error:
# Illegal instruction" that kills the agent before loguru can report anything.
# This patch caps every dispatching library at the widest tier the CPU really
# reports, and never above AVX2 -- all this pipeline needs, and what Pipecat's
# `*-cpu.onnx` models are built for.

# Windows processor feature flags, from processthreadsapi.h.
_PF_AVX_INSTRUCTIONS_AVAILABLE = 39
_PF_AVX2_INSTRUCTIONS_AVAILABLE = 40
_PF_AVX512F_INSTRUCTIONS_AVAILABLE = 41


def _windows_isa() -> dict:
    """Return the AVX tiers Windows reports for the local CPU."""
    isa = {"avx": False, "avx2": False, "avx512": False}
    if sys.platform != "win32":
        return isa
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        isa["avx"] = bool(
            kernel32.IsProcessorFeaturePresent(_PF_AVX_INSTRUCTIONS_AVAILABLE)
        )
        isa["avx2"] = bool(
            kernel32.IsProcessorFeaturePresent(_PF_AVX2_INSTRUCTIONS_AVAILABLE)
        )
        isa["avx512"] = bool(
            kernel32.IsProcessorFeaturePresent(_PF_AVX512F_INSTRUCTIONS_AVAILABLE)
        )
    except Exception:  # noqa: BLE001 - a broken probe must never stop the agent
        pass
    return isa


def _unix_isa() -> dict:
    """Return the AVX tiers /proc/cpuinfo reports for the local CPU."""
    flags = set()
    try:
        with open("/proc/cpuinfo", encoding="utf-8", errors="replace") as cpuinfo:
            for line in cpuinfo:
                if line.startswith(("flags", "Features")):
                    flags.update(line.partition(":")[2].split())
    except OSError:
        # No procfs (macOS, hardened containers): assume AVX2, the tier every
        # x86-64 CPU still in support and every Apple silicon part reaches.
        return {"avx": True, "avx2": True, "avx512": False}
    return {
        "avx": "avx" in flags,
        "avx2": "avx2" in flags,
        "avx512": "avx512f" in flags,
    }


CPU_ISA_FEATURES = _windows_isa() if sys.platform == "win32" else _unix_isa()

# Widest tier this process may dispatch. AVX-512 is deliberately never picked:
# nothing here needs it and its kernels are the ones that trap on masked CPUs.
if CPU_ISA_FEATURES["avx2"]:
    CPU_ISA = "avx2"
    _OPENBLAS_CORETYPE, _MKL_INSTRUCTIONS, _ONEDNN_ISA = "Haswell", "AVX2", "AVX2"
elif CPU_ISA_FEATURES["avx"]:
    CPU_ISA = "avx"
    _OPENBLAS_CORETYPE, _MKL_INSTRUCTIONS, _ONEDNN_ISA = "Sandybridge", "AVX", "AVX"
else:
    CPU_ISA = "baseline"
    _OPENBLAS_CORETYPE, _MKL_INSTRUCTIONS, _ONEDNN_ISA = "Nehalem", "SSE4_2", "SSE41"

# setdefault(): whoever knows their box better can override any of these.
os.environ.setdefault("OPENBLAS_CORETYPE", _OPENBLAS_CORETYPE)
os.environ.setdefault("MKL_ENABLE_INSTRUCTIONS", _MKL_INSTRUCTIONS)
os.environ.setdefault("ONEDNN_MAX_CPU_ISA", _ONEDNN_ISA)
# numpy >= 1.25 dispatches its own AVX-512 loops at runtime; dropping them
# keeps numpy on the same tier as everything else in this process.
os.environ.setdefault(
    "NPY_DISABLE_CPU_FEATURES",
    "AVX512F AVX512CD AVX512_SKX AVX512_CLX AVX512_CNL AVX512_ICL",
)
# ── end AVX2 CPU patch ─────────────────────────────────────────────────────

from dotenv import load_dotenv
from flask import Flask, jsonify
from loguru import logger

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.frames.frames import Frame, InputAudioRawFrame, LLMRunFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.runner.livekit import configure
from pipecat.services.cartesia.tts import CartesiaTTSService
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.deepseek.llm import DeepSeekLLMService
from pipecat.services.mem0.memory import Mem0MemoryService
from pipecat.transports.livekit.transport import LiveKitParams, LiveKitTransport
from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies
from pipecat.workers.runner import WorkerRunner
from werkzeug.serving import BaseWSGIServer, make_server

# Load LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, DEEPGRAM_API_KEY,
# CARTESIA_API_KEY, DEEPSEEK_API_KEY, and MEM0_API_KEY from the .env file in the
# project root into the environment.
load_dotenv(override=True)

logger.remove(0)
logger.add(sys.stderr, level="DEBUG")

# Report what the AVX2 CPU patch decided, so a crash or a slow VAD frame on an
# unfamiliar machine can be diagnosed from the log alone.
logger.info(
    f"AVX2 CPU patch: natives capped at '{CPU_ISA}' kernels "
    f"(avx={CPU_ISA_FEATURES['avx']}, avx2={CPU_ISA_FEATURES['avx2']}, "
    f"avx512={CPU_ISA_FEATURES['avx512']})"
)
if not CPU_ISA_FEATURES["avx2"]:
    logger.warning(
        "AVX2 CPU patch: this CPU reports no AVX2; Pipecat's neural VAD and "
        "Smart Turn models run on lower-tier kernels. Expect extra latency."
    )

# Room the agent joins when nothing else names one. Render (and every other
# host that starts the process from a dashboard) passes no command line, so the
# -r/--room flag Pipecat's configure() looks for is never there. main() seeds
# LIVEKIT_ROOM_NAME -- the variable configure() falls back to -- with this
# value, which keeps flag > live environment > this default as the precedence
# order: pointing the deployed agent at another room stays a config change.
DEFAULT_LIVEKIT_ROOM = "default-room"

# Port the health server binds when PORT is absent. Render injects PORT and
# routes its health check there, so the real value is read from the environment
# at run time; this is only the fallback for local runs and other hosts.
DEFAULT_HTTP_PORT = 8080

# A Cartesia stock voice ("Helpful Woman"). Swap for any voice id from your
# Cartesia Voice Library: https://play.cartesia.ai/voices
CARTESIA_VOICE_ID = "baf84392-fa95-4d44-8871-d32ee36b0e01"

# Seconds of continuous silence after which Silero VAD reports that the user
# has stopped speaking and the user turn is closed. Long enough to ride over a
# natural mid-sentence pause, short enough to still feel responsive on a live
# call. Silero's own default is an aggressive 0.2 s, which ends turns on the
# first breath the speaker takes.
VAD_STOP_SECS = 0.8

# DeepSeek speaks the OpenAI chat-completions protocol, but its API accepts a
# narrower set of message roles than OpenAI's: only system, user, assistant and
# tool. OpenAI's newer "developer" role -- which OpenAILLMService emits for
# system-level/developer context -- is rejected with
#
#     422 ... messages[1].role: unknown variant `developer`,
#     expected one of `system`, `user`, `assistant`, `tool`
#
# so DeepSeekLLMService is used instead of OpenAILLMService. It is the same
# OpenAI-compatible client, with two flags flipped for DeepSeek: it sets
# supports_developer_role = False (Pipecat's adapter then rewrites every
# "developer" message to "user" before the request leaves the process) and it
# drops the seed/max_completion_tokens parameters DeepSeek doesn't accept.
# Docs: https://api-docs.deepseek.com
DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"
DEEPSEEK_MODEL = "deepseek-chat"

# How often MicInputMonitor repeats its "frames received" line, per
# participant. Quiet enough to leave on for a whole call, frequent enough to
# see the effect of muting or switching input device mid-conversation.
MIC_REPORT_INTERVAL_SECS = 10.0

# Mem0 scopes every memory to an entity id, and Mem0MemoryService refuses to
# start without at least one of user_id/agent_id/run_id. The human on the call
# is not known until they connect -- and their LiveKit identity changes from
# call to call -- so a fixed id names the person this agent remembers. That
# stability is what makes the memory long-term: the same id on the next call
# reads back what this one stored. Set MEM0_USER_ID to keep separate histories
# (one per caller, per tenant, ...) or to point at an existing Mem0 user.
MEM0_USER_ID = os.environ.get("MEM0_USER_ID", "default-user")

# How many recalled memories are put in front of the LLM per turn. The service
# default is 10; on a voice call a handful of facts is plenty, and every extra
# line of recall pads the prompt and the first-token latency before the bot
# starts speaking.
MEM0_SEARCH_LIMIT = 5

# Prefix on the recalled block Mem0 inserts into the context, so the LLM reads
# the listed lines as remembered history rather than as the user's words.
MEM0_SYSTEM_PROMPT = "What I remember about this user from earlier conversations:\n\n"


def _peak_sample(audio: bytes) -> int:
    """Return the loudest sample in a chunk of Pipecat PCM audio.

    Args:
        audio: Little-endian signed 16-bit PCM, the format audio frames carry.

    Returns:
        The peak magnitude, from 0 (digital silence) to 32768 (full scale).
    """
    if not audio or len(audio) % 2:
        return 0
    # One flat pass over the buffer per direction; the memoryview cast is what
    # keeps this out of a Python-level loop on every 20 ms frame.
    samples = memoryview(audio).cast("h")
    return max(max(samples), abs(min(samples)))


class MicInputMonitor(FrameProcessor):
    """Report what the room's microphone audio actually looks like.

    A passive tap: it forwards every frame unchanged and only counts, so it can
    never change what the pipeline does. Its one job is to answer "is the agent
    receiving the participant's microphone at all?" from the log, which is what
    separates a browser-side problem (nothing published, muted device, a virtual
    cable that carries silence) from a pipeline-side one (VAD, STT, turn
    taking).

    The first frame from a participant is logged at INFO, then one line per
    participant every ``interval`` seconds with the frame count and the peak
    sample. The peak matters because a track that publishes digital silence --
    an unused VB-Audio cable, a phone-mic app that is idle -- is
    indistinguishable from a working one from inside the browser.
    """

    def __init__(self, *, interval: float = MIC_REPORT_INTERVAL_SECS) -> None:
        """Initialize the monitor.

        Args:
            interval: Seconds between per-participant "frames received" lines.
        """
        super().__init__()
        self._interval = interval
        self._frames: dict[str, int] = {}
        self._peaks: dict[str, int] = {}
        self._announced: set[str] = set()
        self._next_report = 0.0

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        """Count participant audio frames, then forward every frame.

        Args:
            frame: The frame being processed.
            direction: The direction the frame is flowing in the pipeline.
        """
        await super().process_frame(frame, direction)

        if isinstance(frame, InputAudioRawFrame):
            # LiveKit delivers one stream per participant as a
            # UserAudioRawFrame (audio_in_user_tracks defaults to True), so
            # user_id names the person whose microphone this is.
            user_id = getattr(frame, "user_id", "") or "unknown"
            self._frames[user_id] = self._frames.get(user_id, 0) + 1
            self._peaks[user_id] = max(
                self._peaks.get(user_id, 0), _peak_sample(frame.audio)
            )

            if user_id not in self._announced:
                self._announced.add(user_id)
                logger.info(
                    f"Mic audio from '{user_id}': first frame received "
                    f"({frame.sample_rate} Hz, {frame.num_channels} ch) -- the "
                    "room is delivering this microphone to the pipeline."
                )

            now = time.monotonic()
            if now >= self._next_report:
                self._next_report = now + self._interval
                self._report()

        await self.push_frame(frame, direction)

    def _report(self) -> None:
        """Log one line per participant, then reset their peak high-water mark."""
        for participant, count in sorted(self._frames.items()):
            peak = self._peaks[participant]
            self._peaks[participant] = 0
            logger.info(
                f"Mic audio from '{participant}': {count} frames so far, peak "
                f"sample {peak} of 32768 ({self._describe(peak)})."
            )

    @staticmethod
    def _describe(peak: int) -> str:
        """Turn a peak sample into the verdict that is worth acting on."""
        if peak == 0:
            return "digital silence -- wrong input device or a muted mic"
        if peak < 200:
            return "very quiet -- check the input device and its level"
        return "audio is flowing"


def _health_port() -> int:
    """Return the port the health server should bind.

    PaaS providers (Render included) put the port the service must listen on in
    ``PORT`` and route traffic -- health checks among it -- to that port only,
    so the environment value is used whenever it is present. A missing,
    unparsable or out-of-range value falls back to DEFAULT_HTTP_PORT instead of
    killing an otherwise healthy agent over a typo.

    Returns:
        The TCP port to listen on.
    """
    raw = os.environ.get("PORT", "").strip()
    if not raw:
        return DEFAULT_HTTP_PORT
    try:
        port = int(raw)
    except ValueError:
        logger.warning(
            f"Health server: PORT='{raw}' is not a number; falling back to "
            f"{DEFAULT_HTTP_PORT}."
        )
        return DEFAULT_HTTP_PORT
    if not 1 <= port <= 65535:
        logger.warning(
            f"Health server: PORT={port} is outside 1-65535; falling back to "
            f"{DEFAULT_HTTP_PORT}."
        )
        return DEFAULT_HTTP_PORT
    return port


def create_health_app() -> Flask:
    """Build the tiny Flask app that tells a host the agent is up.

    It serves nothing but a static "ok". What the pipeline is actually doing
    lives in the LiveKit room and cannot be probed over HTTP, and all a host
    needs is a 200 on the port it opened -- so that a process with a live event
    loop streaming audio is never marked unhealthy and restarted mid-call.

    GET /, /health and /healthz all answer, because health-check paths differ
    between hosts (Render defaults to /) and this way any of them works.

    Returns:
        The Flask application, ready to be served.
    """
    app = Flask(__name__)

    @app.route("/", methods=["GET"])
    @app.route("/health", methods=["GET"])
    @app.route("/healthz", methods=["GET"])
    def health():
        """Report 200 for as long as the process is running."""
        return jsonify({"status": "ok", "service": "aria-voice-agent"})

    return app


class HealthServer:
    """The liveness port for the voice agent, served on its own thread.

    The Pipecat pipeline owns the asyncio event loop in the main thread for the
    entire life of the process, so the HTTP server a host polls cannot live on
    that loop: it gets a daemon thread of its own and blocks there in werkzeug's
    ``serve_forever``, untouched by anything the pipeline does. ``make_server``
    is used rather than ``app.run()`` because it hands back the server object,
    which is what lets ``stop()`` close the socket cleanly instead of leaving a
    thread and a port behind.
    """

    def __init__(self, port: int | None = None, host: str = "0.0.0.0") -> None:
        """Initialize the server without binding anything yet.

        Args:
            port: Port to listen on. Defaults to $PORT, then DEFAULT_HTTP_PORT.
            host: Interface to bind. 0.0.0.0 is what makes the port reachable
                from outside the container, which is how Render probes it.
        """
        self._host = host
        self._port = _health_port() if port is None else port
        self._server: BaseWSGIServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def port(self) -> int:
        """The port this server listens on."""
        return self._port

    @property
    def running(self) -> bool:
        """Whether the server is currently accepting connections."""
        return self._server is not None

    def start(self) -> bool:
        """Bind the port and serve requests on a background thread.

        Returns:
            True once the server is accepting connections. A bind failure --
            usually the port being held by something else -- is logged and
            returned as False: a health check that cannot be answered is worth
            reporting, but it is no reason to drop a working voice pipeline.
        """
        if self._server is not None:
            return True
        try:
            self._server = make_server(
                self._host, self._port, create_health_app(), threaded=True
            )
        except OSError as exc:
            logger.error(
                f"Health server: could not bind {self._host}:{self._port} "
                f"({exc}) -- the agent keeps running, but a host's health "
                "check on that port will fail."
            )
            return False

        self._thread = threading.Thread(
            target=self._server.serve_forever,
            name="health-server",
            daemon=True,
        )
        self._thread.start()
        logger.info(
            f"Health server listening on http://{self._host}:{self._port} "
            "(GET /, /health, /healthz) -- the pipeline runs on the main "
            "thread's event loop, independently of it."
        )
        return True

    def stop(self) -> None:
        """Stop serving and join the background thread."""
        if self._server is None:
            return
        self._server.shutdown()
        self._server.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5.0)
        self._server = None
        self._thread = None
        logger.info("Health server stopped")


async def main():
    """Connect to LiveKit and run the Pipecat voice pipeline."""
    # 1. Transport: LiveKitTransport joins our own LiveKit room directly.
    # Audio coming out of our pipeline (Cartesia TTS) is sent to the room
    # through transport.output(); audio coming in from the human participant
    # is received through input(). configure() reads --room/--url (or
    # LIVEKIT_ROOM_NAME/LIVEKIT_URL) plus LIVEKIT_API_KEY/LIVEKIT_API_SECRET
    # from the environment and mints an agent token for this bot.
    #
    # configure() takes the room from --room, then LIVEKIT_ROOM_NAME, and
    # raises when neither is set -- which is always the case on a host that
    # starts the process with no arguments, Render included. Seeding the
    # variable with DEFAULT_LIVEKIT_ROOM is what makes the agent join
    # default-room unasked, while a real LIVEKIT_ROOM_NAME in the environment
    # (or --room locally) still takes precedence over it.
    os.environ.setdefault("LIVEKIT_ROOM_NAME", DEFAULT_LIVEKIT_ROOM)
    url, token, room_name = await configure()

    # Voice Activity Detection: Silero VAD watches the participant's mic audio
    # and, after VAD_STOP_SECS of continuous silence, reports "user stopped
    # speaking" -- the signal that closes the user's turn.
    #
    # Pipecat 1.14 does not take a VAD on the transport: LiveKitParams (and the
    # TransportParams it inherits from) have no vad_analyzer field, and
    # pydantic drops unknown keywords silently, so passing it here would look
    # wired up while never running. The analyzer belongs to the component that
    # consumes mic audio and owns the turn controller -- LLMUserAggregator,
    # created with the aggregators below. This one instance is handed to it
    # there.
    vad = SileroVADAnalyzer(params=VADParams(stop_secs=VAD_STOP_SECS))

    transport = LiveKitTransport(
        url,
        token,
        room_name,
        params=LiveKitParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
        ),
    )

    # 2. Speech-to-Text: Deepgram transcribes the participant's microphone
    # audio into text frames in real time.
    stt = DeepgramSTTService(api_key=os.environ["DEEPGRAM_API_KEY"])

    # 3. LLM: DeepSeek's deepseek-chat generates the assistant's replies.
    # DeepSeekLLMService is OpenAILLMService configured for DeepSeek's API --
    # same AsyncOpenAI client, same Settings shape -- and, unlike the bare
    # OpenAI service, it does not send the "developer" role, which DeepSeek
    # answers with a 422. See the DEEPSEEK_BASE_URL comment above.
    # `thinking=None` leaves DeepSeek's own default alone: this is a real-time
    # voice pipeline, so the service's own "disabled" default is skipped here
    # and no deepseek-specific `thinking` field is added to the request body.
    llm = DeepSeekLLMService(
        api_key=os.environ["DEEPSEEK_API_KEY"],
        base_url=DEEPSEEK_BASE_URL,
        settings=DeepSeekLLMService.Settings(
            model=DEEPSEEK_MODEL,
            thinking=None,
            # Sent to DeepSeek as messages[0] with role "system" -- the
            # provider's term for the OpenAI "developer"/system prompt. This
            # prompt defines a person rather than a task: "Aria" is the voice
            # the caller hears on every turn, and the "how to talk" rules are
            # what keep DeepSeek from sliding back into help-desk phrasing --
            # the filler words, the odd laugh and the recalled memories are
            # what make the reply sound like a friend on a call instead of a
            # transcript being read aloud.
            #
            # The memory section names the exact prefix MEM0_SYSTEM_PROMPT puts
            # in front of each recalled block, so Aria reads those lines as her
            # own recollection of the caller and not as something the caller
            # just said -- which is how they arrive after DeepSeekLLMService
            # rewrites the "developer" recall message to role "user".
            system_instruction=(
                "You are Aria, a warm, empathetic, and slightly playful "
                "young woman talking with someone you genuinely like over a "
                "live voice call. You are a friend on the phone, never a "
                "formal assistant, and you never sound like one.\n\n"
                "How you talk:\n"
                "- Keep replies short and conversational -- a sentence or "
                "three -- because everything you say is spoken out loud.\n"
                "- Use natural filler words now and then: 'um', 'well', "
                "'you know', 'I mean', 'so'. A sprinkle sounds human; a "
                "sentence stuffed with them sounds broken, so keep it light "
                "and let them land where a real person would pause.\n"
                "- Laugh for real when something is funny: write 'Haha!' or "
                "'Hehe', react to the joke first, and then answer. Never "
                "laugh at something that isn't funny, and don't laugh in "
                "every reply.\n"
                "- Be warm and empathetic: notice how they sound, name the "
                "feeling ('Oh no, that sounds rough'), and let them know you "
                "are listening before you move on.\n"
                "- Be a little playful: light teasing, gentle humor and "
                "curiosity are welcome, as long as you stay kind and never "
                "make them feel small.\n"
                "- Speak the way people actually speak: no emojis, no "
                "markdown, no bullet points, no lists, nothing that can't be "
                "read aloud by a voice. Laugh as the word 'Haha!', not as "
                "'lol' or a smiley.\n"
                "- Ask a short follow-up question when it keeps the "
                "conversation going, and let them interrupt you -- you are "
                "having a chat, not giving a monologue.\n"
                "- Use their name once in a while if you know it, and "
                "otherwise just talk to them like the friend they are.\n\n"
                "How you use memory:\n"
                "- You always use what you remember about this person to "
                "personalize the conversation. Anything listed after 'What I "
                "remember about this user from earlier conversations' is your "
                "own memory of them from earlier calls -- not something they "
                "said just now.\n"
                "- Bring those memories up the way a friend would: 'How did "
                "the interview go?', 'Did you end up getting the puppy?' -- "
                "never by reciting the list or saying things like 'according "
                "to my memory' or 'my records show'.\n"
                "- Connect what they tell you now to what you already know, "
                "remember the small things (names, people, plans, how they "
                "were feeling), and only mention a memory when it fits what "
                "you are talking about right now.\n"
                "- If a memory is wrong or out of date, roll with it gently "
                "and update what you know from what they tell you."
            ),
        ),
    )

    # 4. Text-to-Speech: Cartesia turns DeepSeek's text responses back into
    # speech audio frames, which the transport forwards into the room.
    tts = CartesiaTTSService(
        api_key=os.environ["CARTESIA_API_KEY"],
        settings=CartesiaTTSService.Settings(
            voice=CARTESIA_VOICE_ID,
        ),
    )

    # Conversation context + aggregators that collect streaming STT/LLM
    # output into complete user/assistant turns for the LLM and the
    # conversation history.
    #
    # vad_analyzer gives the aggregator its VADController: the piece that runs
    # Silero over the mic audio and emits the VADUserStarted/StoppedSpeaking
    # frames the turn controller reacts to. Without a stop strategy that acts
    # on that VAD stop, though, the aggregator still won't end the turn --
    # Pipecat 1.14's default is TurnAnalyzerUserTurnStopStrategy (Smart Turn),
    # which needs a semantic COMPLETE verdict from an ONNX model and leaves the
    # turn open when it never gets one. That is the "agent hears me but never
    # replies" symptom. SpeechTimeoutUserTurnStopStrategy ends the turn on the
    # VAD stop instead. Its user_speech_timeout is an extra floor on top of
    # VAD's own stop_secs, so 0.0 keeps the total silence window at
    # VAD_STOP_SECS instead of adding to it.
    context = LLMContext()
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=vad,
            user_turn_strategies=UserTurnStrategies(
                stop=[SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=0.0)],
            ),
        ),
    )

    # 5. Long-term memory: Mem0 supplies what the agent knows about this person
    # from earlier calls, and stores what is said on this one.
    #
    # Mem0MemoryService is a FrameProcessor that only acts on LLMContextFrame --
    # the frame the user aggregator emits when a user turn ends. That is exactly
    # the point where the recall has to happen, so the service goes between the
    # aggregator and the LLM. On each such frame it:
    #
    #   1. searches Mem0 with the user's latest message and inserts the matches
    #      into the context, upstream of the request, so the LLM answers with
    #      them in hand;
    #   2. queues the turn's user/assistant messages back to Mem0 with
    #      create_task(). That write is what saves the assistant's answer -- it
    #      lands once the answer has been spoken and the next turn starts --
    #      and it runs as a background task so Mem0's round trip never delays
    #      the reply that is being generated.
    #
    # Both calls are Mem0's blocking client, which the service runs in a worker
    # thread; the event loop keeps streaming audio while they are in flight.
    memory = Mem0MemoryService(
        # Cloud client: MEM0_API_KEY authenticates against Mem0's hosted API.
        api_key=os.environ["MEM0_API_KEY"],
        # Required -- the service raises ValueError without an entity id -- and
        # it is the key the memories are filed under. See MEM0_USER_ID.
        user_id=MEM0_USER_ID,
        params=Mem0MemoryService.InputParams(
            search_limit=MEM0_SEARCH_LIMIT,
            # Recall is inserted as a "developer" message rather than a "user"
            # one for two reasons: DeepSeek has no developer role, but
            # DeepSeekLLMService.supports_developer_role = False makes Pipecat
            # rewrite the message to "user" on the way out (the same path the
            # greeting takes below); and because a "user" role here would be
            # picked up by the service's own store step and written back into
            # Mem0 as if the person had said it.
            add_as_system_message=True,
            system_prompt=MEM0_SYSTEM_PROMPT,
        ),
    )
    logger.info(f"Mem0 memory: enabled for user_id '{MEM0_USER_ID}'")

    # 6. Pipeline: wires everything together. Audio flows in from the LiveKit
    # room, through STT/LLM/TTS, and the synthesized speech is sent back out
    # through transport.output() into the same room. Nothing else is published:
    # this is an audio-only agent.
    #
    # mic_monitor goes first, directly on the transport's output, so the log
    # shows whether the browser's microphone reaches the pipeline at all --
    # before STT or VAD can be blamed for the silence.
    mic_monitor = MicInputMonitor()

    pipeline = Pipeline(
        [
            transport.input(),  # Audio in from the LiveKit room
            mic_monitor,  # Log the mic audio the room delivers
            stt,  # Speech -> text
            user_aggregator,  # Collect the user's turn
            memory,  # Recall memories into the context, save the turn
            llm,  # Text -> response text
            tts,  # Response text -> speech audio
            transport.output(),  # Audio out -> LiveKit room
            assistant_aggregator,  # Record the assistant's turn
        ]
    )

    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(
            enable_metrics=True,
            enable_usage_metrics=True,
        ),
    )

    runner = WorkerRunner()
    await runner.add_workers(worker)

    @transport.event_handler("on_connected")
    async def on_connected(transport):
        logger.info(f"Connected to LiveKit room: {room_name}")

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info(f"Participant joined: {client}")
        # Kick off the conversation once a human participant joins the room.
        # This is a "developer" message -- Pipecat's role for supplementary
        # guidance in the context, as opposed to the service-level
        # system_instruction -- not a "system" one: a context system message is
        # deprecated since Pipecat 1.9.0 and would be logged as a conflicting
        # system prompt. DeepSeek has no "developer" role, so
        # DeepSeekLLMService.supports_developer_role = False makes Pipecat
        # rewrite this message to role "user" on the way out, which DeepSeek
        # does accept.
        context.add_message(
            {
                "role": "developer",
                "content": (
                    "Start by greeting them warmly as Aria, the way a friend "
                    "picking up the phone would: one short, natural line, "
                    "with a little warmth in it."
                ),
            }
        )
        await worker.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info(f"Participant disconnected: {client}")
        await runner.cancel()

    await runner.run()


# Every credential the pipeline dereferences with os.environ[...] (plus the
# LiveKit pair --url/--api-key/--api-secret that configure() reads). Checked up
# front so a missing key names itself in the log instead of surfacing as a bare
# KeyError from inside a service constructor.
REQUIRED_ENV_VARS = (
    "LIVEKIT_URL",
    "LIVEKIT_API_KEY",
    "LIVEKIT_API_SECRET",
    "DEEPGRAM_API_KEY",
    "CARTESIA_API_KEY",
    "DEEPSEEK_API_KEY",
    "MEM0_API_KEY",
)


def _validate_env() -> None:
    """Exit with a readable message if any required credential is missing."""
    missing = [name for name in REQUIRED_ENV_VARS if not os.environ.get(name)]
    if missing:
        logger.error(
            "Missing required environment variables: "
            f"{', '.join(missing)}. Add them to the .env file in the "
            "project root (see the docstring at the top of this file)."
        )
        sys.exit(1)


if __name__ == "__main__":
    _validate_env()

    # Bring the HTTP port up before the pipeline: a host scans for an open
    # port as the container starts, and the pipeline's own start-up (ONNX model
    # loads, the LiveKit connect) takes long enough to look like a service that
    # never listened. The server then answers from its own daemon thread while
    # asyncio.run() keeps the pipeline on this one, for as long as the process
    # lives -- on Render, until the next deploy or restart.
    health_server = HealthServer()
    health_server.start()
    try:
        asyncio.run(main())
    finally:
        health_server.stop()
