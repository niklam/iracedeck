/**
 * @iracedeck/audio-native
 *
 * Native Node.js addon wrapping the miniaudio single-header library.
 * Provides a 4-channel mixer used by Pit Engineer and other audio actions.
 */

#include <cstring>
#include <mutex>
#include <napi.h>
#include <string>

#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"

// ============================================================================
// Stable device-id encoding
// ============================================================================
//
// `ma_device_id` is a union of platform-specific stable identifiers (WASAPI
// endpoint IDs, CoreAudio UIDs, ALSA names, etc.). The raw layout is opaque
// to JS; we expose it as an uppercase-hex string so it round-trips losslessly
// between native enumeration and the persisted plugin setting.
//
// We trim trailing zero bytes before hex-encoding and zero-pad on decode.
// `ma_context_get_devices` zero-initializes the union, so unused tail bytes
// are not data — trimming reduces a Windows WASAPI endpoint id from
// 2 * sizeof(ma_device_id) (~512 chars) down to ~220 chars (the actual
// `{0.0.0.00000000}.{guid}` wide-string plus its null terminator). Without
// trimming, pushing the device list into Stream Deck's global settings
// inflates the cross-process settings echo enough to trigger a stack
// overflow in the SDK's connection logger when the failed-parse fallback
// tries to format the oversized payload.
//
// The encoding is deliberately format-stable: the byte layout of
// `ma_device_id` depends on miniaudio's compile-time configuration (active
// backends), so a setting persisted under one build is only meaningful to
// the same build. That is acceptable for iRaceDeck — we ship a single
// addon binary per platform and there is no cross-machine setting sync.

static std::string SerializeDeviceId(const ma_device_id &id)
{
    static constexpr char hex[] = "0123456789ABCDEF";
    const ma_uint8 *bytes = reinterpret_cast<const ma_uint8 *>(&id);

    // Trim trailing zero bytes. Safe because miniaudio zero-fills the union
    // and every backend stores its identifier in the leading bytes (string
    // backends include their null terminator; integer backends fit in 4 bytes
    // followed by zero padding).
    size_t sigLen = sizeof(ma_device_id);
    while (sigLen > 0 && bytes[sigLen - 1] == 0)
    {
        sigLen--;
    }

    std::string out;
    out.resize(sigLen * 2);
    for (size_t i = 0; i < sigLen; i++)
    {
        out[i * 2] = hex[(bytes[i] >> 4) & 0x0F];
        out[i * 2 + 1] = hex[bytes[i] & 0x0F];
    }
    return out;
}

static bool DeserializeDeviceId(const std::string &hex, ma_device_id &outId)
{
    // Hex must be even-length and fit within the union. Empty string is
    // rejected so the System Default sentinel ("") never round-trips into
    // a zero-filled ma_device_id and accidentally matches a real device.
    if (hex.empty() || hex.size() > sizeof(ma_device_id) * 2 || hex.size() % 2 != 0)
    {
        return false;
    }

    // Zero-fill so trimmed trailing bytes are restored — the resulting
    // memcmp matches what `ma_context_get_devices` enumerates.
    memset(&outId, 0, sizeof(ma_device_id));
    ma_uint8 *bytes = reinterpret_cast<ma_uint8 *>(&outId);
    size_t numBytes = hex.size() / 2;
    for (size_t i = 0; i < numBytes; i++)
    {
        auto fromHex = [](char c) -> int {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return c - 'a' + 10;
            if (c >= 'A' && c <= 'F') return c - 'A' + 10;
            return -1;
        };

        int hi = fromHex(hex[i * 2]);
        int lo = fromHex(hex[i * 2 + 1]);
        if (hi < 0 || lo < 0)
        {
            return false;
        }
        bytes[i] = static_cast<ma_uint8>((hi << 4) | lo);
    }
    return true;
}

// ============================================================================
// Audio Engine (miniaudio — multi-channel mixer)
// ============================================================================

static const int IRD_MAX_CHANNELS = 4;
static ma_context *g_audioContext = nullptr;
static ma_engine *g_engine = nullptr;
static ma_sound *g_channels[IRD_MAX_CHANNELS] = {};
static Napi::ThreadSafeFunction g_completionTSFN[IRD_MAX_CHANNELS];
static bool g_tsfnRegistered[IRD_MAX_CHANNELS] = {};
static int g_selectedDeviceIndex = -1; // -1 = system default

