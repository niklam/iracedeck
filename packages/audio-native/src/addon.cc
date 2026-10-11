/**
 * @iracedeck/audio-native
 *
 * Native Node.js addon wrapping the miniaudio single-header library.
 * Provides a 4-channel mixer used by Pit Engineer and other audio actions.
 */

#include <chrono>
#include <condition_variable>
#include <cstring>
#include <mutex>
#include <napi.h>
#include <string>
#include <thread>
#include <vector>

// The one change this repo makes to the vendored miniaudio.h (#1414): where
// ma_device_reinit__wasapi abandons its old playback IAudioClient at a
// reroute, it hands the pointer to this function first. Declared before the
// include because the header calls it; defined with the namer thread below.
#if defined(_WIN32)
static void irdOnAbandonedAudioClient(void *audioClient);
#define MA_IRD_ON_ABANDONED_AUDIO_CLIENT(audioClient) irdOnAbandonedAudioClient(audioClient)
#endif

#define MINIAUDIO_IMPLEMENTATION
#include "miniaudio.h"

// The Core Audio device and session APIs, for naming our session in the
// Windows Volume Mixer (#1253, #1411). miniaudio declares its own
// `ma_`-prefixed COM interfaces and never includes these headers, so including
// them after it does not clash. The same guard covers the reroute notification
// plumbing (g_rerouteTSFN and the device-rerouted callback, #1330): off it,
// all of it is a no-op.
#if defined(_WIN32) && defined(MA_SUPPORT_WASAPI)
#define IRD_SESSION_IDENTITY_SUPPORTED 1
#include <audioclient.h>
#include <audiopolicy.h>
#include <mmdeviceapi.h>

// A miniaudio upgrade replaces the header, and with it the hook declared
// above the include. This stops the build then. Re-read
// ma_device_reinit__wasapi (written against 0.11.25): put the hook back only
// if it still sets pAudioClientPlayback to NULL without releasing it. If it
// releases the client itself, delete the hook and irdOnAbandonedAudioClient
// with it, or ours becomes a second release of freed memory.
#if !defined(MA_IRD_ABANDONED_AUDIO_CLIENT_HOOK_PRESENT)
#error "miniaudio.h has lost the iRaceDeck hook in ma_device_reinit__wasapi (#1414): see the comment above this line"
#endif
#endif

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

// The user-selected output device, remembered across engine teardowns so a
// lazily recreated engine (see ensureEngineCreated) reopens the same device.
// Windows holds a sleep-blocking power request for a WASAPI stream that is
// merely INITIALIZED — stopping it is not enough (issue #849) — so the
// engine (and with it the device) only exists while audio is in flight.
// Identity is tracked by stable ma_device_id bytes only, never by the
// volatile enumeration index (order changes across hotplug/reorder).
static ma_device_id g_selectedDeviceId = {};
static bool g_useSelectedDevice = false;

// ============================================================================
// Audio session identity (#1253, #1411)
// ============================================================================
//
// Windows' Volume Mixer labels a session with the name and icon its owner set,
// falling back to the executable's (the deck host's node.exe — "Node"). The
// stream miniaudio opens passes no session GUID, so it is in our process's
// default session on its endpoint, and that session is reachable without the
// stream's IAudioClient: an IMMDeviceEnumerator of our own, the endpoint's
// IMMDevice, its IAudioSessionManager, GetAudioSessionControl(NULL, 0). We name
// it after every engine creation and after every reroute — a session belongs
// to one endpoint, so the stream miniaudio opens on a new default device is in
// an unnamed one.
//
// Nothing of ours calls into a COM object miniaudio owns (#1411). The audio
// clients the namer releases are ones miniaudio has abandoned (#1414). Before that
// issue the name went through the playback IAudioClient's GetService, on the
// JS thread, and a default-device change while the stream was open froze the
// plugin for good:
//
//   JS thread            holds the audio client's lock (GetService); creating
//                        the session control registers an endpoint
//                        notification callback, which waits for the device
//                        enumerator's notification lock
//   notification thread  holds that lock for the whole of
//                        OnDefaultDeviceChanged, in which miniaudio's
//                        ma_device_stop waits for the audio worker to stop
//   audio worker         in GetBuffer, waits for the audio client's lock
//
// Creating a session control ALWAYS needs the notification lock, whichever
// object it comes from, so it can always have to wait for a notification
// callback to finish. What differs now is who waits and what it holds
// meanwhile: a thread of our own (the namer), holding nothing the audio
// worker, miniaudio or the JS thread needs. The worker keeps running,
// ma_device_stop returns, the callback finishes and the wait ends. The cost of
// such a wait is a session that shows the host's name a little longer.
//
// Threading:
// - The JS thread writes the identity, and posts a request once it has created
//   an engine, served at once. The request carries a copy of the selected
//   device's id, so the namer never reads miniaudio state or the selection.
// - miniaudio's notification callback posts a request on a reroute. It runs on
//   Windows' notification thread, inside miniaudio's reroute, so it takes the
//   namer's mutex for a moment and nothing else: no COM work, no device. A
//   reroute request is served SESSION_NAMER_REROUTE_DELAY after the LAST one
//   arrived: Windows reports one default change once per role and miniaudio
//   reroutes on each, and there is no point naming a session the next round
//   replaces.
// - Requests coalesce: only the latest target is kept.
// - miniaudio's reroute also hands over the audio client it abandons, through
//   the hook in ma_device_reinit__wasapi, on the same notification thread and
//   under the same rule: the namer's mutex for a moment, and nothing else. The
//   namer releases each one ABANDONED_AUDIO_CLIENT_RELEASE_DELAY later (#1414).
// - The namer does the COM work, with its mutex released.
//
// A reroute also reaches the JS thread, through g_rerouteTSFN, for the JS
// callback SetDeviceReroutedCallback registered (#1330), which the audio
// service turns into a log line. That is all the JS thread does about one.

