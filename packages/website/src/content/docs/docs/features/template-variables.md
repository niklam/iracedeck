---
title: Template Variables
description: iRacing telemetry and session variables available for Mustache templates in Telemetry Display and Chat actions.
---

These are the variables available for use in Mustache templates. Use them with the `{{variable}}` syntax to display live iRacing data on your Stream Deck buttons or include dynamic values in chat messages.

Template variables are supported by:
- [Telemetry Display](/docs/actions/display-session/telemetry-display/) — show any variable on a Stream Deck button
- [Chat](/docs/actions/communication/chat/) — include variables in custom chat messages

## Driver Info

Available prefixes: `self`, `track_ahead`, `track_behind`, `race_ahead`, `race_behind`

Examples shown with `self` prefix. Replace with any prefix above.

| Variable | Description |
|----------|-------------|
| `{{self.name}}` | Full driver name |
| `{{self.first_name}}` | First name |
| `{{self.last_name}}` | Last name |
| `{{self.abbrev_name}}` | Abbreviated name (e.g., "J. Smith") |
| `{{self.car_number}}` | Car number |
| `{{self.position}}` | Overall race position |
| `{{self.class_position}}` | Class position |
| `{{self.lap}}` | Current lap number |
| `{{self.laps_completed}}` | Laps completed |
| `{{self.irating}}` | iRating |
| `{{self.license}}` | License string (e.g., "A 4.99") |
| `{{self.incidents}}` | Incident count (self only) |

## Session

| Variable | Description |
|----------|-------------|
| `{{session.type}}` | Session type (Practice, Qualify, Race, etc.) |
| `{{session.laps_remaining}}` | Laps remaining |
| `{{session.time_remaining}}` | Time remaining (MM:SS) |

## Track

| Variable | Description |
|----------|-------------|
| `{{track.name}}` | Full track name |
| `{{track.short_name}}` | Short track name |

## Telemetry

All iRacing telemetry variables (excluding per-car arrays and high-frequency samples).

### Session State

| Variable | Description |
|----------|-------------|
| `{{telemetry.SessionTime}}` | Seconds since session start (s) |
| `{{telemetry.SessionTick}}` | Current update number |
| `{{telemetry.SessionNum}}` | Session number |
| `{{telemetry.SessionState}}` | Session state (irsdk_SessionState) |
| `{{telemetry.SessionUniqueID}}` | Session ID |
| `{{telemetry.SessionFlags}}` | Session flags (irsdk_Flags) |
| `{{telemetry.SessionTimeRemain}}` | Seconds left till session ends (s) |
| `{{telemetry.SessionLapsRemain}}` | Old laps left till session ends use SessionLapsRemainEx |
| `{{telemetry.SessionLapsRemainEx}}` | New improved laps left till session ends |
| `{{telemetry.SessionTimeTotal}}` | Total number of seconds in session (s) |
| `{{telemetry.SessionLapsTotal}}` | Total number of laps in session |
| `{{telemetry.SessionJokerLapsRemain}}` | Joker laps remaining to be taken |
| `{{telemetry.SessionOnJokerLap}}` | Player is currently completing a joker lap |
| `{{telemetry.SessionTimeOfDay}}` | Time of day in seconds (s) |

### Radio & Communications

| Variable | Description |
|----------|-------------|
| `{{telemetry.RadioTransmitCarIdx}}` | Car index of the current person speaking |
| `{{telemetry.RadioTransmitRadioIdx}}` | Radio index of the current person speaking |
| `{{telemetry.RadioTransmitFrequencyIdx}}` | Frequency index of the current person speaking |
| `{{telemetry.PushToTalk}}` | Push to talk button state |

### System & Display

| Variable | Description |
|----------|-------------|
| `{{telemetry.DisplayUnits}}` | Default units (0 = english, 1 = metric) |
| `{{telemetry.FrameRate}}` | Average frames per second (fps) |
| `{{telemetry.CpuUsageFG}}` | Foreground thread CPU usage (%) |
| `{{telemetry.CpuUsageBG}}` | Background thread CPU usage (%) |
| `{{telemetry.GpuUsage}}` | GPU usage (%) |
| `{{telemetry.MemPageFaultSec}}` | Memory page faults per second |
| `{{telemetry.MemSoftPageFaultSec}}` | Memory soft page faults per second |
| `{{telemetry.ChanAvgLatency}}` | Communications average latency (s) |
| `{{telemetry.ChanLatency}}` | Communications latency (s) |
| `{{telemetry.ChanQuality}}` | Communications quality (%) |
| `{{telemetry.ChanPartnerQuality}}` | Partner communications quality (%) |
| `{{telemetry.ChanClockSkew}}` | Communications server clock skew (s) |
| `{{telemetry.IsGarageVisible}}` | 1=Garage screen is visible |
| `{{telemetry.VidCapEnabled}}` | True if video capture system is enabled |
| `{{telemetry.VidCapActive}}` | True if video currently being captured |
| `{{telemetry.OkToReloadTextures}}` | True if it is ok to reload car textures |
| `{{telemetry.LoadNumTextures}}` | True if the car_num texture will be loaded |

### Player Car Info

| Variable | Description |
|----------|-------------|
| `{{telemetry.PlayerCarIdx}}` | Players carIdx |
| `{{telemetry.PlayerCarPosition}}` | Players position in race |
| `{{telemetry.PlayerCarClassPosition}}` | Players class position in race |
| `{{telemetry.PlayerCarClass}}` | Player car class id |
| `{{telemetry.PlayerTrackSurface}}` | Players car track surface type (irsdk_TrkLoc) |
| `{{telemetry.PlayerTrackSurfaceMaterial}}` | Players car track surface material type (irsdk_TrkSurf) |
| `{{telemetry.PlayerCarTeamIncidentCount}}` | Players team incident count for this session |
| `{{telemetry.PlayerCarMyIncidentCount}}` | Players own incident count for this session |
| `{{telemetry.PlayerCarDriverIncidentCount}}` | Teams current drivers incident count for this session |
| `{{telemetry.PlayerCarWeightPenalty}}` | Players weight penalty (kg) |
| `{{telemetry.PlayerCarPowerAdjust}}` | Players power adjust (%) |
| `{{telemetry.PlayerCarDryTireSetLimit}}` | Players dry tire set limit |
| `{{telemetry.PlayerCarTowTime}}` | Players car is being towed if time is greater than zero (s) |
| `{{telemetry.PlayerCarInPitStall}}` | Players car is properly in their pitstall |
| `{{telemetry.PlayerCarPitSvStatus}}` | Players car pit service status bits (irsdk_PitSvStatus) |
| `{{telemetry.PlayerTireCompound}}` | Players car current tire compound |
| `{{telemetry.PlayerFastRepairsUsed}}` | Players car number of fast repairs used |
| `{{telemetry.PlayerIncidents}}` | Log incidents that the player received (irsdk_IncidentFlags) |
| `{{telemetry.IsOnTrack}}` | 1=Car on track physics running with player in car |
| `{{telemetry.IsOnTrackCar}}` | 1=Car on track physics running |
| `{{telemetry.IsInGarage}}` | 1=Car in garage physics running |
| `{{telemetry.OnPitRoad}}` | Is the player car on pit road between the cones |
| `{{telemetry.PaceMode}}` | Are we pacing or not (irsdk_PaceMode) |
| `{{telemetry.CarLeftRight}}` | Notify if car is to the left or right of driver (irsdk_CarLeftRight) |