// Serializes access to g_completionTSFN[] / g_tsfnRegistered[].
// Without it, maEndCallback runs on miniaudio's audio thread while
// DestroyAudioEngine and SetChannelEndCallback mutate those slots on the
// JS thread — the callback could dereference a released TSFN.
// We deliberately do NOT hold this lock across ma_sound_uninit or
// ma_sound_init_from_file: miniaudio's own audio-thread work must stay
// unblocked, and we only need the lock for the narrow window that inspects
// or rewrites the TSFN handle itself.
static std::mutex g_tsfnMutex;

/**
 * Completion callback fired on miniaudio's audio thread when a sound finishes.
 * Marshals to the JS main thread via ThreadSafeFunction.
 */
static void maEndCallback(void *pUserData, ma_sound * /*pSound*/)
{
    int channel = static_cast<int>(reinterpret_cast<intptr_t>(pUserData));
    if (channel < 0 || channel >= IRD_MAX_CHANNELS)
    {
        return;
    }

    std::lock_guard<std::mutex> lock(g_tsfnMutex);
    if (g_tsfnRegistered[channel])
    {
        g_completionTSFN[channel].NonBlockingCall();
    }
}

/**
 * Uninitialize and free a sound on a specific channel.
 */
static void uninitChannel(int channel)
{
    if (g_channels[channel])
    {
        ma_sound_uninit(g_channels[channel]);
        delete g_channels[channel];
        g_channels[channel] = nullptr;
    }
}

/**
 * Initialize the miniaudio engine.
 * Creates a shared context for device enumeration and engine use.
 * @returns true if engine was created successfully
 */
Napi::Value InitAudioEngine(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (g_engine)
    {
        return Napi::Boolean::New(env, true); // already initialized
    }

    // Create shared context if not already created
    if (!g_audioContext)
    {
        g_audioContext = new ma_context();
        ma_result ctxResult = ma_context_init(NULL, 0, NULL, g_audioContext);
        if (ctxResult != MA_SUCCESS)
        {
            delete g_audioContext;
            g_audioContext = nullptr;
            return Napi::Boolean::New(env, false);
        }
    }

    g_engine = new ma_engine();
    ma_engine_config config = ma_engine_config_init();
    config.pContext = g_audioContext;
    // Don't start the playback device at init. A running device keeps a
    // WASAPI render stream open 24/7, which makes Windows hold a SYSTEM
    // power request ("An audio stream is currently in use") and blocks
    // PC sleep (issue #849). The JS layer starts/stops the device around
    // actual playback via StartAudioEngine/StopAudioEngine.
    config.noAutoStart = MA_TRUE;

    ma_result result = ma_engine_init(&config, g_engine);
    if (result != MA_SUCCESS)
    {
        delete g_engine;
        g_engine = nullptr;
        return Napi::Boolean::New(env, false);
    }

    g_selectedDeviceIndex = -1;
    return Napi::Boolean::New(env, true);
}

/**
 * Start the engine's playback device. Idempotent — an already-started
 * device reports success.
 * @returns true if the device is running after the call
 */
Napi::Value StartAudioEngine(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (!g_engine)
    {
        return Napi::Boolean::New(env, false);
    }

    ma_device *device = ma_engine_get_device(g_engine);
    if (device && ma_device_is_started(device))
    {
        return Napi::Boolean::New(env, true);
    }

    return Napi::Boolean::New(env, ma_engine_start(g_engine) == MA_SUCCESS);
}

/**
 * Stop the engine's playback device, releasing the OS audio stream (and
 * with it Windows' sleep-blocking power request, issue #849). Sounds are
 * not touched — a started sound resumes when the device starts again.
 * Idempotent — an already-stopped device reports success.
 * @returns true if the device is stopped after the call
 */
Napi::Value StopAudioEngine(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (!g_engine)
    {
        return Napi::Boolean::New(env, false);
    }

    ma_device *device = ma_engine_get_device(g_engine);
    if (device && !ma_device_is_started(device))
    {
        return Napi::Boolean::New(env, true);
    }

    return Napi::Boolean::New(env, ma_engine_stop(g_engine) == MA_SUCCESS);
}

/**
 * Destroy the miniaudio engine and all active sounds.
 */
