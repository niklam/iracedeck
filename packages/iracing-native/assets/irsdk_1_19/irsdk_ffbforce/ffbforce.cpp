//------
#define MIN_WIN_VER 0x0501

#ifndef WINVER
#	define WINVER			MIN_WIN_VER
#endif

#ifndef _WIN32_WINNT
#	define _WIN32_WINNT		MIN_WIN_VER 
#endif

// uncomment to output data in simple csv format
//#define SIMPLEOUTPUT

#pragma warning(disable:4996) //_CRT_SECURE_NO_WARNINGS

#include <stdio.h>
#include <stdlib.h>
#include <cmath>
#include <string.h>
#include <conio.h>

#include "irsdk_defines.h"
#include "irsdk_diskclient.h"

// tune these to your liking
const int maxTorque_Nm = 80; // max number of bins in the histogram
float minSpeed_mps = 2.0f; // car must be going this fast, meters per second
float targetPct = 0.98f; // toss values above this out
float maxPct = 0.995f; // clip our graph to this length

irsdkDiskClient idk;

int isOnTrack_idx = 0; // bool 
int playerTrackSurface_idx = 0; // int
int speed_idx = 0; // float
int steeringWheelTorque_idx = 0; // float

int hist[maxTorque_Nm] = {0};
float histPct[maxTorque_Nm] = {0.0f};
float histPctTot[maxTorque_Nm] = {0.0f};
int histCount = 0;

#define MAX_PATH 270
char outFile[MAX_PATH] = "";


bool init(const char *path)
{
	if(idk.openFile(path))
	{
		isOnTrack_idx = idk.getVarIdx("IsOnTrack");
		playerTrackSurface_idx = idk.getVarIdx("PlayerTrackSurface");
		speed_idx = idk.getVarIdx("Speed");
		steeringWheelTorque_idx = idk.getVarIdx("SteeringWheelTorque");

		if(isOnTrack_idx != -1 &&
			//playerTrackSurface_idx != -1 &&
			speed_idx != -1 &&
			steeringWheelTorque_idx != -1)
		{

			const int MAX_STR = 512;
			char tstr[MAX_STR];
			char tpath[MAX_STR];

			int driverCarIdx = 0;

			if(1 == idk.getSessionStrVal("DriverInfo:DriverCarIdx:", tstr, MAX_STR))
			{
				driverCarIdx = atoi(tstr);

				// car
#ifndef SIMPLEOUTPUT
				printf("Car: ");
#else
//				printf("car,setup,track,Nm,nonLin,lin\n");
#endif
				_snprintf(tpath, MAX_STR, "DriverInfo:Drivers:CarIdx:{%d}CarScreenName:", driverCarIdx);
				tpath[MAX_STR-1] = '\0';
				if(1 == idk.getSessionStrVal(tpath, tstr, MAX_STR))
					printf("%s", tstr);

				sprintf(outFile, "histogram");

				_snprintf(tpath, MAX_STR, "DriverInfo:Drivers:CarIdx:{%d}CarPath:", driverCarIdx);
				tpath[MAX_STR-1] = '\0';
				if(1 == idk.getSessionStrVal(tpath, tstr, MAX_STR))
				{
					printf(" [%s]", tstr);
					sprintf(outFile, "%s %s", outFile, tstr);
				}

#ifndef SIMPLEOUTPUT
				printf("\n");
#else
				printf(",");
#endif

				// setup
#ifndef SIMPLEOUTPUT
				printf("Setup: ");
#endif
				if(1 == idk.getSessionStrVal("DriverInfo:DriverSetupName:", tstr, MAX_STR))
					printf("%s", tstr);

				if(1 == idk.getSessionStrVal("DriverInfo:DriverSetupIsModified:", tstr, MAX_STR))
					if(atoi(tstr) == 1)
						printf(" (modified)");

#ifndef SIMPLEOUTPUT
				printf("\n");
#else
				printf(",");
#endif

				// track
#ifndef SIMPLEOUTPUT
				printf("Track: ");
#endif
				if(1 == idk.getSessionStrVal("WeekendInfo:TrackDisplayName:", tstr, MAX_STR))
					printf("%s", tstr);

				if(1 == idk.getSessionStrVal("WeekendInfo:TrackConfigName:", tstr, MAX_STR))
					printf(" %s", tstr);

				if(1 == idk.getSessionStrVal("WeekendInfo:TrackName:", tstr, MAX_STR))
				{
					printf(" [%s]", tstr);
					sprintf(outFile, "%s %s", outFile, tstr);
				}

#ifndef SIMPLEOUTPUT
				printf("\n");
#else
				printf(",");
#endif

				sprintf(outFile, "%s.csv", outFile);


				return true;
			}
		}
	}

	return false;
}