#if defined(IRD_SESSION_IDENTITY_SUPPORTED)
// How long after the last reroute request the namer serves it.
static const std::chrono::milliseconds SESSION_NAMER_REROUTE_DELAY(500);

// Guards the identity, the pending request, the abandoned audio clients and
// the stop flag below. Never held
// across a COM call, a miniaudio call or the join of the namer thread, so
// taking it is always brief — which is what makes it safe to take on Windows'
// notification thread.
static std::mutex g_namerMutex;
static std::condition_variable g_namerWake;

// The identity is "set" while the display name is non-empty. Written on the JS
// thread; the namer serves a request from a copy.
static std::wstring g_sessionDisplayName;
static std::wstring g_sessionIconPath;

// The pending request, if any: the endpoint whose session to name (an empty id
// is the default render endpoint) and the earliest time to do it.
static bool g_namerRequestPending = false;
static std::wstring g_namerRequestDeviceId;
static std::chrono::steady_clock::time_point g_namerRequestDue;

// True while no namer thread runs or the one that does is being stopped.
static bool g_namerStop = true;

// How long an abandoned audio client waits before the namer releases it: twice
// the rename's delay, so the rename for the same reroute is served first and
// never queues behind a release that has to wait on Windows.
static const std::chrono::milliseconds ABANDONED_AUDIO_CLIENT_RELEASE_DELAY(1000);

// The playback audio clients miniaudio has abandoned at reroutes, oldest
// first, each with the time from which the namer may release it (#1414). Every
// client has a due time of its own, so a default device that keeps changing
// cannot hold the older ones back.
struct AbandonedAudioClient
{
    IUnknown *client;
    std::chrono::steady_clock::time_point due;
};
static std::vector<AbandonedAudioClient> g_abandonedAudioClients;

// The namer thread, or nullptr, and the environment its cleanup hook is
// registered with. JS thread only. Heap-held rather than a static std::thread:
// the deck host often ends the process with no cleanup at all, and the
// destructor of a std::thread that is still joinable calls std::terminate.
static std::thread *g_namerThread = nullptr;
static napi_env g_namerEnv = nullptr;

// Marshals reroute notifications to the JS thread, for the device-rerouted
// callback alone. Created on the JS thread by SetDeviceReroutedCallback when a
// callback is registered, Unref'd so it never keeps the Node event loop alive,
// and released when the callback is cleared (or by DestroyAudioEngine, or
// cleared by the env cleanup hook when Node tears the environment down first).
// The mutex serializes the notification thread's NonBlockingCall with the JS
// thread creating or releasing the handle — the same pattern as
// g_completionTSFN.
static Napi::ThreadSafeFunction g_rerouteTSFN;
static bool g_rerouteTSFNRegistered = false;
static napi_env g_rerouteTSFNEnv = nullptr;
static std::mutex g_rerouteTSFNMutex;

// The JS callback SetDeviceReroutedCallback registered (#1330), or nullptr.
// JS thread only. Heap-held rather than a static Napi::FunctionReference so no
// static destructor calls napi_delete_reference at process exit, after the
// environment that owns the reference is gone.
static Napi::FunctionReference *g_deviceReroutedCallback = nullptr;

/**
 * Drop the registered device-rerouted callback, if any. JS thread only, while
 * the environment is alive (deleting the reference calls into Node-API).
 */
static void clearDeviceReroutedCallback()
{
    delete g_deviceReroutedCallback;
    g_deviceReroutedCallback = nullptr;
}

/**
 * Call the registered device-rerouted callback, if any. JS thread only. A
 * callback that throws is swallowed: an exception escaping a
 * ThreadSafeFunction call is an uncaught exception that would take the plugin
 * down.
 */
static void notifyDeviceRerouted(Napi::Env env)
{
    if (g_deviceReroutedCallback == nullptr || g_deviceReroutedCallback->IsEmpty())
    {
        return;
    }

    // A local handle, so the callback may clear or replace the registration.
    Napi::Function callback = g_deviceReroutedCallback->Value();
    callback.Call({});
    if (env.IsExceptionPending())
    {
        env.GetAndClearPendingException();
    }
}

/**
 * Convert a UTF-8 string to UTF-16. Returns false on invalid input.
 */
static bool Utf8ToWide(const std::string &utf8, std::wstring &out)
{
    out.clear();
    if (utf8.empty())
    {
        return true;
    }

    int len = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), static_cast<int>(utf8.size()), NULL, 0);
    if (len <= 0)
    {
        return false;
    }

    out.resize(static_cast<size_t>(len));
    int written =
        MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(), static_cast<int>(utf8.size()), &out[0], len);
    if (written != len)
    {
        out.clear();
        return false;
    }
    return true;
}

/**
 * Name our process's default session on one render endpoint. Namer thread
 * only, with COM initialised and no lock of ours held. An empty device id is
 * the default render endpoint for the console role, which is the one miniaudio
 * opens. Every object used here is our own — nothing of miniaudio's is read or
 * called (#1411). Every failure is silent: the session keeps the host's name,
 * and playback is never affected.
 */
