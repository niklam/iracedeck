//------
#define MIN_WIN_VER 0x0501

#ifndef WINVER
#	define WINVER			MIN_WIN_VER
#endif

#ifndef _WIN32_WINNT
#	define _WIN32_WINNT		MIN_WIN_VER 
#endif

#pragma warning(disable:4996) //_CRT_SECURE_NO_WARNINGS

#include <Windows.h>
#include <stdio.h>
#include <conio.h>
#include <signal.h>
#include <time.h>
#include <assert.h>
#include <math.h>

#include "irsdk_defines.h"
#include "irsdk_client.h"
#include "yaml_parser.h"

#include "console.h"

// for timeBeginPeriod
#pragma comment(lib, "Winmm")


// uncomment to dump race info to dos box as well as to yaml files
//#define DUMP_TO_DISPLAY

// 'live' session info

// Live weather info, may change as session progresses
irsdkCVar g_AirDensity("AirDensity"); // (float) kg/m^3, Density of air at start/finish line
irsdkCVar g_AirPressure("AirPressure"); // (float) Hg, Pressure of air at start/finish line
irsdkCVar g_AirTemp("AirTemp"); // (float) C, Temperature of air at start/finish line
irsdkCVar g_FogLevel("FogLevel"); // (float) %, Fog level
irsdkCVar g_RelativeHumidity("RelativeHumidity"); // (float) %, Relative Humidity
irsdkCVar g_Skies("Skies"); // (int) Skies (0=clear/1=p cloudy/2=m cloudy/3=overcast)
irsdkCVar g_TrackTempCrew("TrackTempCrew"); // (float) C, Temperature of track measured by crew around track
irsdkCVar g_WeatherType("WeatherType"); // (int) Weather type (0=constant 1=dynamic)
irsdkCVar g_WindDir("WindDir"); // (float) rad, Wind direction at start/finish line
irsdkCVar g_WindVel("WindVel"); // (float) m/s, Wind velocity at start/finish line

// session status
irsdkCVar g_PitsOpen("PitsOpen"); // (bool) True if pit stop is allowed, basically true if caution lights not out
irsdkCVar g_RaceLaps("RaceLaps"); // (int) Laps completed in race
irsdkCVar g_SessionFlags("SessionFlags"); // (int) irsdk_Flags, bitfield
irsdkCVar g_SessionLapsRemain("SessionLapsRemain"); // (int) Laps left till session ends
irsdkCVar g_SessionLapsRemainEx("SessionLapsRemainEx"); // (int) New improved laps left till session ends
irsdkCVar g_SessionNum("SessionNum"); // (int) Session number
irsdkCVar g_SessionState("SessionState"); // (int) irsdk_SessionState, Session state
irsdkCVar g_SessionTick("SessionTick"); // (int) Current update number
irsdkCVar g_SessionTime("SessionTime"); // (double), s, Seconds since session start
irsdkCVar g_SessionTimeOfDay("SessionTimeOfDay"); // (float) s, Time of day in seconds
irsdkCVar g_SessionTimeRemain("SessionTimeRemain"); // (double) s, Seconds left till session ends
irsdkCVar g_SessionUniqueID("SessionUniqueID"); // (int) Session ID

// competitor information, array of up to 64 cars
irsdkCVar g_CarIdxEstTime("CarIdxEstTime"); // (float) s, Estimated time to reach current location on track
irsdkCVar g_CarIdxClassPosition("CarIdxClassPosition"); // (int) Cars class position in race by car index
irsdkCVar g_CarIdxF2Time("CarIdxF2Time"); // (float) s, Race time behind leader or fastest lap time otherwise
irsdkCVar g_CarIdxGear("CarIdxGear"); // (int) -1=reverse 0=neutral 1..n=current gear by car index
irsdkCVar g_CarIdxLap("CarIdxLap"); // (int) Lap count by car index
irsdkCVar g_CarIdxLapCompleted("CarIdxLapCompleted"); // (int) Laps completed by car index
irsdkCVar g_CarIdxLapDistPct("CarIdxLapDistPct"); // (float) %, Percentage distance around lap by car index
irsdkCVar g_CarIdxOnPitRoad("CarIdxOnPitRoad"); // (bool) On pit road between the cones by car index
irsdkCVar g_CarIdxPosition("CarIdxPosition"); // (int) Cars position in race by car index
irsdkCVar g_CarIdxRPM("CarIdxRPM"); // (float) revs/min, Engine rpm by car index
irsdkCVar g_CarIdxSteer("CarIdxSteer"); // (float) rad, Steering wheel angle by car index
irsdkCVar g_CarIdxTrackSurface("CarIdxTrackSurface"); // (int) irsdk_TrkLoc, Track surface type by car index
irsdkCVar g_CarIdxTrackSurfaceMaterial("CarIdxTrackSurfaceMaterial"); // (int) irsdk_TrkSurf, Track surface material type by car index

