/**
 * @iracedeck/iracing-native
 *
 * Native Node.js addon for iRacing SDK integration.
 * Uses the official iRacing SDK for memory-mapped file access and broadcast messaging.
 */

#include <napi.h>
#include <windows.h>
#include <string>
#include <mutex>
#include <vector>
#include <irsdk_defines.h>

// Serializes all in-flight chat sends so the paste/broadcast sequence can't
// interleave with itself on different worker threads. Chat sends run on the
// libuv thread pool, and iRacing only has one chat window — attempting two
// sends in parallel would clobber the clipboard and chat state.
static std::mutex g_chatSendMutex;

// ============================================================================
// SDK Connection Functions
// ============================================================================

/**
 * Initialize connection to iRacing
 * @returns true if connected
 */
Napi::Value Startup(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    return Napi::Boolean::New(env, irsdk_startup());
}

/**
 * Close connection to iRacing
 */
Napi::Value Shutdown(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    irsdk_shutdown();
    return env.Undefined();
}

/**
 * Check if connected to iRacing
 * Note: We don't use irsdk_isConnected() because it requires recent data reads
 * to update lastValidTime. Instead, we directly check the header status.
 * @returns true if connected
 */
Napi::Value IsConnected(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    const irsdk_header *header = irsdk_getHeader();
    if (!header)
    {
        return Napi::Boolean::New(env, false);
    }

    return Napi::Boolean::New(env, (header->status & irsdk_stConnected) > 0);
}

// ============================================================================
// Header and Data Functions
// ============================================================================

/**
 * Get the iRacing SDK header
 * @returns Object with header properties or null if not connected
 */
Napi::Value GetHeader(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    const irsdk_header *header = irsdk_getHeader();
    if (!header)
    {
        return env.Null();
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("ver", Napi::Number::New(env, header->ver));
    result.Set("status", Napi::Number::New(env, header->status));
    result.Set("tickRate", Napi::Number::New(env, header->tickRate));
    result.Set("sessionInfoUpdate", Napi::Number::New(env, header->sessionInfoUpdate));
    result.Set("sessionInfoLen", Napi::Number::New(env, header->sessionInfoLen));
    result.Set("sessionInfoOffset", Napi::Number::New(env, header->sessionInfoOffset));
    result.Set("numVars", Napi::Number::New(env, header->numVars));
    result.Set("varHeaderOffset", Napi::Number::New(env, header->varHeaderOffset));
    result.Set("numBuf", Napi::Number::New(env, header->numBuf));
    result.Set("bufLen", Napi::Number::New(env, header->bufLen));

    return result;
}

/**
 * Get telemetry data from a specific buffer
 * @param index - Buffer index (0-3)
 * @returns Buffer with telemetry data or null
 */
Napi::Value GetData(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber())
    {
        Napi::TypeError::New(env, "Expected (index: number)").ThrowAsJavaScriptException();
        return env.Null();
    }

    int index = info[0].As<Napi::Number>().Int32Value();

    const char *data = irsdk_getData(index);
    const irsdk_header *header = irsdk_getHeader();

    if (!data || !header)
    {
        return env.Null();
    }

    // Copy the data to a new buffer
    Napi::Buffer<char> buffer = Napi::Buffer<char>::Copy(env, data, header->bufLen);
    return buffer;
}

/**
 * Wait for new data to be available
 * @param timeoutMs - Timeout in milliseconds
 * @returns Buffer with new data or null if timeout
 */
Napi::Value WaitForData(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    int timeoutMs = 16; // Default ~60fps
    if (info.Length() >= 1 && info[0].IsNumber())
    {
        timeoutMs = info[0].As<Napi::Number>().Int32Value();
    }

    const irsdk_header *header = irsdk_getHeader();
    if (!header)
    {
        // Try to initialize first
        if (!irsdk_startup())
        {
            return env.Null();
        }
        header = irsdk_getHeader();
        if (!header)
        {
            return env.Null();
        }
    }

    // Allocate buffer for data
    char *data = new char[header->bufLen];

    bool hasData = irsdk_waitForDataReady(timeoutMs, data);

    if (hasData)
    {
        Napi::Buffer<char> buffer = Napi::Buffer<char>::Copy(env, data, header->bufLen);
        delete[] data;
        return buffer;
    }

    delete[] data;
    return env.Null();
}

/**
 * Get session info YAML string
 * @returns Session info string or null
 */
