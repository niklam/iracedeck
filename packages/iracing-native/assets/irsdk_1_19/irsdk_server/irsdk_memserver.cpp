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

// memory write barier, keeps compiler from messing up the ordering of our memoyr writes
#include <intrin.h>
#pragma intrinsic(_WriteBarrier)

#include <stdio.h>

#include "irsdk_defines.h"
#include "irsdk_server.h"
#include "irsdk_memserver.h"

irsdkMemServer* irsdkMemServer::instance()
{
	// initialize on the stack instead of the heap.  
	// That way we get initialized at first call 
	// even if we are called in a static constructor.
	static irsdkMemServer instance;
	return &instance;
}

irsdkMemServer::irsdkMemServer() 
	: hDataValidEvent(NULL)
	, hMemMapFile(NULL)
	, pSharedMem(NULL)
	, pHeader(NULL)
	, m_isInitialized(false)
	, curBuf(0)
	, m_isHeaderFinalized(false)
	, count(0)
{
	memset(&localHeader, 0, sizeof(localHeader));

	//init our header
	localHeader.status = 0;

	localHeader.ver = 1;
	localHeader.tickRate = TICKS_PER_SEC;
	
	localHeader.numBuf = irsdkMemServer::bufCount;
	localHeader.bufLen = 0;
	localVarHeader[0].offset = 0;

	//offset points to end of memory
	int offset = sizeof(irsdk_header);

	// add in session string
	localHeader.sessionInfoUpdate = 0;
	localHeader.sessionInfoLen = irsdkServer::sessionStrLen;
	localHeader.sessionInfoOffset = offset;
	offset += irsdkServer::sessionStrLen;

	// add in space for our var headers
	localHeader.numVars = 0;
	localHeader.varHeaderOffset = offset;
	offset += sizeof(localVarHeader);

	// fill in buffer memory
	for(int i=0; i< irsdkMemServer::bufCount; i++)
	{
		localHeader.varBuf[i].bufOffset = offset;
		localHeader.varBuf[i].tickCount = -1;
		offset += irsdkMemServer::bufLength;
	}

	// Make sure we did not goof!
	assert(offset == irsdkMemServer::SharedMemSize);

	// initialize at construction time
	startup();
}

irsdkMemServer::~irsdkMemServer()
{
	//close up link
	shutdown();
}

bool irsdkMemServer::startup()
{
	if(!hMemMapFile)
	{
		hMemMapFile = CreateFileMapping(INVALID_HANDLE_VALUE, NULL, 
			PAGE_READWRITE, 0, irsdkMemServer::SharedMemSize, IRSDK_MEMMAPFILENAME); 
	}

	if (hMemMapFile) 
	{ 
		if(!pSharedMem)
		{
			pSharedMem = (char *)MapViewOfFile(hMemMapFile, 
					FILE_MAP_ALL_ACCESS, 0, 0, irsdkMemServer::SharedMemSize);
			pHeader = (irsdk_header *)pSharedMem;
		}

		//****Warning, assuming pHeader is valid if pSharedMem is valid
		if(pSharedMem)
		{ 
			// zero shared memory
			memset(pSharedMem, 0, irsdkMemServer::SharedMemSize);

			//clear status untill we are fully initialized
			pHeader->status = 0;
			localHeader.status = 0;

			// flush caches to all processors
			_WriteBarrier();

			if(!hDataValidEvent)
				hDataValidEvent = CreateEvent(NULL, true, false, IRSDK_DATAVALIDEVENTNAME);

			if(hDataValidEvent)
			{
				// ok all setup, allow access
				m_isInitialized = true;

				return true;
			}
			else printf("Could not create data valid event (%d).\n", GetLastError());
		}
		else printf("Could not map view of file (%d).\n", GetLastError()); 
	}
	else printf("Could not create file mapping object (%d).\n", GetLastError());

	m_isInitialized = false;
	return false;
}

void irsdkMemServer::shutdown()
{
	//signal clients that we are going away
	if(pHeader)
		pHeader->status = 0;
	localHeader.status = 0;

	// flush caches to all processors
	_WriteBarrier();

	if(hDataValidEvent)
	{
		//make sure event not left triggered (probably redundant)
		ResetEvent(hDataValidEvent);
		CloseHandle(hDataValidEvent);
	}

	if(pSharedMem)
		UnmapViewOfFile(pSharedMem);

	if(hMemMapFile)
		CloseHandle(hMemMapFile);

	hDataValidEvent = NULL;
	pSharedMem = NULL;
	pHeader = NULL;
	hMemMapFile = NULL;

	m_isInitialized = false;
	m_isHeaderFinalized = false;
}

