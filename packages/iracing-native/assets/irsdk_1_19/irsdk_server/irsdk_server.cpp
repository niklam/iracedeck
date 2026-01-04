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
#include <stdio.h>
#pragma intrinsic(_WriteBarrier)

#include "irsdk_defines.h"
#include "irsdk_server.h"
#include "irsdk_memserver.h"
#include "irsdk_diskserver.h"

// uncomment this to dump the vars to debug
//#define DUMP_IRSDK_VAR_LIST

// static accessors
irsdkServer* irsdkServer::instance()
{
	// initialize on the stack instead of the heap.  
	// That way we get initialized at first call 
	// even if we are called in a static constructor.
	static irsdkServer instance;
	return &instance;
}

irsdkServer::irsdkServer() 
	: varCount(0)
{
	//memset(varLookup, 0, sizeof(varLookup));
}

irsdkServer::~irsdkServer()
{
}

// safe to call before m_isInitialized, only writes to localHeader
int irsdkServer::regVar(const char *name, const void *var, 
							  irsdk_VarType type, int count, 
							  const char *desc, const char *unit,
							  int logMode, float multiplier, float offset)
{
	int index = nameToIndex(name);

	// if not registered already
	if(index < 0)
	{
		// if someone can register
		if(logMode & IRSDK_LOG_ALL)
		{
			// choke if out of room
			assert(varCount < IRSDK_MAX_VARS);
			// create a new entry
			if(varCount < IRSDK_MAX_VARS)
			{
				index = varCount++;
				strncpy(varLookup[index].name, name, IRSDK_MAX_STRING);
				varLookup[index].name[IRSDK_MAX_STRING-1] = '\0';
				varLookup[index].memIndex = varLookup[index].diskIndex = -1;
				varLookup[index].logMode = logMode;
			}
		}
	}

	// ok, we have an index so notify the children
	if(index >= 0 && index < varCount)
	{
		if(logMode & IRSDK_LOG_LIVE)
			varLookup[index].memIndex = irsdkMemServer::instance()->regVar(name, var, type, count, desc, unit, multiplier, offset);

		if(logMode & IRSDK_LOG_DISK)
			varLookup[index].diskIndex = irsdkDiskServer::instance()->regVar(name, var, type, count, desc, unit, multiplier, offset);
	}

	return index;
}

// warning, linear search!  don't call this often
int irsdkServer::reRegVar(const char *name, const void *var)
{
	int index = nameToIndex(name);
	return (reRegVar(index, var)) ? index : -1;
}

bool irsdkServer::reRegVar(int index, const void *var)
{
	if(index >= 0 && index < varCount)
	{
		if(varLookup[index].memIndex >= 0)
			irsdkMemServer::instance()->reRegVar(varLookup[index].memIndex, var);
		if(varLookup[index].diskIndex >= 0)
			irsdkDiskServer::instance()->reRegVar(varLookup[index].diskIndex, var);

		return true;
	}

	return false;
}

// warning, linear search!  don't call this often
int irsdkServer::setVar(const char *name, const void *var)
{
	int index = nameToIndex(name);
	return (setVar(index, var)) ? index : -1;
}

bool irsdkServer::setVar(int index, const void *var)
{
	if(index >= 0 && index < varCount)
	{
		if(varLookup[index].memIndex >= 0)
			irsdkMemServer::instance()->setVar(varLookup[index].memIndex, var);
		if(varLookup[index].diskIndex >= 0)
			irsdkDiskServer::instance()->setVar(varLookup[index].diskIndex, var);

		return true;
	}

	return false;
}

// safe to call before m_isInitialized, only writes to localHeader
bool irsdkServer::regSessionInfo(const char *str)
{
	bool ret = true;
	ret = irsdkMemServer::instance()->regSessionInfo(str) && ret;
	ret = irsdkDiskServer::instance()->regSessionInfo(str) && ret;

	return ret;
}

bool irsdkServer::isHeaderFinalized()
{
	bool ret = true;
	ret = irsdkMemServer::instance()->isHeaderFinalized() && ret;
	ret = irsdkDiskServer::instance()->isHeaderFinalized() && ret;

	return ret;
}

