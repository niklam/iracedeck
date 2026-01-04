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

// don't warn about stdlib
#pragma warning(disable: 4996) 

#include <windows.h>
#include <assert.h>

#include <direct.h>
#include <stdio.h>
#include <conio.h>
#include <time.h>

#include "irsdk_defines.h"
#include "irsdk_server.h"
#include "irsdk_diskserver.h"

// don't warn about stdlib
#pragma warning(disable: 4996) 


#define MAX_FILE_NAME_LEN 2048

// Uncomment to log to ascii CSV format instead of binary IBT format
//#define LOG_TO_CSV

static const char lapIndexString[] = "Lap";
static const char sessionTimeString[] = "SessionTime";

FILE *openUniqueFile(const char *name, const char *ext, time_t t_time, bool asBinary)
{
	FILE *file = NULL;
	char tstr[MAX_PATH] = "";
	int i = 0;
	tm tm_time;

	localtime_s(&tm_time, &t_time);

	// find an unused filename
	do
	{
		if(file)
			fclose(file);

		_snprintf(tstr, MAX_PATH, "%s", name);
		tstr[MAX_PATH-1] = '\0';

		strftime(tstr+strlen(tstr), MAX_PATH-strlen(tstr), " %Y-%m-%d %H-%M-%S", &tm_time);
		tstr[MAX_PATH-1] = '\0';

		if(i > 0)
		{
			_snprintf(tstr+strlen(tstr), MAX_PATH-strlen(tstr), " %02d", i);
			tstr[MAX_PATH-1] = '\0';
		}

		_snprintf(tstr+strlen(tstr), MAX_PATH-strlen(tstr), ".%s", ext);
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

	// open in exclusive mode
	if(asBinary)
		fopen_s(&file, tstr, "wb");
	else
		fopen_s(&file, tstr, "w");

	return file;
}

static const int reserveCount = 32;
// reserve a little space in the file for a number to be written
long int fileReserveSpace(FILE *file)
{
	long int pos = ftell(file);

	int count = reserveCount;
	while(count--)
		fputc(' ', file);
	fputs("\n", file);

	return pos;
}

// fill in a number in our reserved space, without overwriting the newline
void fileWriteReservedInt(FILE *file, long int pos, int value)
{
	long int curpos = ftell(file);

	fseek(file, pos, SEEK_SET);
	fprintf(file, "%d", value);

	fseek(file, curpos, SEEK_SET);
}

void fileWriteReservedFloat(FILE *file, long int pos, double value)
{
	long int curpos = ftell(file);

	fseek(file, pos, SEEK_SET);
	fprintf(file, "%f", value);

	fseek(file, curpos, SEEK_SET);
}

int irsdkDiskServer::varNameToIndex(const char *name)
{
	if(name && m_isInitialized)
	{
		for(int index = 0; index < localHeader.numVars; index++)
		{
			if(0 == strncmp(name, localVarHeader[index].name, IRSDK_MAX_STRING))
			{
				return index;
			}
		}
	}

	return -1;
}

int irsdkDiskServer::varNameToOffset(const char *name)
{
	if(name && m_isInitialized)
	{
		for(int index=0; index<localHeader.numVars; index++)
		{
			if(0 == strncmp(name, localVarHeader[index].name, IRSDK_MAX_STRING))
			{
				return localVarHeader[index].offset;
			}
		}
	}

	return -1;
}

//--------

irsdkDiskServer* irsdkDiskServer::instance()
{
	// initialize on the stack instead of the heap.  
	// That way we get initialized at first call 
	// even if we are called in a static constructor.
	static irsdkDiskServer instance;
	return &instance;
}

irsdkDiskServer::irsdkDiskServer() 
	: m_isInitialized(false)
	, m_isHeaderFinalized(false)
	, tickCount(0)
	, file(NULL)
	, sessionTimeOffset(-1)
	, lapIndexOffset(-1)
	, startTime(0.0)
	, startTimeOffset(-1)
	, endTime(0.0)
	, endTimeOffset(-1)
	, lastLap(0)
	, lapCount(0)
	, lapCountOffset(-1)
	, recordCount(0)
	, recordCountOffset(-1)
	, enableLogging(false)
{
	memset(sessionStr, 0, sizeof(sessionStr));
	memset(&localHeader, 0, sizeof(localHeader));

	//init our header
	localHeader.status = 0;

	localHeader.ver = 1;
	localHeader.tickRate = TICKS_PER_SEC;
	localHeader.numVars = 0;
	localHeader.numBuf = 1;
	localHeader.bufLen = 0;
	localVarHeader[0].offset = 0;

	// fill in buffer memory
	//****FixMe, fill in offset to buffer properly
	localHeader.varBuf[0].bufOffset = 0;
	localHeader.varBuf[0].tickCount = -1;

	// initialize at construction time
	startup();
}

irsdkDiskServer::~irsdkDiskServer()
{
	//close up link
	 shutdown();
}

bool irsdkDiskServer::startup()
{
	// zero shared memory
	memset(pSharedMem, 0, irsdkDiskServer::SharedMemSize);

	localHeader.status = 0;

	m_isInitialized = true;

	return true;
}

void irsdkDiskServer::shutdown()
{
	//****FixMe, flush last write to disk
	//****FixMe, update header info

	if(file)
	{
#ifndef LOG_TO_CSV
		logCloseIBT();
#endif
		fclose(file);
	}

	m_isInitialized = false;
	m_isHeaderFinalized = false;
}

// safe to call before m_isInitialized, only writes to localHeader
int irsdkDiskServer::regVar(const char *name, const void *var, 
							  irsdk_VarType type, int count, 
							  const char *desc, const char *unit,
							  float multiplier, float offset)
{
	assert(name);
	assert(strlen(name) < IRSDK_MAX_STRING);
	assert(strlen(name) > 0);
	assert(desc);
	assert(strlen(desc) < IRSDK_MAX_DESC);
	assert(unit);
	assert(strlen(unit) < IRSDK_MAX_STRING);
	assert(localHeader.numVars < IRSDK_MAX_VARS);

	int index;

	if(m_isInitialized)
	{
		// update the var, if already defined
		index = reRegVar(name, var);
		if(index >= 0)
			return index;
	
		//else, add it in the first time
		if(!m_isHeaderFinalized)
		{
			if(localHeader.numVars < IRSDK_MAX_VARS)
			{
				if(name && desc && unit)
				{
					//double check the space
					int recLen = irsdk_VarTypeBytes[type] * count;
					int usedLen = recLen + localHeader.bufLen;
					assert(usedLen < irsdkDiskServer::bufLength);

					if(usedLen < irsdkDiskServer::bufLength)
					{
						index = localHeader.numVars++;
						irsdk_varHeader *rec = &localVarHeader[index];

						rec->offset = localHeader.bufLen;
						localHeader.bufLen = usedLen;

						rec->type = type;
						rec->count = count;

						strncpy(rec->name, name, IRSDK_MAX_STRING);
						rec->name[IRSDK_MAX_STRING-1] = '\0';

						strncpy(rec->desc, desc, IRSDK_MAX_DESC);
						rec->desc[IRSDK_MAX_DESC-1] = '\0';

						strncpy(rec->unit, unit, IRSDK_MAX_STRING);
						rec->unit[IRSDK_MAX_STRING-1] = '\0';

						//stash local var so we can retrieve it later
						entryVarHelper[index].varPtr = var;
						entryVarHelper[index].multiplier = multiplier;
						entryVarHelper[index].offset = offset;

						return index;
					}
				}
			}
		}
		else
			printf("****Failed to register irsdk diskvar: %s", name);
	}

	return -1;
}

// warning, linear search!  don't call this often
int irsdkDiskServer::reRegVar(const char *name, const void *var)
{
	int index = varNameToIndex(name);
	return (reRegVar(index, var)) ? index : -1;
}

bool irsdkDiskServer::reRegVar(int index, const void *var)
{
	if(m_isInitialized)
	{
		if(index >= 0 && index < localHeader.numVars)
		{
			entryVarHelper[index].varPtr = var;

			return true;
		}
	}

	return false;
}

// warning, linear search!  don't call this often
int irsdkDiskServer::setVar(const char *name, const void *var)
{
	int index = varNameToIndex(name);
	return (setVar(index, var)) ? index : -1;
}

bool irsdkDiskServer::setVar(int index, const void *var)
{
	const irsdk_varHeader *rec;
	if(m_isInitialized && var)
	{
		if(index >= 0 && index < localHeader.numVars)
		{
			char *pBase = pSharedMem + localHeader.varBuf[0].bufOffset;

			rec = &localVarHeader[index];

			writeVar(localVarHeader[index].count, localVarHeader[index].type, 
					 entryVarHelper[index].multiplier, entryVarHelper[index].offset, 
					 var, pBase + rec->offset);

			return true;
		}
	}

	return false;
}


// safe to call before m_isInitialized, only writes to localHeader
bool irsdkDiskServer::regSessionInfo(const char *str)
{
	if(m_isInitialized)
	{
		if(str)
		{
			strncpy(sessionStr, str, irsdkServer::sessionStrLen);
			sessionStr[irsdkServer::sessionStrLen-1] = '\0';
		}
	}

	return false;
}

bool irsdkDiskServer::isHeaderFinalized()
{
	return m_isHeaderFinalized;
}

bool irsdkDiskServer::finalizeHeader()
{
	assert(!m_isHeaderFinalized);

	if(m_isInitialized && !m_isHeaderFinalized)
	{
		localHeader.status = irsdk_stConnected;

		sessionTimeOffset = varNameToOffset(sessionTimeString);
		assert(sessionTimeOffset >= 0);
		lapIndexOffset = varNameToOffset(lapIndexString);
		assert(lapIndexOffset >= 0);

		// only write header out once
		m_isHeaderFinalized = true;
		return true;
	}

	return false;
}

bool irsdkDiskServer::isInitialized()
{
	return m_isInitialized;
}

bool irsdkDiskServer::resetSampleVars()
{
	if(m_isInitialized)
	{
		char *pBase = pSharedMem + localHeader.varBuf[0].bufOffset;
		memset(pBase, 0, irsdkDiskServer::bufLength);

		return true;
	}
	return false;
}

bool irsdkDiskServer::pollSampleVars()
{
	const irsdk_varHeader *rec;
	if(m_isInitialized)
	{
		char *pBase = pSharedMem + localHeader.varBuf[0].bufOffset;

		// for each entry
		for(int index=0; index<localHeader.numVars; index++)
		{
			rec = &localVarHeader[index];
		
			if(entryVarHelper[index].varPtr)
			{
				writeVar(localVarHeader[index].count, localVarHeader[index].type, 
						 entryVarHelper[index].multiplier, entryVarHelper[index].offset, 
						 entryVarHelper[index].varPtr, pBase + rec->offset);
			}
		}

		// update index
		localHeader.varBuf[0].tickCount = tickCount;

		// log data to disk
		if(canLogToFile())
		{
			if(!file)
			{
#ifdef LOG_TO_CSV
				logHeaderToCSV();
#else
				logHeaderToIBT();
#endif
			}

			if(file)
			{
#ifdef LOG_TO_CSV
				logDataToCSV();
#else
				logDataToIBT();
#endif
			}
		}
		else if(file)
		{
#ifndef LOG_TO_CSV
			logCloseIBT();
#endif
			fclose(file);
			file = NULL;
		}

		// increment tickCount
		tickCount++;
		return true;
	}

	return false;
}

bool irsdkDiskServer::canLogToFile()
{
	// put logic here if you only want to log when car is on track, etc
	return enableLogging //only if logging turned on
		//&& carIsOnTrack
		; 
}

void irsdkDiskServer::toggleDiskLogging()
{
	enableLogging = !enableLogging;
}

bool irsdkDiskServer::isDiskLoggingEnabled()
{
	return enableLogging;
}

bool irsdkDiskServer::isDiskLoggingActive()
{
	return file != NULL;
}

const irsdk_varHeader *irsdkDiskServer::getHeaderByIndex(int index)
{
	if(index >= 0 && index < localHeader.numVars)
		return &localVarHeader[index];

	return NULL;
}

void initPathStr(char *path, int len)
{
	//make sure directory exists
	//****FixMe, point this to your data directory
	_snprintf(path, len,"c:\\temp\\");
	path[len-1] = '\0';
	_mkdir(path);

	_snprintf(path, len,"c:\\temp\\irsdkLog");
	path[len-1] = '\0';
}

//----
// CSV File writer

void irsdkDiskServer::logHeaderToCSV()
{
	if(file)
		fclose(file);

	char path[MAX_PATH];
	initPathStr(path, MAX_PATH);

	t_time = time(NULL);

	file = openUniqueFile(path, "csv", t_time, false);

	if(file)
	{
		// remove trailing ... from string
		char *pStr = strstr(sessionStr, "...");
		if(pStr)
			*pStr = '\0';

		// and write the whole thing out
		fputs(sessionStr, file);

		// reserve space for entrys that will be filled in later
		fprintf(file, "SessionLogInfo:\n");

		// get file open time as a string
		char tstr[512];
		tm tm_time;
		localtime_s(&tm_time, &t_time);
		strftime(tstr, 512, " %Y-%m-%d %H:%M:%S", &tm_time);
		tstr[512-1] = '\0';
		fprintf(file, " SessionStartDate: %s\n", tstr);

		fprintf(file, " SessionStartTime: ");
		startTimeOffset = fileReserveSpace(file);
		startTime = -1.0;

		fprintf(file, " SessionEndTime: ");
		endTimeOffset = fileReserveSpace(file);
		endTime = -1.0;

		fprintf(file, " SessionLapCount: ");
		lapCountOffset = fileReserveSpace(file);
		lapCount = 0;
		lastLap = -1;

		fprintf(file, " SessionRecordCount: ");
		recordCountOffset = fileReserveSpace(file);
		recordCount = 0;

		fprintf(file, "...\n");

		// dump the var names
		for(int i=0; i<localHeader.numVars; i++)
		{
			const irsdk_varHeader *rec = &localVarHeader[i];

			if(rec->type != irsdk_char && rec->count > 1)
			{
				for(int j=0; j<rec->count; j++)
					fprintf(file, "%s_%d, ", rec->name, j+1);
			}
			else
				fprintf(file, "%s, ", rec->name);
		}
		fprintf(file, "\n");

		// dump the var descriptions
		for(int i=0; i<localHeader.numVars; i++)
		{
			const irsdk_varHeader *rec = &localVarHeader[i];

			int count = (rec->type != irsdk_char && rec->count > 1) ? rec->count : 1;
			for(int j=0; j<count; j++)
				fprintf(file, "%s, ", rec->desc);
		}
		fprintf(file, "\n");

		// dump the var units
		for(int i=0; i<localHeader.numVars; i++)
		{
			const irsdk_varHeader *rec = &localVarHeader[i];

			int count = (rec->type != irsdk_char && rec->count > 1) ? rec->count : 1;
			for(int j=0; j<count; j++)
				fprintf(file, "%s, ", rec->unit);
		}
		fprintf(file, "\n");

		// dump the var data type
		for(int i=0; i<localHeader.numVars; i++)
		{
			const irsdk_varHeader *rec = &localVarHeader[i];

			int count = (rec->type != irsdk_char && rec->count > 1) ? rec->count : 1;
			for(int j=0; j<count; j++)
			{
				switch(rec->type)
				{
				case irsdk_char:
					fprintf(file, "string, ");
					break;
				case irsdk_bool:
					fprintf(file, "boolean, ");
					break;
				case irsdk_int:
					fprintf(file, "integer, ");
					break;
				case irsdk_bitField:
					fprintf(file, "bitfield, ");
					break;
				case irsdk_float:
					fprintf(file, "float, ");
					break;
				case irsdk_double:
					fprintf(file, "double, ");
					break;
				default:
					fprintf(file, "unknown, ");
					break;
				}
			}
		}
		fprintf(file, "\n");
	}
}

void irsdkDiskServer::logDataToCSV()
{
	if(file)
	{
		char *pBase = pSharedMem + localHeader.varBuf[0].bufOffset;
		for(int i=0; i<localHeader.numVars; i++)
		{
			const irsdk_varHeader *rec = &localVarHeader[i];

			// write each entry out
			int count = (rec->type != irsdk_char && rec->count > 1) ? rec->count : 1;
			for(int j=0; j<count; j++)
			{
				switch(rec->type)
				{
				case irsdk_char:
					fprintf(file, "%s, ", (char *)(pBase+rec->offset) ); break;
				case irsdk_bool:
					fprintf(file, "%d, ", ((bool *)(pBase+rec->offset))[j]); break;
				case irsdk_int:
					fprintf(file, "%d, ", ((int *)(pBase+rec->offset))[j]); break;
				case irsdk_bitField:
					fprintf(file, "%d, ", ((int *)(pBase+rec->offset))[j]); break;
				case irsdk_float:
					fprintf(file, "%g, ", ((float *)(pBase+rec->offset))[j]); break;
				case irsdk_double:
					fprintf(file, "%g, ", ((double *)(pBase+rec->offset))[j]); break;
				}
			}
		}

		// update our session counters
		if(sessionTimeOffset >= 0)
		{
			double time = *((double *)(pBase+sessionTimeOffset));
			if(startTime < 0.0)
			{
				startTime = time;
				endTime = time;
				fileWriteReservedFloat(file, startTimeOffset, startTime); // move these to close?
				fileWriteReservedFloat(file, endTimeOffset, endTime);
			}
			if(endTime < time)
			{
				endTime = time;
				fileWriteReservedFloat(file, endTimeOffset, endTime);
			}
		}
		if(lapIndexOffset >= 0)
		{
			int lap = *((int *)(pBase+lapIndexOffset));
			if(lastLap < lap)
			{
				lapCount++;
				lastLap = lap;
				fileWriteReservedInt(file, lapCountOffset, lapCount);
			}
		}

		recordCount++;
		fileWriteReservedInt(file, recordCountOffset, recordCount);

		fprintf(file, "\n");
	}
}

//----
// IBT file format

void irsdkDiskServer::logHeaderToIBT()
{
	if(file)
		fclose(file);

	char path[MAX_PATH];
	initPathStr(path, MAX_PATH);

	t_time = time(NULL);

	file = openUniqueFile(path, "ibt", t_time, true);

	if(file)
	{
		int offset = 0;

		// reset
		diskSubHeaderOffset = 0;
		diskLastLap = -1;

		// main header
		//****FixMe, no need to clone localHeader?
		memcpy(&diskHeader, &localHeader, sizeof(diskHeader));
		offset += sizeof(diskHeader);
		//****FixMe, is this nessisary?
		diskHeader.sessionInfoLen = (int)strlen(sessionStr);

		// sub header is written out at end of session
		memset(&diskSubHeader, 0, sizeof(diskSubHeader));
		diskSubHeader.sessionStartDate = t_time;
		diskSubHeaderOffset = offset;
		offset += sizeof(diskSubHeader);

		// pointer to var definitions
		diskHeader.varHeaderOffset = offset;
		offset += diskHeader.numVars * sizeof(irsdk_varHeader);

		// pointer to session info string
		diskHeader.sessionInfoOffset = offset;
		offset += diskHeader.sessionInfoLen;

		// pointer to start of buffered data
		diskHeader.numBuf = 1;
		diskHeader.varBuf[0].bufOffset = offset;

		fwrite(&diskHeader, 1, sizeof(diskHeader), file);
		fwrite(&diskSubHeader, 1, sizeof(diskSubHeader), file);
		fwrite(&localVarHeader, 1, diskHeader.numVars * sizeof(irsdk_varHeader), file);
		fwrite(sessionStr, 1, diskHeader.sessionInfoLen, file);

		if(ftell(file) != diskHeader.varBuf[0].bufOffset)
			printf("ERROR: file pointer mismach: %d != %d\n", ftell(file), diskHeader.varBuf[0].bufOffset);
	}
}

void irsdkDiskServer::logDataToIBT()
{
	// write data to disk, and update irsdk_diskSubHeader in memory
	if(file)
	{
		char *pBase = pSharedMem + localHeader.varBuf[0].bufOffset;
		fwrite(pBase, 1, diskHeader.bufLen, file);

		diskSubHeader.sessionRecordCount++;

		if(sessionTimeOffset >= 0)
		{
			double time = *((double *)(pBase+sessionTimeOffset));
			if(diskSubHeader.sessionRecordCount == 1)
			{
				diskSubHeader.sessionStartTime = time;
				diskSubHeader.sessionEndTime = time;
			}

			if(diskSubHeader.sessionEndTime < time)
				diskSubHeader.sessionEndTime = time;
		}

		if(lapIndexOffset >= 0)
		{
			int lap = *((int *)(pBase+lapIndexOffset));

			if(diskSubHeader.sessionRecordCount == 1)
				diskLastLap = lap-1;

			if(diskLastLap < lap)
			{
				diskSubHeader.sessionLapCount++;
				diskLastLap = lap;
			}
		}
	}
}

void irsdkDiskServer::logCloseIBT()
{
	if(file)
	{
		// dump count
		fseek(file, diskSubHeaderOffset, SEEK_SET);
		fwrite(&diskSubHeader, 1, sizeof(diskSubHeader), file);
	}
}