// safe to call before m_isInitialized, only writes to localHeader
int irsdkMemServer::regVar(const char *name, const void *var, 
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
					assert(usedLen < irsdkMemServer::bufLength);

					if(usedLen < irsdkMemServer::bufLength)
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
			printf("****Failed to register irsdk memvar: %s", name);
	}

	return -1;
}

// warning, linear search!  don't call this often
int irsdkMemServer::reRegVar(const char *name, const void *var)
{
	int index = varNameToIndex(name);
	return (reRegVar(index, var)) ? index : -1;
}

bool irsdkMemServer::reRegVar(int index, const void *var)
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
int irsdkMemServer::setVar(const char *name, const void *var)
{
	int index = varNameToIndex(name);
	return (setVar(index, var)) ? index : -1;
}

bool irsdkMemServer::setVar(int index, const void *var)
{
	const irsdk_varHeader *rec;
	if(m_isInitialized && var)
	{
		if(index >= 0 && index < localHeader.numVars)
		{
			char *pBase = pSharedMem + localHeader.varBuf[curBuf].bufOffset;

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
bool irsdkMemServer::regSessionInfo(const char *str)
{
	if(m_isInitialized)
	{
		if(str)
		{
			// only update if changed
			char *dest = (pSharedMem + localHeader.sessionInfoOffset);
			if(0 != strncmp(str, dest, localHeader.sessionInfoLen))
			{
				strncpy(dest, str, localHeader.sessionInfoLen);
				dest[localHeader.sessionInfoLen-1] = '\0';

				// flush caches to all processors
				_WriteBarrier();

				localHeader.sessionInfoUpdate++;
				pHeader->sessionInfoUpdate = localHeader.sessionInfoUpdate;
			}
		}
	}

	return false;
}

bool irsdkMemServer::isHeaderFinalized()
{
	return m_isHeaderFinalized;
}

bool irsdkMemServer::finalizeHeader()
{
	assert(!m_isHeaderFinalized);

	if(m_isInitialized && !m_isHeaderFinalized)
	{
		// copy our local header
		memcpy(pHeader, &localHeader, sizeof(localHeader));
		// copy over the var header
		char *pBase = pSharedMem + localHeader.varHeaderOffset;
		memcpy(pBase, &localVarHeader, sizeof(localVarHeader));

		// flush caches to all processors
		_WriteBarrier();

		localHeader.status = irsdk_stConnected;
		pHeader->status = irsdk_stConnected;

		//should we fire an event?
		PulseEvent(hDataValidEvent);

		// only write header out once
		m_isHeaderFinalized = true;
		return true;
	}

	return false;
}

bool irsdkMemServer::isInitialized()
{
	return m_isInitialized;
}

bool irsdkMemServer::resetSampleVars()
{
	if(m_isInitialized)
	{
		char *pBase = pSharedMem + localHeader.varBuf[curBuf].bufOffset;
		memset(pBase, 0, irsdkMemServer::bufLength);

		return true;
	}
	return false;
}

bool irsdkMemServer::pollSampleVars()
{
	const irsdk_varHeader *rec;
	if(m_isInitialized)
	{
		char *pBase = pSharedMem + localHeader.varBuf[curBuf].bufOffset;

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

		// flush caches to all processors
		_WriteBarrier();

		// update indexes
		localHeader.varBuf[curBuf].tickCount = count;
		pHeader->varBuf[curBuf].tickCount = count;

		// flush caches to all processors
		_WriteBarrier();

		// and signal new data
		PulseEvent(hDataValidEvent);

		// switch buffers
		curBuf = (curBuf+1) % irsdkMemServer::bufCount;

		// increment count
		count++;
		return true;
	}

	return false;
}

int irsdkMemServer::varNameToIndex(const char *name)
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

const irsdk_varHeader *irsdkMemServer::getHeaderByIndex(int index)
{
	if(index >= 0 && index < localHeader.numVars)
		return &localVarHeader[index];

	return NULL;
}