### Driving Inputs

| Variable | Description |
|----------|-------------|
| `{{telemetry.SteeringWheelAngle}}` | Steering wheel angle (rad) |
| `{{telemetry.SteeringWheelAngleMax}}` | Steering wheel max angle (rad) |
| `{{telemetry.Throttle}}` | 0=off throttle to 1=full throttle (%) |
| `{{telemetry.ThrottleRaw}}` | Raw throttle input (%) |
| `{{telemetry.Brake}}` | 0=brake released to 1=max pedal force (%) |
| `{{telemetry.BrakeRaw}}` | Raw brake input (%) |
| `{{telemetry.BrakeABSactive}}` | True if ABS is currently reducing brake force |
| `{{telemetry.Clutch}}` | 0=disengaged to 1=fully engaged (%) |
| `{{telemetry.ClutchRaw}}` | Raw clutch input (%) |
| `{{telemetry.HandbrakeRaw}}` | Raw handbrake input (%) |
| `{{telemetry.Gear}}` | -1=reverse 0=neutral 1..n=current gear |
| `{{telemetry.RPM}}` | Engine rpm (revs/min) |
| `{{telemetry.Speed}}` | GPS vehicle speed (m/s) |
| `{{telemetry.Shifter}}` | Log inputs from the players shifter control |
| `{{telemetry.DriverMarker}}` | Driver activated flag |
| `{{telemetry.PushToPass}}` | Push to pass button state |
| `{{telemetry.ManualBoost}}` | Hybrid manual boost state |
| `{{telemetry.ManualNoBoost}}` | Hybrid manual no boost state |
| `{{telemetry.EnterExitReset}}` | Indicate action the reset key will take (0=enter, 1=exit, 2=reset) |

### Shift Light

| Variable | Description |
|----------|-------------|
| `{{telemetry.PlayerCarSLFirstRPM}}` | Shift light first light rpm (revs/min) |
| `{{telemetry.PlayerCarSLShiftRPM}}` | Shift light shift rpm (revs/min) |
| `{{telemetry.PlayerCarSLLastRPM}}` | Shift light last light rpm (revs/min) |
| `{{telemetry.PlayerCarSLBlinkRPM}}` | Shift light blink rpm (revs/min) |
| `{{telemetry.ShiftPowerPct}}` | Friction torque applied to gears when shifting (%) |
| `{{telemetry.ShiftGrindRPM}}` | RPM of shifter grinding noise |

### Laps & Position

| Variable | Description |
|----------|-------------|
| `{{telemetry.Lap}}` | Laps started count |
| `{{telemetry.LapCompleted}}` | Laps completed count |
| `{{telemetry.LapDist}}` | Meters traveled from S/F this lap (m) |
| `{{telemetry.LapDistPct}}` | Percentage distance around lap (%) |
| `{{telemetry.RaceLaps}}` | Laps completed in race |
| `{{telemetry.CarDistAhead}}` | Distance to first car in front (m) |
| `{{telemetry.CarDistBehind}}` | Distance to first car behind (m) |

### Lap Times & Deltas

| Variable | Description |
|----------|-------------|
| `{{telemetry.LapBestLap}}` | Players best lap number |
| `{{telemetry.LapBestLapTime}}` | Players best lap time (s) |
| `{{telemetry.LapLastLapTime}}` | Players last lap time (s) |
| `{{telemetry.LapCurrentLapTime}}` | Estimate of players current lap time as shown in F3 box (s) |
| `{{telemetry.LapLasNLapSeq}}` | Player num consecutive clean laps completed for N average |
| `{{telemetry.LapLastNLapTime}}` | Player last N average lap time (s) |
| `{{telemetry.LapBestNLapLap}}` | Player last lap in best N average lap time |
| `{{telemetry.LapBestNLapTime}}` | Player best N average lap time (s) |
| `{{telemetry.LapDeltaToBestLap}}` | Delta time for best lap (s) |
| `{{telemetry.LapDeltaToBestLap_DD}}` | Rate of change of delta time for best lap (s/s) |
| `{{telemetry.LapDeltaToBestLap_OK}}` | Delta time for best lap is valid |
| `{{telemetry.LapDeltaToOptimalLap}}` | Delta time for optimal lap (s) |
| `{{telemetry.LapDeltaToOptimalLap_DD}}` | Rate of change of delta time for optimal lap (s/s) |
| `{{telemetry.LapDeltaToOptimalLap_OK}}` | Delta time for optimal lap is valid |
| `{{telemetry.LapDeltaToSessionBestLap}}` | Delta time for session best lap (s) |
| `{{telemetry.LapDeltaToSessionBestLap_DD}}` | Rate of change of delta time for session best lap (s/s) |
| `{{telemetry.LapDeltaToSessionBestLap_OK}}` | Delta time for session best lap is valid |
| `{{telemetry.LapDeltaToSessionOptimalLap}}` | Delta time for session optimal lap (s) |
| `{{telemetry.LapDeltaToSessionOptimalLap_DD}}` | Rate of change of delta time for session optimal lap (s/s) |
| `{{telemetry.LapDeltaToSessionOptimalLap_OK}}` | Delta time for session optimal lap is valid |
| `{{telemetry.LapDeltaToSessionLastlLap}}` | Delta time for session last lap (s) |
| `{{telemetry.LapDeltaToSessionLastlLap_DD}}` | Rate of change of delta time for session last lap (s/s) |
| `{{telemetry.LapDeltaToSessionLastlLap_OK}}` | Delta time for session last lap is valid |

### Vehicle Dynamics

