/**
 * @iracedeck/iracing-native
 *
 * Native Node.js addon for iRacing SDK integration.
 * Uses the official iRacing SDK for memory-mapped file access and broadcast messaging.
 */

#include <napi.h>
#include <windows.h>
#include <string>
#include <irsdk_defines.h>

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

static constexpr DWORD kChatStepDelayMs = 100;

/**
 * Send a complete chat message to iRacing using clipboard paste.
 * This function handles the entire chat flow:
 * 1. Saves the current clipboard content (plain text only)
 * 2. Copies the message to the clipboard
 * 3. Cancels any existing chat to ensure clean state, then waits
 * 4. Opens chat window via broadcast message, then waits
 * 5. Pastes the message with Ctrl+V, then waits
 * 6. Presses Enter to send the message, then waits
 * 7. Cancels chat via broadcast to explicitly close the chat window
 *    (Enter sends the message but leaves the input focused)
 * 8. Restores the original clipboard content
 *
 * Each wait is kChatStepDelayMs to give iRacing time to process.
 *
 * @param message - The message to send
 * @returns Success boolean
 */
Napi::Value SendChatMessage(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString())
    {
        Napi::TypeError::New(env, "Expected (message: string)").ThrowAsJavaScriptException();
        return Napi::Boolean::New(env, false);
    }

    std::u16string message = info[0].As<Napi::String>().Utf16Value();

    if (message.empty())
    {
        return Napi::Boolean::New(env, false);
    }

    // 1. Save the current clipboard content (text only)
    std::u16string savedClipboard;
    bool hadClipboardText = false;

    if (OpenClipboard(NULL))
    {
        HANDLE hData = GetClipboardData(CF_UNICODETEXT);

        if (hData)
        {
            const wchar_t *pText = static_cast<const wchar_t *>(GlobalLock(hData));

            if (pText)
            {
                savedClipboard = reinterpret_cast<const char16_t *>(pText);
                hadClipboardText = true;
                GlobalUnlock(hData);
            }
        }

        CloseClipboard();
    }

    // 2. Copy the message to the clipboard
    if (!copyToClipboard(message))
    {
        return Napi::Boolean::New(env, false);
    }

    // 3. Cancel any existing chat to ensure clean state
    irsdk_broadcastMsg(irsdk_BroadcastChatComand, irsdk_ChatCommand_Cancel, 0);
    Sleep(kChatStepDelayMs);

    // 4. Open chat window via broadcast
    irsdk_broadcastMsg(irsdk_BroadcastChatComand, irsdk_ChatCommand_BeginChat, 0);

    // 5. Wait for chat window to open
    Sleep(kChatStepDelayMs);

    // 6. Paste the message with Ctrl+V
    sendPaste();

    // 7. Wait for paste to complete
    Sleep(kChatStepDelayMs);

    // 8. Press Enter to send
    INPUT enterInputs[2] = {};
    enterInputs[0].type = INPUT_KEYBOARD;
    enterInputs[0].ki.wVk = VK_RETURN;
    enterInputs[1].type = INPUT_KEYBOARD;
    enterInputs[1].ki.wVk = VK_RETURN;
    enterInputs[1].ki.dwFlags = KEYEVENTF_KEYUP;
    SendInput(2, enterInputs, sizeof(INPUT));

    // 9. Wait for Enter to be processed
    Sleep(kChatStepDelayMs);

    // 10. Cancel chat to close the window
    irsdk_broadcastMsg(irsdk_BroadcastChatComand, irsdk_ChatCommand_Cancel, 0);

    // 11. Restore the original clipboard content
    if (hadClipboardText)
    {
        copyToClipboard(savedClipboard);
    }

    return Napi::Boolean::New(env, true);
}

// ============================================================================
// Window Management Functions
// ============================================================================

/**
 * Attempt to bring the iRacing simulator window to the foreground.
 * Uses AttachThreadInput pattern for reliable focusing across
 * Windows foreground window restrictions.
 *
 * @returns true if iRacing window was found and focused (or already focused)
 */
static bool focusIRacingWindow()
{
    HWND hwnd = FindWindowA(NULL, "iRacing.com Simulator");
    if (!hwnd)
    {
        return false;
    }

    // Already focused — nothing to do
    if (GetForegroundWindow() == hwnd)
    {
        return true;
    }

    HWND fg = GetForegroundWindow();
    DWORD foregroundThreadId = fg ? GetWindowThreadProcessId(fg, NULL) : 0;
    DWORD currentThreadId = GetCurrentThreadId();

    if (foregroundThreadId != 0 && foregroundThreadId != currentThreadId)
    {
        AttachThreadInput(currentThreadId, foregroundThreadId, TRUE);
    }

    SetForegroundWindow(hwnd);

    if (foregroundThreadId != 0 && foregroundThreadId != currentThreadId)
    {
        AttachThreadInput(currentThreadId, foregroundThreadId, FALSE);
    }

    // Wait until Windows has actually moved focus to iRacing.
    // SetForegroundWindow returns immediately but focus changes
    // asynchronously. Without this, subsequent actions (e.g., chat
    // commands) may fire before the target window has focus.
    for (int i = 0; i < 50; i++)
    {
        if (GetForegroundWindow() == hwnd)
        {
            return true;
        }
        Sleep(10);
    }

    // Timed out (500ms) — focus may not have switched
    return false;
}

/**
 * N-API wrapper: Focus the iRacing simulator window.
 * @returns boolean - true if window was found and focused (or already focused)
 */
Napi::Value FocusIRacingWindow(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    return Napi::Boolean::New(env, focusIRacingWindow());
}

// ============================================================================
// Keyboard Input Functions
// ============================================================================

/**
 * Send a single scan code key event via SendInput.
 * Uses KEYEVENTF_SCANCODE for layout-independent physical key sending.
 *
 * @param scanCode - PS/2 scan code. Bit 0x100 signals an extended key (KEYEVENTF_EXTENDEDKEY).
 * @param isDown - true for key press, false for key release
 */
static void sendScanKey(UINT scanCode, bool isDown)
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

    return exports;
}

NODE_API_MODULE(iracing_native, Init)