bool irsdkServer::finalizeHeader()
{
	bool ret = true;
	if(!irsdkMemServer::instance()->isHeaderFinalized())
		ret = irsdkMemServer::instance()->finalizeHeader() && ret;
	if(!irsdkDiskServer::instance()->isHeaderFinalized())
		ret = irsdkDiskServer::instance()->finalizeHeader() && ret;

#ifdef DUMP_IRSDK_VAR_LIST
	if(isInitialized())
	{
		printf("irsdkVarList");
		printf("Name, Desc, Unit, Type, LogMem, LogDisk, Length");
		const irsdk_varHeader *pHeader = NULL;
		for(int index=0; index<varCount; index++)
		{
			pHeader = NULL;
			if(!pHeader && varLookup[index].memIndex > -1)
				pHeader = irsdkMemServer::instance()->getHeaderByIndex(varLookup[index].memIndex);
			if(!pHeader && varLookup[index].diskIndex > -1)
				pHeader = irsdkDiskServer::instance()->getHeaderByIndex(varLookup[index].diskIndex);

			if(pHeader)
			{
				char typeStr[32] = "";
				switch(pHeader->type)
				{
				case irsdk_char:
					sprintf(typeStr, "string"); break;
				case irsdk_bool:
					sprintf(typeStr, "bool"); break;
				case irsdk_int:
					sprintf(typeStr, "int"); break;
				case irsdk_bitField:
					sprintf(typeStr, "bitfield"); break;
				case irsdk_float:
					sprintf(typeStr, "float"); break;
				case irsdk_double:
					sprintf(typeStr, "double"); break;
				default:
					sprintf(typeStr, "unknown"); break;
				}

				printf("%s, %s, %s, %s, %d, %d, %d",
					pHeader->name,
					pHeader->desc,
					pHeader->unit,
					typeStr,
					(varLookup[index].logMode & IRSDK_LOG_LIVE) ? 1 : 0,
					(varLookup[index].logMode & IRSDK_LOG_DISK) ? 1 : 0,
					pHeader->count);
			}
		}
	}
#endif
	return ret;
}

bool irsdkServer::isInitialized()
{
	bool ret = true;
	ret = irsdkMemServer::instance()->isInitialized() && ret;
	ret = irsdkDiskServer::instance()->isInitialized() && ret;

	return ret;
}

bool irsdkServer::resetSampleVars()
{
	bool ret = true;
	ret = irsdkMemServer::instance()->resetSampleVars() && ret;
	ret = irsdkDiskServer::instance()->resetSampleVars() && ret;

	return ret;
}

bool irsdkServer::pollSampleVars()
{
	bool ret = true;
	ret = irsdkMemServer::instance()->pollSampleVars() && ret;
	ret = irsdkDiskServer::instance()->pollSampleVars() && ret;

	return ret;
}

int irsdkServer::nameToIndex(const char *name)
{
	if(name)
	{
		for(int index = 0; index < varCount; index++)
		{
			if(0 == strncmp(name, varLookup[index].name, IRSDK_MAX_STRING))
			{
				return index;
			}
		}
	}

	return -1;
}

void irsdkServer::toggleDiskLogging()
{
	irsdkDiskServer::instance()->toggleDiskLogging();
}

bool irsdkServer::isDiskLoggingEnabled()
{
	return irsdkDiskServer::instance()->isDiskLoggingEnabled();
}

bool irsdkServer::isDiskLoggingActive()
{
	return irsdkDiskServer::instance()->isDiskLoggingActive();
}

//-------------

irsdkVar::irsdkVar(const char *name, const void *var, 
				   irsdk_VarType type, int count, 
				   const char *desc, const char *unit,
				   int logMode, float multiplier, float offset)
{
	index = irsdkServer::instance()->regVar(name, var, type, count, desc, unit, logMode, multiplier, offset);
}

bool irsdkVar::reRegVar(const void *var)
{
	return irsdkServer::instance()->reRegVar(index, var);
}

bool irsdkVar::setVar(const void *var)
{
	return irsdkServer::instance()->setVar(index, var);
}

//-------------

void writeVar(int count, int type, float multiplier, float offset, const void *pSourceV, char *pDest)
{
	char *pSource = (char*)pSourceV;

	if(count > 0 && pSource && pDest)
	{

		// if data needs scalling, then slowly walk the array
		if(
			(type == irsdk_int || type == irsdk_float || type == irsdk_double) && 
			(multiplier != 1.0f || offset != 0.0f)
		)
		{
			while(count--)
			{
				switch(type)
				{
				case irsdk_double:
					*((double*)pDest) = (double)(*((double*)pSource) * multiplier + offset);
					break;
				case irsdk_float:
					*((float*)pDest) = (float)(*((float*)pSource) * multiplier + offset);
					break;
				case irsdk_int:
					*((int*)pDest) = (int)(*((int*)pSource) * multiplier + offset);
					break;
				case irsdk_bitField:
					*((int*)pDest) = *((int*)pSource);
					break;
				case irsdk_bool:
					*((char*)pDest) = *((char*)pSource);
					break;
				case irsdk_char:
				default:
					*((char*)pDest) = *((char*)pSource);
					break;
				}
				
				pSource += irsdk_VarTypeBytes[type];
				pDest += irsdk_VarTypeBytes[type];
			}
		}
		// otherwise just copy it over
		else
		{
			// dump to buffer
			memcpy(
				pDest,
				pSource,
				irsdk_VarTypeBytes[type] * count);
		}
	}
}