| Variable | Description |
|----------|-------------|
| `{{telemetry.Yaw}}` | Yaw orientation (rad) |
| `{{telemetry.YawNorth}}` | Yaw orientation relative to north (rad) |
| `{{telemetry.Pitch}}` | Pitch orientation (rad) |
| `{{telemetry.Roll}}` | Roll orientation (rad) |
| `{{telemetry.VelocityX}}` | X velocity (m/s) |
| `{{telemetry.VelocityY}}` | Y velocity (m/s) |
| `{{telemetry.VelocityZ}}` | Z velocity (m/s) |
| `{{telemetry.YawRate}}` | Yaw rate (rad/s) |
| `{{telemetry.PitchRate}}` | Pitch rate (rad/s) |
| `{{telemetry.RollRate}}` | Roll rate (rad/s) |
| `{{telemetry.VertAccel}}` | Vertical acceleration including gravity (m/s^2) |
| `{{telemetry.LatAccel}}` | Lateral acceleration including gravity (m/s^2) |
| `{{telemetry.LongAccel}}` | Longitudinal acceleration including gravity (m/s^2) |

### Weather & Track Conditions

| Variable | Description |
|----------|-------------|
| `{{telemetry.TrackTempCrew}}` | Temperature of track measured by crew (C) |
| `{{telemetry.AirTemp}}` | Temperature of air at start/finish line (C) |
| `{{telemetry.TrackWetness}}` | How wet is the average track surface (irsdk_TrackWetness) |
| `{{telemetry.Skies}}` | Skies (0=clear, 1=p cloudy, 2=m cloudy, 3=overcast) |
| `{{telemetry.AirDensity}}` | Density of air at start/finish line (kg/m^3) |
| `{{telemetry.AirPressure}}` | Pressure of air at start/finish line (Pa) |
| `{{telemetry.WindVel}}` | Wind velocity at start/finish line (m/s) |
| `{{telemetry.WindDir}}` | Wind direction at start/finish line (rad) |
| `{{telemetry.RelativeHumidity}}` | Relative humidity (%) |
| `{{telemetry.FogLevel}}` | Fog level (%) |
| `{{telemetry.Precipitation}}` | Precipitation (%) |
| `{{telemetry.SolarAltitude}}` | Sun angle above horizon (rad) |
| `{{telemetry.SolarAzimuth}}` | Sun angle clockwise from north (rad) |
| `{{telemetry.WeatherDeclaredWet}}` | The steward says rain tires can be used |

### Engine & Fuel

| Variable | Description |
|----------|-------------|
| `{{telemetry.FuelLevel}}` | Liters of fuel remaining (l) |
| `{{telemetry.FuelLevelPct}}` | Percent fuel remaining (%) |
| `{{telemetry.FuelUsePerHour}}` | Engine fuel used instantaneous (kg/h) |
| `{{telemetry.FuelPress}}` | Engine fuel pressure (bar) |
| `{{telemetry.Voltage}}` | Engine voltage (V) |
| `{{telemetry.WaterTemp}}` | Engine coolant temp (C) |
| `{{telemetry.WaterLevel}}` | Engine coolant level (l) |
| `{{telemetry.OilTemp}}` | Engine oil temperature (C) |
| `{{telemetry.OilPress}}` | Engine oil pressure (bar) |
| `{{telemetry.OilLevel}}` | Engine oil level (l) |
| `{{telemetry.ManifoldPress}}` | Engine manifold pressure (bar) |
| `{{telemetry.Engine0_RPM}}` | Engine0 engine rpm (revs/min) |
| `{{telemetry.Engine1_RPM}}` | Engine1 engine rpm (revs/min) |
| `{{telemetry.EngineWarnings}}` | Bitfield for warning lights (irsdk_EngineWarnings) |

### Tires — Temperature & Wear

| Variable | Description |
|----------|-------------|
| `{{telemetry.LFtempCL}}` | LF tire left carcass temperature (C) |
| `{{telemetry.LFtempCM}}` | LF tire middle carcass temperature (C) |
| `{{telemetry.LFtempCR}}` | LF tire right carcass temperature (C) |
| `{{telemetry.LFwearL}}` | LF tire left percent tread remaining (%) |
| `{{telemetry.LFwearM}}` | LF tire middle percent tread remaining (%) |
| `{{telemetry.LFwearR}}` | LF tire right percent tread remaining (%) |
| `{{telemetry.RFtempCL}}` | RF tire left carcass temperature (C) |
| `{{telemetry.RFtempCM}}` | RF tire middle carcass temperature (C) |
| `{{telemetry.RFtempCR}}` | RF tire right carcass temperature (C) |
| `{{telemetry.RFwearL}}` | RF tire left percent tread remaining (%) |
| `{{telemetry.RFwearM}}` | RF tire middle percent tread remaining (%) |
| `{{telemetry.RFwearR}}` | RF tire right percent tread remaining (%) |
| `{{telemetry.LRtempCL}}` | LR tire left carcass temperature (C) |
| `{{telemetry.LRtempCM}}` | LR tire middle carcass temperature (C) |
| `{{telemetry.LRtempCR}}` | LR tire right carcass temperature (C) |
| `{{telemetry.LRwearL}}` | LR tire left percent tread remaining (%) |
| `{{telemetry.LRwearM}}` | LR tire middle percent tread remaining (%) |
| `{{telemetry.LRwearR}}` | LR tire right percent tread remaining (%) |
| `{{telemetry.RRtempCL}}` | RR tire left carcass temperature (C) |
| `{{telemetry.RRtempCM}}` | RR tire middle carcass temperature (C) |
| `{{telemetry.RRtempCR}}` | RR tire right carcass temperature (C) |
| `{{telemetry.RRwearL}}` | RR tire left percent tread remaining (%) |
| `{{telemetry.RRwearM}}` | RR tire middle percent tread remaining (%) |
| `{{telemetry.RRwearR}}` | RR tire right percent tread remaining (%) |

### Tires — Pressure & Odometer

| Variable | Description |
|----------|-------------|
| `{{telemetry.LFcoldPressure}}` | LF tire cold pressure as set in garage (kPa) |
| `{{telemetry.LFodometer}}` | LF distance tire traveled since placed on car (m) |
| `{{telemetry.LFbrakeLinePress}}` | LF brake line pressure (bar) |
| `{{telemetry.RFcoldPressure}}` | RF tire cold pressure as set in garage (kPa) |
| `{{telemetry.RFodometer}}` | RF distance tire traveled since placed on car (m) |
| `{{telemetry.RFbrakeLinePress}}` | RF brake line pressure (bar) |
| `{{telemetry.LRcoldPressure}}` | LR tire cold pressure as set in garage (kPa) |
| `{{telemetry.LRodometer}}` | LR distance tire traveled since placed on car (m) |
| `{{telemetry.LRbrakeLinePress}}` | LR brake line pressure (bar) |
| `{{telemetry.RRcoldPressure}}` | RR tire cold pressure as set in garage (kPa) |
| `{{telemetry.RRodometer}}` | RR distance tire traveled since placed on car (m) |
| `{{telemetry.RRbrakeLinePress}}` | RR brake line pressure (bar) |

