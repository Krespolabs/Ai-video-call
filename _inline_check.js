
    // Token server endpoint (from token_server.py)
    const TOKEN_SERVER_URL = "http://localhost:5000/getToken";

    // How long a caption stays on screen after its turn ends.
    const CAPTION_MS = 6000;

    const joinBtn = document.getElementById("joinBtn");
    const statusEl = document.getElementById("status");
    const videoGrid = document.getElementById("video-grid");

    // ── three.ws avatar ────────────────────────────────────────────────────
    const avatarEl = document.getElementById("avatar");
    const badgeEl = document.getElementById("avatar-badge");
    const captionAssistant = document.getElementById("caption-assistant");
    const captionUser = document.getElementById("caption-user");

    // Avatar actions can arrive on the data channel before the GLB has
    // finished loading, so anything that lands early is queued until the
    // element fires `agent:ready`.
    let avatarReady = false;
    // Set when the element fires `agent:error`: the avatar is not coming, so
    // queued actions are dropped instead of piling up behind a dead element.
    let avatarFailed = false;
    const queuedAvatarActions = [];

    // The remote audio track carrying the agent's TTS voice. It is tapped
    // (never re-routed) to feed the avatar's lipsync analyser.
    let agentAudioTrack = null;
    let lipsyncSource = null;
    let lipsyncContext = null;
    let captionTimer = null;

    function setBadge(text) {
      badgeEl.textContent = text;
    }

    // The element comes from a CDN: if that script never loads, the tag stays
    // an inert unknown element, so every avatar call has to be a no-op
    // instead of breaking the call.
    function safeAvatar(method, ...args) {
      try {
        if (typeof avatarEl[method] !== "function") return undefined;
        const result = avatarEl[method](...args);
        // lookAt()/wave() hand back promises that reject once the runtime is
        // gone; swallow that instead of tripping `unhandledrejection`.
        if (result && typeof result.catch === "function") result.catch(() => {});
        return result;
      } catch (err) {
        console.warn(`three.ws avatar.${method}() failed`, err);
      }
      return undefined;
    }

    function showCaption(el, text) {
      el.querySelector(".text").textContent = text || "";
      el.classList.add("show");
    }

    avatarEl.addEventListener("agent:ready", () => {
      avatarReady = true;
      setBadge("Avatar ready");
      while (queuedAvatarActions.length) driveAvatar(queuedAvatarActions.shift());
      attachLipsync();
    });

    avatarEl.addEventListener("agent:load-progress", (event) => {
      const pct = Math.round((event.detail?.pct ?? 0) * 100);
      setBadge(`Loading avatar… ${pct}%`);
    });

    avatarEl.addEventListener("agent:error", (event) => {
      console.error("three.ws avatar failed to load", event.detail?.error);
      avatarFailed = true;
      queuedAvatarActions.length = 0;
      setBadge("Avatar unavailable — voice + captions only");
    });

    /**
     * Map one Pipecat avatar message onto the <agent-3d> public API.
     *
     * The shape is fixed by pipecat_threews.ThreeWsAvatarProcessor:
     *   {"type": "transcript", "text": "..."}
     *   {"type": "gesture", "name": "wave" | "nod" | "shrug"}
     *   {"type": "speech_started"}
     *   {"type": "speech_ended", "transcript": "..."}
     */
    function driveAvatar(message) {
      if (!message || typeof message.type !== "string") return;
      // Captions are plain DOM, so they are updated before the avatar
      // readiness check below: a CDN that never loads must not cost the user
      // the transcript of what the agent just said.
      if (message.type === "transcript") {
        showCaption(captionAssistant, message.text);
        clearTimeout(captionTimer);
        captionTimer = setTimeout(
          () => captionAssistant.classList.remove("show"),
          CAPTION_MS
        );
      } else if (message.type === "speech_started") {
        captionUser.classList.remove("show");
      } else if (message.type === "speech_ended" && message.transcript) {
        showCaption(captionUser, message.transcript);
        clearTimeout(captionTimer);
        captionTimer = setTimeout(
          () => captionUser.classList.remove("show"),
          CAPTION_MS
        );
      }

      // Avatar actions wait for `agent:ready` and are replayed then; if the
      // element failed outright they are dropped instead of queueing forever.
      if (!avatarReady) {
        if (!avatarFailed) queuedAvatarActions.push(message);
        return;
      }

      switch (message.type) {
        case "transcript": {
          // A finished assistant turn. The mouth is driven by the TTS
          // waveform (see attachLipsync below); this adds the talk gesture.
          safeAvatar("speak", message.text);
          safeAvatar("setMood", 0.4, 0.6); // engaged, animated
          break;
        }

        case "gesture": {
          // wave | nod | shrug are all real slots in the three.ws clip library.
          if (message.name) safeAvatar("playClip", message.name);
          break;
        }

        case "speech_started": {
          // The human started talking: listening pose, attentive mood.
          setBadge("Listening…");
          safeAvatar("lookAt", "user");
          safeAvatar("setMood", 0.1, 0.6);
          break;
        }

        case "speech_ended": {
          setBadge("Avatar ready");
          safeAvatar("setMood", 0.1, 0.3); // back to a resting face
          break;
        }

        default:
          break;
      }
    }

    /**
     * Feed the agent's TTS audio into the avatar's viseme analyser.
     *
     * LiveKit's own <audio> element is deliberately left alone: pushing a
     * MediaStream-backed element through a MediaElementAudioSourceNode plays
     * silence on several browsers. Tapping the raw track with a
     * MediaStreamAudioSourceNode analyses the very same audio without
     * touching playback.
     *
     * `connectLipSync()` on the runtime is the hook the element's own
     * `speakAudio()` uses. It is private, hence the optional chaining, and the
     * element build is pinned by SRI above so it cannot drift underneath us.
     */
    function attachLipsync() {
      if (!agentAudioTrack || lipsyncSource || !avatarReady) return;
      try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        const ctx = new AudioCtx();
        const source = ctx.createMediaStreamSource(
          new MediaStream([agentAudioTrack.mediaStreamTrack])
        );
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        ctx.resume().catch(() => {});

        lipsyncContext = ctx;
        lipsyncSource = source;
        avatarEl._avatar?.connectLipSync?.(analyser);
      } catch (err) {
        console.warn("Avatar lipsync tap unavailable — using talk animation", err);
        detachLipsync();
      }
    }

    function detachLipsync() {
      try {
        avatarEl._avatar?.disconnectLipSync?.();
      } catch (err) {
        /* runtime already gone */
      }
      try {
        lipsyncSource?.disconnect();
      } catch (err) {
        /* already disconnected */
      }
      lipsyncContext?.close?.().catch(() => {});
      lipsyncSource = null;
      lipsyncContext = null;
    }

    // Keep the avatar paused while the tab is hidden (WebGL context + CPU).
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) safeAvatar("pause");
      else safeAvatar("resume");
    });

    window.addEventListener("pagehide", () => {
      detachLipsync();
      safeAvatar("destroy");
    });
    // ── LiveKit room ───────────────────────────────────────────────────────
    let room;

    /**
     * Publish the local microphone, on its own.
     *
     * This is deliberately *not* `localParticipant.enableCameraAndMicrophone()`.
     * That helper builds both tracks in a single
     * `createTracks({audio: true, video: true})` call and rejects as a unit, so
     * a camera that is missing, already in use (Zoom, Teams, DroidCam) or
     * denied by the browser costs us the microphone too: no track is published
     * at all. The agent then greets you and hears nothing, and Deepgram logs no
     * transcript, because there is no audio in the room to transcribe. The
     * microphone is the only track this agent listens to, so it gets its own
     * call, placed before anything else.
     *
     * @returns {Promise<string>} A short device description for the status line.
     * @throws {Error} If the browser refuses the mic or publishes it muted.
     */
    async function publishMicrophone() {
      await room.localParticipant.setMicrophoneEnabled(true);

      // setMicrophoneEnabled() resolves once the track is published, but a
      // muted publication (device held by another app, OS privacy switch)
      // leaves the agent with pure silence, so the publication itself is
      // checked rather than trusted.
      const publication = room.localParticipant.getTrackPublication(
        LivekitClient.Track.Source.Microphone
      );
      const mediaTrack = publication?.track?.mediaStreamTrack;

      if (!publication?.track || publication.isMuted || mediaTrack?.readyState !== "live") {
        throw new Error(
          "the microphone track is not live (browser mic permission or default input device)"
        );
      }

      // Which device the browser actually picked: when the agent hears silence
      // this line is what points at a virtual cable or an idle phone mic.
      console.info("Microphone published", {
        sid: publication.trackSid,
        device: mediaTrack.label,
        deviceId: mediaTrack.getSettings?.().deviceId,
      });

      return mediaTrack.label || "live";
    }

    /**
     * Publish the local camera as a best-effort extra.
     *
     * The avatar is the face of this call, so a webcam that is missing or busy
     * must not fail the join: it degrades to audio + avatar instead.
     *
     * @returns {Promise<string>} "on" or "off (<reason>)" for the status line.
     */
    async function publishCamera() {
      try {
        await room.localParticipant.setCameraEnabled(true);

        const publication = room.localParticipant.getTrackPublication(
          LivekitClient.Track.Source.Camera
        );
        if (!publication?.track) return "off";

        const element = publication.track.attach();
        element.classList.add("participant-video");
        videoGrid.appendChild(element);
        return "on";
      } catch (err) {
        console.warn("Camera unavailable — continuing with audio only", err);
        return `off (${err.message})`;
      }
    }

    joinBtn.addEventListener("click", async () => {
      const identity = document.getElementById("identity").value || "guest";
      const roomName = document.getElementById("room").value || "default-room";

      statusEl.innerText = "Fetching token...";

      try {
        // 1. Get a token (and server URL) from our local token_server.py
        const res = await fetch(
          `${TOKEN_SERVER_URL}?identity=${encodeURIComponent(identity)}&room=${encodeURIComponent(roomName)}`
        );
        const data = await res.json();
        const { token, url } = data;

        // 2. Create and connect to the LiveKit room
        room = new LivekitClient.Room();

        room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
          if (track.kind === "video") {
            const element = track.attach();
            element.classList.add("participant-video");
            element.id = `track-${participant.identity}-${track.sid}`;
            videoGrid.appendChild(element);
          } else if (track.kind === "audio") {
            // Attach the audio element so the agent's voice actually plays.
            // The same track is then tapped for the avatar's lipsync.
            track.attach();
            agentAudioTrack = track;
            attachLipsync();
          }
        });

        room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track) => {
          track.detach().forEach((el) => el.remove());
          if (track === agentAudioTrack) {
            agentAudioTrack = null;
            detachLipsync();
          }
        });

        // 3. Avatar messages published by ThreeWsAvatarProcessor
        //    (pipecat_threews -> OutputTransportMessageUrgentFrame -> LiveKit
        //    data channel, UTF-8 JSON).
        room.on(LivekitClient.RoomEvent.DataReceived, (payload) => {
          let message;
          try {
            message = JSON.parse(new TextDecoder().decode(payload));
          } catch (err) {
            return; // not a JSON avatar message
          }
          driveAvatar(message);
        });

        room.on(LivekitClient.RoomEvent.Disconnected, () => {
          detachLipsync();
          agentAudioTrack = null;
          statusEl.innerText = "Disconnected";
        });

        statusEl.innerText = "Connecting to room...";
        await room.connect(url, token);
        statusEl.innerText = `Connected to room: ${roomName} as ${identity}`;

        // Browsers only allow audible playback after a real user gesture.
        // This still runs inside the click handler, so the agent's voice can
        // start the moment its first audio track arrives.
        try {
          await room.startAudio();
        } catch (err) {
          console.warn("room.startAudio() failed — audio may need a click", err);
        }

        // 4. Publish the microphone. This is the track the agent listens to,
        //    so it is published first and on its own (see publishMicrophone).
        let mic = null;
        try {
          mic = await publishMicrophone();
        } catch (err) {
          console.error("Microphone could not be published", err);
        }

        // 5. Publish the camera as a best-effort extra. A busy or missing
        //    webcam only costs video; it can no longer cost the microphone.
        const camera = await publishCamera();

        statusEl.innerText = mic
          ? `Connected to room: ${roomName} as ${identity} — mic: ${mic}, camera: ${camera}`
          : `Connected to ${roomName}, but NO microphone is published — the agent cannot hear you. ` +
            `Allow the microphone for this page and check the system's default input device.`;
      } catch (err) {
        console.error(err);
        statusEl.innerText = "Error: " + err.message;
      }
    });
  