// new variables
irsdkCVar g_CarIdxLastLapTime("CarIdxLastLapTime"); // (float) s, Cars last lap time
irsdkCVar g_CarIdxBestLapTime("CarIdxBestLapTime"); // (float) s, Cars best lap time
irsdkCVar g_CarIdxBestLapNum("CarIdxBestLapNum"); // (int) Cars best lap number

irsdkCVar g_CarIdxP2P_Status("CarIdxP2P_Status"); // (bool) Push2Pass active or not
irsdkCVar g_CarIdxP2P_Count("CarIdxP2P_Count"); // (int) Push2Pass count of usage (or remaining in Race)

irsdkCVar g_PaceMode("PaceMode"); // (int) irsdk_PaceMode, Are we pacing or not
irsdkCVar g_CarIdxPaceLine("CarIdxPaceLine"); // (int) What line cars are pacing in, or -1 if not pacing
irsdkCVar g_CarIdxPaceRow("CarIdxPaceRow"); // (int) What row cars are pacing in, or -1 if not pacing
irsdkCVar g_CarIdxPaceFlags("CarIdxPaceFlags"); // (int) irsdk_PaceFlags, Pacing status flags for each car

const int g_maxCars = 64;
const int g_maxNameLen = 64;

double g_lastTime = -1;
float g_lastDistPct[g_maxCars] = { -1 };
double g_lapStartTime[g_maxCars] = { -1 };
// lap time for last lap, or -1 if not yet completed a lap
float g_lapTime[g_maxCars] = { -1 };

struct DriverEntry
{
	int carIdx;
	int carClassId;
	char driverName[g_maxNameLen];
	char teamName[g_maxNameLen];
	char carNumStr[10]; // the player car number as a character string so we can handle 001 and other oddities
};

// updated for each driver as they cross the start/finish line
DriverEntry g_driverTableTable[g_maxCars];

// notify everyone when we update the file
static const _TCHAR IRSDK_LAPTIMINGDATAVALIDEVENTNAME[] = _T("Local\\IRSDKLapTimingDataValidEvent");
HANDLE hDataValidEvent = NULL;

//****Note, implement this listener on client side to get notifications when data is updated
/*
// startup on client side
hDataValidEvent = OpenEvent(SYNCHRONIZE, false, IRSDK_LAPTIMINGDATAVALIDEVENTNAME);

// sleep till signaled
if(hDataValidEvent)
	WaitForSingleObject(hDataValidEvent, timeOut);

// shutdown
if(hDataValidEvent)
	CloseHandle(hDataValidEvent);
*/

//---------------------------

bool parceYamlInt(const char *yamlStr, const char *path, int *dest)
{
	if(dest)
	{
		(*dest) = 0;

		if(yamlStr && path)
		{
			int count;
			const char *strPtr;

			if(parseYaml(yamlStr, path, &strPtr, &count))
			{
				(*dest) = atoi(strPtr);
				return true;
			}
		}
	}

	return false;
}

bool parceYamlStr(const char *yamlStr, const char *path, char *dest, int maxCount)
{
	if(dest && maxCount > 0)
	{
		dest[0] = '\0';

		if(yamlStr && path)
		{
			int count;
			const char *strPtr;

			if(parseYaml(yamlStr, path, &strPtr, &count))
			{
				// strip leading quotes
				if(*strPtr == '"')
				{
					strPtr++;
					count--;
				}

				int l = min(count, maxCount);
				strncpy(dest, strPtr, l);
				dest[l] = '\0';

				// strip trailing quotes
				if(l >= 1 && dest[l-1] == '"')
					dest[l-1] = '\0';

				return true;
			}
		}
	}

	return false;
}

//---------------------------