Napi::Value GetSessionInfoStr(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    const char *sessionInfo = irsdk_getSessionInfoStr();
    if (!sessionInfo)
    {
        return env.Null();
    }

    return Napi::String::New(env, sessionInfo);
}

/**
 * Get variable header by index
 * @param index - Variable index
 * @returns Object with variable header properties or null
 */
Napi::Value GetVarHeaderEntry(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsNumber())
    {
        Napi::TypeError::New(env, "Expected (index: number)").ThrowAsJavaScriptException();
        return env.Null();
    }

    int index = info[0].As<Napi::Number>().Int32Value();
    const irsdk_varHeader *varHeader = irsdk_getVarHeaderEntry(index);

    if (!varHeader)
    {
        return env.Null();
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("type", Napi::Number::New(env, varHeader->type));
    result.Set("offset", Napi::Number::New(env, varHeader->offset));
    result.Set("count", Napi::Number::New(env, varHeader->count));
    result.Set("countAsTime", Napi::Boolean::New(env, varHeader->countAsTime != 0));
    result.Set("name", Napi::String::New(env, varHeader->name));
    result.Set("desc", Napi::String::New(env, varHeader->desc));
    result.Set("unit", Napi::String::New(env, varHeader->unit));

    return result;
}

/**
 * Get variable index by name
 * @param name - Variable name
 * @returns Index or -1 if not found
 */
Napi::Value VarNameToIndex(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString())
    {
        Napi::TypeError::New(env, "Expected (name: string)").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string name = info[0].As<Napi::String>().Utf8Value();
    int index = irsdk_varNameToIndex(name.c_str());

    return Napi::Number::New(env, index);
}

// ============================================================================
// Broadcast Message Functions
// ============================================================================

/**
 * Send a broadcast message to iRacing
 * @param msg - Broadcast message type (irsdk_BroadcastMsg enum value)
 * @param var1 - First parameter
 * @param var2 - Second parameter (optional, default 0)
 * @param var3 - Third parameter (optional, default 0)
 */
