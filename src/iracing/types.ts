/**
 * iRacing SDK type definitions
 * Based on irsdk_defines.h from the iRacing SDK
 */

// Re-export utility functions for easy access
export {
	hasFlag, hasAllFlags, hasAnyFlag, getActiveFlags, getActiveFlagNames,
	addFlag, addFlags, removeFlag, removeFlags, toggleFlag, setFlag
} from './utils';

export const IRSDK_MAX_BUFS = 4;
export const IRSDK_MAX_STRING = 32;
export const IRSDK_MAX_DESC = 64;

/**
 * Variable types in the telemetry data
 */
export enum VarType {
	Char = 0,
	Bool = 1,
	Int = 2,
	BitField = 3,
	Float = 4,
	Double = 5
}

/**
 * Status flags from the header
 */
export enum StatusField {
	Connected = 1
}

/**
 * Variable header entry - describes a single telemetry variable
 */
export interface VarHeader {
	type: VarType;
	offset: number;
	count: number;
	countAsTime: boolean;
	name: string;
	desc: string;
	unit: string;
}

/**
 * Variable buffer - contains raw telemetry data
 */
export interface VarBuf {
	tickCount: number;
	bufOffset: number;
	padData: number[];
}

/**
 * Main iRacing SDK header structure
 */
export interface IRSDKHeader {
	ver: number;
	status: number;
	tickRate: number;
	sessionInfoUpdate: number;
	sessionInfoLen: number;
	sessionInfoOffset: number;
	numVars: number;
	varHeaderOffset: number;
	numBuf: number;
	bufLen: number;
	padData: number[];
	varBuf: VarBuf[];
}

/**
 * Parsed telemetry data
 * Variables are dynamically available based on car/session type.
 * All properties are optional as not all variables are present in all sessions.
 *
 * Variable list extracted from iRacing telemetry.
 * Array types (count=64) are indexed by car index (CarIdx).
 */
export interface TelemetryData {
	// Allow additional dynamic properties
	[key: string]: number | boolean | string | number[] | boolean[] | undefined;

	// ========== Environment ==========
	/** Air density at start/finish line (kg/m³) */
	AirDensity?: number;
	/** Air pressure at start/finish line (Pa) */
	AirPressure?: number;
	/** Air temperature at start/finish line (°C) */
	AirTemp?: number;
	/** Fog level at start/finish line (%) */
	FogLevel?: number;
	/** Relative humidity at start/finish line (%) */
	RelativeHumidity?: number;
	/** Sky conditions (Skies enum) */
	Skies?: number;
	/** Sun angle above horizon (rad) */
	SolarAltitude?: number;
	/** Sun angle clockwise from north (rad) */
	SolarAzimuth?: number;
	/** Track temperature measured by crew (°C) */
	TrackTempCrew?: number;
	/** Average track wetness level */
	TrackWetness?: number;
	/** Wind direction at start/finish line (rad) */
	WindDir?: number;
	/** Wind velocity at start/finish line (m/s) */
	WindVel?: number;
	/** Precipitation at start/finish line (%) */
	Precipitation?: number;
	/** Steward rain tire approval flag */
	WeatherDeclaredWet?: boolean;

	// ========== Driver Inputs ==========
	/** 0=brake released to 1=max pedal force */
	Brake?: number;
	/** Raw brake input (%) */
	BrakeRaw?: number;
	/** ABS currently reducing brake force */
	BrakeABSactive?: boolean;
	/** 0=disengaged to 1=fully engaged */
	Clutch?: number;
	/** Raw clutch input (%) */
	ClutchRaw?: number;
	/** 0=off throttle to 1=full throttle */
	Throttle?: number;
	/** Raw throttle input (%) */
	ThrottleRaw?: number;
	/** Steering wheel angle (rad) */
	SteeringWheelAngle?: number;
	/** Steering wheel maximum angle (rad) */
	SteeringWheelAngleMax?: number;
	/** Raw handbrake input (%) */
	HandbrakeRaw?: number;