Napi::Value DestroyAudioEngine(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    for (int i = 0; i < IRD_MAX_CHANNELS; i++)
    {
        // uninitChannel detaches miniaudio's end callback. An end callback
        // that started before uninit may still be in flight on the audio
        // thread — the mutex below serializes its access to the TSFN slot
        // with the Release() below.
        uninitChannel(i);
        std::lock_guard<std::mutex> lock(g_tsfnMutex);
        if (g_tsfnRegistered[i])
        {
            g_completionTSFN[i].Release();
            g_tsfnRegistered[i] = false;
        }
    }

    if (g_engine)
    {
        ma_engine_uninit(g_engine);
        delete g_engine;
        g_engine = nullptr;
    }

    if (g_audioContext)
    {
        ma_context_uninit(g_audioContext);
        delete g_audioContext;
        g_audioContext = nullptr;
    }

    g_selectedDeviceIndex = -1;
    return env.Undefined();
}

/**
 * Play an audio file on a specific channel.
 * @param channel - Channel index (0-3)
 * @param filePath - Absolute path to audio file (WAV, MP3, or FLAC)
 * @param loop - Whether to loop the sound (default false)
 * @param volume - Volume level 0.0-1.0 (default 1.0)
 * @returns true if playback started successfully
 */
Napi::Value PlayOnChannel(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString())
    {
        Napi::TypeError::New(env, "Expected (channel: number, filePath: string, loop?: boolean, volume?: number)")
            .ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    if (!g_engine)
    {
        return Napi::Boolean::New(env, false);
    }

    int channel = info[0].As<Napi::Number>().Int32Value();
    if (channel < 0 || channel >= IRD_MAX_CHANNELS)
    {
        return Napi::Boolean::New(env, false);
    }

    std::string path = info[1].As<Napi::String>().Utf8Value();
    bool loop = info.Length() >= 3 && info[2].IsBoolean() ? info[2].As<Napi::Boolean>().Value() : false;
    float volume = info.Length() >= 4 && info[3].IsNumber() ? info[3].As<Napi::Number>().FloatValue() : 1.0f;

    // Stop and release any existing sound on this channel
    uninitChannel(channel);

    // Create new sound
    ma_sound *sound = new ma_sound();
    ma_result result = ma_sound_init_from_file(g_engine, path.c_str(), 0, NULL, NULL, sound);
    if (result != MA_SUCCESS)
    {
        delete sound;
        return Napi::Boolean::New(env, false);
    }

    ma_sound_set_volume(sound, volume);
    ma_sound_set_looping(sound, loop ? MA_TRUE : MA_FALSE);

    // Register end callback with channel index as user data
    ma_sound_set_end_callback(sound, maEndCallback, reinterpret_cast<void *>(static_cast<intptr_t>(channel)));

    g_channels[channel] = sound;

    result = ma_sound_start(sound);
    if (result != MA_SUCCESS)
    {
        uninitChannel(channel);
        return Napi::Boolean::New(env, false);
    }

    return Napi::Boolean::New(env, true);
}

/**
 * Stop playback on a specific channel.
 * @param channel - Channel index (0-3)
 */
