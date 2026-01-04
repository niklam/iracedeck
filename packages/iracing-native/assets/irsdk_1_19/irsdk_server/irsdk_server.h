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

#ifndef IRSDK_SERVER_H
#define IRSDK_SERVER_H

#include "irsdk_defines.h"

static const int TICKS_PER_SEC = 60;

static const int IRSDK_MAX_VARS = 4096;

// log in realtime to clients
#define IRSDK_LOG_LIVE 1
// log to disk
#define IRSDK_LOG_DISK 2
// log both to realtime and to disk
#define IRSDK_LOG_ALL (IRSDK_LOG_LIVE | IRSDK_LOG_DISK)

void writeVar(int count, int type, float multiplier, float offset, const void *pSourceV, char *pDest);

struct VarLookup
{
public:
	VarLookup()
		: memIndex(-1)
		, diskIndex(-1)
		, logMode(0)
	{
		memset(name, 0, sizeof(name));
	}

	char name[IRSDK_MAX_STRING];
	int memIndex;
	int diskIndex;
	int logMode;
};

struct entryHelper
{
public:
	entryHelper()
		: multiplier(1.0f)
		, offset(0.0f)
		, varPtr(NULL)
	{}

	float multiplier; 
	float offset;
	const void *varPtr;
};

class irsdkServer
{
public:
	// only allow one instance globaly for the whole program.
	static irsdkServer* instance();

	int regVar(const char *name, const void *var, 
		irsdk_VarType type, int count, 
		const char *desc, const char *unit,
		int logMode, float multiplier = 1.0f, float offset = 0.0f);

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

	static const int sessionStrLen = 0x20000; // 128k

private:
	// treat these as private constructor, only one instance allowed
	irsdkServer();
	~irsdkServer();

	// no copy constructors
	irsdkServer(irsdkServer const&) {};
	irsdkServer& operator=(irsdkServer const&) {};

	// lookup table into disk/mem var lists
	int nameToIndex(const char *name);

	int varCount;
	VarLookup varLookup[IRSDK_MAX_VARS];
};


// container class to hold index into irsdkServer's var table
// used so we can quickly look up a variable to register/deregester it at initialization time
class irsdkVar
{
public:
	irsdkVar(const char *name, const void *var, 
		irsdk_VarType type, int count, 
		const char *desc, const char *unit,
		int logMode, float multiplier = 1.0f, float offset = 0.0f);

	bool reRegVar(const void *var);

	bool setVar(const void *var);

	bool setVar(bool v) { return setVar(&v); }
	bool setVar(int v) { return setVar(&v); }
	bool setVar(float v) { return setVar(&v); }
	bool setVar(double v) { return setVar(&v); }

protected:
	int index;
};

#endif //IRSDK_SERVER_H