	// ========== Vehicle State ==========
	/** Current gear: -1=reverse, 0=neutral, 1+=forward gears */
	Gear?: number;
	/** Engine RPM */
	RPM?: number;
	/** GPS vehicle speed (m/s) */
	Speed?: number;
	/** Fuel remaining (L) */
	FuelLevel?: number;
	/** Fuel remaining (%) */
	FuelLevelPct?: number;
	/** Instantaneous fuel consumption (kg/h) */
	FuelUsePerHour?: number;
	/** Engine fuel pressure (bar) */
	FuelPress?: number;
	/** Engine oil level (L) */
	OilLevel?: number;
	/** Engine oil pressure (bar) */
	OilPress?: number;
	/** Engine oil temperature (°C) */
	OilTemp?: number;
	/** Engine coolant level (L) */
	WaterLevel?: number;
	/** Engine coolant temperature (°C) */
	WaterTemp?: number;
	/** Engine voltage (V) */
	Voltage?: number;
	/** Engine manifold pressure (bar) */
	ManifoldPress?: number;
	/** Warning lights bitfield (EngineWarnings) */
	EngineWarnings?: number;

	// ========== Physics ==========
	/** Lateral acceleration (m/s²) */
	LatAccel?: number;
	/** Longitudinal acceleration (m/s²) */
	LongAccel?: number;
	/** Vertical acceleration (m/s²) */
	VertAccel?: number;
	/** X-axis velocity (m/s) */
	VelocityX?: number;
	/** Y-axis velocity (m/s) */
	VelocityY?: number;
	/** Z-axis velocity (m/s) */
	VelocityZ?: number;
	/** Pitch orientation (rad) */
	Pitch?: number;
	/** Pitch rate (rad/s) */
	PitchRate?: number;
	/** Roll orientation (rad) */
	Roll?: number;
	/** Roll rate (rad/s) */
	RollRate?: number;
	/** Yaw orientation (rad) */
	Yaw?: number;
	/** Yaw orientation relative to north (rad) */
	YawNorth?: number;
	/** Yaw rate (rad/s) */
	YawRate?: number;

	// ========== Tire Data - Left Front ==========
	/** LF tire cold pressure from garage (kPa) */
	LFcoldPressure?: number;
	/** LF tire left carcass temperature (°C) */
	LFtempCL?: number;
	/** LF tire middle carcass temperature (°C) */
	LFtempCM?: number;
	/** LF tire right carcass temperature (°C) */
	LFtempCR?: number;
	/** LF tire left tread remaining (%) */
	LFwearL?: number;
	/** LF tire middle tread remaining (%) */
	LFwearM?: number;
	/** LF tire right tread remaining (%) */
	LFwearR?: number;
	/** LF shock deflection (m) */
	LFshockDefl?: number;
	/** LF shock velocity (m/s) */
	LFshockVel?: number;
	/** LF brake line pressure (bar) */
	LFbrakeLinePress?: number;

	// ========== Tire Data - Right Front ==========
	/** RF tire cold pressure from garage (kPa) */
	RFcoldPressure?: number;
	/** RF tire left carcass temperature (°C) */
	RFtempCL?: number;
	/** RF tire middle carcass temperature (°C) */
	RFtempCM?: number;
	/** RF tire right carcass temperature (°C) */
	RFtempCR?: number;
	/** RF tire left tread remaining (%) */
	RFwearL?: number;
	/** RF tire middle tread remaining (%) */
	RFwearM?: number;
	/** RF tire right tread remaining (%) */
	RFwearR?: number;
	/** RF shock deflection (m) */
	RFshockDefl?: number;
	/** RF shock velocity (m/s) */
	RFshockVel?: number;
	/** RF brake line pressure (bar) */
	RFbrakeLinePress?: number;

