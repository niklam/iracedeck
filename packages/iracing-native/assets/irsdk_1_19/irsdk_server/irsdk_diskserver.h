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

#ifndef IRSDK_DISKSERVER_H
#define IRSDK_DISKSERVER_H

#include "irsdk_defines.h"
#include "irsdk_server.h"

class irsdkDiskServer
{
public:
	// only allow one instance globaly for the whole program.
	static irsdkDiskServer* instance();

	int regVar(const char *name, const void *var, 
		irsdk_VarType type, int count, 
		const char *desc, const char *unit,
		float multiplier = 1.0f, float offset = 0.0f);

	// save the pointer var for use in next poll
	// set to NULL to dissable polling on this var
	int reRegVar(const char *name, const void *var);
	bool reRegVar(int index, const void *var);

	// pull the value in var and store it
	int setVar(const char *name, const void *var);
	bool setVar(int index, const void *var);

	bool regSessionInfo(const char *str);
	bool isHeaderFinalized();
	bool finalizeHeader();

	bool resetSampleVars();
	bool pollSampleVars();

	bool isInitialized();

	void toggleDiskLogging();
	bool isDiskLoggingEnabled();
	bool isDiskLoggingActive();

	const irsdk_varHeader *getHeaderByIndex(int index);

private:
	// treat these as private constructor, only one instance allowed
	irsdkDiskServer();
	~irsdkDiskServer();

	// no copy constructors
	irsdkDiskServer(irsdkDiskServer const&) {};
	irsdkDiskServer& operator=(irsdkDiskServer const&) {};

	// handled at create time
	bool startup();
	void shutdown();

	int varNameToIndex(const char *name);
	int varNameToOffset(const char *name);


	static const int bufCount = 100;
	static const int bufLength = IRSDK_MAX_VARS * 6;
	static const int SharedMemSize = bufCount * bufLength;

	char pSharedMem[irsdkDiskServer::SharedMemSize];

	//local copy for read/write
	irsdk_header localHeader;
	irsdk_varHeader localVarHeader[IRSDK_MAX_VARS];

	entryHelper entryVarHelper[IRSDK_MAX_VARS];

	bool m_isInitialized;
	bool m_isHeaderFinalized;

	int tickCount;
	char sessionStr[irsdkServer::sessionStrLen];

	bool enableLogging;

	bool canLogToFile();

	FILE *file;

	time_t t_time;

	int playerInCarOffset;
	int sessionTimeOffset;
	int lapIndexOffset;

	// place holders for variables that need to be updated in the header of our CSV file
	double startTime;
	long int startTimeOffset;

	double endTime;
	long int endTimeOffset;

	int lastLap;
	int lapCount;
	long int lapCountOffset;

	int recordCount;
	long int recordCountOffset;

	////

	void logHeaderToCSV();
	void logDataToCSV();

	////

	void logHeaderToIBT();
	void logDataToIBT();
	void logCloseIBT();
	irsdk_header diskHeader;
	irsdk_diskSubHeader diskSubHeader;
	int diskSubHeaderOffset;
	int diskLastLap;
};

#endif //IRSDK_DISKSERVER_H