Napi::Value BroadcastMsg(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber())
    {
        Napi::TypeError::New(env, "Expected (msg: number, var1: number, var2?: number, var3?: number)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    int msg = info[0].As<Napi::Number>().Int32Value();
    int var1 = info[1].As<Napi::Number>().Int32Value();
    int var2 = info.Length() >= 3 && info[2].IsNumber() ? info[2].As<Napi::Number>().Int32Value() : 0;
    int var3 = info.Length() >= 4 && info[3].IsNumber() ? info[3].As<Napi::Number>().Int32Value() : 0;

    irsdk_broadcastMsg(static_cast<irsdk_BroadcastMsg>(msg), var1, var2, var3);

    return env.Undefined();
}

// ============================================================================
// Chat Functions
// ============================================================================

/**
 * Copy a UTF-16 string to the Windows clipboard.
 *
 * @param text - The text to place on the clipboard
 * @returns true if successful
 */
static bool copyToClipboard(const std::u16string &text)
{
    if (!OpenClipboard(NULL))
    {
        return false;
    }

    EmptyClipboard();

    // Allocate global memory for the text (including null terminator)
    size_t bytes = (text.size() + 1) * sizeof(wchar_t);
    HGLOBAL hMem = GlobalAlloc(GMEM_MOVEABLE, bytes);

    if (!hMem)
    {
        CloseClipboard();
        return false;
    }

    void *pMem = GlobalLock(hMem);

    if (!pMem)
    {
        GlobalFree(hMem);
        CloseClipboard();
        return false;
    }

    memcpy(pMem, text.c_str(), bytes);
    GlobalUnlock(hMem);

    // CF_UNICODETEXT takes ownership of hMem
    SetClipboardData(CF_UNICODETEXT, hMem);
    CloseClipboard();

    return true;
}

/**
 * Send a Ctrl+V keystroke to paste clipboard content.
 */
static void sendPaste()
{
    INPUT inputs[4] = {};

    // Ctrl down
    inputs[0].type = INPUT_KEYBOARD;
    inputs[0].ki.wVk = VK_CONTROL;

    // V down
    inputs[1].type = INPUT_KEYBOARD;
    inputs[1].ki.wVk = 0x56; // 'V'

    // V up
    inputs[2].type = INPUT_KEYBOARD;
    inputs[2].ki.wVk = 0x56;
    inputs[2].ki.dwFlags = KEYEVENTF_KEYUP;

    // Ctrl up
    inputs[3].type = INPUT_KEYBOARD;
    inputs[3].ki.wVk = VK_CONTROL;
    inputs[3].ki.dwFlags = KEYEVENTF_KEYUP;

    SendInput(4, inputs, sizeof(INPUT));
}

// Fixed delay for the cancel→begin pipeline sleep that stays non-configurable.
// The open→paste, paste→enter, and enter→close waits are caller-supplied
// (issues #581, #589).
static constexpr DWORD kChatStepDelayMs = 100;

// Fixed hold for the Enter keypress (issues #581, #589). A zero-duration down+up
// can be dropped by iRacing under load; 100ms gives the key event ample time to
// register so the message reliably submits before the chat box is closed.
// Intentionally not user-configurable.
static constexpr DWORD kChatEnterHoldMs = 100;

/**
 * Async worker that runs the full chat-send pipeline on a libuv worker
 * thread and resolves a Promise with the resulting success boolean.
 *
 * The actual steps are identical to the previous synchronous version —
 * save clipboard, paste message, Enter, restore clipboard — but running
 * off the main thread means the JS event loop stays free during the
 * ~400ms native pipeline. setTimeout callbacks and Stream Deck events
 * continue to flow while a chat message is being typed.
 *
 * The open→paste, paste→enter, and enter→close waits are caller-supplied
 * (issues #581, #589) so users on slower machines can dial in reliable sends;
 * the cancel→begin wait stays on kChatStepDelayMs. Enter is held
 * kChatEnterHoldMs.
 *
 * Serialized via g_chatSendMutex so concurrent sends queue up instead of
 * clobbering each other: iRacing only has one chat window, and two
 * overlapping sends would fight over the clipboard.
 */
class ChatSendWorker : public Napi::AsyncWorker
{
public:
    ChatSendWorker(Napi::Env env, std::u16string message, DWORD openToPasteDelayMs, DWORD pasteToEnterDelayMs,
                   DWORD enterToCloseDelayMs)
        : Napi::AsyncWorker(env),
          message_(std::move(message)),
          openToPasteDelayMs_(openToPasteDelayMs),
          pasteToEnterDelayMs_(pasteToEnterDelayMs),
          enterToCloseDelayMs_(enterToCloseDelayMs),
          deferred_(Napi::Promise::Deferred::New(env)),
          result_(false)
    {
    }

    Napi::Promise GetPromise() { return deferred_.Promise(); }

    void Execute() override
    {
        if (message_.empty())
        {
            result_ = false;
            return;
        }

        std::lock_guard<std::mutex> lock(g_chatSendMutex);

        // Sending a chat message uses the clipboard as a fast "type" channel
        // (copy → BeginChat → paste → Enter). We intentionally do NOT save
        // and restore the user's prior clipboard content. Every extra
        // clipboard write wakes clipboard-manager apps via WM_CLIPBOARDUPDATE
        // and risks one of them stealing focus in the narrow window between
        // our copy and the subsequent paste/Enter, which can leave the chat
        // window half-open or drop the send. Fewer writes = fewer chances
        // for that contention. This behavior is documented on the website
        // under Troubleshooting → Known issues.
        if (!copyToClipboard(message_))
        {
            result_ = false;
            return;
        }

        irsdk_broadcastMsg(irsdk_BroadcastChatComand, irsdk_ChatCommand_Cancel, 0);
        Sleep(kChatStepDelayMs);

        irsdk_broadcastMsg(irsdk_BroadcastChatComand, irsdk_ChatCommand_BeginChat, 0);
        Sleep(openToPasteDelayMs_);

        sendPaste();
        Sleep(pasteToEnterDelayMs_);

        // Hold Enter for kChatEnterHoldMs rather than sending a zero-duration
        // down+up batch — the instantaneous press can be dropped by iRacing
        // under load, leaving the message typed but unsent (issue #581).
        INPUT enterDown = {};
        enterDown.type = INPUT_KEYBOARD;
        enterDown.ki.wVk = VK_RETURN;
        SendInput(1, &enterDown, sizeof(INPUT));

        Sleep(kChatEnterHoldMs);

        INPUT enterUp = {};
        enterUp.type = INPUT_KEYBOARD;
        enterUp.ki.wVk = VK_RETURN;
        enterUp.ki.dwFlags = KEYEVENTF_KEYUP;
        SendInput(1, &enterUp, sizeof(INPUT));

        // Wait before closing the chat box so iRacing finishes processing the
        // Enter; otherwise the Cancel below lands too early, gets dropped, and
        // the chat window keeps focus (issue #589). Caller-supplied.
        Sleep(enterToCloseDelayMs_);

        irsdk_broadcastMsg(irsdk_BroadcastChatComand, irsdk_ChatCommand_Cancel, 0);

        result_ = true;
    }

    void OnOK() override
    {
        Napi::HandleScope scope(Env());
        deferred_.Resolve(Napi::Boolean::New(Env(), result_));
    }

    void OnError(const Napi::Error &e) override
    {
        Napi::HandleScope scope(Env());
        deferred_.Reject(e.Value());
    }

private:
    std::u16string message_;
    DWORD openToPasteDelayMs_;
    DWORD pasteToEnterDelayMs_;
    DWORD enterToCloseDelayMs_;
    Napi::Promise::Deferred deferred_;
    bool result_;
};

// Fallback delay (ms) used when the caller omits a timing argument. Matches the
// chatOpenToPasteDelayMs / chatPasteToEnterDelayMs / chatEnterToCloseDelayMs
// global-settings default.
static constexpr DWORD kChatDefaultDelayMs = 200;

// Safety ceiling (ms) for a caller-supplied chat delay. The Property Inspector
// caps the settings at 2000 ms; this generous upper bound exists only so a
// bad/out-of-range native caller can't turn Sleep() into a multi-day stall
// while ChatSendWorker holds g_chatSendMutex (which would block every other
// chat send).
static constexpr DWORD kMaxChatDelayMs = 10000;

/**
 * Read an optional chat-delay argument and clamp it into [0, kMaxChatDelayMs].
 *
 * Falls back to kChatDefaultDelayMs when the argument is absent, non-numeric,
 * or NaN. We read the value as a double rather than via Uint32Value() because
 * Uint32Value() applies ECMAScript ToUint32, which would wrap a negative input
 * (e.g. -1) into a huge DWORD (~4.29e9 ms ≈ 49 days) — exactly the runaway
 * Sleep() this guards against.
 */
static DWORD readChatDelayArg(const Napi::CallbackInfo &info, size_t index)
{
    if (index >= info.Length() || !info[index].IsNumber())
    {
        return kChatDefaultDelayMs;
    }

    double value = info[index].As<Napi::Number>().DoubleValue();

    // NaN is the only value not equal to itself; avoids needing <cmath>.
    if (value != value)
    {
        return kChatDefaultDelayMs;
    }
    if (value < 0.0)
    {
        return 0;
    }
    if (value > static_cast<double>(kMaxChatDelayMs))
    {
        return kMaxChatDelayMs;
    }

    return static_cast<DWORD>(value);
}

/**
 * Send a complete chat message to iRacing using clipboard paste.
 * Returns a Promise that resolves to true on success, false on failure.
 *
 * The full pipeline runs on a libuv worker thread (see ChatSendWorker),
 * so the JS event loop remains responsive during the ~400ms native work.
 *
 * The open→paste, paste→enter, and enter→close waits are caller-supplied
 * (issues #581, #589), each defaulting to kChatDefaultDelayMs when omitted. The
 * cancel→begin wait stays on kChatStepDelayMs; Enter is held kChatEnterHoldMs.
 *
 * @param message - The message to send
 * @param openToPasteDelayMs - (optional) ms to wait after opening chat before pasting
 * @param pasteToEnterDelayMs - (optional) ms to wait after pasting before pressing Enter
 * @param enterToCloseDelayMs - (optional) ms to wait after pressing Enter before closing the chat box
 * @returns Promise<boolean>
 */
Napi::Value SendChatMessage(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString())
    {
        Napi::TypeError::New(env, "Expected (message: string, openToPasteDelayMs?: number, pasteToEnterDelayMs?: number, enterToCloseDelayMs?: number)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::u16string message = info[0].As<Napi::String>().Utf16Value();

    DWORD openToPasteDelayMs = readChatDelayArg(info, 1);
    DWORD pasteToEnterDelayMs = readChatDelayArg(info, 2);
    DWORD enterToCloseDelayMs = readChatDelayArg(info, 3);

    ChatSendWorker *worker = new ChatSendWorker(env, std::move(message), openToPasteDelayMs, pasteToEnterDelayMs, enterToCloseDelayMs);
    Napi::Promise promise = worker->GetPromise();
    worker->Queue();

    return promise;
}

// ============================================================================
// Window Management Functions
// ============================================================================

/**
 * Focus result codes returned by focusIRacingWindow().
 *
 * 0 = AlreadyFocused — window was already in the foreground
 * 1 = Focused        — window was found and successfully focused
 * 2 = WindowNotFound — no window with the expected title exists
 * 3 = FocusTimedOut  — window was found but SetForegroundWindow
 *                       did not take effect within 1000ms
 */
static const int FOCUS_ALREADY_FOCUSED = 0;
static const int FOCUS_FOCUSED = 1;
static const int FOCUS_WINDOW_NOT_FOUND = 2;
static const int FOCUS_TIMED_OUT = 3;

/**
 * Attempt to bring the iRacing simulator window to the foreground.
 * Uses AttachThreadInput pattern for reliable focusing across
 * Windows foreground window restrictions.
 *
 * @returns int status code (see FOCUS_* constants above)
 */
static int focusIRacingWindow()
{
    HWND hwnd = FindWindowA(NULL, "iRacing.com Simulator");
    if (!hwnd)
    {
        return FOCUS_WINDOW_NOT_FOUND;
    }

    // Already focused — nothing to do
    if (GetForegroundWindow() == hwnd)
    {
        return FOCUS_ALREADY_FOCUSED;
    }

    HWND fg = GetForegroundWindow();
    DWORD foregroundThreadId = fg ? GetWindowThreadProcessId(fg, NULL) : 0;
    DWORD currentThreadId = GetCurrentThreadId();

    if (foregroundThreadId != 0 && foregroundThreadId != currentThreadId)
    {
        AttachThreadInput(currentThreadId, foregroundThreadId, TRUE);
    }

    // Simulate an ALT key press/release to satisfy Windows' foreground lock.
    // Windows blocks SetForegroundWindow from background processes unless
    // the caller received the last input event. This workaround is a
    // well-known technique to bypass the restriction.
    keybd_event(VK_MENU, 0, 0, 0);
    keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);

    SetForegroundWindow(hwnd);

    if (foregroundThreadId != 0 && foregroundThreadId != currentThreadId)
    {
        AttachThreadInput(currentThreadId, foregroundThreadId, FALSE);
    }

    // Wait until Windows has actually moved focus to iRacing.
    // SetForegroundWindow returns immediately but focus changes
    // asynchronously. Without this, subsequent actions (e.g., chat
    // commands) may fire before the target window has focus.
    for (int i = 0; i < 100; i++)
    {
        if (GetForegroundWindow() == hwnd)
        {
            return FOCUS_FOCUSED;
        }
        Sleep(10);
    }

    // Timed out (1000ms) — focus may not have switched
    return FOCUS_TIMED_OUT;
}

/**
 * N-API wrapper: Focus the iRacing simulator window.
 * @returns number - status code (0=already focused, 1=focused, 2=not found, 3=timed out)
 */
Napi::Value FocusIRacingWindow(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    return Napi::Number::New(env, focusIRacingWindow());
}

// ============================================================================
// Keyboard Input Functions
// ============================================================================

/**
 * Build a single scan code INPUT record.
 * Uses KEYEVENTF_SCANCODE for layout-independent physical key sending.
 *
 * @param scanCode - PS/2 scan code. Bit 0x100 signals an extended key (KEYEVENTF_EXTENDEDKEY).
 * @param isDown - true for key press, false for key release
 */
static INPUT makeScanKeyInput(UINT scanCode, bool isDown)
{
    INPUT ip = {};
    ip.type = INPUT_KEYBOARD;
    ip.ki.dwFlags = KEYEVENTF_SCANCODE;

    if (!isDown)
    {
        ip.ki.dwFlags |= KEYEVENTF_KEYUP;
    }

    WORD sc = static_cast<WORD>(scanCode & 0xFF);

    if (scanCode & 0x100)
    {
        ip.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
    }

    ip.ki.wScan = sc;
    // Derive VK from scan code for compatibility with apps that read wVk.
    // Use MAPVK_VSC_TO_VK_EX to distinguish extended keys (e.g. PageUp vs Numpad9).
    UINT mapType = (scanCode & 0x100) ? MAPVK_VSC_TO_VK_EX : MAPVK_VSC_TO_VK;
    ip.ki.wVk = static_cast<WORD>(MapVirtualKeyW(sc, mapType));

    return ip;
}

/**
 * Send a single scan code key event via SendInput.
 *
 * @param scanCode - PS/2 scan code. Bit 0x100 signals an extended key (KEYEVENTF_EXTENDEDKEY).
 * @param isDown - true for key press, false for key release
 */
static void sendScanKey(UINT scanCode, bool isDown)
{
    INPUT ip = makeScanKeyInput(scanCode, isDown);
    SendInput(1, &ip, sizeof(INPUT));
}

/**
 * Send a key combination using scan codes.
 * Presses each scan code in order (modifiers first, then main key),
 * then releases all in reverse order.
 *
 * This bypasses VK code resolution entirely, making it layout-independent.
 * The caller maps KeyboardEvent.code values to PS/2 scan codes.
 *
 * @param scanCodes - Array of PS/2 scan codes (bit 0x100 = extended key)
 */
Napi::Value SendScanKeys(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsArray())
    {
        Napi::TypeError::New(env, "Expected (scanCodes: number[])").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Array scanCodes = info[0].As<Napi::Array>();
    uint32_t len = scanCodes.Length();

    if (len == 0)
    {
        return env.Undefined();
    }

    // Key down for each scan code in order
    for (uint32_t i = 0; i < len; i++)
    {
        UINT sc = scanCodes.Get(i).As<Napi::Number>().Uint32Value();
        sendScanKey(sc, true);
    }

    // Hold keys long enough for the target application's input loop to register them
    Sleep(100);

    // Key up in reverse order
    for (int32_t i = static_cast<int32_t>(len) - 1; i >= 0; i--)
    {
        UINT sc = scanCodes.Get(static_cast<uint32_t>(i)).As<Napi::Number>().Uint32Value();
        sendScanKey(sc, false);
    }

    return env.Undefined();
}

/**
 * Press scan codes without releasing (for key hold/long-press).
 * Presses each scan code in order (modifiers first, then main key).
 * No Sleep(), no key up — caller is responsible for releasing via SendScanKeyUp.
 *
 * @param scanCodes - Array of PS/2 scan codes (bit 0x100 = extended key)
 */
Napi::Value SendScanKeyDown(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsArray())
    {
        Napi::TypeError::New(env, "Expected (scanCodes: number[])").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Array scanCodes = info[0].As<Napi::Array>();
    uint32_t len = scanCodes.Length();

    if (len == 0)
    {
        return env.Undefined();
    }

    // Key down for each scan code in order
    for (uint32_t i = 0; i < len; i++)
    {
        UINT sc = scanCodes.Get(i).As<Napi::Number>().Uint32Value();
        sendScanKey(sc, true);
    }

    return env.Undefined();
}

/**
 * Release scan codes without pressing (for key hold/long-press).
 * Releases each scan code in reverse order (main key first, then modifiers).
 * No Sleep(), no key down — caller is responsible for pressing via SendScanKeyDown.
 *
 * @param scanCodes - Array of PS/2 scan codes (bit 0x100 = extended key)
 */
Napi::Value SendScanKeyUp(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsArray())
    {
        Napi::TypeError::New(env, "Expected (scanCodes: number[])").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Array scanCodes = info[0].As<Napi::Array>();
    uint32_t len = scanCodes.Length();

    if (len == 0)
    {
        return env.Undefined();
    }

    // Key up in reverse order
    for (int32_t i = static_cast<int32_t>(len) - 1; i >= 0; i--)
    {
        UINT sc = scanCodes.Get(static_cast<uint32_t>(i)).As<Napi::Number>().Uint32Value();
        sendScanKey(sc, false);
    }

    return env.Undefined();
}

/**
 * Upper bound for the per-chord hold in SendScanKeySequence.
 *
 * The held path Sleep()s on the calling (JS main) thread, once per chord, so the
 * bound is what caps the worst-case stall. 50 ms exists because the ONLY reason
 * to hold a key here is to survive a target that samples keyboard state per frame:
 * one frame is ~16 ms at 60 Hz, so a couple of frames is the whole useful range.
 * A two-chord sequence therefore blocks at most ~100 ms — the same stall
 * SendScanKeys already imposes on every ordinary tap, so this adds no new class
 * of freeze. Nothing legitimately needs a second-long hold.
 *
 * Also a defensive clamp, like the chat pipeline's: a negative or absurd JS value
 * must never turn Sleep() into a multi-second stall.
 */
static const double kMaxSequenceHoldMs = 50.0;

/**
 * Send a SEQUENCE of distinct key chords in one native call (issue #818).
 *
 * Each chord is a scan code array in the usual convention (modifiers first,
 * main key last). Chords fire in order.
 *
 * holdMs == 0 (the default): every down/up event of every chord is emitted in a
 * SINGLE SendInput batch, with no Sleep. The events reach the target's input
 * queue atomically, so a two-chord sequence ("show Lap Timing, then show Fuel")
 * is consumed within one frame and the intermediate box never renders.
 *
 * holdMs > 0: falls back to per-chord press -> Sleep(holdMs) -> release, the
 * same shape as SendScanKeys, for a target that samples keyboard state per
 * frame and would miss a zero-duration press.
 *
 * @param chords - Array of scan code arrays (bit 0x100 = extended key)
 * @param holdMs - Optional per-chord hold in ms; clamped to [0, kMaxSequenceHoldMs]
 */
Napi::Value SendScanKeySequence(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsArray())
    {
        Napi::TypeError::New(env, "Expected (chords: number[][], holdMs?: number)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    Napi::Array chords = info[0].As<Napi::Array>();
    uint32_t chordCount = chords.Length();

    if (chordCount == 0)
    {
        return env.Undefined();
    }

    // Read as a double, then clamp. Reading via Uint32Value() would let
    // ECMAScript ToUint32 wrap a negative value into a huge DWORD.
    double rawHold = 0.0;

    if (info.Length() >= 2 && info[1].IsNumber())
    {
        rawHold = info[1].As<Napi::Number>().DoubleValue();
    }

    if (!(rawHold > 0.0))
    {
        rawHold = 0.0;
    }
    else if (rawHold > kMaxSequenceHoldMs)
    {
        rawHold = kMaxSequenceHoldMs;
    }

    DWORD holdMs = static_cast<DWORD>(rawHold);

    // Atomic path: one SendInput for the whole sequence, no Sleep.
    if (holdMs == 0)
    {
        std::vector<INPUT> inputs;

        for (uint32_t c = 0; c < chordCount; c++)
        {
            Napi::Value entry = chords.Get(c);

            if (!entry.IsArray())
            {
                continue;
            }

            Napi::Array scanCodes = entry.As<Napi::Array>();
            uint32_t len = scanCodes.Length();

            for (uint32_t i = 0; i < len; i++)
            {
                UINT sc = scanCodes.Get(i).As<Napi::Number>().Uint32Value();
                inputs.push_back(makeScanKeyInput(sc, true));
            }

            for (int32_t i = static_cast<int32_t>(len) - 1; i >= 0; i--)
            {
                UINT sc = scanCodes.Get(static_cast<uint32_t>(i)).As<Napi::Number>().Uint32Value();
                inputs.push_back(makeScanKeyInput(sc, false));
            }
        }

        if (!inputs.empty())
        {
            SendInput(static_cast<UINT>(inputs.size()), inputs.data(), sizeof(INPUT));
        }

        return env.Undefined();
    }

    // Held path: press, hold, release — one chord at a time.
    for (uint32_t c = 0; c < chordCount; c++)
    {
        Napi::Value entry = chords.Get(c);

        if (!entry.IsArray())
        {
            continue;
        }

        Napi::Array scanCodes = entry.As<Napi::Array>();
        uint32_t len = scanCodes.Length();

        if (len == 0)
        {
            continue;
        }

        for (uint32_t i = 0; i < len; i++)
        {
            sendScanKey(scanCodes.Get(i).As<Napi::Number>().Uint32Value(), true);
        }

        Sleep(holdMs);

        for (int32_t i = static_cast<int32_t>(len) - 1; i >= 0; i--)
        {
            sendScanKey(scanCodes.Get(static_cast<uint32_t>(i)).As<Napi::Number>().Uint32Value(), false);
        }
    }

    return env.Undefined();
}

// ============================================================================
// Clipboard
// ============================================================================

/**
 * Write text to the Windows clipboard as CF_UNICODETEXT.
 * Returns true on success.
 *
 * The implementation reuses the static `copyToClipboard()` helper used by the
 * chat-send pipeline. Unlike `sendChatMessage`, this exposes the bare clipboard
 * write so callers can compose paste flows themselves (e.g. race-admin's
 * "Type in Chat" mode pastes a command prefix and lets the user finish typing).
 */
Napi::Value SetClipboardText(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString())
    {
        Napi::TypeError::New(env, "Expected (text: string)").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    std::u16string text = info[0].As<Napi::String>().Utf16Value();
    bool ok = copyToClipboard(text);

    return Napi::Boolean::New(env, ok);
}

// ============================================================================
// Elevation / Integrity Detection (issue #610)
// ============================================================================

struct ElevationStatus
{
    bool selfElevated = false;
    bool iracingFound = false;
    bool iracingQueryDenied = false;
    bool iracingElevated = false;
};

/**
 * Query whether a process token reports an elevated (Administrator) integrity.
 * Returns true on a successful query and writes the result to outElevated.
 */
static bool queryTokenElevation(HANDLE process, bool &outElevated)
{
    HANDLE token = NULL;
    if (!OpenProcessToken(process, TOKEN_QUERY, &token))
    {
        return false;
    }

    TOKEN_ELEVATION elevation = {};
    DWORD size = sizeof(elevation);
    BOOL ok = GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &size);
    if (ok)
    {
        outElevated = elevation.TokenIsElevated != 0;
    }

    CloseHandle(token);
    return ok != 0;
}

/**
 * Compare this process's integrity/elevation with iRacing's.
 *
 * A functional probe can't detect the UIPI block (blocked SendInput/broadcast
 * still report success), so we compare integrity levels. ACCESS_DENIED when
 * opening an iRacing process we can clearly see means it runs at a higher
 * integrity level than us.
 */
static ElevationStatus getElevationStatus()
{
    ElevationStatus status;

    // Own elevation — reliable token query against the current process.
    queryTokenElevation(GetCurrentProcess(), status.selfElevated);

    // Locate iRacing via its window, then resolve the owning PID.
    HWND hwnd = FindWindowA(NULL, "iRacing.com Simulator");
    if (!hwnd)
    {
        return status; // iracingFound stays false
    }
    status.iracingFound = true;

    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == 0)
    {
        return status;
    }

    HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!process)
    {
        // ACCESS_DENIED on a process we can see means higher integrity than us.
        if (GetLastError() == ERROR_ACCESS_DENIED)
        {
            status.iracingQueryDenied = true;
        }
        return status;
    }

    queryTokenElevation(process, status.iracingElevated);
    CloseHandle(process);
    return status;
}