static void nameEndpointSession(const std::wstring &deviceId,
                                const std::wstring &displayName,
                                const std::wstring &iconPath)
{
    IMMDeviceEnumerator *enumerator = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator),
                                  NULL,
                                  CLSCTX_ALL,
                                  __uuidof(IMMDeviceEnumerator),
                                  reinterpret_cast<void **>(&enumerator));
    if (FAILED(hr) || enumerator == nullptr)
    {
        return;
    }

    IMMDevice *endpoint = nullptr;
    hr = deviceId.empty() ? enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &endpoint)
                          : enumerator->GetDevice(deviceId.c_str(), &endpoint);
    enumerator->Release();
    if (FAILED(hr) || endpoint == nullptr)
    {
        return;
    }

    IAudioSessionManager *manager = nullptr;
    hr = endpoint->Activate(__uuidof(IAudioSessionManager), CLSCTX_ALL, NULL, reinterpret_cast<void **>(&manager));
    endpoint->Release();
    if (FAILED(hr) || manager == nullptr)
    {
        return;
    }

    // A NULL session GUID is the process's default session on this endpoint:
    // the one the stream is in, since miniaudio initialises its client with
    // none. This is the call that can wait for a notification callback.
    IAudioSessionControl *session = nullptr;
    hr = manager->GetAudioSessionControl(NULL, 0, &session);
    manager->Release();
    if (FAILED(hr) || session == nullptr)
    {
        return;
    }

    // The event-context GUID is NULL: nothing of ours listens for session events.
    hr = session->SetDisplayName(displayName.c_str(), NULL);
    (void)hr; // A failure leaves the default name; the icon is still worth trying.

    if (!iconPath.empty())
    {
        hr = session->SetIconPath(iconPath.c_str(), NULL);
        (void)hr; // A failure leaves the default icon.
    }

    session->Release();
}

/**
 * Release audio clients miniaudio abandoned (#1414). Namer thread only, with
 * no lock of ours held. The last reference goes with each call, and Windows
 * may make this thread wait for a notification in flight before it lets the
 * client go; it waits holding nothing another thread needs. Without COM on
 * this thread they stay abandoned, as they all were before #1414.
 */
static void releaseAbandonedAudioClients(std::vector<IUnknown *> &clients, bool comReady)
{
    if (comReady)
    {
        for (IUnknown *client : clients)
        {
            client->Release();
        }
    }
    clients.clear();
}

/**
 * The namer thread, which since #1414 has two jobs: naming the session, and
 * releasing the audio clients miniaudio abandons at a reroute. It sleeps
 * until one of them is due, takes the work with the mutex held and does it
 * with the mutex released, the rename first. A rename request posted while it
 * waits for a due time restarts the wait from the new one, which is the
 * reroute debounce; an abandoned client keeps the due time it arrived with.
 * Leaves when the stop flag is set: work it is doing at that moment is
 * finished first, and clients still queued then are released on the way out.
 */
static void sessionNamerMain()
{
    // Multithreaded, as miniaudio's own threads are: the device and session
    // objects are free-threaded, and this thread pumps no messages. Without
    // COM the thread still runs, and drops every request.
    bool comReady = SUCCEEDED(CoInitializeEx(NULL, COINIT_MULTITHREADED));

    std::unique_lock<std::mutex> lock(g_namerMutex);
    while (!g_namerStop)
    {
        std::chrono::steady_clock::time_point now = std::chrono::steady_clock::now();
        bool requestDue = g_namerRequestPending && now >= g_namerRequestDue;

        // Oldest first, so the ones that are due are at the front.
        size_t dueClients = 0;
        while (dueClients < g_abandonedAudioClients.size() && now >= g_abandonedAudioClients[dueClients].due)
        {
            dueClients++;
        }

        if (!requestDue && dueClients == 0)
        {
            bool hasRequest = g_namerRequestPending;
            bool hasAbandoned = !g_abandonedAudioClients.empty();
            if (!hasRequest && !hasAbandoned)
            {
                g_namerWake.wait(lock);
                continue;
            }

            std::chrono::steady_clock::time_point due =
                hasRequest ? g_namerRequestDue : g_abandonedAudioClients.front().due;
            if (hasRequest && hasAbandoned && g_abandonedAudioClients.front().due < due)
            {
                due = g_abandonedAudioClients.front().due;
            }
            g_namerWake.wait_until(lock, due);
            continue;
        }

        std::wstring deviceId;
        std::wstring displayName;
        std::wstring iconPath;
        if (requestDue)
        {
            deviceId.swap(g_namerRequestDeviceId);
            g_namerRequestPending = false;
            displayName = g_sessionDisplayName;
            iconPath = g_sessionIconPath;
        }

        std::vector<IUnknown *> abandoned;
        for (size_t i = 0; i < dueClients; i++)
        {
            abandoned.push_back(g_abandonedAudioClients[i].client);
        }
        g_abandonedAudioClients.erase(g_abandonedAudioClients.begin(),
                                      g_abandonedAudioClients.begin() + static_cast<std::ptrdiff_t>(dueClients));

        lock.unlock();
        if (comReady && requestDue && !displayName.empty())
        {
            nameEndpointSession(deviceId, displayName, iconPath);
        }
        releaseAbandonedAudioClients(abandoned, comReady);
        lock.lock();
    }

    // Whatever is still queued, due or not: nobody else will release it.
    std::vector<IUnknown *> abandoned;
    for (const AbandonedAudioClient &entry : g_abandonedAudioClients)
    {
        abandoned.push_back(entry.client);
    }
    g_abandonedAudioClients.clear();
    lock.unlock();
    releaseAbandonedAudioClients(abandoned, comReady);

    if (comReady)
    {
        CoUninitialize();
    }
}