### Tire Sets Available

| Variable | Description |
|----------|-------------|
| `{{telemetry.LFTiresUsed}}` | How many left front tires used so far |
| `{{telemetry.RFTiresUsed}}` | How many right front tires used so far |
| `{{telemetry.LRTiresUsed}}` | How many left rear tires used so far |
| `{{telemetry.RRTiresUsed}}` | How many right rear tires used so far |
| `{{telemetry.LeftTireSetsUsed}}` | How many left tire sets used so far |
| `{{telemetry.RightTireSetsUsed}}` | How many right tire sets used so far |
| `{{telemetry.FrontTireSetsUsed}}` | How many front tire sets used so far |
| `{{telemetry.RearTireSetsUsed}}` | How many rear tire sets used so far |
| `{{telemetry.TireSetsUsed}}` | How many tire sets used so far |
| `{{telemetry.LFTiresAvailable}}` | How many left front tires remaining (255 = unlimited) |
| `{{telemetry.RFTiresAvailable}}` | How many right front tires remaining (255 = unlimited) |
| `{{telemetry.LRTiresAvailable}}` | How many left rear tires remaining (255 = unlimited) |
| `{{telemetry.RRTiresAvailable}}` | How many right rear tires remaining (255 = unlimited) |
| `{{telemetry.LeftTireSetsAvailable}}` | How many left tire sets remaining (255 = unlimited) |
| `{{telemetry.RightTireSetsAvailable}}` | How many right tire sets remaining (255 = unlimited) |
| `{{telemetry.FrontTireSetsAvailable}}` | How many front tire sets remaining (255 = unlimited) |
| `{{telemetry.RearTireSetsAvailable}}` | How many rear tire sets remaining (255 = unlimited) |
| `{{telemetry.TireSetsAvailable}}` | How many tire sets remaining (255 = unlimited) |

### Suspension & Shocks

| Variable | Description |
|----------|-------------|
| `{{telemetry.LFshockDefl}}` | LF shock deflection (m) |
| `{{telemetry.LFshockVel}}` | LF shock velocity (m/s) |
| `{{telemetry.RFshockDefl}}` | RF shock deflection (m) |
| `{{telemetry.RFshockVel}}` | RF shock velocity (m/s) |
| `{{telemetry.LRshockDefl}}` | LR shock deflection (m) |
| `{{telemetry.LRshockVel}}` | LR shock velocity (m/s) |
| `{{telemetry.RRshockDefl}}` | RR shock deflection (m) |
| `{{telemetry.RRshockVel}}` | RR shock velocity (m/s) |
| `{{telemetry.TireLF_RumblePitch}}` | LF tire rumblestrip pitch (Hz) |
| `{{telemetry.TireRF_RumblePitch}}` | RF tire rumblestrip pitch (Hz) |
| `{{telemetry.TireLR_RumblePitch}}` | LR tire rumblestrip pitch (Hz) |
| `{{telemetry.TireRR_RumblePitch}}` | RR tire rumblestrip pitch (Hz) |
| `{{telemetry.CFshockDefl}}` | CF shock deflection (m) |
| `{{telemetry.CFshockVel}}` | CF shock velocity (m/s) |
| `{{telemetry.CRshockDefl}}` | CR shock deflection (m) |
| `{{telemetry.CRshockVel}}` | CR shock velocity (m/s) |
| `{{telemetry.HFshockDefl}}` | HF shock deflection (m) |
| `{{telemetry.HFshockVel}}` | HF shock velocity (m/s) |
| `{{telemetry.HRshockDefl}}` | HR shock deflection (m) |
| `{{telemetry.HRshockVel}}` | HR shock velocity (m/s) |
| `{{telemetry.ROLLFshockDefl}}` | ROLLF shock deflection (m) |
| `{{telemetry.ROLLFshockVel}}` | ROLLF shock velocity (m/s) |
| `{{telemetry.ROLLRshockDefl}}` | ROLLR shock deflection (m) |
| `{{telemetry.ROLLRshockVel}}` | ROLLR shock velocity (m/s) |
| `{{telemetry.LFSHshockDefl}}` | LFSH shock deflection (m) |
| `{{telemetry.LFSHshockVel}}` | LFSH shock velocity (m/s) |
| `{{telemetry.RFSHshockDefl}}` | RFSH shock deflection (m) |
| `{{telemetry.RFSHshockVel}}` | RFSH shock velocity (m/s) |
| `{{telemetry.LRSHshockDefl}}` | LRSH shock deflection (m) |
| `{{telemetry.LRSHshockVel}}` | LRSH shock velocity (m/s) |
| `{{telemetry.RRSHshockDefl}}` | RRSH shock deflection (m) |
| `{{telemetry.RRSHshockVel}}` | RRSH shock velocity (m/s) |
| `{{telemetry.LR2shockDefl}}` | LR2 shock deflection (m) |
| `{{telemetry.LR2shockVel}}` | LR2 shock velocity (m/s) |

### Force Feedback

| Variable | Description |
|----------|-------------|
| `{{telemetry.SteeringWheelTorque}}` | Output torque on steering shaft (N*m) |
| `{{telemetry.SteeringWheelPctTorque}}` | Force feedback % max torque unsigned (%) |
| `{{telemetry.SteeringWheelPctTorqueSign}}` | Force feedback % max torque signed (%) |
| `{{telemetry.SteeringWheelPctTorqueSignStops}}` | Force feedback % max torque signed stops (%) |
| `{{telemetry.SteeringWheelPctIntensity}}` | Force feedback % max intensity (%) |
| `{{telemetry.SteeringWheelPctSmoothing}}` | Force feedback % max smoothing (%) |
| `{{telemetry.SteeringWheelPctDamper}}` | Force feedback % max damping (%) |
| `{{telemetry.SteeringWheelLimiter}}` | Force feedback limiter strength (%) |
| `{{telemetry.SteeringWheelMaxForceNm}}` | Strength/max force slider in Nm (N*m) |
| `{{telemetry.SteeringWheelPeakForceNm}}` | Peak torque mapping for FFB (N*m) |
| `{{telemetry.SteeringWheelUseLinear}}` | True if steering wheel force is using linear mode |
| `{{telemetry.SteeringFFBEnabled}}` | Force feedback is enabled |