void resetState(bool isNewConnection)
{
	if(isNewConnection)
		memset(g_driverTableTable, 0, sizeof(g_driverTableTable));

	for(int i=0; i<g_maxCars; i++)
	{
		g_lastTime = -1;
		g_lastDistPct[i] = -1;
		g_lapStartTime[i] = -1;
		g_lapTime[i] = -1;
	}
}

// helper function to handle interpolation across a checkpoint
// p1,t1 are position and time before checkpoint
// p2,t2 are position and time after checkpoint
// pCheck is position of checkpoint
double interpolateTimeAcrossPoint(double t1, double t2, float p1, float p2, float pCheck) 
{ 
	// unwrap if crossing start/finish line
	//****Note, assumes p1 is a percent from 0 to 1
	// if that is not true then unwrap the numbers before calling this function
	if(p1 > p2)
		p1 -= 1;

	// calculate where line is between points
	float pct = (pCheck - p1) / (p2 - p1);

	return t1 + (t2-t1) * pct; 
}

void processLapInfo()
{
	// work out lap times for all cars
	double curTime = g_SessionTime.getDouble();

	// if time moves backwards were in a new session!
	if(g_lastTime > curTime)
		resetState(false);

	for(int i=0; i<g_maxCars; i++)
	{
		float curDistPct = g_CarIdxLapDistPct.getFloat(i);
		// reject if the car blinked out of the world
		if(curDistPct != -1)
		{
			// did we cross the lap?
			if(g_lastDistPct[i] > 0.9f && curDistPct < 0.1f)
			{
				// calculate exact time of lap crossing
				double curLapStartTime = interpolateTimeAcrossPoint(g_lastTime, curTime, g_lastDistPct[i], curDistPct, 0);

				// calculate lap time, if already crossed start/finish
				if(g_lapStartTime[i] != -1)
					g_lapTime[i] = (float)(curLapStartTime - g_lapStartTime[i]);

				// and store start/finish crossing time for next lap
				g_lapStartTime[i] = curLapStartTime;
			}

			g_lastDistPct[i] = curDistPct;
		}
	}

	g_lastTime = curTime;
}