/**
 * The hook this repo adds to miniaudio's ma_device_reinit__wasapi calls this
 * with the playback IAudioClient it is about to abandon at a reroute (#1414).
 * It runs on Windows' notification thread, inside miniaudio's reroute, so it
 * makes no COM call: it takes the namer's mutex for a moment, queues the
 * pointer and wakes the namer, which releases it later. The reference that
 * goes with the pointer is the one miniaudio held and no longer uses.
 *
 * Nothing is queued while no namer thread runs to release it: the client then
 * stays abandoned, as every one of them did before #1414.
 */
static void irdOnAbandonedAudioClient(void *audioClient)
{
    if (audioClient == nullptr)
    {
        return;
    }

    {
        std::lock_guard<std::mutex> lock(g_namerMutex);
        if (g_namerStop)
        {
            return;
        }

        g_abandonedAudioClients.push_back({reinterpret_cast<IUnknown *>(audioClient),
                                           std::chrono::steady_clock::now() + ABANDONED_AUDIO_CLIENT_RELEASE_DELAY});
    }
    g_namerWake.notify_one();
}

/**
 * Ask the namer to name our session on an endpoint (an empty id: the default
 * render endpoint) once `delay` has passed. Any thread: it only takes the
 * namer's mutex for a moment and wakes the namer, so it is safe on Windows'
 * notification thread. Replaces a request that is still pending, target and
 * due time both, and is dropped while no identity is set — which is also the
 * state after the namer has been stopped.
 */
static void postSessionNameRequest(std::wstring deviceId, std::chrono::milliseconds delay)
{
    {
        std::lock_guard<std::mutex> lock(g_namerMutex);
        if (g_sessionDisplayName.empty())
        {
            return;
        }

        g_namerRequestDeviceId.swap(deviceId);
        g_namerRequestDue = std::chrono::steady_clock::now() + delay;
        g_namerRequestPending = true;
    }
    g_namerWake.notify_one();
}

/**
 * Stop the namer thread, if one runs, and wait for it; forget the identity and
 * any pending request, so a request posted from now on is dropped. JS thread
 * only. The join cannot deadlock: this thread holds none of the namer's locks
 * while it waits, the namer holds none of ours while it is inside Windows, and
 * a namer waiting there for the notification lock is let go when the
 * notification callback it waits for returns — which never waits for the JS
 * thread.
 *
 * Abandoned audio clients still queued are released by the namer on its way
 * out when `releaseQueued` is set, and dropped (left abandoned) when it is
 * not. Releasing can wait for a notification in flight, and this thread waits
 * for the namer, so it is only asked for where no notification of ours can be
 * in flight: after the engine is gone.
 */
static void stopSessionNamerThread(bool releaseQueued)
{
    {
        std::lock_guard<std::mutex> lock(g_namerMutex);
        if (!releaseQueued)
        {
            g_abandonedAudioClients.clear();
        }
        g_sessionDisplayName.clear();
        g_sessionIconPath.clear();
        g_namerRequestPending = false;
        g_namerRequestDeviceId.clear();
        g_namerStop = true;
    }

    if (g_namerThread == nullptr)
    {
        return;
    }

    g_namerWake.notify_all();
    g_namerThread->join();
    delete g_namerThread;
    g_namerThread = nullptr;
}

/**
 * Env cleanup hook: Node is tearing the environment down without
 * destroyAudioEngine having run. Join the namer so no thread of ours outlives
 * the environment. An engine may still exist; a reroute it reports after this
 * finds no identity and no namer, and is dropped. Audio clients still queued
 * for release are left abandoned: the process is ending, and a reroute may be
 * in flight.
 */
static void SessionNamerCleanupHook(void * /*arg*/)
{
    g_namerEnv = nullptr;
    stopSessionNamerThread(false);
}

/**
 * Start the namer thread if none runs. JS thread only. Called when the audio
 * context is created on WASAPI, because every engine may leave abandoned
 * audio clients to release (#1414), and when a non-empty identity is set.
 * After DestroyAudioEngine the next of either starts a new one.
 */
static void ensureSessionNamerThread(Napi::Env env)
{
    if (g_namerThread != nullptr)
    {
        return;
    }

    {
        std::lock_guard<std::mutex> lock(g_namerMutex);
        g_namerStop = false;
    }

    g_namerThread = new std::thread(sessionNamerMain);
    napi_add_env_cleanup_hook(env, SessionNamerCleanupHook, nullptr);
    g_namerEnv = env;
}

/**
 * JS-thread end of a reroute notification: tell the registered device-rerouted
 * callback (#1330). The session of the new endpoint is named by the namer
 * thread, never from here (#1411).
 */
static Napi::Value OnDeviceRerouted(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    notifyDeviceRerouted(env);
    return env.Undefined();
}

/**
 * Env cleanup hook: Node closes the TSFN itself when the environment goes
 * away, so stop the notification thread from calling into it. Registered
 * after the TSFN is created, so it runs before the TSFN's own cleanup. The
 * device-rerouted callback is only ever registered alongside the TSFN, so it
 * is forgotten here too — deliberately without deleting the reference, which
 * Node-API frees itself with the environment.
 */