void process()
{
	// isOnTrack indicates that the player is in his car and ready to race
	bool isOnTrack = idk.getVarBool(isOnTrack_idx);
	// irsdk_OnTrack indicates that the players car is on the racing surface, as opposed to spinning off the track
	int trackSurface = (playerTrackSurface_idx == -1) ? irsdk_OnTrack : idk.getVarInt(playerTrackSurface_idx); // new variable, not avaliable in older telemetry
	// Speed is in meters/second, make sure we are moving before starting to collect data
	float speed = idk.getVarFloat(speed_idx);
	// torque is the force in Nm that the car is applying to the steering wheel in your hands
	float steeringWheelTorque = idk.getVarFloat(steeringWheelTorque_idx);
	
	int torqBin = (int)fabsf(steeringWheelTorque);

	// is this a valid data point?
	if(isOnTrack &&
		trackSurface == irsdk_OnTrack &&
		fabsf(speed) > minSpeed_mps &&
		torqBin < maxTorque_Nm)
	{
		hist[torqBin]++;
		histCount++;
	}
}

void shutdown()
{
	if(histCount < 10)
		printf("not enough valid samples!\n");
	else
	{
		float peakVal = 0.0f;
		int peakIndex = 0;
		int Nm = 0;

		float pctTot = 0.0f;
		for(int i=0; i<maxTorque_Nm; i++)
		{
			float pct = (float)hist[i] / (float)histCount;
			pctTot += pct;

			histPct[i] = pct;
			histPctTot[i] = pctTot;

			peakIndex = i+1;


			// find the max value so we can scale the graph
			if(peakVal < pctTot)
				peakVal = pctTot;

			// toss out points above target percent
			if(Nm == 0 && pctTot >= targetPct)
				Nm = i+1;

			// call it quits eventually
			if(pctTot >= maxPct)
				break;
		}

#ifdef SIMPLEOUTPUT
		printf("%d,%0.1f\n", Nm, 340.0f /*IR2NMFACTOR*/ / Nm);
#else
		// report status
		printf("\nPeak torque: %d Nm\n", Nm);
		printf("Strength: %0.1f\n", 340.0f /*IR2NMFACTOR*/ / Nm);

		// dump data to file
		FILE *out = fopen(outFile, "w");
		if(out)
		{
			for(int i=0; i<peakIndex; i++)
				fprintf(out, "%d Nm,", i+1);
			fprintf(out, "\n");

			for(int i=0; i<peakIndex; i++)
				fprintf(out, "%0.2f,", histPct[i] * 100.0f);
			fprintf(out, "\n");

			for(int i=0; i<peakIndex; i++)
				fprintf(out, "%0.2f,", histPctTot[i] * 100.0f);
			fprintf(out, "\n");

			fclose(out);

			printf("\ndata saved to '%s'\n", outFile);
			out = NULL;
		}
#endif // SIMPLEOUTPUT
	}

	idk.closeFile();
}

int main(int argc, char *argv[])
{
#ifndef SIMPLEOUTPUT
	printf("ffbforce 1.0 - calculate peak torque from telemetry\n\n");
#endif //SIMPLEOUTPUT

	if(argc < 2)
		printf("ffbforce <file.ibt>\n");
	else
	{
		if(init(argv[1]))
		{
			while(idk.getNextData())
				process();

			shutdown();
		}
		else
			printf("init failed\n");
	}

#ifndef SIMPLEOUTPUT
	printf("\nhit any key to continue\n");
	getch();
#endif //SIMPLEOUTPUT

	return 0;
}
