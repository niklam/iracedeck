/**
 * Mock session info YAML string.
 *
 * Simulates a practice session at Spa with 3 drivers.
 * This is placeholder data — replace with real telemetry captures later.
 *
 * `CameraInfo` is the exception: a real 25-group list from a Lakeland capture
 * (#958), in the sim's own numbering, so a mock session carries every camera
 * group Camera Controls knows — TV4, Spotter and Spectator included, which a
 * real Spa session would not.
 */
export const MOCK_SESSION_INFO_YAML = `---
WeekendInfo:
 TrackName: Circuit de Spa-Francorchamps
 TrackID: 13
 TrackLength: 7.004 km
 TrackDisplayName: Circuit de Spa-Francorchamps
 TrackDisplayShortName: Spa
 TrackConfigName: Grand Prix
 TrackCity: Francorchamps
 TrackCountry: Belgium
 TrackAltitude: 415.00 m
 TrackLatitude: 50.437222 m
 TrackLongitude: 5.971389 m
 TrackNumTurns: 20
 TrackPitSpeedLimit: 60.00 kph
 TrackType: road course
 TrackDirection: neutral
 TrackWeatherType: 0
 TrackSkies: Partly Cloudy
 TrackSurfaceTemp: 32.22 C
 TrackAirTemp: 25.56 C
 TrackAirPressure: 29.33 Hg
 TrackWindVel: 0.89 m/s
 TrackWindDir: 0.00 rad
 TrackRelativeHumidity: 55 %
 TrackFogLevel: 0 %
 TrackPrecipitation: 0 %
 SeriesID: 0
 SeasonID: 0
 SessionID: 0
 SubSessionID: 0
 LeagueID: 0
 Official: 0
 RaceWeek: 0
 EventType: Test
 Category: Road
 SimMode: full
 TeamRacing: 0
 MinDrivers: 0
 MaxDrivers: 0
 DCRuleSet: None
 QualifierMustStartRace: 0
 NumCarClasses: 1
 NumCarTypes: 1
 HeatRacing: 0
 BuildType: Release
 BuildTarget: Members
 BuildVersion: 2025.03.04.01
 WeekendOptions:
  NumStarters: 0
  StartingGrid: single file
  QualifyScoring: best lap
  CourseCautions: off
  StandingStart: 0
  ShortParadeLap: 0
  Restarts: single file
  WeatherType: 0
  Skies: Partly Cloudy
  WindDirection: N
  WindSpeed: 3.22 km/h
  WeatherTemp: 25.56 C
  RelativeHumidity: 55 %
  FogLevel: 0 %
  TimeOfDay: 12:00 pm
  Date: 2025-06-21
  EarthRotationSpeedupFactor: 1
  Unofficial: 0
  CommercialMode: consumer
  NightMode: variable
  IsFixedSetup: 0
  StrictLapsChecking: default
  HasOpenRegistration: 0
  HardcoreLevel: 1
  NumJokerLaps: 0
  IncidentLimit: unlimited

SessionInfo:
 Sessions:
 - SessionNum: 0
   SessionLaps: unlimited
   SessionTime: unlimited
   SessionNumLapsToAvg: 0
   SessionType: Practice
   SessionTrackRubberState: moderately low usage
   SessionName: PRACTICE
   SessionSubType:
   SessionSkipped: 0
   SessionRunGroupsUsed: 0
   ResultsPositions: []
   ResultsFastestLap:
   - CarIdx: 255
     FastestLap: 0
     FastestTime: -1.0000
   ResultsAverageLapTime: -1.0000
   ResultsNumCautionFlags: 0
   ResultsNumCautionLaps: 0
   ResultsNumLeadChanges: 0
   ResultsLapsComplete: -1
   ResultsOfficial: 0

CameraInfo:
 Groups:
 - GroupNum: 1
   GroupName: Nose
   Cameras:
   - CameraNum: 1
     CameraName: CamNose
 - GroupNum: 2
   GroupName: Gearbox
   Cameras:
   - CameraNum: 1
     CameraName: CamGearbox
 - GroupNum: 3
   GroupName: Roll Bar
   Cameras:
   - CameraNum: 1
     CameraName: CamRoll Bar
 - GroupNum: 4
   GroupName: LF Susp
   Cameras:
   - CameraNum: 1
     CameraName: CamLF Susp
 - GroupNum: 5
   GroupName: LR Susp
   Cameras:
   - CameraNum: 1
     CameraName: CamLR Susp
 - GroupNum: 6
   GroupName: Gyro
   Cameras:
   - CameraNum: 1
     CameraName: CamGyro
 - GroupNum: 7
   GroupName: RF Susp
   Cameras:
   - CameraNum: 1
     CameraName: CamRF Susp
 - GroupNum: 8
   GroupName: RR Susp
   Cameras:
   - CameraNum: 1
     CameraName: CamRR Susp
 - GroupNum: 9
   GroupName: Cockpit
   Cameras:
   - CameraNum: 1
     CameraName: CamCockpit
 - GroupNum: 10
   GroupName: Scenic
   IsScenic: true
   Cameras:
   - CameraNum: 1
     CameraName: Scenic_03
   - CameraNum: 2
     CameraName: Scenic_04
   - CameraNum: 3
     CameraName: Scenic_05
   - CameraNum: 4
     CameraName: Scenic_06
   - CameraNum: 5
     CameraName: Scenic_07
   - CameraNum: 6
     CameraName: Scenic_01
   - CameraNum: 7
     CameraName: Scenic_02
 - GroupNum: 11
   GroupName: Spotter
   Cameras:
   - CameraNum: 1
     CameraName: CamSpotter
 - GroupNum: 12
   GroupName: TV1
   Cameras:
   - CameraNum: 1
     CameraName: CamTV1_00
   - CameraNum: 2
     CameraName: CamTV1_01
   - CameraNum: 3
     CameraName: CamTV1_02
   - CameraNum: 4
     CameraName: CamTV1_02b
   - CameraNum: 5
     CameraName: CamTV1_03
 - GroupNum: 13
   GroupName: TV2
   Cameras:
   - CameraNum: 1
     CameraName: CamTV2_00b
   - CameraNum: 2
     CameraName: CamTV2_09
   - CameraNum: 3
     CameraName: CamTV2_10
   - CameraNum: 4
     CameraName: CamTV2_00
   - CameraNum: 5
     CameraName: CamTV2_02
   - CameraNum: 6
     CameraName: CamTV2_01
   - CameraNum: 7
     CameraName: CamTV2_06
   - CameraNum: 8
     CameraName: CamTV2_08
 - GroupNum: 14
   GroupName: TV3
   Cameras:
   - CameraNum: 1
     CameraName: CamTV3_00
   - CameraNum: 2
     CameraName: CamTV3_01
 - GroupNum: 15
   GroupName: TV4
   Cameras:
   - CameraNum: 1
     CameraName: CamTV5_01
 - GroupNum: 16
   GroupName: TV Static
   Cameras:
   - CameraNum: 1
     CameraName: CamTV4_00
   - CameraNum: 2
     CameraName: CamTV4_04
   - CameraNum: 3
     CameraName: CamTV4_01
   - CameraNum: 4
     CameraName: CamTV4_02
   - CameraNum: 5
     CameraName: CamTV4_03
   - CameraNum: 6
     CameraName: CamTV4_05
   - CameraNum: 7
     CameraName: CamTV4_06
 - GroupNum: 17
   GroupName: TV Mixed
   Cameras:
   - CameraNum: 1
     CameraName: CamTV1_00
   - CameraNum: 2
     CameraName: CamTV1_01
   - CameraNum: 3
     CameraName: CamTV1_02
   - CameraNum: 4
     CameraName: CamTV1_02b
   - CameraNum: 5
     CameraName: CamTV1_03
   - CameraNum: 6
     CameraName: CamTV2_00
   - CameraNum: 7
     CameraName: CamTV2_00b
   - CameraNum: 8
     CameraName: CamTV2_01
   - CameraNum: 9
     CameraName: CamTV2_02
   - CameraNum: 10
     CameraName: CamTV2_06
   - CameraNum: 11
     CameraName: CamTV2_08
   - CameraNum: 12
     CameraName: CamTV2_09
   - CameraNum: 13
     CameraName: CamTV2_10
   - CameraNum: 14
     CameraName: CamTV3_00
   - CameraNum: 15
     CameraName: CamTV3_01
   - CameraNum: 16
     CameraName: CamTV4_00
   - CameraNum: 17
     CameraName: CamTV4_01
   - CameraNum: 18
     CameraName: CamTV4_02
   - CameraNum: 19
     CameraName: CamTV4_03
   - CameraNum: 20
     CameraName: CamTV4_04
   - CameraNum: 21
     CameraName: CamTV4_05
   - CameraNum: 22
     CameraName: CamTV4_06
   - CameraNum: 23
     CameraName: CamRoll Bar
 - GroupNum: 18
   GroupName: Spectator
   Cameras:
   - CameraNum: 1
     CameraName: CamSpectator
 - GroupNum: 19
   GroupName: Pit Lane
   Cameras:
   - CameraNum: 1
     CameraName: CamPit Lane
 - GroupNum: 20
   GroupName: Pit Lane 2
   Cameras:
   - CameraNum: 1
     CameraName: CamPit Lane 2
 - GroupNum: 21
   GroupName: Blimp
   Cameras:
   - CameraNum: 1
     CameraName: CamBlimp
 - GroupNum: 22
   GroupName: Chopper
   Cameras:
   - CameraNum: 1
     CameraName: CamChopper
 - GroupNum: 23
   GroupName: Chase
   Cameras:
   - CameraNum: 1
     CameraName: CamChase
 - GroupNum: 24
   GroupName: Far Chase
   Cameras:
   - CameraNum: 1
     CameraName: CamFar Chase
 - GroupNum: 25
   GroupName: Rear Chase
   Cameras:
   - CameraNum: 1
     CameraName: CamRear Chase

RadioInfo:
 SelectedRadioNum: 0
 Radios:
 - RadioNum: 0
   HopCount: 1
   NumFrequencies: 7
   TunedToFrequencyNum: 0
   ScanningIsOn: 1
   Frequencies:
   - FrequencyNum: 0
     FrequencyName: "@ALLTEAMS"
     Priority: 12
     CarIdx: -1
     EntryIdx: -1
     ClubID: 0
     CanScan: 1
     CanSquawk: 1
     Muted: 0
     IsMutable: 1
     IsDeletable: 0

DriverInfo:
 DriverCarIdx: 0
 DriverUserID: 12345
 PaceCarIdx: -1
 DriverHeadPosX: -0.050
 DriverHeadPosY: 0.350
 DriverHeadPosZ: 0.500
 DriverCarIdleRPM: 800.000
 DriverCarRedLine: 8500.000
 DriverCarEngCylinderCount: 6
 DriverCarFuelKgPerLtr: 0.750
 DriverCarFuelMaxLtr: 110.000
 DriverCarMaxFuelPct: 1.000
 DriverCarGearNumForward: 6
 DriverCarGearNeutral: 1
 DriverCarGearReverse: 1
 DriverCarSLFirstRPM: 6500.000
 DriverCarSLShiftRPM: 8000.000
 DriverCarSLLastRPM: 8500.000
 DriverCarSLBlinkRPM: 8200.000
 DriverCarVersion: 2025.03.04.01
 DriverPitTrkPct: 0.129032
 DriverCarEstLapTime: 137.5000
 DriverSetupName: baseline.sto
 DriverSetupIsModified: 0
 DriverSetupLoadTypeName: user
 DriverSetupPassedTech: 1
 DriverIncidentCount: 0
 Drivers:
 - CarIdx: 0
   UserName: Mock Driver
   AbbrevName: M. Driver
   Initials: MD
   UserID: 12345
   TeamID: 0
   TeamName: Mock Racing
   CarNumber: "1"
   CarNumberRaw: 1
   CarClassID: 0
   CarID: 1
   CarIsPaceCar: 0
   CarIsAI: 0
   CarIsElectric: 0
   CarScreenName: Mock Car GT3
   CarScreenNameShort: Mock GT3
   CarClassShortName:
   CarClassRelSpeed: 0
   CarClassLicenseLevel: 0
   CarClassMaxFuelPct: 1.000
   CarClassWeightPenalty: 0.000
   CarClassPowerAdjust: 0.000
   CarClassDryTireSetLimit: 0 /run
   CarClassColor: 0xffffff
   CarClassEstLapTime: 137.5000
   IRating: 3500
   LicLevel: 12
   LicSubLevel: 499
   LicString: A 4.99
   LicColor: 0x0153db
   IsSpectator: 0
   CarDesignStr: 0,ffffff,ff0000,000000
   HelmetDesignStr: 0,ffffff,ff0000,000000
   SuitDesignStr: 0,ffffff,ff0000,000000
   BodyType: 0
   FaceType: 0
   HelmetType: 0
   CarNumberDesignStr: 0,0,ffffff,777777,000000
   CarSponsor_1: 0
   CarSponsor_2: 0
   CurDriverIncidentCount: 0
   TeamIncidentCount: 0
 - CarIdx: 1
   UserName: AI Driver One
   AbbrevName: A. One
   Initials: AO
   UserID: 23456
   TeamID: 0
   TeamName: AI Team Alpha
   CarNumber: "42"
   CarNumberRaw: 42
   CarClassID: 0
   CarID: 1
   CarIsPaceCar: 0
   CarIsAI: 1
   CarIsElectric: 0
   CarScreenName: Mock Car GT3
   CarScreenNameShort: Mock GT3
   CarClassShortName:
   CarClassRelSpeed: 0
   CarClassLicenseLevel: 0
   CarClassMaxFuelPct: 1.000
   CarClassWeightPenalty: 0.000
   CarClassPowerAdjust: 0.000
   CarClassDryTireSetLimit: 0 /run
   CarClassColor: 0xffffff
   CarClassEstLapTime: 137.5000
   IRating: 2800
   LicLevel: 8
   LicSubLevel: 350
   LicString: B 3.50
   LicColor: 0x00c702
   IsSpectator: 0
   CarDesignStr: 1,0000ff,ffffff,ff0000
   HelmetDesignStr: 1,0000ff,ffffff,ff0000
   SuitDesignStr: 1,0000ff,ffffff,ff0000
   BodyType: 0
   FaceType: 0
   HelmetType: 0
   CarNumberDesignStr: 0,0,ffffff,777777,000000
   CarSponsor_1: 0
   CarSponsor_2: 0
   CurDriverIncidentCount: 0
   TeamIncidentCount: 0
 - CarIdx: 2
   UserName: AI Driver Two
   AbbrevName: A. Two
   Initials: AT
   UserID: 34567
   TeamID: 0
   TeamName: AI Team Beta
   CarNumber: "77"
   CarNumberRaw: 77
   CarClassID: 0
   CarID: 1
   CarIsPaceCar: 0
   CarIsAI: 1
   CarIsElectric: 0
   CarScreenName: Mock Car GT3
   CarScreenNameShort: Mock GT3
   CarClassShortName:
   CarClassRelSpeed: 0
   CarClassLicenseLevel: 0
   CarClassMaxFuelPct: 1.000
   CarClassWeightPenalty: 0.000
   CarClassPowerAdjust: 0.000
   CarClassDryTireSetLimit: 0 /run
   CarClassColor: 0xffffff
   CarClassEstLapTime: 137.5000
   IRating: 2200
   LicLevel: 6
   LicSubLevel: 250
   LicString: C 2.50
   LicColor: 0xfeec04
   IsSpectator: 0
   CarDesignStr: 2,ff0000,000000,ffffff
   HelmetDesignStr: 2,ff0000,000000,ffffff
   SuitDesignStr: 2,ff0000,000000,ffffff
   BodyType: 0
   FaceType: 0
   HelmetType: 0
   CarNumberDesignStr: 0,0,ffffff,777777,000000
   CarSponsor_1: 0
   CarSponsor_2: 0
   CurDriverIncidentCount: 0
   TeamIncidentCount: 0

SplitTimeInfo:
 Sectors:
 - SectorNum: 0
   SectorStartPct: 0.000000
 - SectorNum: 1
   SectorStartPct: 0.333333
 - SectorNum: 2
   SectorStartPct: 0.666667
...
`;