static void RerouteTSFNCleanupHook(void * /*arg*/)
{
    std::lock_guard<std::mutex> lock(g_rerouteTSFNMutex);
    g_rerouteTSFNRegistered = false;
    g_rerouteTSFNEnv = nullptr;
    g_deviceReroutedCallback = nullptr;
}

/**
 * Create the reroute TSFN if it does not exist yet. JS thread only.
 */
static void ensureRerouteTSFN(Napi::Env env)
{
    std::lock_guard<std::mutex> lock(g_rerouteTSFNMutex);
    if (g_rerouteTSFNRegistered)
    {
        return;
    }

    g_rerouteTSFN = Napi::ThreadSafeFunction::New(env,
                                                  Napi::Function::New(env, OnDeviceRerouted),
                                                  "maRerouted",
                                                  0,  // unlimited queue
                                                  1); // one thread (miniaudio's notification thread)
    g_rerouteTSFN.Unref(env);
    napi_add_env_cleanup_hook(env, RerouteTSFNCleanupHook, nullptr);
    g_rerouteTSFNEnv = env;
    g_rerouteTSFNRegistered = true;
}
#endif

/**
 * Release the reroute TSFN, if any. JS thread only. Safe while a device
 * exists: the notification thread checks g_rerouteTSFNRegistered under the
 * same mutex before calling into the handle, so a notification arriving
 * afterwards is dropped. A call already queued is still delivered and finds
 * whatever callback is left.
 */
static void releaseRerouteTSFN()
{
#if defined(IRD_SESSION_IDENTITY_SUPPORTED)
    std::lock_guard<std::mutex> lock(g_rerouteTSFNMutex);
    if (!g_rerouteTSFNRegistered)
    {
        return;
    }

    g_rerouteTSFN.Release();
    napi_remove_env_cleanup_hook(g_rerouteTSFNEnv, RerouteTSFNCleanupHook, nullptr);
    g_rerouteTSFNEnv = nullptr;
    g_rerouteTSFNRegistered = false;
#endif
}

/**
 * Ask the namer to name the session of the engine that was just created, at
 * once. JS thread only. The stream is on the selected device when the first
 * init opened it, and on the default render endpoint when there is no
 * selection or the fallback init was used. The device id is copied here, so
 * the namer never reads the selection. A no-op on any backend other than
 * WASAPI, and off Windows.
 */
static void requestSessionNameForNewEngine(bool onSelectedDevice)
{
#if defined(IRD_SESSION_IDENTITY_SUPPORTED)
    if (g_audioContext == nullptr || g_audioContext->backend != ma_backend_wasapi)
    {
        return;
    }

    std::wstring deviceId;
    if (onSelectedDevice)
    {
        const size_t capacity = sizeof(g_selectedDeviceId.wasapi) / sizeof(g_selectedDeviceId.wasapi[0]);
        deviceId.assign(g_selectedDeviceId.wasapi, wcsnlen(g_selectedDeviceId.wasapi, capacity));
        if (deviceId.empty())
        {
            // No id to look the endpoint up by, and an empty one would name
            // the default endpoint's session instead.
            return;
        }
    }

    postSessionNameRequest(std::move(deviceId), std::chrono::milliseconds(0));
#else
    (void)onSelectedDevice;
#endif
}

/**
 * Forget a pending name request. JS thread only, when the engine is torn
 * down: the stream the request was for is gone. A request the namer has
 * already taken still runs, and names a session with no stream in it, which
 * is harmless.
 */
static void cancelSessionNameRequest()
{
#if defined(IRD_SESSION_IDENTITY_SUPPORTED)
    std::lock_guard<std::mutex> lock(g_namerMutex);
    g_namerRequestPending = false;
    g_namerRequestDeviceId.clear();
#endif
}

/**
 * Stop and join the namer thread, clearing the session identity, and take its
 * env cleanup hook back. JS thread only, while the environment is alive.
 */
static void stopSessionNamer()
{
#if defined(IRD_SESSION_IDENTITY_SUPPORTED)
    // The engine is gone, so no reroute is in flight: the namer releases what
    // is still queued before it leaves.
    stopSessionNamerThread(true);
    if (g_namerEnv != nullptr)
    {
        napi_remove_env_cleanup_hook(g_namerEnv, SessionNamerCleanupHook, nullptr);
        g_namerEnv = nullptr;
    }
#endif
}

/**
 * Engine device notification. Runs on the thread miniaudio reroutes from —
 * Windows' notification thread — inside miniaudio's reroute: it reads nothing
 * but the notification type, posts to the JS thread for the device-rerouted
 * callback, and asks the namer to name the new endpoint's session (a fresh,
 * unnamed one). Both are a brief lock of our own; no COM work and no device
 * access may ever be added here (#1411).
 */