### Pit Service Status

| Variable | Description |
|----------|-------------|
| `{{telemetry.PitsOpen}}` | True if pit stop is allowed for the current player |
| `{{telemetry.PitstopActive}}` | Is the player getting pit stop service |
| `{{telemetry.PitRepairLeft}}` | Time left for mandatory pit repairs (s) |
| `{{telemetry.PitOptRepairLeft}}` | Time left for optional repairs (s) |
| `{{telemetry.FastRepairUsed}}` | How many fast repairs used so far |
| `{{telemetry.FastRepairAvailable}}` | How many fast repairs left (255 = unlimited) |
| `{{telemetry.PitSvFlags}}` | Bitfield of pit service checkboxes (irsdk_PitSvFlags) |
| `{{telemetry.PitSvLFP}}` | Pit service left front tire pressure (kPa) |
| `{{telemetry.PitSvRFP}}` | Pit service right front tire pressure (kPa) |
| `{{telemetry.PitSvLRP}}` | Pit service left rear tire pressure (kPa) |
| `{{telemetry.PitSvRRP}}` | Pit service right rear tire pressure (kPa) |
| `{{telemetry.PitSvFuel}}` | Pit service fuel add amount (l or kWh) |
| `{{telemetry.PitSvTireCompound}}` | Pit service pending tire compound |

### Hybrid & ERS

| Variable | Description |
|----------|-------------|
| `{{telemetry.PowerMGU_K}}` | Engine MGU-K mechanical power (W) |
| `{{telemetry.TorqueMGU_K}}` | Engine MGU-K mechanical torque (Nm) |
| `{{telemetry.PowerMGU_H}}` | Engine MGU-H mechanical power (W) |
| `{{telemetry.EnergyERSBattery}}` | Engine ERS battery charge (J) |
| `{{telemetry.EnergyERSBatteryPct}}` | Engine ERS battery charge as a percent (%) |
| `{{telemetry.EnergyBatteryToMGU_KLap}}` | Electrical energy from battery to MGU-K per lap (J) |
| `{{telemetry.EnergyMGU_KLapDeployPct}}` | Electrical energy available to MGU-K per lap (%) |
| `{{telemetry.DRS_Status}}` | Drag Reduction System Status |
| `{{telemetry.DRS_Count}}` | Drag Reduction System count of usage |
| `{{telemetry.P2P_Status}}` | Push2Pass active or not on your car |
| `{{telemetry.P2P_Count}}` | Push2Pass count of usage (or remaining in Race) |

### Replay & Camera

| Variable | Description |
|----------|-------------|
| `{{telemetry.IsReplayPlaying}}` | 0=replay not playing, 1=replay playing |
| `{{telemetry.ReplayFrameNum}}` | Integer replay frame number (60 per second) |
| `{{telemetry.ReplayFrameNumEnd}}` | Integer replay frame number from end of tape |
| `{{telemetry.ReplayPlaySpeed}}` | Replay playback speed |
| `{{telemetry.ReplayPlaySlowMotion}}` | 0=not slow motion, 1=replay is in slow motion |
| `{{telemetry.ReplaySessionTime}}` | Seconds since replay session start (s) |
| `{{telemetry.ReplaySessionNum}}` | Replay session number |
| `{{telemetry.CamCarIdx}}` | Active camera's focus car index |
| `{{telemetry.CamCameraNumber}}` | Active camera number |
| `{{telemetry.CamGroupNumber}}` | Active camera group number |
| `{{telemetry.CamCameraState}}` | State of camera system (irsdk_CameraState) |

### In-Car Adjustments

| Variable | Description |
|----------|-------------|
| `{{telemetry.dcStarter}}` | In car trigger car starter |
| `{{telemetry.dcPitSpeedLimiterToggle}}` | Pit speed limiter system enabled |
| `{{telemetry.dcTractionControlToggle}}` | Traction control active |
| `{{telemetry.dcTractionControl}}` | Traction control adjustment |
| `{{telemetry.dcTractionControl2}}` | Traction control 2 adjustment |
| `{{telemetry.dcTractionControl3}}` | Traction control 3 adjustment |
| `{{telemetry.dcTractionControl4}}` | Traction control 4 adjustment |
| `{{telemetry.dcABS}}` | ABS adjustment |
| `{{telemetry.dcBrakeBias}}` | Brake bias adjustment |
| `{{telemetry.dcBrakeBiasFine}}` | Brake bias fine adjustment |
| `{{telemetry.dcPeakBrakeBias}}` | Peak brake bias adjustment |
| `{{telemetry.dcBrakeMisc}}` | Brake misc adjustment |
| `{{telemetry.dcEngineBraking}}` | Engine braking adjustment |
| `{{telemetry.dcEnginePower}}` | Engine power adjustment |
| `{{telemetry.dcThrottleShape}}` | Throttle shape adjustment |
| `{{telemetry.dcFuelMixture}}` | Fuel mixture adjustment |
| `{{telemetry.dcFuelCutPosition}}` | Fuel cut position |
| `{{telemetry.dcFuelNoCutToggle}}` | Fuel cut on straight active |
| `{{telemetry.dcFCYToggle}}` | Full course yellow mode toggle |
| `{{telemetry.dcLowFuelAccept}}` | Low fuel accept |
| `{{telemetry.dcLaunchRPM}}` | Launch RPM adjustment |
| `{{telemetry.dcPowerSteering}}` | Power steering adjustment |
| `{{telemetry.dcAntiRollFront}}` | Front anti roll bar adjustment |
| `{{telemetry.dcAntiRollRear}}` | Rear anti roll bar adjustment |
| `{{telemetry.dcWeightJackerRight}}` | Right wedge/weight jacker adjustment |
| `{{telemetry.dcDashPage}}` | Dash display page adjustment |
| `{{telemetry.dcDashPage2}}` | Second dash display page adjustment |
| `{{telemetry.dcInLapToggle}}` | Toggle in lap settings |
| `{{telemetry.dcHeadlightFlash}}` | Headlight flash control active |
| `{{telemetry.dcToggleWindshieldWipers}}` | Turn wipers on or off |
| `{{telemetry.dcTriggerWindshieldWipers}}` | Momentarily turn on wipers |
| `{{telemetry.dcTearOffVisor}}` | Tear off visor film |
| `{{telemetry.dcDRSToggle}}` | Toggle DRS |
| `{{telemetry.dcPushToPass}}` | Trigger push to pass |
| `{{telemetry.dcRFBrakeAttachedToggle}}` | Right front brake attached (1) or detached (0) |
| `{{telemetry.dcMGUKDeployMode}}` | MGU-K deployment mode adjustment |
| `{{telemetry.dcMGUKRegenGain}}` | MGU-K regen gain adjustment |
| `{{telemetry.dcMGUKDeployFixed}}` | MGU-K fixed deployment adjustment |
| `{{telemetry.dcHysBoostHold}}` | Hold HYS deploy |
| `{{telemetry.dcDiffEntry}}` | Diff entry adjustment |
| `{{telemetry.dcDiffMiddle}}` | Diff middle adjustment |
| `{{telemetry.dcDiffExit}}` | Diff exit adjustment |
| `{{telemetry.IsDiskLoggingEnabled}}` | 0=telemetry logging off, 1=on |
| `{{telemetry.IsDiskLoggingActive}}` | 0=telemetry file not being written, 1=writing |
| `{{telemetry.DCLapStatus}}` | Status of driver change lap requirements |
| `{{telemetry.DCDriversSoFar}}` | Number of team drivers who have run a stint |