const char* generateLiveYAMLString()
{
	//****Warning, shared static memory!
	static const int m_len = 50000;
	static char tstr[m_len] = "";
	int len = 0;

	// Start of YAML file
	len += _snprintf(tstr+len, m_len-len,"---\n");

	// Live weather info, may change as session progresses
	len += _snprintf(tstr+len, m_len-len,"WeatherStatus:\n");
	len += _snprintf(tstr+len, m_len-len," AirDensity: %.2f\n", g_AirDensity.getFloat()); // kg/m^3, Density of air at start/finish line
	len += _snprintf(tstr+len, m_len-len," AirPressure: %.2f\n", g_AirPressure.getFloat()); // Hg, Pressure of air at start/finish line
	len += _snprintf(tstr+len, m_len-len," AirTemp: %.2f\n", g_AirTemp.getFloat()); // C, Temperature of air at start/finish line
	len += _snprintf(tstr+len, m_len-len," FogLevel: %.2f\n", g_FogLevel.getFloat()); // %, Fog level
	len += _snprintf(tstr+len, m_len-len," RelativeHumidity: %.2f\n", g_RelativeHumidity.getFloat()); // %, Relative Humidity
	len += _snprintf(tstr+len, m_len-len," Skies: %d\n", g_Skies.getInt()); // Skies (0=clear/1=p cloudy/2=m cloudy/3=overcast)
	len += _snprintf(tstr+len, m_len-len," TrackTempCrew: %.2f\n", g_TrackTempCrew.getFloat()); // C, Temperature of track measured by crew around track
	len += _snprintf(tstr+len, m_len-len," WeatherType: %d\n", g_WeatherType.getInt()); // Weather type (0=constant 1=dynamic)
	len += _snprintf(tstr+len, m_len-len," WindDir: %.2f\n", g_WindDir.getFloat()); // rad, Wind direction at start/finish line
	len += _snprintf(tstr+len, m_len-len," WindVel: %.2f\n", g_WindVel.getFloat()); // m/s, Wind velocity at start/finish line
	len += _snprintf(tstr+len, m_len-len,"\n");

	// session status
	len += _snprintf(tstr+len, m_len-len,"SessionStatus:\n");
	len += _snprintf(tstr+len, m_len-len," PitsOpen: %d\n", g_PitsOpen.getBool()); // True if pit stop is allowed, basically true if caution lights not out
	len += _snprintf(tstr+len, m_len-len," RaceLaps: %d\n", g_RaceLaps.getInt()); // Laps completed in race
	len += _snprintf(tstr+len, m_len-len," SessionFlags: %d\n", g_SessionFlags.getInt()); // irsdk_Flags, bitfield
	len += _snprintf(tstr+len, m_len-len," SessionLapsRemain: %d\n", g_SessionLapsRemain.getInt()); // Laps left till session ends
	len += _snprintf(tstr+len, m_len-len," SessionLapsRemainEx: %d\n", g_SessionLapsRemainEx.getInt()); // New improved laps left till session ends
	len += _snprintf(tstr+len, m_len-len," SessionNum: %d\n", g_SessionNum.getInt()); // Session number
	len += _snprintf(tstr+len, m_len-len," SessionState: %d\n", g_SessionState.getInt()); // irsdk_SessionState, Session state
	len += _snprintf(tstr+len, m_len-len," SessionTick: %d\n", g_SessionTick.getInt()); // Current update number
	len += _snprintf(tstr+len, m_len-len," SessionTime: %.12f\n", g_SessionTime.getDouble()); // s, Seconds since session start
	len += _snprintf(tstr+len, m_len-len," SessionTimeOfDay: %.6f\n", g_SessionTimeOfDay.getFloat()); // s, Time of day in seconds
	len += _snprintf(tstr+len, m_len-len," SessionTimeRemain: %.12f\n", g_SessionTimeRemain.getDouble()); // s, Seconds left till session ends
	len += _snprintf(tstr+len, m_len-len," SessionUniqueID: %d\n", g_SessionUniqueID.getInt()); // Session ID
	len += _snprintf(tstr+len, m_len-len,"\n");

	// competitor information, array of up to 64 cars
	len += _snprintf(tstr+len, m_len-len,"CarStatus:\n");
	if(g_PaceMode.isValid())
		len += _snprintf(tstr+len, m_len-len," PaceMode: %d\n", g_PaceMode.getInt()); // irsdk_PaceMode, Are we pacing or not

	len += _snprintf(tstr+len, m_len-len," Cars:\n");
	for(int i=0; i<g_maxCars; i++)
	{
		len += _snprintf(tstr+len, m_len-len," - CarIdx: %d\n", i); // for convenience, the index into the array is the carIdx
		len += _snprintf(tstr+len, m_len-len,"   CarIdxEstTime: %.6f\n", g_CarIdxEstTime.getFloat(i)); // s, Estimated time to reach current location on track
		len += _snprintf(tstr+len, m_len-len,"   CarIdxClassPosition: %d\n", g_CarIdxClassPosition.getInt(i)); // Cars class position in race by car index
		len += _snprintf(tstr+len, m_len-len,"   CarIdxF2Time: %.6f\n", g_CarIdxF2Time.getFloat(i)); // s, Race time behind leader or fastest lap time otherwise
		len += _snprintf(tstr+len, m_len-len,"   CarIdxGear: %d\n", g_CarIdxGear.getInt(i)); // -1=reverse 0=neutral 1..n=current gear by car index
		len += _snprintf(tstr+len, m_len-len,"   CarIdxLap: %d\n", g_CarIdxLap.getInt(i)); // Lap count by car index
		len += _snprintf(tstr+len, m_len-len,"   CarIdxLapCompleted: %d\n", g_CarIdxLapCompleted.getInt(i)); // Laps completed by car index
		len += _snprintf(tstr+len, m_len-len,"   CarIdxLapDistPct: %.6f\n", g_CarIdxLapDistPct.getFloat(i)); // %, Percentage distance around lap by car index
		len += _snprintf(tstr+len, m_len-len,"   CarIdxOnPitRoad: %d\n", g_CarIdxOnPitRoad.getBool(i)); // On pit road between the cones by car index
		len += _snprintf(tstr+len, m_len-len,"   CarIdxPosition: %d\n", g_CarIdxPosition.getInt(i)); // Cars position in race by car index
		len += _snprintf(tstr+len, m_len-len,"   CarIdxRPM: %.2f\n", g_CarIdxRPM.getFloat(i)); // revs/min, Engine rpm by car index
		len += _snprintf(tstr+len, m_len-len,"   CarIdxSteer: %.2f\n", g_CarIdxSteer.getFloat(i)); // rad, Steering wheel angle by car index
		len += _snprintf(tstr+len, m_len-len,"   CarIdxTrackSurface: %d\n", g_CarIdxTrackSurface.getInt(i)); // irsdk_TrkLoc, Track surface type by car index
		len += _snprintf(tstr+len, m_len-len,"   CarIdxTrackSurfaceMaterial: %d\n", g_CarIdxTrackSurfaceMaterial.getInt(i)); // irsdk_TrkSurf, Track surface material type by car index

		//****Note, don't use this one any more, it is replaced by CarIdxLastLapTime
		len += _snprintf(tstr+len, m_len-len,"   CarIdxLapTime: %.6f\n", g_lapTime[i]); // s, last lap time or -1 if not yet crossed s/f

		// new variables, check if they exist on members
		if(g_CarIdxLastLapTime.isValid())
			len += _snprintf(tstr+len, m_len-len,"   CarIdxLastLapTime: %.6f\n", g_CarIdxLastLapTime.getFloat(i)); // s, Cars last lap time
		if(g_CarIdxBestLapTime.isValid())
			len += _snprintf(tstr+len, m_len-len,"   CarIdxBestLapTime: %.6f\n", g_CarIdxBestLapTime.getFloat(i)); // s, Cars best lap time
		if(g_CarIdxBestLapNum.isValid())
			len += _snprintf(tstr+len, m_len-len,"   CarIdxBestLapNum: %d\n", g_CarIdxBestLapNum.getInt(i)); // Cars best lap number
		if(g_CarIdxP2P_Status.isValid())
			len += _snprintf(tstr+len, m_len-len,"   CarIdxP2P_Status: %d\n", g_CarIdxP2P_Status.getBool(i)); // Push2Pass active or not
		if(g_CarIdxP2P_Count.isValid())
			len += _snprintf(tstr+len, m_len-len,"   CarIdxP2P_Count: %d\n", g_CarIdxP2P_Count.getInt(i)); // Push2Pass count of usage (or remaining in Race)
		if(g_CarIdxPaceLine.isValid())
			len += _snprintf(tstr+len, m_len-len,"   CarIdxPaceLine: %d\n", g_CarIdxPaceLine.getInt(i)); // What line cars are pacing in, or -1 if not pacing
		if(g_CarIdxPaceRow.isValid())
			len += _snprintf(tstr+len, m_len-len,"   CarIdxPaceRow: %d\n", g_CarIdxPaceRow.getInt(i)); // What row cars are pacing in, or -1 if not pacing
		if(g_CarIdxPaceFlags.isValid())
			len += _snprintf(tstr+len, m_len-len,"   CarIdxPaceFlags: %d\n", g_CarIdxPaceFlags.getInt(i)); // irsdk_PaceFlags, Pacing status flags for each car
	}
	len += _snprintf(tstr+len, m_len-len,"\n");

	// End of YAML file
	len += _snprintf(tstr+len, m_len-len,"...\n");

	// terminate string in case we blew off the end of the array.
	tstr[m_len-1] = '\0'; 

	// make sure we are not close to running out of room
	// if this triggers then double m_len
	assert(len < (m_len-256)); 

	return tstr;
}

