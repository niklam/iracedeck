/**
 * iRacing Broadcast API Constants
 * These constants are used to send commands to iRacing via the broadcast message API
 *
 * Remote control the sim by sending these windows messages
 * - Camera and replay commands only work when you are out of your car
 * - Pit commands only work when in your car
 */

/**
 * Broadcast message types (wParam values)
 */
export enum BroadcastMsg {
	CamSwitchPos = 0,              // car position, group, camera
	CamSwitchNum = 1,              // driver #, group, camera
	CamSetState = 2,               // irsdk_CameraState, unused, unused
	ReplaySetPlaySpeed = 3,        // speed, slowMotion, unused
	ReplaySetPlayPosition = 4,     // irsdk_RpyPosMode, Frame Number (high, low)
	ReplaySearch = 5,              // irsdk_RpySrchMode, unused, unused
	ReplaySetState = 6,            // irsdk_RpyStateMode, unused, unused
	ReloadTextures = 7,            // irsdk_ReloadTexturesMode, carIdx, unused
	ChatCommand = 8,               // irsdk_ChatCommandMode, subCommand, unused
	PitCommand = 9,                // irsdk_PitCommandMode, parameter
	TelemCommand = 10,             // irsdk_TelemCommandMode, unused, unused
	FFBCommand = 11,               // irsdk_FFBCommandMode, value (float, high, low)
	ReplaySearchSessionTime = 12,  // sessionNum, sessionTimeMS (high, low)
	VideoCapture = 13,             // irsdk_VideoCaptureMode, unused, unused
	Last = 14                      // unused placeholder
}

/**
 * Chat command modes (for BroadcastMsg.ChatCommand)
 */
export enum ChatCommandMode {
	Macro = 0,      // Pass in a number from 1-15 representing the chat macro to launch
	BeginChat = 1,  // Open up a new chat window
	Reply = 2,      // Reply to last private chat
	Cancel = 3      // Close chat window
}

/**
 * Pit command modes (for BroadcastMsg.PitCommand)
 * This only works when the driver is in the car
 */
export enum PitCommandMode {
	Clear = 0,        // Clear all pit checkboxes
	WS = 1,           // Clean the winshield, using one tear off
	Fuel = 2,         // Add fuel, optionally specify the amount to add in liters or pass '0' to use existing amount
	LF = 3,           // Change the left front tire, optionally specifying the pressure in KPa or pass '0' to use existing pressure
	RF = 4,           // Right front tire
	LR = 5,           // Left rear tire
	RR = 6,           // Right rear tire
	ClearTires = 7,   // Clear tire pit checkboxes
	FR = 8,           // Request a fast repair
	ClearWS = 9,      // Uncheck Clean the winshield checkbox
	ClearFR = 10,     // Uncheck request a fast repair
	ClearFuel = 11,   // Uncheck add fuel
	TC = 12           // Change tire compound
}

/**
 * Telemetry command modes (for BroadcastMsg.TelemCommand)
 * You can call this any time, but telemetry only records when driver is in their car
 */
export enum TelemCommandMode {
	Stop = 0,    // Turn telemetry recording off
	Start = 1,   // Turn telemetry recording on
	Restart = 2  // Write current file to disk and start a new one
}

/**
 * Replay state modes (for BroadcastMsg.ReplaySetState)
 */
export enum ReplayStateMode {
	EraseTape = 0,  // Clear any data in the replay tape
	Last = 1        // Unused placeholder
}

/**
 * Reload textures modes (for BroadcastMsg.ReloadTextures)
 */
export enum ReloadTexturesMode {
	All = 0,     // Reload all textures
	CarIdx = 1   // Reload only textures for the specific carIdx
}

/**
 * Replay search modes (for BroadcastMsg.ReplaySearch)
 * Search replay tape for events
 */
export enum ReplaySearchMode {
	ToStart = 0,
	ToEnd = 1,
	PrevSession = 2,
	NextSession = 3,
	PrevLap = 4,
	NextLap = 5,
	PrevFrame = 6,
	NextFrame = 7,
	PrevIncident = 8,
	NextIncident = 9,
	Last = 10           // Unused placeholder
}

/**
 * Replay position modes (for BroadcastMsg.ReplaySetPlayPosition)
 */
export enum ReplayPosMode {
	Begin = 0,
	Current = 1,
	End = 2,
	Last = 3            // Unused placeholder
}

/**
 * Force feedback command modes (for BroadcastMsg.FFBCommand)
 * You can call this any time
 */
export enum FFBCommandMode {
	MaxForce = 0,  // Set the maximum force when mapping steering torque force to direct input units (float in Nm)
	Last = 1       // Unused placeholder
}

/**
 * Camera focus modes
 * For BroadcastMsg.CamSwitchPos or BroadcastMsg.CamSwitchNum
 * Pass these in for the first parameter to select the 'focus at' types in the camera system
 */
export enum CameraFocusMode {
	FocusAtIncident = -3,
	FocusAtLeader = -2,
	FocusAtExiting = -1,
	// FocusAtDriver + car number...
	FocusAtDriver = 0
}

/**
 * Video capture modes (for BroadcastMsg.VideoCapture)
 */
export enum VideoCaptureMode {
	TriggerScreenShot = 0,      // Save a screenshot to disk
	StartVideoCapture = 1,      // Start capturing video
	EndVideoCapture = 2,        // Stop capturing video
	ToggleVideoCapture = 3,     // Toggle video capture on/off
	ShowVideoTimer = 4,         // Show video timer in upper left corner of display
	HideVideoTimer = 5          // Hide video timer
}

/**
 * Windows API constants
 */
export const HWND_BROADCAST = 0xFFFF;

/**
 * iRacing SDK broadcast message name
 */
export const IRSDK_BROADCAST_MSG_NAME = 'IRSDK_BROADCASTMSG';

/**
 * Create a MAKELONG value from low and high 16-bit values
 */
export function MAKELONG(low: number, high: number): number {
	return ((high & 0xFFFF) << 16) | (low & 0xFFFF);
}