Napi::Value StopChannel(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber())
    {
        Napi::TypeError::New(env, "Expected (channel: number)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int channel = info[0].As<Napi::Number>().Int32Value();
    if (channel >= 0 && channel < IRD_MAX_CHANNELS)
    {
        uninitChannel(channel);
    }

    return env.Undefined();
}

/**
 * Set volume on a specific channel.
 * @param channel - Channel index (0-3)
 * @param volume - Volume level 0.0-1.0
 */
Napi::Value SetChannelVolume(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber())
    {
        Napi::TypeError::New(env, "Expected (channel: number, volume: number)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int channel = info[0].As<Napi::Number>().Int32Value();
    float volume = info[1].As<Napi::Number>().FloatValue();

    if (channel >= 0 && channel < IRD_MAX_CHANNELS && g_channels[channel])
    {
        ma_sound_set_volume(g_channels[channel], volume);
    }

    return env.Undefined();
}

/**
 * Check if a channel is currently playing.
 * @param channel - Channel index (0-3)
 * @returns true if the channel has an active sound playing
 */
Napi::Value IsChannelPlaying(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber())
    {
        Napi::TypeError::New(env, "Expected (channel: number)").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    int channel = info[0].As<Napi::Number>().Int32Value();
    if (channel >= 0 && channel < IRD_MAX_CHANNELS && g_channels[channel])
    {
        return Napi::Boolean::New(env, ma_sound_is_playing(g_channels[channel]) == MA_TRUE);
    }

    return Napi::Boolean::New(env, false);
}

/**
 * Register a JS callback that fires when a channel's sound finishes playing.
 * Uses ThreadSafeFunction to marshal from the audio thread to the JS main thread.
 *
 * @param channel - Channel index (0-3)
 * @param callback - JavaScript function to call on completion
 */
Napi::Value SetChannelEndCallback(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsFunction())
    {
        Napi::TypeError::New(env, "Expected (channel: number, callback: function)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int channel = info[0].As<Napi::Number>().Int32Value();
    if (channel < 0 || channel >= IRD_MAX_CHANNELS)
    {
        return env.Undefined();
    }

    Napi::Function callback = info[1].As<Napi::Function>();

    // Serialize release+reassign with maEndCallback so the audio thread can
    // never read a TSFN handle that is being torn down or rewritten.
    std::lock_guard<std::mutex> lock(g_tsfnMutex);

    if (g_tsfnRegistered[channel])
    {
        g_completionTSFN[channel].Release();
        g_tsfnRegistered[channel] = false;
    }

    g_completionTSFN[channel] = Napi::ThreadSafeFunction::New(
        env,
        callback,
        "maEndCallback_ch" + std::to_string(channel),
        0,  // unlimited queue
        1); // one thread (the audio thread)

    g_tsfnRegistered[channel] = true;

    return env.Undefined();
}

/**
 * Stop all channels.
 */
Napi::Value StopAllChannels(const Napi::CallbackInfo &info)
{
    for (int i = 0; i < IRD_MAX_CHANNELS; i++)
    {
        uninitChannel(i);
    }
    return info.Env().Undefined();
}

/**
 * Seek a channel to a random position within the sound.
 * Useful for looping ambient tracks so each play starts at a different point.
 * @param channel - Channel index (0-3)
 */
Napi::Value SeekChannelRandom(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber())
    {
        Napi::TypeError::New(env, "Expected (channel: number)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int channel = info[0].As<Napi::Number>().Int32Value();
    if (channel < 0 || channel >= IRD_MAX_CHANNELS || !g_channels[channel])
    {
        return env.Undefined();
    }

    ma_uint64 totalFrames = 0;
    ma_result res = ma_sound_get_length_in_pcm_frames(g_channels[channel], &totalFrames);
    if (res != MA_SUCCESS || totalFrames == 0)
    {
        return env.Undefined();
    }

    // Random position within the track
    ma_uint64 randomFrame = static_cast<ma_uint64>(
        (static_cast<double>(rand()) / RAND_MAX) * static_cast<double>(totalFrames));
    ma_sound_seek_to_pcm_frame(g_channels[channel], randomFrame);

    return env.Undefined();
}

/**
 * Get list of available audio playback devices.
 * @returns Array of { index: number, name: string, id: string, isDefault: boolean }
 *
 * `id` is a hex-encoded `ma_device_id` — the platform-stable identifier
 * (WASAPI endpoint ID on Windows, CoreAudio UID on macOS, etc.) suitable
 * for persisting selection across sessions. `index` is preserved for
 * backward compatibility with `setAudioDevice(index)`.
 */
Napi::Value GetAudioDevices(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    Napi::Array result = Napi::Array::New(env);

    if (!g_audioContext)
    {
        return result; // empty array if no context
    }

    ma_device_info *pPlaybackDevices;
    ma_uint32 playbackCount;
    ma_result res = ma_context_get_devices(g_audioContext, &pPlaybackDevices, &playbackCount, NULL, NULL);
    if (res != MA_SUCCESS)
    {
        return result;
    }

    for (ma_uint32 i = 0; i < playbackCount; i++)
    {
        Napi::Object device = Napi::Object::New(env);
        device.Set("index", Napi::Number::New(env, static_cast<int>(i)));
        device.Set("name", Napi::String::New(env, pPlaybackDevices[i].name));
        device.Set("id", Napi::String::New(env, SerializeDeviceId(pPlaybackDevices[i].id)));
        device.Set("isDefault", Napi::Boolean::New(env, pPlaybackDevices[i].isDefault != 0));
        result.Set(i, device);
    }

    return result;
}

/**
 * Switch audio output to a specific device.
 * Stops all sounds, reinitializes engine with the selected device.
 * @param deviceIndex - Device index from GetAudioDevices(), or -1 for system default
 * @returns true if engine was reinitialized successfully
 */
Napi::Value SetAudioDevice(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber())
    {
        Napi::TypeError::New(env, "Expected (deviceIndex: number)").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    int deviceIndex = info[0].As<Napi::Number>().Int32Value();

    // Only -1 (system default) and non-negative device indices are valid.
    // Without this, negative values below -1 skip the `>= 0` enumeration
    // branch, silently get treated as "default device", and are then
    // persisted into g_selectedDeviceIndex — the next call with the same
    // invalid value would short-circuit via the fast-path below.
    if (deviceIndex < -1)
    {
        return Napi::Boolean::New(env, false);
    }

    if (!g_engine || !g_audioContext)
    {
        return Napi::Boolean::New(env, false);
    }

    // Skip if already on the requested device
    if (deviceIndex == g_selectedDeviceIndex)
    {
        return Napi::Boolean::New(env, true);
    }

    // Validate deviceIndex BEFORE tearing down the current engine.
    // Without this, an invalid index silently falls back to the default
    // device but is still recorded as selected — the next call on the same
    // stale index would short-circuit via the fast-path above and return
    // true for a device that was never active.
    ma_device_id *pDeviceId = nullptr;
    ma_device_id selectedId = {};

    if (deviceIndex >= 0)
    {
        ma_device_info *pPlaybackDevices;
        ma_uint32 playbackCount;
        ma_result enumResult = ma_context_get_devices(g_audioContext, &pPlaybackDevices, &playbackCount, NULL, NULL);
        if (enumResult != MA_SUCCESS || static_cast<ma_uint32>(deviceIndex) >= playbackCount)
        {
            return Napi::Boolean::New(env, false);
        }
        selectedId = pPlaybackDevices[deviceIndex].id;
        pDeviceId = &selectedId;
    }
    // deviceIndex == -1 leaves pDeviceId null → engine uses the system default.

    // Stop all active sounds (but keep TSFNs alive)
    for (int i = 0; i < IRD_MAX_CHANNELS; i++)
    {
        uninitChannel(i);
    }

    // Destroy current engine
    ma_engine_uninit(g_engine);
    delete g_engine;
    g_engine = nullptr;

    // Reinitialize engine with selected device (stopped — see InitAudioEngine)
    g_engine = new ma_engine();
    ma_engine_config engineConfig = ma_engine_config_init();
    engineConfig.pContext = g_audioContext;
    engineConfig.noAutoStart = MA_TRUE;
    if (pDeviceId)
    {
        engineConfig.pPlaybackDeviceID = pDeviceId;
    }

    ma_result result = ma_engine_init(&engineConfig, g_engine);
    if (result != MA_SUCCESS)
    {
        delete g_engine;
        g_engine = nullptr;

        // Fallback: try default device
        g_engine = new ma_engine();
        ma_engine_config fallbackConfig = ma_engine_config_init();
        fallbackConfig.pContext = g_audioContext;
        fallbackConfig.noAutoStart = MA_TRUE;
        ma_result fallbackResult = ma_engine_init(&fallbackConfig, g_engine);
        if (fallbackResult != MA_SUCCESS)
        {
            delete g_engine;
            g_engine = nullptr;
            g_selectedDeviceIndex = -1;
            return Napi::Boolean::New(env, false);
        }
        g_selectedDeviceIndex = -1;
        return Napi::Boolean::New(env, false);
    }

    g_selectedDeviceIndex = deviceIndex;
    return Napi::Boolean::New(env, true);
}

/**
 * Switch audio output to a specific device looked up by its stable ID.
 * Stops all sounds, reinitializes engine with the matched device.
 *
 * @param deviceId - Hex-encoded `ma_device_id` from a `getAudioDevices()` entry.
 * @returns true if the device was found and the engine was reinitialized.
 *          Returns false if the ID is malformed, the device isn't in the
 *          current enumeration, or engine reinit fails. On reinit failure
 *          the engine is recreated with the system default so the mixer
 *          stays usable.
 */
Napi::Value SetAudioDeviceById(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString())
    {
        Napi::TypeError::New(env, "Expected (deviceId: string)").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    if (!g_engine || !g_audioContext)
    {
        return Napi::Boolean::New(env, false);
    }

    std::string idHex = info[0].As<Napi::String>().Utf8Value();
    ma_device_id targetId;
    if (!DeserializeDeviceId(idHex, targetId))
    {
        return Napi::Boolean::New(env, false);
    }

    // Look up the device by raw-bytes match against the current enumeration.
    // We resolve every session because device list ordering is volatile, but
    // the underlying ma_device_id bytes are platform-stable.
    ma_device_info *pPlaybackDevices;
    ma_uint32 playbackCount;
    ma_result enumResult = ma_context_get_devices(g_audioContext, &pPlaybackDevices, &playbackCount, NULL, NULL);
    if (enumResult != MA_SUCCESS)
    {
        return Napi::Boolean::New(env, false);
    }

    int matchIndex = -1;
    for (ma_uint32 i = 0; i < playbackCount; i++)
    {
        if (memcmp(&pPlaybackDevices[i].id, &targetId, sizeof(ma_device_id)) == 0)
        {
            matchIndex = static_cast<int>(i);
            break;
        }
    }

    if (matchIndex < 0)
    {
        return Napi::Boolean::New(env, false);
    }

    // Snapshot the matched ID — `pPlaybackDevices` is owned by miniaudio and
    // may be invalidated by the next enumeration / reinit.
    ma_device_id selectedId = pPlaybackDevices[matchIndex].id;

    // Stop all active sounds before tearing down the engine
    for (int i = 0; i < IRD_MAX_CHANNELS; i++)
    {
        uninitChannel(i);
    }

    ma_engine_uninit(g_engine);
    delete g_engine;
    g_engine = nullptr;

    // Reinitialize engine with the selected device (stopped — see InitAudioEngine)
    g_engine = new ma_engine();
    ma_engine_config engineConfig = ma_engine_config_init();
    engineConfig.pContext = g_audioContext;
    engineConfig.noAutoStart = MA_TRUE;
    engineConfig.pPlaybackDeviceID = &selectedId;

    ma_result result = ma_engine_init(&engineConfig, g_engine);
    if (result != MA_SUCCESS)
    {
        delete g_engine;
        g_engine = nullptr;

        // Fallback: try default device so the mixer remains usable.
        g_engine = new ma_engine();
        ma_engine_config fallbackConfig = ma_engine_config_init();
        fallbackConfig.pContext = g_audioContext;
        fallbackConfig.noAutoStart = MA_TRUE;
        ma_result fallbackResult = ma_engine_init(&fallbackConfig, g_engine);
        if (fallbackResult != MA_SUCCESS)
        {
            delete g_engine;
            g_engine = nullptr;
        }
        g_selectedDeviceIndex = -1;
        return Napi::Boolean::New(env, false);
    }

    // Track the matched index so a subsequent `setAudioDevice(index)` skip
    // optimization stays consistent with what's actually open.
    g_selectedDeviceIndex = matchIndex;
    return Napi::Boolean::New(env, true);
}

// ============================================================================
// Module Initialization
// ============================================================================

Napi::Object Init(Napi::Env env, Napi::Object exports)
{
    exports.Set("initAudioEngine", Napi::Function::New(env, InitAudioEngine));
    exports.Set("destroyAudioEngine", Napi::Function::New(env, DestroyAudioEngine));
    exports.Set("startAudioEngine", Napi::Function::New(env, StartAudioEngine));
    exports.Set("stopAudioEngine", Napi::Function::New(env, StopAudioEngine));
    exports.Set("playOnChannel", Napi::Function::New(env, PlayOnChannel));
    exports.Set("stopChannel", Napi::Function::New(env, StopChannel));
    exports.Set("setChannelVolume", Napi::Function::New(env, SetChannelVolume));
    exports.Set("isChannelPlaying", Napi::Function::New(env, IsChannelPlaying));
    exports.Set("setChannelEndCallback", Napi::Function::New(env, SetChannelEndCallback));
    exports.Set("stopAllChannels", Napi::Function::New(env, StopAllChannels));
    exports.Set("seekChannelRandom", Napi::Function::New(env, SeekChannelRandom));
    exports.Set("getAudioDevices", Napi::Function::New(env, GetAudioDevices));
    exports.Set("setAudioDevice", Napi::Function::New(env, SetAudioDevice));
    exports.Set("setAudioDeviceById", Napi::Function::New(env, SetAudioDeviceById));

    return exports;
}

NODE_API_MODULE(audio_native, Init)