### Pitstop Requests

| Variable | Description |
|----------|-------------|
| `{{telemetry.dpFuelFill}}` | Pitstop fuel fill flag |
| `{{telemetry.dpFuelAutoFillEnabled}}` | Pitstop auto fill fuel system enabled |
| `{{telemetry.dpFuelAutoFillActive}}` | Pitstop auto fill fuel next stop flag |
| `{{telemetry.dpFuelAddKg}}` | Pitstop fuel add amount (kg) |
| `{{telemetry.dpChargeAddKWh}}` | Pitstop charge add amount (kWh) |
| `{{telemetry.dpWindshieldTearoff}}` | Pitstop windshield tearoff |
| `{{telemetry.dpFastRepair}}` | Pitstop fast repair set |
| `{{telemetry.dpTireChange}}` | Pitstop all tire change request |
| `{{telemetry.dpLFTireChange}}` | Pitstop LF tire change request |
| `{{telemetry.dpRFTireChange}}` | Pitstop RF tire change request |
| `{{telemetry.dpLRTireChange}}` | Pitstop LR tire change request |
| `{{telemetry.dpRRTireChange}}` | Pitstop RR tire change request |
| `{{telemetry.dpLTireChange}}` | Pitstop left tire change request |
| `{{telemetry.dpRTireChange}}` | Pitstop right tire change request |
| `{{telemetry.dpLFTireColdPress}}` | Pitstop LF tire cold pressure adjustment (Pa) |
| `{{telemetry.dpRFTireColdPress}}` | Pitstop RF cold tire pressure adjustment (Pa) |
| `{{telemetry.dpLRTireColdPress}}` | Pitstop LR tire cold pressure adjustment (Pa) |
| `{{telemetry.dpRRTireColdPress}}` | Pitstop RR cold tire pressure adjustment (Pa) |
| `{{telemetry.dpWingFront}}` | Pitstop front wing adjustment |
| `{{telemetry.dpWingRear}}` | Pitstop rear wing adjustment |
| `{{telemetry.dpQTape}}` | Pitstop qualify tape adjustment |
| `{{telemetry.dpPowerSteering}}` | Pitstop power steering adjustment |
| `{{telemetry.dpWeightJackerLeft}}` | Pitstop left wedge/weight jacker adjustment |
| `{{telemetry.dpWeightJackerRight}}` | Pitstop right wedge/weight jacker adjustment |

## Session Info

Raw session data from iRacing using dot-notation paths. Arrays (drivers list, session results, cameras) are excluded.

### Weekend Info

Track metadata, weather conditions, and session configuration.

| Variable | Description |
|----------|-------------|
| `{{sessionInfo.WeekendInfo.TrackName}}` | Internal track name |
| `{{sessionInfo.WeekendInfo.TrackID}}` | Track ID number |
| `{{sessionInfo.WeekendInfo.TrackLength}}` | Track length with units |
| `{{sessionInfo.WeekendInfo.TrackLengthOfficial}}` | Official track length |
| `{{sessionInfo.WeekendInfo.TrackDisplayName}}` | Full track display name |
| `{{sessionInfo.WeekendInfo.TrackDisplayShortName}}` | Short track name |
| `{{sessionInfo.WeekendInfo.TrackConfigName}}` | Track configuration name |
| `{{sessionInfo.WeekendInfo.TrackCity}}` | City |
| `{{sessionInfo.WeekendInfo.TrackState}}` | State or province |
| `{{sessionInfo.WeekendInfo.TrackCountry}}` | Country |
| `{{sessionInfo.WeekendInfo.TrackAltitude}}` | Elevation with units |
| `{{sessionInfo.WeekendInfo.TrackLatitude}}` | Latitude |
| `{{sessionInfo.WeekendInfo.TrackLongitude}}` | Longitude |
| `{{sessionInfo.WeekendInfo.TrackNorthOffset}}` | North offset (radians) |
| `{{sessionInfo.WeekendInfo.TrackNumTurns}}` | Number of turns |
| `{{sessionInfo.WeekendInfo.TrackPitSpeedLimit}}` | Pit speed limit with units |
| `{{sessionInfo.WeekendInfo.TrackPaceSpeed}}` | Pace car speed with units |
| `{{sessionInfo.WeekendInfo.TrackNumPitStalls}}` | Number of pit stalls |
| `{{sessionInfo.WeekendInfo.TrackType}}` | Track type (road, oval, etc.) |
| `{{sessionInfo.WeekendInfo.TrackDirection}}` | Direction (turns left/right/neutral) |
| `{{sessionInfo.WeekendInfo.TrackWeatherType}}` | Weather type |
| `{{sessionInfo.WeekendInfo.TrackSkies}}` | Sky conditions |
| `{{sessionInfo.WeekendInfo.TrackSurfaceTemp}}` | Surface temperature with units |
| `{{sessionInfo.WeekendInfo.TrackSurfaceTempCrew}}` | Surface temp at crew location |
| `{{sessionInfo.WeekendInfo.TrackAirTemp}}` | Air temperature with units |
| `{{sessionInfo.WeekendInfo.TrackAirPressure}}` | Air pressure with units |
| `{{sessionInfo.WeekendInfo.TrackAirDensity}}` | Air density with units |
| `{{sessionInfo.WeekendInfo.TrackWindVel}}` | Wind velocity with units |
| `{{sessionInfo.WeekendInfo.TrackWindDir}}` | Wind direction with units |
| `{{sessionInfo.WeekendInfo.TrackRelativeHumidity}}` | Relative humidity percentage |
| `{{sessionInfo.WeekendInfo.TrackFogLevel}}` | Fog level |
| `{{sessionInfo.WeekendInfo.TrackPrecipitation}}` | Precipitation level |
| `{{sessionInfo.WeekendInfo.TrackCleanup}}` | Track cleanup state |
| `{{sessionInfo.WeekendInfo.TrackDynamicTrack}}` | Dynamic track rubber enabled |
| `{{sessionInfo.WeekendInfo.TrackVersion}}` | Track version string |