	// ========== Tire Data - Left Rear ==========
	/** LR tire cold pressure from garage (kPa) */
	LRcoldPressure?: number;
	/** LR tire left carcass temperature (°C) */
	LRtempCL?: number;
	/** LR tire middle carcass temperature (°C) */
	LRtempCM?: number;
	/** LR tire right carcass temperature (°C) */
	LRtempCR?: number;
	/** LR tire left tread remaining (%) */
	LRwearL?: number;
	/** LR tire middle tread remaining (%) */
	LRwearM?: number;
	/** LR tire right tread remaining (%) */
	LRwearR?: number;
	/** LR shock deflection (m) */
	LRshockDefl?: number;
	/** LR shock velocity (m/s) */
	LRshockVel?: number;
	/** LR brake line pressure (bar) */
	LRbrakeLinePress?: number;

	// ========== Tire Data - Right Rear ==========
	/** RR tire cold pressure from garage (kPa) */
	RRcoldPressure?: number;
	/** RR tire left carcass temperature (°C) */
	RRtempCL?: number;
	/** RR tire middle carcass temperature (°C) */
	RRtempCM?: number;
	/** RR tire right carcass temperature (°C) */
	RRtempCR?: number;
	/** RR tire left tread remaining (%) */
	RRwearL?: number;
	/** RR tire middle tread remaining (%) */
	RRwearM?: number;
	/** RR tire right tread remaining (%) */
	RRwearR?: number;
	/** RR shock deflection (m) */
	RRshockDefl?: number;
	/** RR shock velocity (m/s) */
	RRshockVel?: number;
	/** RR brake line pressure (bar) */
	RRbrakeLinePress?: number;

	// ========== Lap & Timing ==========
	/** Laps started count */
	Lap?: number;
	/** Laps completed count */
	LapCompleted?: number;
	/** Player's best lap number */
	LapBestLap?: number;
	/** Player's best lap time (s) */
	LapBestLapTime?: number;
	/** Player's last lap time (s) */
	LapLastLapTime?: number;
	/** Estimate of current lap time (s) */
	LapCurrentLapTime?: number;
	/** Meters traveled from S/F this lap (m) */
	LapDist?: number;
	/** Lap distance percentage (%) */
	LapDistPct?: number;
	/** Delta time vs best lap (s) */
	LapDeltaToBestLap?: number;
	/** Delta time vs best lap validity flag */
	LapDeltaToBestLap_OK?: boolean;
	/** Delta time vs optimal lap (s) */
	LapDeltaToOptimalLap?: number;
	/** Delta time vs session best lap (s) */
	LapDeltaToSessionBestLap?: number;
	/** Laps completed in race */
	RaceLaps?: number;

	// ========== Session Info ==========
	/** Session number */
	SessionNum?: number;
	/** Session state (SessionState enum) */
	SessionState?: number;
	/** Session flags bitfield (Flags enum) */
	SessionFlags?: number;
	/** Seconds since session start (s) */
	SessionTime?: number;
	/** Seconds remaining in session (s) */
	SessionTimeRemain?: number;
	/** Total session duration (s) */
	SessionTimeTotal?: number;
	/** Time of day in seconds (s) */
	SessionTimeOfDay?: number;
	/** Laps remaining in session */
	SessionLapsRemainEx?: number;
	/** Total session laps */
	SessionLapsTotal?: number;
	/** Session ID */
	SessionUniqueID?: number;
	/** Current update tick number */
	SessionTick?: number;

