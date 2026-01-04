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

#ifndef IRSDK_MEMSERVER_H
#define IRSDK_MEMSERVER_H

#include "irsdk_defines.h"
#include "irsdk_server.h"

class irsdkMemServer
{
public:
	// only allow one instance globaly for the whole program.
	static irsdkMemServer* instance();

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

	const irsdk_varHeader *getHeaderByIndex(int index);

private:
	// treat these as private constructor, only one instance allowed
	irsdkMemServer();
	~irsdkMemServer();

	// no copy constructors
	irsdkMemServer(irsdkMemServer const&) {};
	irsdkMemServer& operator=(irsdkMemServer const&) {};

	// handled at create time
	bool startup();
	void shutdown();

	int varNameToIndex(const char *name);

	HANDLE hDataValidEvent;
	HANDLE hMemMapFile;

	//****Warning, make sure we never read from memory pointed to by pHeader.
	// it is not safe and can be changed by the clients!
	char *pSharedMem;
	//pointer to header in memory map file, write only!
	irsdk_header *pHeader;

	//local copy for read/write
	irsdk_header localHeader;
	irsdk_varHeader localVarHeader[IRSDK_MAX_VARS];

	entryHelper entryVarHelper[IRSDK_MAX_VARS];

	bool m_isInitialized;
	bool m_isHeaderFinalized;

	int curBuf;
	int count;

	static const int bufCount = 3;
	static const int bufLength = IRSDK_MAX_VARS * 6;
	static const int SharedMemSize = sizeof(irsdk_header) + (irsdkServer::sessionStrLen) + (IRSDK_MAX_VARS * sizeof(irsdk_varHeader)) + (bufCount * bufLength);
};

#endif // IRSDK_MEMSERVER_H