### Weekend Options

| Variable | Description |
|----------|-------------|
| `{{sessionInfo.WeekendInfo.WeekendOptions.NumStarters}}` | Number of starters |
| `{{sessionInfo.WeekendInfo.WeekendOptions.StartingGrid}}` | Starting grid type |
| `{{sessionInfo.WeekendInfo.WeekendOptions.QualifyScoring}}` | Qualifying scoring method |
| `{{sessionInfo.WeekendInfo.WeekendOptions.CourseCautions}}` | Course cautions type |
| `{{sessionInfo.WeekendInfo.WeekendOptions.StandingStart}}` | Standing start (0/1) |
| `{{sessionInfo.WeekendInfo.WeekendOptions.ShortParadeLap}}` | Short parade lap (0/1) |
| `{{sessionInfo.WeekendInfo.WeekendOptions.Restarts}}` | Restart type |
| `{{sessionInfo.WeekendInfo.WeekendOptions.WeatherType}}` | Weather type setting |
| `{{sessionInfo.WeekendInfo.WeekendOptions.Skies}}` | Sky setting |
| `{{sessionInfo.WeekendInfo.WeekendOptions.WindDirection}}` | Wind direction setting |
| `{{sessionInfo.WeekendInfo.WeekendOptions.WindSpeed}}` | Wind speed setting |
| `{{sessionInfo.WeekendInfo.WeekendOptions.WeatherTemp}}` | Weather temperature setting |
| `{{sessionInfo.WeekendInfo.WeekendOptions.RelativeHumidity}}` | Relative humidity setting |
| `{{sessionInfo.WeekendInfo.WeekendOptions.FogLevel}}` | Fog level setting |
| `{{sessionInfo.WeekendInfo.WeekendOptions.TimeOfDay}}` | Time of day |
| `{{sessionInfo.WeekendInfo.WeekendOptions.Date}}` | Session date |
| `{{sessionInfo.WeekendInfo.WeekendOptions.EarthRotationSpeedupFactor}}` | Time speed multiplier |
| `{{sessionInfo.WeekendInfo.WeekendOptions.Unofficial}}` | Unofficial session (0/1) |
| `{{sessionInfo.WeekendInfo.WeekendOptions.IsFixedSetup}}` | Fixed setup (0/1) |
| `{{sessionInfo.WeekendInfo.WeekendOptions.HasOpenRegistration}}` | Open registration (0/1) |
| `{{sessionInfo.WeekendInfo.WeekendOptions.HardcoreLevel}}` | Hardcore level |
| `{{sessionInfo.WeekendInfo.WeekendOptions.NumJokerLaps}}` | Number of joker laps |
| `{{sessionInfo.WeekendInfo.WeekendOptions.IncidentLimit}}` | Incident limit |
| `{{sessionInfo.WeekendInfo.WeekendOptions.FastRepairsLimit}}` | Fast repairs limit |
| `{{sessionInfo.WeekendInfo.WeekendOptions.GreenWhiteCheckeredLimit}}` | GWC attempts limit |

### Series & Event Info

| Variable | Description |
|----------|-------------|
| `{{sessionInfo.WeekendInfo.SeriesID}}` | Series ID |
| `{{sessionInfo.WeekendInfo.SeasonID}}` | Season ID |
| `{{sessionInfo.WeekendInfo.SessionID}}` | Session ID |
| `{{sessionInfo.WeekendInfo.SubSessionID}}` | Sub-session ID |
| `{{sessionInfo.WeekendInfo.LeagueID}}` | League ID (0 if not league) |
| `{{sessionInfo.WeekendInfo.Official}}` | Official session (0/1) |
| `{{sessionInfo.WeekendInfo.RaceWeek}}` | Race week number |
| `{{sessionInfo.WeekendInfo.EventType}}` | Event type |
| `{{sessionInfo.WeekendInfo.Category}}` | Category (Road, Oval, etc.) |
| `{{sessionInfo.WeekendInfo.SimMode}}` | Simulation mode |
| `{{sessionInfo.WeekendInfo.TeamRacing}}` | Team racing enabled (0/1) |
| `{{sessionInfo.WeekendInfo.MinDrivers}}` | Min drivers per team |
| `{{sessionInfo.WeekendInfo.MaxDrivers}}` | Max drivers per team |
| `{{sessionInfo.WeekendInfo.DCRuleSet}}` | Driver change rule set |
| `{{sessionInfo.WeekendInfo.QualifierMustStartRace}}` | Qualifier must start race (0/1) |
| `{{sessionInfo.WeekendInfo.NumCarClasses}}` | Number of car classes |
| `{{sessionInfo.WeekendInfo.NumCarTypes}}` | Number of car types |
| `{{sessionInfo.WeekendInfo.HeatRacing}}` | Heat racing enabled (0/1) |
| `{{sessionInfo.WeekendInfo.BuildType}}` | Build type |
| `{{sessionInfo.WeekendInfo.BuildTarget}}` | Build target |
| `{{sessionInfo.WeekendInfo.BuildVersion}}` | iRacing build version |
| `{{sessionInfo.WeekendInfo.RaceFarm}}` | Race farm ID |
| `{{sessionInfo.WeekendInfo.TelemetryOptions.TelemetryDiskFile}}` | Telemetry disk file path |

### Current Session

| Variable | Description |
|----------|-------------|
| `{{sessionInfo.SessionInfo.CurrentSessionNum}}` | Current session number index |

### Driver / Car Info

Your car specs and setup metadata. Per-driver entries (arrays) are not available.