// called 60 times a second, if we are connected
bool processYAMLLiveString()
{
	static DWORD lastTime = 0;
	bool wasUpdated = false;

	//****Note, your code goes here
	// can write to disk, parse, etc

	// output file once every 1 seconds
	DWORD minTime = (DWORD)(1.0f * 1000);
	DWORD curTime = timeGetTime(); // millisecond resolution
	if(abs((long long)(curTime - lastTime)) > minTime)
	{
		lastTime = curTime;

		const char *yamlStr = generateLiveYAMLString();
		// validate string
		if(yamlStr && yamlStr[0])
		{
			FILE *f = fopen("liveStr.txt", "w");
			if(f)
			{
				fputs(yamlStr, f);
				fclose(f);
				f = NULL;
				wasUpdated = true;
			}
		}
	}

	return wasUpdated;
}

// called only when it changes
void processYAMLSessionString(const char *yamlStr)
{
	// validate string
	if(yamlStr && yamlStr[0])
	{
		FILE *f = fopen("sessionStr.txt", "w");
		if(f)
		{
			fputs(yamlStr, f);
			fclose(f);
			f = NULL;
		}

		//---

		// Pull some driver info into a local array

		char tstr[256];
		for(int i=0; i<g_maxCars; i++)
		{
			// skip the rest if carIdx not found
			sprintf(tstr, "DriverInfo:Drivers:CarIdx:{%d}", i);
			if(parceYamlInt(yamlStr, tstr, &(g_driverTableTable[i].carIdx)))
			{
				sprintf(tstr, "DriverInfo:Drivers:CarIdx:{%d}CarClassID:", i);
				parceYamlInt(yamlStr, tstr, &(g_driverTableTable[i].carClassId));

				sprintf(tstr, "DriverInfo:Drivers:CarIdx:{%d}UserName:", i);
				parceYamlStr(yamlStr, tstr, g_driverTableTable[i].driverName, sizeof(g_driverTableTable[i].driverName)-1);

				sprintf(tstr, "DriverInfo:Drivers:CarIdx:{%d}TeamName:", i);
				parceYamlStr(yamlStr, tstr, g_driverTableTable[i].teamName, sizeof(g_driverTableTable[i].teamName)-1);

				sprintf(tstr, "DriverInfo:Drivers:CarIdx:{%d}CarNumber:", i);
				parceYamlStr(yamlStr, tstr, g_driverTableTable[i].carNumStr, sizeof(g_driverTableTable[i].carNumStr)-1);

				// TeamID
			}
		}


		//---

		//****Note, your code goes here
		// can write to disk, parse, etc

	}
}

