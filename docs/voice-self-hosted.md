# Self-hosted voice and fleet transport

Updated September 4, 2026. This supplements and supersedes the original single-provider decision in `voice-mode.md`.

## Supported paths

V Bot keeps language-model selection separate from speech. Existing native macOS and iOS calls, voice previews, and spoken replies use the hub TTS API. The hub supports ElevenLabs, built-in macOS voices when the hub itself runs on a Mac, and optional self-hosted Kokoro. Selecting Kokoro never silently falls back to a cloud provider. Browser microphone calling is not implemented by this change; a web speech preview is not proof of a microphone call.

Kokoro can be a direct operator-configured HTTP service:

```sh
OMB_KOKORO_BASE_URL=http://127.0.0.1:8880/v1
```

Or it can be an existing Docker container on an explicitly selected, shell-capable fleet bridge:

```sh
OMB_KOKORO_BRIDGE_ID=<exact existing bridge id>
OMB_KOKORO_CONTAINER=kokoro-tts
OMB_KOKORO_DOCKER_CLI=docker
```

Use `docker.exe` instead of `docker` only when a Windows bridge's Bash shell sees a separate WSL Docker engine and the existing speech container is in Docker Desktop. This is a speech-only operator selection. It does not alter the bridge's browser runtime, Docker contexts, shell grants, or other containers.

The bridge transport requires Python and the Kokoro HTTP service inside the existing container. It runs a fixed, bounded Docker/Python request through the authenticated job channel. It creates no tunnel, listener, published port, model download, or new capability grant. User text is encoded data, never shell or Python syntax. A missing/offline selected bridge cannot fall back to another machine. Explicit bridge configuration takes precedence over a direct URL.

Set these variables on the hub, restart its service, then use the exact paired-safe metadata route:

```http
PATCH /api/config/voice
Content-Type: application/json

{"provider":"kokoro","voice":"af_heart"}
```

The route accepts only `provider` and `voice`. It rejects credentials, URLs, arbitrary headers, models, methods, query strings, and non-JSON bodies. Existing host-side encrypted/native credential management remains separate. Per-bot voice ids are preserved across provider changes; an incompatible old voice prompts a new selection rather than being overwritten or silently changed.

## Bounds and failure behavior

Utterances are limited to 500 UTF-16 code units. Direct requests validate the operator URL, reject redirects, cap catalog/audio bodies, validate the voice catalog and audio MIME, and use deadlines covering headers plus the complete body. Provider error bodies and private endpoint details are not returned to clients. Empty or oversized audio fails explicitly.

Fleet speech uses a smaller 700 KB audio cap so the base64 result remains within the existing bridge's 1 MiB output limit. It uses one delivery attempt and cancels unfinished jobs on transport abort. A successful voice catalog is cached for 30 seconds within the same pinned transport; audio is never cached or reused. This avoids paying a bridge round trip merely to revalidate each utterance's voice. Configuration status is not an assertion that a machine is online.

Kokoro on another fleet machine is self-hosted speech, not on-device phone synthesis. Cloud language models still receive their normal chat input; choosing local speech does not change their policies or make the language model local.

## Verification

`server/tts/*test.ts` covers URL/voice validation, body deadlines and cancellation, bounded output, exact bridge operations, shell-data separation, provider selection, credential rejection, and no silent cloud fallback. `scripts/smoke-voice.mjs` starts a real disposable harness with a local speech fixture and verifies the HTTP routes, response bytes, metadata persistence, secret preservation, incompatible voices, and utterance limits. It does not use production accounts or fleet state.

On September 4, the existing Windows bridge successfully returned 68 voices and generated a neutral 51,884-byte MP3 from the healthy Docker Desktop `kokoro-tts` container. The initial plain `docker` probe correctly failed because WSL uses a different Docker engine; `docker.exe` reached the intended existing container. The audio job completed in about 8 seconds. This transport proof is distinct from the later production hub deployment and a physical-device microphone call.