	// ========== Player Car Info ==========
	/** Player car index */
	PlayerCarIdx?: number;
	/** Player position in race */
	PlayerCarPosition?: number;
	/** Player class position in race */
	PlayerCarClassPosition?: number;
	/** Player car class ID */
	PlayerCarClass?: number;
	/** Player car in pit stall flag */
	PlayerCarInPitStall?: boolean;
	/** Shift light first light RPM */
	PlayerCarSLFirstRPM?: number;
	/** Shift light shift RPM */
	PlayerCarSLShiftRPM?: number;
	/** Shift light last light RPM */
	PlayerCarSLLastRPM?: number;
	/** Shift light blink RPM */
	PlayerCarSLBlinkRPM?: number;
	/** Player's incident count */
	PlayerCarMyIncidentCount?: number;
	/** Team driver incident count */
	PlayerCarDriverIncidentCount?: number;
	/** Player team incident count */
	PlayerCarTeamIncidentCount?: number;
	/** Car tow duration (s) (>0 if being towed) */
	PlayerCarTowTime?: number;
	/** Player weight penalty (kg) */
	PlayerCarWeightPenalty?: number;
	/** Player power adjustment (%) */
	PlayerCarPowerAdjust?: number;
	/** Player track surface type (TrkLoc enum) */
	PlayerTrackSurface?: number;
	/** Player track surface material (TrkSurf enum) */
	PlayerTrackSurfaceMaterial?: number;
	/** Player current tire compound */
	PlayerTireCompound?: number;
	/** Player fast repairs used */
	PlayerFastRepairsUsed?: number;

	// ========== On Track Status ==========
	/** Car on track with player in vehicle */
	IsOnTrack?: boolean;
	/** Car on track physics running */
	IsOnTrackCar?: boolean;
	/** Car in garage with physics running */
	IsInGarage?: boolean;
	/** Player car on pit road flag */
	OnPitRoad?: boolean;
	/** Car position relative to driver (CarLeftRight enum) */
	CarLeftRight?: number;
	/** Pit stop allowed flag */
	PitsOpen?: boolean;
	/** Player receiving pit service flag */
	PitstopActive?: boolean;
	/** Pacing status (PaceMode enum) */
	PaceMode?: number;

	// ========== Pit Service ==========
	/** Pit service checkboxes bitfield (PitSvFlags enum) */
	PitSvFlags?: number;
	/** Pit service fuel add amount (L/kWh) */
	PitSvFuel?: number;
	/** Pit service left front tire pressure (kPa) */
	PitSvLFP?: number;
	/** Pit service right front tire pressure (kPa) */
	PitSvRFP?: number;
	/** Pit service left rear tire pressure (kPa) */
	PitSvLRP?: number;
	/** Pit service right rear tire pressure (kPa) */
	PitSvRRP?: number;
	/** Pit service pending tire compound */
	PitSvTireCompound?: number;
	/** Mandatory pit repairs time remaining (s) */
	PitRepairLeft?: number;
	/** Optional pit repairs time remaining (s) */
	PitOptRepairLeft?: number;
	/** Fast repairs remaining (255=unlimited) */
	FastRepairAvailable?: number;
	/** Fast repairs used so far */
	FastRepairUsed?: number;

	// ========== Camera & Replay ==========
	/** Active camera number */
	CamCameraNumber?: number;
	/** Active camera group number */
	CamGroupNumber?: number;
	/** Active camera's focus car index */
	CamCarIdx?: number;
	/** Camera system state (CameraState enum) */
	CamCameraState?: number;
	/** Replay playback status */
	IsReplayPlaying?: boolean;
	/** Replay frame number (60 per second) */
	ReplayFrameNum?: number;
	/** Replay playback speed */
	ReplayPlaySpeed?: number;
	/** Replay slow motion flag */
	ReplayPlaySlowMotion?: boolean;
	/** Replay session number */
	ReplaySessionNum?: number;
	/** Seconds since replay session start (s) */
	ReplaySessionTime?: number;

	// ========== Force Feedback ==========
	/** Force feedback enabled flag */
	SteeringFFBEnabled?: boolean;
	/** Force feedback strength/max force (N·m) */
	SteeringWheelMaxForceNm?: number;
	/** Peak torque mapping to input units (N·m) */
	SteeringWheelPeakForceNm?: number;
	/** Output torque on steering shaft (N·m) */
	SteeringWheelTorque?: number;
	/** Force feedback limiter strength (%) */
	SteeringWheelLimiter?: number;
	/** Force feedback max torque (%) */
	SteeringWheelPctTorque?: number;
	/** Force feedback max damping (%) */
	SteeringWheelPctDamper?: number;