void printFlags(int flags)
{
	// global flags
	if(flags & irsdk_checkered) printf("checkered ");
	if(flags & irsdk_white) printf("white ");
	if(flags & irsdk_green) printf("green ");
	if(flags & irsdk_yellow) printf("yellow ");
	if(flags & irsdk_red) printf("red ");
	if(flags & irsdk_blue) printf("blue ");
	if(flags & irsdk_debris) printf("debris ");
	if(flags & irsdk_crossed) printf("crossed ");
	if(flags & irsdk_yellowWaving) printf("yellowWaving ");
	if(flags & irsdk_oneLapToGreen) printf("oneLapToGreen ");
	if(flags & irsdk_greenHeld) printf("greenHeld ");
	if(flags & irsdk_tenToGo) printf("tenToGo ");
	if(flags & irsdk_fiveToGo) printf("fiveToGo ");
	if(flags & irsdk_randomWaving) printf("randomWaving ");
	if(flags & irsdk_caution) printf("caution ");
	if(flags & irsdk_cautionWaving) printf("cautionWaving ");
	
	// drivers black flags
	if(flags & irsdk_black) printf("black ");
	if(flags & irsdk_disqualify) printf("disqualify ");
	if(flags & irsdk_servicible) printf("servicible ");
	if(flags & irsdk_furled) printf("furled ");
	if(flags & irsdk_repair) printf("repair ");
	
	// start lights
	if(flags & irsdk_startHidden) printf("startHidden ");
	if(flags & irsdk_startReady) printf("startReady ");
	if(flags & irsdk_startSet) printf("startSet ");
	if(flags & irsdk_startGo) printf("startGo ");
}

void printTime(double time_s)
{
	int minutes = (int)(time_s / 60);
	float seconds = (float)(time_s - (60 * minutes));
	printf("%03d:%05.2f", minutes, seconds); 
}

void printSessionState(int state)
{
	switch(state)
	{
	case irsdk_StateInvalid:
		printf("Invalid");
		break;
	case irsdk_StateGetInCar:
		printf("GetInCar");
		break;
	case irsdk_StateWarmup:
		printf("Warmup");
		break;
	case irsdk_StateParadeLaps:
		printf("ParadeLap");
		break;
	case irsdk_StateRacing:
		printf("Racing");
		break;
	case irsdk_StateCheckered:
		printf("Checkered");
		break;
	case irsdk_StateCoolDown:
		printf("CoolDown");
		break;
	}
}