| Variable | Description |
|----------|-------------|
| `{{sessionInfo.DriverInfo.DriverCarIdx}}` | Your car index |
| `{{sessionInfo.DriverInfo.DriverUserID}}` | Your user ID |
| `{{sessionInfo.DriverInfo.PaceCarIdx}}` | Pace car index |
| `{{sessionInfo.DriverInfo.DriverIsAdmin}}` | You are admin (0/1) |
| `{{sessionInfo.DriverInfo.DriverHeadPosX}}` | Head position X |
| `{{sessionInfo.DriverInfo.DriverHeadPosY}}` | Head position Y |
| `{{sessionInfo.DriverInfo.DriverHeadPosZ}}` | Head position Z |
| `{{sessionInfo.DriverInfo.DriverCarIsElectric}}` | Car is electric (0/1) |
| `{{sessionInfo.DriverInfo.DriverCarIdleRPM}}` | Idle RPM |
| `{{sessionInfo.DriverInfo.DriverCarRedLine}}` | Redline RPM |
| `{{sessionInfo.DriverInfo.DriverCarEngCylinderCount}}` | Engine cylinder count |
| `{{sessionInfo.DriverInfo.DriverCarFuelKgPerLtr}}` | Fuel weight (kg per liter) |
| `{{sessionInfo.DriverInfo.DriverCarFuelMaxLtr}}` | Max fuel capacity (liters) |
| `{{sessionInfo.DriverInfo.DriverCarMaxFuelPct}}` | Max fuel fill percentage |
| `{{sessionInfo.DriverInfo.DriverCarGearNumForward}}` | Number of forward gears |
| `{{sessionInfo.DriverInfo.DriverGearboxType}}` | Gearbox type |
| `{{sessionInfo.DriverInfo.DriverCarSLFirstRPM}}` | Shift light first RPM |
| `{{sessionInfo.DriverInfo.DriverCarSLShiftRPM}}` | Shift light shift RPM |
| `{{sessionInfo.DriverInfo.DriverCarSLLastRPM}}` | Shift light last RPM |
| `{{sessionInfo.DriverInfo.DriverCarSLBlinkRPM}}` | Shift light blink RPM |
| `{{sessionInfo.DriverInfo.DriverCarVersion}}` | Car version string |
| `{{sessionInfo.DriverInfo.DriverPitTrkPct}}` | Pit entry track percentage |
| `{{sessionInfo.DriverInfo.DriverCarEstLapTime}}` | Estimated lap time (seconds) |
| `{{sessionInfo.DriverInfo.DriverSetupName}}` | Setup name |
| `{{sessionInfo.DriverInfo.DriverSetupIsModified}}` | Setup modified (0/1) |
| `{{sessionInfo.DriverInfo.DriverIncidentCount}}` | Your incident count |

### Radio

| Variable | Description |
|----------|-------------|
| `{{sessionInfo.RadioInfo.SelectedRadioNum}}` | Currently selected radio number |

### Car Setup

Current car setup values. Available fields vary by car.

| Variable | Description |
|----------|-------------|
| `{{sessionInfo.CarSetup.UpdateCount}}` | Setup update count |
| `{{sessionInfo.CarSetup.TiresAero.TireType.TireType}}` | Tire compound type |
| `{{sessionInfo.CarSetup.TiresAero.LeftFront.ColdPressure}}` | LF cold pressure |
| `{{sessionInfo.CarSetup.TiresAero.LeftFront.LastHotPressure}}` | LF last hot pressure |
| `{{sessionInfo.CarSetup.TiresAero.LeftFront.LastTempsOMI}}` | LF last temps (outside, middle, inside) |
| `{{sessionInfo.CarSetup.TiresAero.LeftFront.TreadRemaining}}` | LF tread remaining |
| `{{sessionInfo.CarSetup.TiresAero.LeftRear.ColdPressure}}` | LR cold pressure |
| `{{sessionInfo.CarSetup.TiresAero.LeftRear.LastHotPressure}}` | LR last hot pressure |
| `{{sessionInfo.CarSetup.TiresAero.LeftRear.LastTempsOMI}}` | LR last temps (outside, middle, inside) |
| `{{sessionInfo.CarSetup.TiresAero.LeftRear.TreadRemaining}}` | LR tread remaining |
| `{{sessionInfo.CarSetup.TiresAero.RightFront.ColdPressure}}` | RF cold pressure |
| `{{sessionInfo.CarSetup.TiresAero.RightFront.LastHotPressure}}` | RF last hot pressure |
| `{{sessionInfo.CarSetup.TiresAero.RightFront.LastTempsIMO}}` | RF last temps (inside, middle, outside) |
| `{{sessionInfo.CarSetup.TiresAero.RightFront.TreadRemaining}}` | RF tread remaining |
| `{{sessionInfo.CarSetup.TiresAero.RightRear.ColdPressure}}` | RR cold pressure |
| `{{sessionInfo.CarSetup.TiresAero.RightRear.LastHotPressure}}` | RR last hot pressure |
| `{{sessionInfo.CarSetup.TiresAero.RightRear.LastTempsIMO}}` | RR last temps (inside, middle, outside) |
| `{{sessionInfo.CarSetup.TiresAero.RightRear.TreadRemaining}}` | RR tread remaining |
| `{{sessionInfo.CarSetup.TiresAero.FrontAero.FlapAngle}}` | Front flap angle |
| `{{sessionInfo.CarSetup.TiresAero.RearAero.WingAngle}}` | Rear wing angle |
| `{{sessionInfo.CarSetup.TiresAero.RearAero.GurneyFlap}}` | Gurney flap size |
| `{{sessionInfo.CarSetup.TiresAero.AeroCalculator.FrontRhAtSpeed}}` | Front ride height at speed |
| `{{sessionInfo.CarSetup.TiresAero.AeroCalculator.RearRhAtSpeed}}` | Rear ride height at speed |
| `{{sessionInfo.CarSetup.TiresAero.AeroCalculator.FrontDownforce}}` | Front downforce percentage |
| `{{sessionInfo.CarSetup.TiresAero.AeroCalculator.DownforceToDrag}}` | Downforce to drag ratio |
| `{{sessionInfo.CarSetup.Chassis.Front.ArbDiameter}}` | Front anti-roll bar diameter |
| `{{sessionInfo.CarSetup.Chassis.Front.BrakePressureBias}}` | Brake pressure bias |
| `{{sessionInfo.CarSetup.Chassis.Front.DisplayPage}}` | Steering wheel display page |
| `{{sessionInfo.CarSetup.Chassis.Rear.FuelLevel}}` | Fuel level |
| `{{sessionInfo.CarSetup.Chassis.Rear.ArbDiameter}}` | Rear anti-roll bar diameter |
| `{{sessionInfo.CarSetup.Drivetrain.Differential.Preload}}` | Differential preload |
| `{{sessionInfo.CarSetup.Drivetrain.EngineInCarDials.ThrottleShaping}}` | Throttle shaping / map |
| `{{sessionInfo.CarSetup.Drivetrain.EngineInCarDials.LaunchControlRpm}}` | Launch control RPM setting |