	// ========== Car Index Arrays (64 cars) ==========
	/** Laps started by car index */
	CarIdxLap?: number[];
	/** Laps completed by car index */
	CarIdxLapCompleted?: number[];
	/** Lap distance percentage by car index (%) */
	CarIdxLapDistPct?: number[];
	/** Track surface type by car index (TrkLoc enum) */
	CarIdxTrackSurface?: number[];
	/** Track surface material by car index (TrkSurf enum) */
	CarIdxTrackSurfaceMaterial?: number[];
	/** On pit road by car index */
	CarIdxOnPitRoad?: boolean[];
	/** Race position by car index */
	CarIdxPosition?: number[];
	/** Class position by car index */
	CarIdxClassPosition?: number[];
	/** Car class ID by car index */
	CarIdxClass?: number[];
	/** Current gear by car index: -1=R, 0=N, 1+=gear */
	CarIdxGear?: number[];
	/** Engine RPM by car index */
	CarIdxRPM?: number[];
	/** Steering wheel angle by car index (rad) */
	CarIdxSteer?: number[];
	/** Session flags by car index (Flags enum) */
	CarIdxSessionFlags?: number[];
	/** Pacing status flags by car index (PaceFlags enum) */
	CarIdxPaceFlags?: number[];
	/** Pacing line by car index (-1 if not pacing) */
	CarIdxPaceLine?: number[];
	/** Pacing row by car index (-1 if not pacing) */
	CarIdxPaceRow?: number[];
	/** Best lap time by car index (s) */
	CarIdxBestLapTime?: number[];
	/** Best lap number by car index */
	CarIdxBestLapNum?: number[];
	/** Last lap time by car index (s) */
	CarIdxLastLapTime?: number[];
	/** Estimated time to reach current location by car index (s) */
	CarIdxEstTime?: number[];
	/** Race time behind leader or fastest lap by car index (s) */
	CarIdxF2Time?: number[];
	/** Fast repairs used by car index */
	CarIdxFastRepairsUsed?: number[];
	/** Current tire compound by car index */
	CarIdxTireCompound?: number[];
	/** Qualifying tire compound by car index */
	CarIdxQualTireCompound?: number[];
	/** Push2Pass usage count by car index */
	CarIdxP2P_Count?: number[];
	/** Push2Pass active status by car index */
	CarIdxP2P_Status?: boolean[];

	// ========== Misc ==========
	/** Display units (DisplayUnits enum) */
	DisplayUnits?: number;
	/** Driver-activated flag */
	DriverMarker?: boolean;
	/** Push to talk button state */
	PushToTalk?: boolean;
	/** Push to pass button state */
	PushToPass?: boolean;
	/** Telemetry disk logging enabled */
	IsDiskLoggingEnabled?: boolean;
	/** Telemetry file actively being written */
	IsDiskLoggingActive?: boolean;
	/** Average frames per second */
	FrameRate?: number;
	/** Foreground thread CPU usage (%) */
	CpuUsageFG?: number;
	/** Background thread CPU usage (%) */
	CpuUsageBG?: number;
	/** GPU usage (%) */
	GpuUsage?: number;
}

/**
 * Session info (YAML data parsed to object)
 */
export interface SessionInfo {
	[key: string]: any;
}

/**
 * Engine warning flags (bitfield)
 * Used with: EngineWarnings telemetry variable
 * From official iRacing SDK (irsdk_defines.h)
 */
export enum EngineWarnings {
	WaterTempWarning = 0x0001,
	FuelPressureWarning = 0x0002,
	OilPressureWarning = 0x0004,
	EngineStalled = 0x0008,
	PitSpeedLimiter = 0x0010,
	RevLimiterActive = 0x0020,
	OilTempWarning = 0x0040,
	MandRepNeeded = 0x0080,  // Car needs mandatory repairs
	OptRepNeeded = 0x0100    // Car needs optional repairs
}