void printPaceMode(int mode)
{
	switch(mode)
	{
	case irsdk_PaceModeSingleFileStart:
		printf("SingleFileStart");
		break;
	case irsdk_PaceModeDoubleFileStart:
		printf("DoubleFileStart");
		break;
	case irsdk_PaceModeSingleFileRestart:
		printf("SingleFileRestart");
		break;
	case irsdk_PaceModeDoubleFileRestart:
		printf("DoubleFileRestart:");
		break;
	case irsdk_PaceModeNotPacing:
		printf("NotPacing");
		break;
	}
}

void printPaceFlags(int flags)
{
	if(flags & irsdk_PaceFlagsEndOfLine)
		printf("EndOfLine|");
	if(flags & irsdk_PaceFlagsFreePass)
		printf("FreePass|");
	if(flags & irsdk_PaceFlagsWavedAround)
		printf("WavedAround|");
}

void updateDisplay()
{
	// force console to scroll to top line
	setCursorPosition(0, 0);

	int width, height;
	getConsoleDimensions(width, height);

	int statusOffset = 3;
	int carsOffset = 6;
	int maxCarLines = height - carsOffset;

	// print race status line
	setCursorPosition(0, statusOffset);
	printf("Time: ");
	printTime(g_SessionTime.getDouble());
	
	printf(" Session: %d", g_SessionNum.getInt());

	printf(" LapsComplete: %03d", g_RaceLaps.getInt());

	if(g_SessionLapsRemainEx.getInt() < 32767)
		printf(" LapsRemain: %03d", g_SessionLapsRemainEx.getInt());
	else
		printf(" LapsRemain: Unlimited");

	printf(" TimeRemain: ");
	if(g_SessionTimeRemain.getDouble() < 604800.0f)
		printTime(g_SessionTimeRemain.getDouble());
	else
		printf("Unlimited");

	// print flag status
	setCursorPosition(0, statusOffset+1);
	printf(" flags: ");
	printFlags(g_SessionFlags.getInt());

	printf(" PitsOpen: %d", g_PitsOpen.getBool());

	printf(" State: ");
	printSessionState(g_SessionState.getInt());

	// new variables check if on members
	if(g_PaceMode.isValid())
	{
		printf(" PaceMode: ");
		printPaceMode(g_PaceMode.getInt());
	}

	// print car info
	setCursorPosition(0, carsOffset);
	// don't scroll off the end of the buffer
	int linesUsed = 0;
	int maxLines = min(g_maxCars, maxCarLines);
	for(int i=0; i<g_maxCars; i++)
	{
		if(linesUsed < maxLines)
		{
			// is the car in the world, or did we at least collect data on it when it was?
			if(g_CarIdxTrackSurface.getInt(i) != -1 || g_CarIdxLap.getInt(i) != -1 || g_CarIdxPosition.getInt(i) != 0)
			{
				printf(" %2d %3s %7.3f %2d %2d %2d %6.3f %2d %8.2f %5.2f %2d %2d %2d %2d %7.3f %7.3f %7.3f %7.3f %2d %d %2d %2d %2d 0x%02x\n", 
					i, g_driverTableTable[i].carNumStr,
					g_CarIdxEstTime.getFloat(i), g_CarIdxGear.getInt(i), g_CarIdxLap.getInt(i), g_CarIdxLapCompleted.getInt(i), 
					g_CarIdxLapDistPct.getFloat(i), g_CarIdxOnPitRoad.getBool(i), g_CarIdxRPM.getFloat(i), g_CarIdxSteer.getFloat(i), 
					g_CarIdxTrackSurface.getInt(i), g_CarIdxTrackSurfaceMaterial.getInt(i), 
					g_CarIdxPosition.getInt(i), g_CarIdxClassPosition.getInt(i), g_CarIdxF2Time.getFloat(i),
					//****Note, don't use this one any more, it is replaced by CarIdxLastLapTime
					g_lapTime[i], 
					// new variables, check if they exist on members
					(g_CarIdxLastLapTime.isValid()) ? g_CarIdxLastLapTime.getFloat(i) : -1, 
					(g_CarIdxBestLapTime.isValid()) ? g_CarIdxBestLapTime.getFloat(i) : -1, 
					(g_CarIdxBestLapNum.isValid()) ? g_CarIdxBestLapNum.getInt(i) : -1,
					(g_CarIdxP2P_Status.isValid()) ? g_CarIdxP2P_Status.getBool(i) : -1, 
					(g_CarIdxP2P_Count.isValid()) ? g_CarIdxP2P_Count.getInt(i) : -1,
					(g_CarIdxPaceLine.isValid()) ? g_CarIdxPaceLine.getInt(i) : -1, 
					(g_CarIdxPaceRow.isValid()) ? g_CarIdxPaceRow.getInt(i) : -1, 
					(g_CarIdxPaceFlags.isValid()) ? g_CarIdxPaceFlags.getInt(i) : -1
				);
				linesUsed++;
			}
		}
	}
	// clear remaining lines
	for(int i=linesUsed; i<maxLines; i++)
		printf("                                                                     \n");
}

