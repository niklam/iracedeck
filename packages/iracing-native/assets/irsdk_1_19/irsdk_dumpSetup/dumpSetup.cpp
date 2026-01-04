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

#include "irsdk_defines.h"
#include "irsdk_client.h"		// live telemetry
#include "irsdk_diskclient.h"	// disk telemetry

// for timeBeginPeriod
#pragma comment(lib, "Winmm")


//------------------------
// process live setup info

int g_lastSetupCount = -1;

void deinit()
{
	timeEndPeriod(1);

	signal(SIGINT, SIG_DFL);
}

void ex_program(int sig) 
{
	(void)sig;

	printf("recieved ctrl-c, exiting\n\n");

	deinit();

	exit(0);
}

bool init()
{
	// trap ctrl-c
	signal(SIGINT, ex_program);
	printf("press enter to exit\n\n");

	// bump priority up so we get time from the sim
	SetPriorityClass(GetCurrentProcess(), HIGH_PRIORITY_CLASS);

	// ask for 1ms timer so sleeps are more precise
	timeBeginPeriod(1);

	g_lastSetupCount = -1;
	
	return true;
}

void monitorConnectionStatus()
{
	// keep track of connection status
	bool isConnected = irsdkClient::instance().isConnected();
	static bool wasConnected = false;
	if(wasConnected != isConnected)
	{
		if(isConnected)
			printf("Connected to iRacing\n");
		else
			printf("Lost connection to iRacing\n");
		wasConnected = isConnected;

		g_lastSetupCount = -1;
	}
}

void run()
{
	// wait up to 16 ms for start of session or new data
	if(irsdkClient::instance().waitForData(16))
	{
		// and grab the data
		const int MAX_STR = 1024;
		char tstr[MAX_STR];

		if(1 == irsdkClient::instance().getSessionStrVal("CarSetup:UpdateCount:", tstr, MAX_STR))
		{
			int count = atoi(tstr);
			if(g_lastSetupCount != count)
			{
				g_lastSetupCount = count;

				// get info on the car path
				if(1 == irsdkClient::instance().getSessionStrVal("DriverInfo:DriverCarIdx:", tstr, MAX_STR))
				{
					int driverCarIdx = atoi(tstr);
					char pathStr[MAX_STR];

					sprintf(pathStr, "DriverInfo:Drivers:CarIdx:{%d}CarScreenName:", driverCarIdx);
					if(1 == irsdkClient::instance().getSessionStrVal(pathStr, tstr, MAX_STR))
						printf("CarName: %s\n", tstr);

					sprintf(pathStr, "DriverInfo:Drivers:CarIdx:{%d}CarPath:", driverCarIdx);
					if(1 == irsdkClient::instance().getSessionStrVal(pathStr, tstr, MAX_STR))
						printf("CarPath: %s\n", tstr);
				}

				// get info on what setup is loaded
				if(1 == irsdkClient::instance().getSessionStrVal("DriverInfo:DriverSetupName:", tstr, MAX_STR))
				{
					printf("CarSetupName: %s", tstr);

					if(1 == irsdkClient::instance().getSessionStrVal("DriverInfo:DriverSetupLoadTypeName:", tstr, MAX_STR))
						printf(", %s", tstr);

					if(1 == irsdkClient::instance().getSessionStrVal("DriverInfo:DriverSetupIsModified:", tstr, MAX_STR))
						if(atoi(tstr) == 1)
							printf(", modified");

					if(1 == irsdkClient::instance().getSessionStrVal("DriverInfo:DriverSetupPassedTech:", tstr, MAX_STR))
						if(atoi(tstr) == 0)
							printf(", failed tech");

					printf("\n");
				}

				// get the current setup and dump it
				const char *sesStr = irsdkClient::instance().getSessionStr();
				if(sesStr)
				{
					//****Note, this assumes CarSetup is the last section of the session string.
					const char *tstr = strstr(sesStr, "CarSetup:");
					if(tstr)
					{
						printf(tstr);
						printf("\n");
					}
				}
			}
		}
	}

	// your normal process loop would go here
	monitorConnectionStatus();
}

void runLoop()
{
	if(init())
	{
		while(!_kbhit())
		{
			run();
		}

		printf("Shutting down.\n");
		deinit();
	}
	else
		printf("init failed\n");
}

//------------------------
// process ibt files

irsdkDiskClient idk;

void processFile(const char *path)
{
	const int MAX_STR = 1024;
	char tstr[MAX_STR];

	const char *fName = strrchr(path, '\\');
	if(fName)
		fName++;
	else
		fName = path;

	printf("\n\nFileName: %s\n", fName);

	if(idk.openFile(path))
	{
		// get info on the car path
		if(1 == idk.getSessionStrVal("DriverInfo:DriverCarIdx:", tstr, MAX_STR))
		{
			int driverCarIdx = atoi(tstr);
			char pathStr[MAX_STR];

			sprintf(pathStr, "DriverInfo:Drivers:CarIdx:{%d}CarScreenName:", driverCarIdx);
			if(1 == idk.getSessionStrVal(pathStr, tstr, MAX_STR))
				printf("CarName: %s\n", tstr);

			sprintf(pathStr, "DriverInfo:Drivers:CarIdx:{%d}CarPath:", driverCarIdx);
			if(1 == idk.getSessionStrVal(pathStr, tstr, MAX_STR))
				printf("CarPath: %s\n", tstr);
		}

		// get info on what setup is loaded
		if(1 == idk.getSessionStrVal("DriverInfo:DriverSetupName:", tstr, MAX_STR))
		{
			printf("CarSetupName: %s", tstr);

			if(1 == idk.getSessionStrVal("DriverInfo:DriverSetupLoadTypeName:", tstr, MAX_STR))
				printf(", %s", tstr);

			if(1 == idk.getSessionStrVal("DriverInfo:DriverSetupIsModified:", tstr, MAX_STR))
				if(atoi(tstr) == 1)
					printf(", modified");

			if(1 == idk.getSessionStrVal("DriverInfo:DriverSetupPassedTech:", tstr, MAX_STR))
				if(atoi(tstr) == 0)
					printf(", failed tech");

			printf("\n");
		}

		// get the current setup and dump it
		const char *sesStr = idk.getSessionStr();
		if(sesStr)
		{
			//****Note, this assumes CarSetup is the last section of the session string.
			const char *tstr = strstr(sesStr, "CarSetup:");
			if(tstr)
			{
				printf(tstr);
				printf("\n");
			}
		}

		idk.closeFile();
	}
	else
		printf("failed!\n");
}

//-----------------------
// entry point

int main(int argc, char *argv[])
{
	printf("dumpSetup 1.1\n");

	// if they passed in a command line then dump the file to disk
	if(argc >= 2)
	{
		// we support passing in multiple files
		for(int i=1; i<argc; i++)
			processFile(argv[i]);

		printf("\n\nhit any key to continue\n");
		getch();
	}
	// else look for a connection and dump the result to the display
	else
		runLoop();

	return 0;
}
