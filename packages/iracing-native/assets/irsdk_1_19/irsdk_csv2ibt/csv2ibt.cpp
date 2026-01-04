/*
Copyright (c) 2013, iRacing.com Motorsport Simulations, LLC.
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * Neither the name of iRacing.com Motorsport Simulations nor the
      names of its contributors may be used to endorse or promote products
      derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

// Simple demo that reads in a .csv file and converts it to iracing binary telemetry format (.ibt)

//------
#define MIN_WIN_VER 0x0501

#ifndef WINVER
#	define WINVER			MIN_WIN_VER
#endif

#ifndef _WIN32_WINNT
#	define _WIN32_WINNT		MIN_WIN_VER 
#endif

#pragma warning(disable:4996) //_CRT_SECURE_NO_WARNINGS

#include <windows.h>
#include <stdio.h>
#include <conio.h>
#include <stdlib.h>
#include <cmath>
#include <string.h>
#include <conio.h>
#include <time.h>

#include "irsdk_defines.h"
#include "irsdk_csvclient.h"

//****Note, modify these to fit your CSV file format
int g_updateRate_Hz = 10;// 60;
//****Note, if nameLine is -1, we will attempt to auto detect all lines
int g_nameLine = 14;// -1;
int g_descriptionLine = -1;
int g_unitsLine = 15;// -1;
int g_dataType_Line = -1;
int g_dataStartLine = 18;// -1;


irsdkCSVClient ick;
FILE *pIBT = NULL;

const char g_sessionTimeString[] = "SessionTime";
int g_sessionTimeOffset = -1;

const char g_lapIndexString[] = "Lap";
int g_lapIndexOffset = -1;

// place holders for data that needs to be updated in our IBT file
irsdk_header g_diskHeader;
irsdk_diskSubHeader g_diskSubHeader;

int g_diskSubHeaderOffset = 0;
int g_diskLastLap = -1;

// open a file for writing, without overwriting any existing files
FILE *openUniqueFile(const char *name, const char *ext, bool asBinary)
{
	FILE *file = NULL;
	char tstr[MAX_PATH] = "";
	int i = 0;

	// find an unused filename
	do
	{
		if(file)
			fclose(file);

		if(i == 0)
			_snprintf(tstr, MAX_PATH, "%s.%s", name, ext);
		else
			_snprintf(tstr, MAX_PATH, "%s_%02d.%s", name, i, ext);

		tstr[MAX_PATH-1] = '\0';

		file = fopen(tstr, "r");
	}
	while(file && ++i < 100);

	// failed to find an unused file
	if(file)
	{
		fclose(file);
		return NULL;
	}

	if(asBinary)
		return fopen(tstr, "wb");
	else
		return fopen(tstr, "w");
}

// log header to ibt binary format
void logHeaderToIBT(irsdkCSVClient *pCSV, FILE *pIBT, int updateRate_Hz)
{
	if(pCSV && pIBT)
	{
		int offset = 0;

		// main header
		g_diskHeader.ver = 1;
		g_diskHeader.status = irsdk_stConnected;
		g_diskHeader.tickRate = updateRate_Hz;
		g_diskHeader.numVars = pCSV->getVarCount();
		g_diskHeader.bufLen = g_diskHeader.numVars * sizeof(float);
		offset += sizeof(g_diskHeader);

		// sub header is written out at end of session
		memset(&g_diskSubHeader, 0, sizeof(g_diskSubHeader));
		g_diskSubHeader.sessionStartDate = time(NULL);
		g_diskSubHeaderOffset = offset;
		offset += sizeof(g_diskSubHeader);

		// pointer to var definitions
		g_diskHeader.varHeaderOffset = offset;
		offset += g_diskHeader.numVars * sizeof(irsdk_varHeader);

		// pointer to session info string
		g_diskHeader.sessionInfoUpdate = 0;
		g_diskHeader.sessionInfoLen = strlen(pCSV->getYAMLStr());
		g_diskHeader.sessionInfoOffset = offset;
		offset += g_diskHeader.sessionInfoLen;

		// pointer to start of buffered data
		g_diskHeader.numBuf = 1;
		g_diskHeader.varBuf[0].bufOffset = offset;
		g_diskHeader.varBuf[0].tickCount = 0;

		fwrite(&g_diskHeader, 1, sizeof(g_diskHeader), pIBT);
		fwrite(&g_diskSubHeader, 1, sizeof(g_diskSubHeader), pIBT);
		fwrite(pCSV->getVarHeaders(), 1, g_diskHeader.numVars * sizeof(irsdk_varHeader), pIBT);
		fwrite(pCSV->getYAMLStr(), 1, g_diskHeader.sessionInfoLen, pIBT);

		if(ftell(pIBT) != g_diskHeader.varBuf[0].bufOffset)
			printf("ERROR: pIBT pointer mismach: %d != %d\n", ftell(pIBT), g_diskHeader.varBuf[0].bufOffset);
	}
}

void logDataToIBT(irsdkCSVClient *pCSV, FILE *pIBT)
{
	// write data to disk, and update irsdk_diskSubHeader in memory
	if(pCSV && pIBT)
	{
		const float* varArray = pCSV->getVarArray();
		if(varArray)
		{
			fwrite(varArray, 1, g_diskHeader.bufLen, pIBT);
			g_diskSubHeader.sessionRecordCount++;

			if(g_sessionTimeOffset >= 0 && g_sessionTimeOffset < pCSV->getVarCount())
			{
				double time = varArray[g_sessionTimeOffset];
				if(g_diskSubHeader.sessionRecordCount == 1)
				{
					g_diskSubHeader.sessionStartTime = time;
					g_diskSubHeader.sessionEndTime = time;
				}

				if(g_diskSubHeader.sessionEndTime < time)
					g_diskSubHeader.sessionEndTime = time;
			}

			if(g_lapIndexOffset >= 0 && g_lapIndexOffset < pCSV->getVarCount())
			{
				int lap = (int)varArray[g_lapIndexOffset];

				if(g_diskSubHeader.sessionRecordCount == 1)
					g_diskLastLap = lap-1;

				if(g_diskLastLap < lap)
				{
					g_diskSubHeader.sessionLapCount++;
					g_diskLastLap = lap;
				}
			}
		}
	}
}

void logCloseIBT(FILE *pIBT)
{
	if(pIBT)
	{
		fseek(pIBT, g_diskSubHeaderOffset, SEEK_SET);
		fwrite(&g_diskSubHeader, 1, sizeof(g_diskSubHeader), pIBT);
	}
}

bool init(char *path)
{
	// name, description, units, data type, data line
	if(ick.openFile(path, g_nameLine, g_descriptionLine, g_unitsLine, g_dataType_Line, g_dataStartLine))
	{
		g_sessionTimeOffset = ick.getVarIdx(g_sessionTimeString);
		g_lapIndexOffset = ick.getVarIdx(g_lapIndexString);

		char *s = strrchr(path, '.');
		if(s)
			s[0] = '\0';

		pIBT = openUniqueFile(path, "ibt", true);
		if(pIBT != NULL)
		{
			logHeaderToIBT(&ick, pIBT, g_updateRate_Hz);
			// we read in one line of data when dealing with header, make sure we save it.
			logDataToIBT(&ick, pIBT);
			return true;
		}
	}

	return false;
}

void process()
{
	while(ick.getNextData())
		logDataToIBT(&ick, pIBT);
}

void shutdown()
{
	logCloseIBT(pIBT);

	ick.closeFile();

	if(pIBT != NULL)
		fclose(pIBT);
	pIBT = NULL;
}

int main(int argc, char *argv[])
{
	printf("csv2ibt 1.0 - convert a csv file to ibt format\n\n");

	if(argc < 2)
		printf("csv2ibt <file.csv>\n");
	else
	{
		if(init(argv[1]))
		{
			process();

			shutdown();
		}
		else
			printf("init failed\n");
	}

	printf("\nhit any key to continue\n");
	getch();

	return 0;
}