void monitorConnectionStatus()
{
	// keep track of connection status
	static bool wasConnected = false;

	bool isConnected = irsdkClient::instance().isConnected();
	if(wasConnected != isConnected)
	{
		setCursorPosition(0, 1);
		if(isConnected)
		{
			printf("Connected to iRacing              \n");
			resetState(true);
		}
		else
			printf("Lost connection to iRacing        \n");

		//****Note, put your connection handling here

		wasConnected = isConnected;
	}
}

void run()
{
	// wait up to 16 ms for start of session or new data
	if(irsdkClient::instance().waitForData(16))
	{
		bool wasUpdated = false;

		// and grab the data
		processLapInfo();
		if(processYAMLLiveString())
			wasUpdated = true;

		// only process session string if it changed
		if(irsdkClient::instance().wasSessionStrUpdated())
		{
			processYAMLSessionString(irsdkClient::instance().getSessionStr());
			wasUpdated = true;
		}

		// notify clients
		if(wasUpdated && hDataValidEvent)
			PulseEvent(hDataValidEvent);

#ifdef DUMP_TO_DISPLAY
		// update the display as well
		updateDisplay();
#endif
	}
	// else we did not grab data, do nothing

	// pump our connection status
	monitorConnectionStatus();

	//****Note, add your own additional loop processing here
	// for anything not dependant on telemetry data (keeping a UI running, etc)
}

//-----------------------

void ex_program(int sig) 
{
	(void)sig;

	printf("recieved ctrl-c, exiting\n\n");

	timeEndPeriod(1);

	signal(SIGINT, SIG_DFL);
	exit(0);
}

bool init()
{
	// trap ctrl-c
	signal(SIGINT, ex_program);

	// bump priority up so we get time from the sim
	SetPriorityClass(GetCurrentProcess(), HIGH_PRIORITY_CLASS);

	// ask for 1ms timer so sleeps are more precise
	timeBeginPeriod(1);

	// startup event broadcaster
	hDataValidEvent = CreateEvent(NULL, true, false, IRSDK_DATAVALIDEVENTNAME);

	//****Note, put your init logic here
	
	return true;
}

void deInit()
{
	printf("Shutting down.\n\n");

	// shutdown
	if(hDataValidEvent)
	{
		//make sure event not left triggered (probably redundant)
		ResetEvent(hDataValidEvent);
		CloseHandle(hDataValidEvent);
		hDataValidEvent = NULL;
	}

	timeEndPeriod(1);
}

int main(int argc, char *argv[])
{
	printf("lapTiming 1.1, press any key to exit\n");

	if(init())
	{
		while(!_kbhit())
		{
			run();
		}

		deInit();
	}
	else
		printf("init failed\n");

	return 0;
}

/*
Session Info:
Flag State
Laps Complete
Laps To Go
Session Elapsed Time
Cautions
Caution Laps

Competitor Info:
Name
Number
Manufacturer
Running Position
Laps Completed
Delta To Leader
Delta To Next Car
Last Lap Time
Best Lap Time
On Track/In Pits
Laps Led
Times Led
Last Pit Stop
Times Pitted
Service Completed (2 tires,4 tires, fuel only, etc)
Resets Remaining
Pit Stops:
Lap Number
Car Number
Time in Pits
Service Completed (2 tires, 4 tires, fuel)
Damage repaired (reset?)

Other telemetry that we might be able to play with that would be impossible in real world
racing?
Tire temps
Tire life remaining
Fuel percentage remaining
??? Anything that we would never be able to actually know in a live race, but that we can see
now because we are simming, that we can play up or talk about. 
*/