/**
 * Session flags (bitfield)
 * Used with: SessionFlags, CarIdxSessionFlags telemetry variables
 * From official iRacing SDK (irsdk_defines.h)
 */
export enum Flags {
	// Global flags
	Checkered = 0x00000001,
	White = 0x00000002,
	Green = 0x00000004,
	Yellow = 0x00000008,
	Red = 0x00000010,
	Blue = 0x00000020,
	Debris = 0x00000040,
	Crossed = 0x00000080,
	YellowWaving = 0x00000100,
	OneLapToGreen = 0x00000200,
	GreenHeld = 0x00000400,
	TenToGo = 0x00000800,
	FiveToGo = 0x00001000,
	RandomWaving = 0x00002000,
	Caution = 0x00004000,
	CautionWaving = 0x00008000,

	// Driver black flags
	Black = 0x00010000,
	Disqualify = 0x00020000,
	Servicible = 0x00040000,  // Car is allowed service (not a flag)
	Furled = 0x00080000,
	Repair = 0x00100000,
	DqScoringInvalid = 0x00200000,  // Car is disqualified and scoring is disabled

	// Start lights
	StartHidden = 0x10000000,
	StartReady = 0x20000000,
	StartSet = 0x40000000,
	StartGo = 0x80000000
}

/**
 * Track location
 * Used with: CarIdxTrackSurface telemetry variable
 * From official iRacing SDK (irsdk_defines.h)
 */
export enum TrkLoc {
	NotInWorld = -1,
	OffTrack = 0,
	InPitStall = 1,
	AproachingPits = 2,
	OnTrack = 3
}

/**
 * Track surface material type
 * Used with: CarIdxTrackSurfaceMaterial telemetry variable
 * From official iRacing SDK (irsdk_defines.h)
 */
export enum TrkSurf {
	NotInWorld = -1,
	Undefined = 0,
	Asphalt1 = 1,
	Asphalt2 = 2,
	Asphalt3 = 3,
	Asphalt4 = 4,
	Concrete1 = 5,
	Concrete2 = 6,
	RacingDirt1 = 7,
	RacingDirt2 = 8,
	Paint1 = 9,
	Paint2 = 10,
	Rumble1 = 11,
	Rumble2 = 12,
	Rumble3 = 13,
	Rumble4 = 14,
	Grass1 = 15,
	Grass2 = 16,
	Grass3 = 17,
	Grass4 = 18,
	Dirt1 = 19,
	Dirt2 = 20,
	Dirt3 = 21,
	Dirt4 = 22,
	Sand = 23,
	Gravel1 = 24,
	Gravel2 = 25,
	Grasscrete = 26,
	Astroturf = 27
}

/**
 * Session state
 * Used with: SessionState telemetry variable
 * From official iRacing SDK (irsdk_defines.h)
 */
export enum SessionState {
	Invalid = 0,
	GetInCar = 1,
	Warmup = 2,
	ParadeLaps = 3,
	Racing = 4,
	Checkered = 5,
	CoolDown = 6
}

/**
 * Camera state flags (bitfield)
 * Used with: CamCameraState telemetry variable
 * From official iRacing SDK (irsdk_defines.h)
 */
export enum CameraState {
	IsSessionScreen = 0x0001,
	IsScenicActive = 0x0002,
	CamToolActive = 0x0004,
	UIHidden = 0x0008,
	UseAutoShotSelection = 0x0010,
	UseTemporaryEdits = 0x0020,
	UseKeyAcceleration = 0x0040,
	UseKey10xAcceleration = 0x0080,
	UseMouseAimMode = 0x0100
}

/**
 * Pit service flags (bitfield)
 * Used with: PitSvFlags telemetry variable
 * From official iRacing SDK (irsdk_defines.h)
 */
export enum PitSvFlags {
	LFTireChange = 0x0001,
	RFTireChange = 0x0002,
	LRTireChange = 0x0004,
	RRTireChange = 0x0008,
	FuelFill = 0x0010,
	WindshieldTearoff = 0x0020,
	FastRepair = 0x0040
}