static void maNotificationCallback(const ma_device_notification *pNotification)
{
#if defined(IRD_SESSION_IDENTITY_SUPPORTED)
    if (pNotification == nullptr || pNotification->type != ma_device_notification_type_rerouted)
    {
        return;
    }

    {
        std::lock_guard<std::mutex> lock(g_rerouteTSFNMutex);
        if (g_rerouteTSFNRegistered)
        {
            g_rerouteTSFN.NonBlockingCall();
        }
    }

    // miniaudio only reroutes a device it opened on the default endpoint, so
    // the default endpoint is where the new stream is.
    postSessionNameRequest(std::wstring(), SESSION_NAMER_REROUTE_DELAY);
#else
    (void)pNotification;
#endif
}

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
 * Take miniaudio's device-notification client off Windows' list, waiting out a
 * notification that is in flight. JS thread only, right before the engine is
 * uninitialised (#1411).
 *
 * miniaudio follows a default-device change on Windows' notification thread:
 * it stops the device there, reroutes it and starts it again, and waits each
 * time for the audio worker to answer. ma_device_uninit ends that worker
 * first and unregisters the client last, so an uninit landing inside one of
 * those waits leaves the notification thread waiting for a worker that is
 * gone, holding the lock the unregister then waits for on this thread — for
 * good. Unregistering first closes that: the call returns only once no
 * notification is running, with the device and its worker still whole, and
 * none can start afterwards. miniaudio's own unregister then finds nothing
 * registered, which it ignores.
 *
 * What this thread waits for is a reroute finishing, and a reroute never
 * waits for this thread and needs no lock a caller of teardownEngine holds.
 */
static void detachDeviceNotifications(ma_engine *engine)
{
#if defined(IRD_SESSION_IDENTITY_SUPPORTED) && defined(MA_WIN32_DESKTOP)
    ma_device *device = ma_engine_get_device(engine);
    if (device == nullptr || device->pContext == nullptr || device->pContext->backend != ma_backend_wasapi)
    {
        return;
    }

    // Set only when miniaudio's registration succeeded.
    ma_IMMDeviceEnumerator *enumerator = static_cast<ma_IMMDeviceEnumerator *>(device->wasapi.pDeviceEnumerator);
    if (enumerator == nullptr)
    {
        return;
    }

    ma_IMMDeviceEnumerator_UnregisterEndpointNotificationCallback(enumerator, &device->wasapi.notificationClient);
#else
    (void)engine;
#endif
}

/**
 * Tear down the engine (and with it the OS audio device/stream) while
 * keeping the context and the per-channel TSFNs alive. Any remaining
 * channel sounds are released first — they belong to the engine. A session
 * name request still pending for its stream goes with it.
 */
static void teardownEngine()
{
    if (!g_engine)
    {
        return;
    }

    for (int i = 0; i < IRD_MAX_CHANNELS; i++)
    {
        uninitChannel(i);
    }

    // Before the uninit, never inside it: see detachDeviceNotifications.
    detachDeviceNotifications(g_engine);
    ma_engine_uninit(g_engine);
    delete g_engine;
    g_engine = nullptr;

    // After the uninit: no reroute of this engine can post another one now.
    cancelSessionNameRequest();
}

/**
 * Lazily create the engine on the remembered device selection (system
 * default when none). The engine — and with it the WASAPI/OS audio
 * stream — must only exist while audio is in flight: Windows holds a
 * sleep-blocking power request for a stream that is merely initialized,
 * not just a running one (issue #849).
 *
 * The device is created stopped (noAutoStart); StartAudioEngine starts it.
 * When the remembered device can't be opened (unplugged), falls back to
 * the system default WITHOUT clearing the selection, so a later replug
 * self-heals on the next engine creation.
 *
 * @returns true if an engine exists after the call
 */
static bool ensureEngineCreated()
{
    if (g_engine)
    {
        return true;
    }

    if (!g_audioContext)
    {
        return false;
    }

    g_engine = new ma_engine();
    ma_engine_config config = ma_engine_config_init();
    config.pContext = g_audioContext;
    config.noAutoStart = MA_TRUE;
    config.notificationCallback = maNotificationCallback;
    if (g_useSelectedDevice)
    {
        config.pPlaybackDeviceID = &g_selectedDeviceId;
    }

    bool onSelectedDevice = g_useSelectedDevice;
    ma_result result = ma_engine_init(&config, g_engine);
    if (result != MA_SUCCESS && g_useSelectedDevice)
    {
        // Fallback: system default so the mixer remains usable.
        ma_engine_config fallbackConfig = ma_engine_config_init();
        fallbackConfig.pContext = g_audioContext;
        fallbackConfig.noAutoStart = MA_TRUE;
        fallbackConfig.notificationCallback = maNotificationCallback;
        result = ma_engine_init(&fallbackConfig, g_engine);
        onSelectedDevice = false;
    }

    if (result != MA_SUCCESS)
    {
        delete g_engine;
        g_engine = nullptr;
        return false;
    }

    // Both init paths land here, so no engine can skip the identity (#1253).
    // The namer thread applies it: nothing here waits on Windows (#1411).
    requestSessionNameForNewEngine(onSelectedDevice);

    return true;
}

/**
 * Initialize the audio subsystem: creates the shared context used for
 * device enumeration and later engine creation. Deliberately does NOT
 * create the engine or open any audio device — see ensureEngineCreated.
 * Idempotent.
 * @returns true if the context exists after the call
 */
Napi::Value InitAudioEngine(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

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

#if defined(IRD_SESSION_IDENTITY_SUPPORTED)
    // The namer thread also releases what a reroute abandons (#1414), so it
    // runs whenever an engine can exist, identity or not.
    if (g_audioContext->backend == ma_backend_wasapi)
    {
        ensureSessionNamerThread(env);
    }
#endif

    // Deliberately no device-selection reset here: init is idempotent and
    // must not desynchronize a remembered selection from a live engine.
    // The initial globals and DestroyAudioEngine establish default state.
    return Napi::Boolean::New(env, true);
}

/**
 * Start the audio device, creating the engine first if needed.
 * Idempotent — an already-started device reports success.
 * @returns true if the device is running after the call
 */
Napi::Value StartAudioEngine(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (!ensureEngineCreated())
    {
        return Napi::Boolean::New(env, false);
    }

    ma_device *device = ma_engine_get_device(g_engine);
    if (device && ma_device_is_started(device))
    {
        return Napi::Boolean::New(env, true);
    }

    if (ma_engine_start(g_engine) != MA_SUCCESS)
    {
        // A created-but-unstartable engine must not linger: even an
        // initialized, stopped stream holds Windows' sleep-blocking power
        // request (#849), and the JS layer only arms the idle release
        // after a successful start. The next play recreates and retries.
        teardownEngine();
        return Napi::Boolean::New(env, false);
    }

    return Napi::Boolean::New(env, true);
}

/**
 * Release the audio device entirely by tearing down the engine. Merely
 * stopping the device is NOT enough — Windows keeps the sleep-blocking
 * "An audio stream is currently in use" power request for an initialized
 * stream (issue #849), so the whole stream must go away. Any remaining
 * channel sounds are released with the engine; the next play recreates
 * everything on demand. Idempotent — no engine reports success.
 * @returns true if no device exists after the call
 */
Napi::Value StopAudioEngine(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    teardownEngine();
    return Napi::Boolean::New(env, true);
}

/**
 * Destroy the miniaudio engine and all active sounds, clear the session
 * identity (#1253) and the device-rerouted callback (#1330) — set both again
 * before the next engine — and stop the namer thread (#1411).
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

    teardownEngine();

    // No device exists any more, so no reroute notification can arrive, and
    // no notification callback of ours can be what the namer waits for: the
    // join inside stopSessionNamer ends once the namer has finished a request
    // it was serving. It clears the session identity too.
    releaseRerouteTSFN();
    stopSessionNamer();
#if defined(IRD_SESSION_IDENTITY_SUPPORTED)
    clearDeviceReroutedCallback();
#endif

    if (g_audioContext)
    {
        ma_context_uninit(g_audioContext);
        delete g_audioContext;
        g_audioContext = nullptr;
    }

    g_useSelectedDevice = false;
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

    // Recreate the engine on demand — it may have been torn down by an
    // idle StopAudioEngine (#849). The device is created stopped; the JS
    // layer starts it via StartAudioEngine right after this call, and a
    // stopped device simply holds the sound at its beginning until then.
    // Track whether THIS call created the engine so failure paths below
    // can roll it back — a failed play must not leave an initialized
    // (sleep-blocking) device behind, since the JS layer only arms the
    // idle release after a successful play.
    bool createdEngine = (g_engine == nullptr);
    if (!ensureEngineCreated())
    {
        return Napi::Boolean::New(env, false);
    }

    int channel = info[0].As<Napi::Number>().Int32Value();
    if (channel < 0 || channel >= IRD_MAX_CHANNELS)
    {
        if (createdEngine)
        {
            teardownEngine();
        }
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
        if (createdEngine)
        {
            teardownEngine();
        }
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
        if (createdEngine)
        {
            teardownEngine();
        }
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
 * Switch audio output to a specific device: validates the index, remembers
 * the selection, and tears down any live engine — the next play recreates
 * it on the new device (see ensureEngineCreated).
 * @param deviceIndex - Device index from GetAudioDevices(), or -1 for system default
 * @returns true if the selection was accepted
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
    // Without this, negative values below -1 would skip the `>= 0`
    // enumeration branch and silently be treated as "default device".
    if (deviceIndex < -1)
    {
        return Napi::Boolean::New(env, false);
    }

    if (!g_audioContext)
    {
        return Napi::Boolean::New(env, false);
    }

    if (deviceIndex == -1)
    {
        // Selecting the default when it is already selected is a no-op.
        if (!g_useSelectedDevice)
        {
            return Napi::Boolean::New(env, true);
        }

        teardownEngine();
        g_useSelectedDevice = false;
        return Napi::Boolean::New(env, true);
    }

    // Resolve the index to its stable id BEFORE tearing anything down.
    // Identity is decided on the id, never the index — enumeration order
    // is volatile across hotplug/reorder, so an index-based comparison
    // could silently "succeed" on a different physical device.
    ma_device_info *pPlaybackDevices;
    ma_uint32 playbackCount;
    ma_result enumResult = ma_context_get_devices(g_audioContext, &pPlaybackDevices, &playbackCount, NULL, NULL);
    if (enumResult != MA_SUCCESS || static_cast<ma_uint32>(deviceIndex) >= playbackCount)
    {
        return Napi::Boolean::New(env, false);
    }
    ma_device_id selectedId = pPlaybackDevices[deviceIndex].id;

    // Already on this physical device — nothing to change.
    if (g_useSelectedDevice && memcmp(&selectedId, &g_selectedDeviceId, sizeof(ma_device_id)) == 0)
    {
        return Napi::Boolean::New(env, true);
    }

    // Remember the selection and tear the engine down — the next play
    // recreates it on the new device (ensureEngineCreated). Recreating
    // eagerly here would leave an initialized device holding Windows'
    // sleep-blocking power request while idle (#849).
    teardownEngine();

    g_selectedDeviceId = selectedId;
    g_useSelectedDevice = true;
    return Napi::Boolean::New(env, true);
}

/**
 * Switch audio output to a specific device looked up by its stable ID:
 * validates the id against the current enumeration, remembers the
 * selection, and tears down any live engine — the next play recreates it
 * on the matched device (see ensureEngineCreated, which falls back to the
 * system default should the device vanish before then).
 *
 * @param deviceId - Hex-encoded `ma_device_id` from a `getAudioDevices()` entry.
 * @returns true if the device was found and the selection accepted.
 *          Returns false if the ID is malformed or the device isn't in
 *          the current enumeration.
 */
Napi::Value SetAudioDeviceById(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString())
    {
        Napi::TypeError::New(env, "Expected (deviceId: string)").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    if (!g_audioContext)
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

    // Already on this physical device — nothing to change.
    if (g_useSelectedDevice && memcmp(&selectedId, &g_selectedDeviceId, sizeof(ma_device_id)) == 0)
    {
        return Napi::Boolean::New(env, true);
    }

    // Remember the selection and tear the engine down — the next play
    // recreates it on the new device (ensureEngineCreated). Recreating
    // eagerly here would leave an initialized device holding Windows'
    // sleep-blocking power request while idle (#849). Should the device
    // vanish before that play, ensureEngineCreated falls back to the
    // system default so the mixer remains usable.
    teardownEngine();

    g_selectedDeviceId = selectedId;
    g_useSelectedDevice = true;
    return Napi::Boolean::New(env, true);
}

/**
 * Set the name (and optionally the icon) the Windows Volume Mixer shows for
 * our audio session (#1253). Applied to every engine created afterwards and
 * reapplied on reroute, by the namer thread (#1411). Refused while an engine exists — the live session was named
 * when its engine was created, and a later change would leave it under the old
 * name — so call it before the first play. An empty display name clears the
 * identity (the icon with it): engines created afterwards are not named,
 * though Windows keeps a name already set on this process's session for as
 * long as that session lives. DestroyAudioEngine clears it too, and stops the
 * namer. A no-op off Windows.
 *
 * @param displayName - The session's display name (UTF-8); empty for none
 * @param iconPath - Optional absolute path to an .ico (UTF-8)
 * @returns true if the identity was stored (always true off Windows while
 *          no engine exists); false while an engine exists or on invalid text
 */
Napi::Value SetSessionIdentity(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    bool hasIcon = info.Length() >= 2 && !info[1].IsUndefined() && !info[1].IsNull();
    if (info.Length() < 1 || !info[0].IsString() || (hasIcon && !info[1].IsString()))
    {
        Napi::TypeError::New(env, "Expected (displayName: string, iconPath?: string)").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    if (g_engine)
    {
        return Napi::Boolean::New(env, false);
    }

#if defined(IRD_SESSION_IDENTITY_SUPPORTED)
    std::wstring displayName;
    std::wstring iconPath;
    if (!Utf8ToWide(info[0].As<Napi::String>().Utf8Value(), displayName))
    {
        return Napi::Boolean::New(env, false);
    }
    if (hasIcon && !Utf8ToWide(info[1].As<Napi::String>().Utf8Value(), iconPath))
    {
        return Napi::Boolean::New(env, false);
    }

    // No name, no identity: the icon alone would never be applied. A namer
    // thread that already runs stays, and drops every request.
    bool hasIdentity = !displayName.empty();
    if (!hasIdentity)
    {
        iconPath.clear();
    }

    {
        std::lock_guard<std::mutex> lock(g_namerMutex);
        g_sessionDisplayName.swap(displayName);
        g_sessionIconPath.swap(iconPath);
    }

    if (hasIdentity)
    {
        ensureSessionNamerThread(env);
    }
#endif

    return Napi::Boolean::New(env, true);
}

/**
 * Register a JS callback that fires, with no arguments, each time miniaudio
 * follows a default-device change onto a new endpoint (#1330). It runs on the
 * JS thread, from the reroute TSFN's handler. That TSFN exists while a
 * callback is registered and does nothing else: the session identity is
 * reapplied by the namer thread (#1411), so the callback and the identity
 * work with or without each other. A callback that throws is swallowed.
 * Passing undefined or null clears it; registering again replaces it;
 * DestroyAudioEngine clears it too. A no-op off Windows.
 *
 * @param callback - Function to call on reroute, or undefined/null to clear
 */
Napi::Value SetDeviceReroutedCallback(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    bool clear = info.Length() < 1 || info[0].IsUndefined() || info[0].IsNull();
    if (!clear && !info[0].IsFunction())
    {
        Napi::TypeError::New(env, "Expected (callback: function | null | undefined)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

#if defined(IRD_SESSION_IDENTITY_SUPPORTED)
    clearDeviceReroutedCallback();

    if (clear)
    {
        // Nothing but the callback uses the TSFN.
        releaseRerouteTSFN();
        return env.Undefined();
    }

    g_deviceReroutedCallback = new Napi::FunctionReference(Napi::Persistent(info[0].As<Napi::Function>()));
    ensureRerouteTSFN(env);
#else
    (void)clear;
#endif

    return env.Undefined();
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
    exports.Set("setSessionIdentity", Napi::Function::New(env, SetSessionIdentity));
    exports.Set("setDeviceReroutedCallback", Napi::Function::New(env, SetDeviceReroutedCallback));

    return exports;
}

NODE_API_MODULE(audio_native, Init)