/**
 * N-API wrapper: return the elevation/mismatch status object.
 *
 * @returns object { selfElevated, iracingFound, iracingQueryDenied,
 *                   iracingElevated, mismatch }
 */
Napi::Value GetElevationStatus(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    ElevationStatus status = getElevationStatus();

    bool mismatch = !status.selfElevated && status.iracingFound &&
                    (status.iracingQueryDenied || status.iracingElevated);

    Napi::Object result = Napi::Object::New(env);
    result.Set("selfElevated", Napi::Boolean::New(env, status.selfElevated));
    result.Set("iracingFound", Napi::Boolean::New(env, status.iracingFound));
    result.Set("iracingQueryDenied", Napi::Boolean::New(env, status.iracingQueryDenied));
    result.Set("iracingElevated", Napi::Boolean::New(env, status.iracingElevated));
    result.Set("mismatch", Napi::Boolean::New(env, mismatch));
    return result;
}

// ============================================================================
// Module Initialization
// ============================================================================

Napi::Object Init(Napi::Env env, Napi::Object exports)
{
    // SDK Connection
    exports.Set("startup", Napi::Function::New(env, Startup));
    exports.Set("shutdown", Napi::Function::New(env, Shutdown));
    exports.Set("isConnected", Napi::Function::New(env, IsConnected));

    // Data Access
    exports.Set("getHeader", Napi::Function::New(env, GetHeader));
    exports.Set("getData", Napi::Function::New(env, GetData));
    exports.Set("waitForData", Napi::Function::New(env, WaitForData));
    exports.Set("getSessionInfoStr", Napi::Function::New(env, GetSessionInfoStr));
    exports.Set("getVarHeaderEntry", Napi::Function::New(env, GetVarHeaderEntry));
    exports.Set("varNameToIndex", Napi::Function::New(env, VarNameToIndex));

    // Broadcast Messages
    exports.Set("broadcastMsg", Napi::Function::New(env, BroadcastMsg));

    // Chat
    exports.Set("sendChatMessage", Napi::Function::New(env, SendChatMessage));

    // Window Management
    exports.Set("focusIRacingWindow", Napi::Function::New(env, FocusIRacingWindow));

    // Keyboard Input
    exports.Set("sendScanKeys", Napi::Function::New(env, SendScanKeys));
    exports.Set("sendScanKeyDown", Napi::Function::New(env, SendScanKeyDown));
    exports.Set("sendScanKeyUp", Napi::Function::New(env, SendScanKeyUp));
    exports.Set("sendScanKeySequence", Napi::Function::New(env, SendScanKeySequence));

    // Clipboard
    exports.Set("setClipboardText", Napi::Function::New(env, SetClipboardText));

    // Elevation / integrity detection (issue #610)
    exports.Set("getElevationStatus", Napi::Function::New(env, GetElevationStatus));

    return exports;
}

NODE_API_MODULE(iracing_native, Init)