/**
 * Pit service status
 * Used with: PitSvStatus telemetry variable
 * From official iRacing SDK (irsdk_defines.h)
 */
export enum PitSvStatus {
	None = 0,
	InProgress = 1,
	Complete = 2,
	TooFarLeft = 100,
	TooFarRight = 101,
	TooFarForward = 102,
	TooFarBack = 103,
	BadAngle = 104,
	CantFixThat = 105
}

/**
 * Pace mode
 * Used with: PaceMode telemetry variable
 * From official iRacing SDK (irsdk_defines.h)
 */
export enum PaceMode {
	SingleFileStart = 0,
	DoubleFileStart = 1,
	SingleFileRestart = 2,
	DoubleFileRestart = 3,
	NotPacing = 4
}

/**
 * Pace flags (bitfield)
 * Used with: CarIdxPaceFlags telemetry variable
 * From official iRacing SDK (irsdk_defines.h)
 */
export enum PaceFlags {
	EndOfLine = 0x0001,
	FreePass = 0x0002,
	WavedAround = 0x0004
}

/**
 * Car left/right spotter info
 * Used with: CarLeftRight telemetry variable
 * From official iRacing SDK (irsdk_defines.h)
 */
export enum CarLeftRight {
	Off = 0,
	Clear = 1,
	CarLeft = 2,
	CarRight = 3,
	CarLeftRight = 4,
	TwoCarsLeft = 5,
	TwoCarsRight = 6
}

/**
 * Track wetness level
 * Used with: TrackWetness telemetry variable
 * From official iRacing SDK (irsdk_defines.h)
 */
export enum TrackWetness {
	Unknown = 0,
	Dry = 1,
	MostlyDry = 2,
	VeryLightlyWet = 3,
	LightlyWet = 4,
	ModeratelyWet = 5,
	VeryWet = 6,
	ExtremelyWet = 7
}

/**
 * Incident flags (bitfield)
 * Used with: incident telemetry variables
 * From official iRacing SDK (irsdk_defines.h)
 *
 * First byte is incident report flag (use INCIDENT_REP_MASK)
 * Second byte is incident penalty (use INCIDENT_PEN_MASK)
 */
export enum IncidentFlags {
	// Incident report flags (first byte)
	RepNoReport = 0x0000,                  // No penalty
	RepOutOfControl = 0x0001,              // "Loss of Control (2x)"
	RepOffTrack = 0x0002,                  // "Off Track (1x)"
	RepOffTrackOngoing = 0x0003,           // Not currently sent
	RepContactWithWorld = 0x0004,          // "Contact (0x)"
	RepCollisionWithWorld = 0x0005,        // "Contact (2x)"
	RepCollisionWithWorldOngoing = 0x0006, // Not currently sent
	RepContactWithCar = 0x0007,            // "Car Contact (0x)"
	RepCollisionWithCar = 0x0008,          // "Car Contact (4x)"

	// Incident penalty flags (second byte)
	PenNoReport = 0x0000,                  // No penalty
	PenZeroX = 0x0100,                     // 0x
	PenOneX = 0x0200,                      // 1x
	PenTwoX = 0x0300,                      // 2x
	PenFourX = 0x0400                      // 4x
}

// Masks for separating incident report and penalty fields
export const INCIDENT_REP_MASK = 0x000000FF;
export const INCIDENT_PEN_MASK = 0x0000FF00;

/**
 * Sky conditions
 * Used with: Skies telemetry variable
 */
export enum Skies {
	Clear = 0,
	PartlyCloudy = 1,
	MostlyCloudy = 2,
	Overcast = 3
}

/**
 * Display units preference
 * Used with: DisplayUnits telemetry variable
 */
export enum DisplayUnits {
	English = 0,
	Metric = 1
}

/**
 * Enter/Exit/Reset state
 * Used with: EnterExitReset telemetry variable
 */
export enum EnterExitReset {
	Enter = 0,
	Exit = 1,
	Reset = 2
}
