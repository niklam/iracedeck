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

#include <stdio.h>
#include <string.h>
#include <time.h>

#include <assert.h>
#include "irsdk_defines.h"
#include "yaml_parser.h"
#include "irsdk_diskclient.h"

#pragma warning(disable:4996)

irsdkDiskClient::irsdkDiskClient()
	: m_ibtFile(NULL)
	, m_sessionInfoString(NULL)
	, m_varHeaders(NULL)
	, m_varBuf(NULL)
	, m_ibtFileSize(0)
{
	memset(&m_header, 0, sizeof(m_header));
	memset(&m_diskSubHeader, 0, sizeof(m_diskSubHeader));
}

irsdkDiskClient::irsdkDiskClient(const char *path)
	: m_ibtFile(NULL)
	, m_sessionInfoString(NULL)
	, m_varHeaders(NULL)
	, m_varBuf(NULL)
	, m_ibtFileSize(0)
{
	memset(&m_header, 0, sizeof(m_header));
	memset(&m_diskSubHeader, 0, sizeof(m_diskSubHeader));

	openFile(path);
}

bool irsdkDiskClient::openFile(const char *path)
{
	closeFile();

	m_ibtFile = fopen(path, "rb");
	if(m_ibtFile)
	{
		// work out file size on disk
		fseek(m_ibtFile, 0L, SEEK_END);
		m_ibtFileSize = ftell(m_ibtFile);
		fseek(m_ibtFile, 0L, SEEK_SET);

		if(fread(&m_header, 1, sizeof(m_header), m_ibtFile) == sizeof(m_header))
		{
			if(fread(&m_diskSubHeader, 1, sizeof(m_diskSubHeader), m_ibtFile) == sizeof(m_diskSubHeader))
			{
				m_sessionInfoString = new char[m_header.sessionInfoLen];
				if(m_sessionInfoString)
				{
					fseek(m_ibtFile, m_header.sessionInfoOffset, SEEK_SET);
					if(fread(m_sessionInfoString, 1, m_header.sessionInfoLen, m_ibtFile) == (size_t)m_header.sessionInfoLen)
					{
						m_sessionInfoString[m_header.sessionInfoLen-1] = '\0';

						m_varHeaders = new irsdk_varHeader[m_header.numVars];
						if(m_varHeaders)
						{
							fseek(m_ibtFile, m_header.varHeaderOffset, SEEK_SET);
							size_t len = m_header.numVars * sizeof(irsdk_varHeader);
							if(fread(m_varHeaders, 1, len, m_ibtFile) == len)
							{
								m_varBuf = new char[m_header.bufLen];
								if(m_varBuf)
								{
									fseek(m_ibtFile, m_header.varBuf[0].bufOffset, SEEK_SET);

									return true;

									//delete [] m_varBuf;
									//m_varBuf = NULL;
								}
							}

							delete [] m_varHeaders;
							m_varHeaders = NULL;
						}
					}

					delete [] m_sessionInfoString;
					m_sessionInfoString = NULL;
				}
			}
		}
		fclose(m_ibtFile);
		m_ibtFile = NULL;
	}

	return false;
}

void irsdkDiskClient::closeFile()
{
	if(m_varBuf)
		delete [] m_varBuf;
	m_varBuf = NULL;

	if(m_varHeaders)
		delete [] m_varHeaders;
	m_varHeaders = NULL;

	if(m_sessionInfoString)
		delete [] m_sessionInfoString;
	m_sessionInfoString = NULL;

	if(m_ibtFile)
		fclose(m_ibtFile);
	m_ibtFile = NULL;

	m_ibtFileSize = 0;
}

bool irsdkDiskClient::getNextData()
{
	if(m_ibtFile)
		return fread(m_varBuf, 1, m_header.bufLen, m_ibtFile) == (size_t)m_header.bufLen;

	return false;
}

// return how many variables this .ibt file has in the header
int irsdkDiskClient::getNumVars()
{
	if(m_ibtFile)
		return m_header.numVars;

	return -1;
}

int irsdkDiskClient::getVarIdx(const char *name)
{
	if(m_ibtFile && name)
	{
		for(int idx=0; idx<m_header.numVars; idx++)
		{
			if(0 == strncmp(name, m_varHeaders[idx].name, IRSDK_MAX_STRING))
			{
				return idx;
			}
		}
	}

	return -1;
}

irsdk_VarType irsdkDiskClient::getVarType(int idx)
{
	if(m_ibtFile)
	{
		if(idx >= 0 && idx < m_header.numVars)
		{
			return (irsdk_VarType)m_varHeaders[idx].type;
		}

		//invalid variable index
		assert(false);
	}

	return irsdk_char;
}

// get info on the var
const char* irsdkDiskClient::getVarName(int idx)
{
	if(m_ibtFile)
	{
		if(idx >= 0 && idx < m_header.numVars)
		{
			return m_varHeaders[idx].name;
		}

		//invalid variable index
		assert(false);
	}

	return NULL;
}

const char* irsdkDiskClient::getVarDesc(int idx)
{
	if(m_ibtFile)
	{
		if(idx >= 0 && idx < m_header.numVars)
		{
			return m_varHeaders[idx].desc;
		}

		//invalid variable index
		assert(false);
	}

	return NULL;
}

const char* irsdkDiskClient::getVarUnit(int idx)
{
	if(m_ibtFile)
	{
		if(idx >= 0 && idx < m_header.numVars)
		{
			return m_varHeaders[idx].unit;
		}

		//invalid variable index
		assert(false);
	}

	return NULL;
}

int irsdkDiskClient::getVarCount(int idx)
{
	if(m_ibtFile)
	{
		if(idx >= 0 && idx < m_header.numVars)
		{
			return m_varHeaders[idx].count;
		}

		//invalid variable index
		assert(false);
	}

	return 0;
}

bool irsdkDiskClient::getVarBool(int idx, int entry)
{
	if(m_ibtFile)
	{
		if(idx >= 0 && idx < m_header.numVars)
		{
			if(entry >= 0 && entry < m_varHeaders[idx].count)
			{
				const char * data = m_varBuf + m_varHeaders[idx].offset;
				switch(m_varHeaders[idx].type)
				{
				// 1 byte
				case irsdk_char:
				case irsdk_bool:
					return (((const char*)data)[entry]) != 0;
					break;

				// 4 bytes
				case irsdk_int:
				case irsdk_bitField:
					return (((const int*)data)[entry]) != 0;
					break;
					
				// test float/double for greater than 1.0 so that
				// we have a chance of this being usefull
				// technically there is no right conversion...
				case irsdk_float:
					return (((const float*)data)[entry]) >= 1.0f;
					break;

				// 8 bytes
				case irsdk_double:
					return (((const double*)data)[entry]) >= 1.0;
					break;
				}
			}
			else
			{
				// invalid offset
				assert(false);
			}
		}
		else
		{
			//invalid variable index
			assert(false);
		}
	}

	return false;
}

int irsdkDiskClient::getVarInt(int idx, int entry)
{
	if(m_ibtFile)
	{
		if(idx >= 0 && idx < m_header.numVars)
		{
			if(entry >= 0 && entry < m_varHeaders[idx].count)
			{
				const char * data = m_varBuf + m_varHeaders[idx].offset;
				switch(m_varHeaders[idx].type)
				{
				// 1 byte
				case irsdk_char:
				case irsdk_bool:
					return (int)(((const char*)data)[entry]);
					break;

				// 4 bytes
				case irsdk_int:
				case irsdk_bitField:
					return (int)(((const int*)data)[entry]);
					break;
					
				case irsdk_float:
					return (int)(((const float*)data)[entry]);
					break;

				// 8 bytes
				case irsdk_double:
					return (int)(((const double*)data)[entry]);
					break;
				}
			}
			else
			{
				// invalid offset
				assert(false);
			}
		}
		else
		{
			//invalid variable index
			assert(false);
		}
	}

	return 0;
}

float irsdkDiskClient::getVarFloat(int idx, int entry)
{
	if(m_ibtFile)
	{
		if(idx >= 0 && idx < m_header.numVars)
		{
			if(entry >= 0 && entry < m_varHeaders[idx].count)
			{
				const char * data = m_varBuf + m_varHeaders[idx].offset;
				switch(m_varHeaders[idx].type)
				{
				// 1 byte
				case irsdk_char:
				case irsdk_bool:
					return (float)(((const char*)data)[entry]);
					break;

				// 4 bytes
				case irsdk_int:
				case irsdk_bitField:
					return (float)(((const int*)data)[entry]);
					break;
					
				case irsdk_float:
					return (float)(((const float*)data)[entry]);
					break;

				// 8 bytes
				case irsdk_double:
					return (float)(((const double*)data)[entry]);
					break;
				}
			}
			else
			{
				// invalid offset
				assert(false);
			}
		}
		else
		{
			//invalid variable index
			assert(false);
		}
	}

	return 0.0f;
}

double irsdkDiskClient::getVarDouble(int idx, int entry)
{
	if(m_ibtFile)
	{
		if(idx >= 0 && idx < m_header.numVars)
		{
			if(entry >= 0 && entry < m_varHeaders[idx].count)
			{
				const char * data = m_varBuf + m_varHeaders[idx].offset;
				switch(m_varHeaders[idx].type)
				{
				// 1 byte
				case irsdk_char:
				case irsdk_bool:
					return (double)(((const char*)data)[entry]);
					break;

				// 4 bytes
				case irsdk_int:
				case irsdk_bitField:
					return (double)(((const int*)data)[entry]);
					break;
					
				case irsdk_float:
					return (double)(((const float*)data)[entry]);
					break;

				// 8 bytes
				case irsdk_double:
					return (double)(((const double*)data)[entry]);
					break;
				}
			}
			else
			{
				// invalid offset
				assert(false);
			}
		}
		else
		{
			//invalid variable index
			assert(false);
		}
	}

	return 0.0;
}

//path is in the form of "DriverInfo:Drivers:CarIdx:{%d}UserName:"
int irsdkDiskClient::getSessionStrVal(const char *path, char *val, int valLen)
{
	if(m_ibtFile && path && val && valLen > 0)
	{
		const char *tVal = NULL;
		int tValLen = 0;
		if(parseYaml(m_sessionInfoString, path, &tVal, &tValLen))
		{
			// dont overflow out buffer
			int len = tValLen;
			if(len > valLen)
				len = valLen;

			// copy what we can, even if buffer too small
			memcpy(val, tVal, len);
			val[len] = '\0'; // origional string has no null termination...

			// if buffer was big enough, return success
			if(valLen >= tValLen)
				return 1;
			else // return size of buffer needed
				return -tValLen;
		}
	}

	return 0;
}

//-----------------

irsdkDiskWriter::irsdkDiskWriter()
{
	initialize();
}

irsdkDiskWriter::irsdkDiskWriter(const char *path)
{
	initialize();

	openFile(path);
}

void irsdkDiskWriter::initialize()
{
	memset(&m_header, 0, sizeof(m_header));
	memset(&m_diskSubHeader, 0, sizeof(m_diskSubHeader));
	memset(&m_sessionInfoString, 0, sizeof(m_sessionInfoString));
	memset(&m_varHeaders, 0, sizeof(m_varHeaders));
	memset(m_varBuf, 0, sizeof(m_varBuf));

	m_ibtFile = NULL;
	m_diskSubHeaderOffset = 0;
	m_isHeaderFinalized = false;

	// default initialization of header
	m_header.ver = IRSDK_VER;
	m_header.status = irsdk_stConnected;
	m_header.tickRate = 60;
	m_header.sessionInfoUpdate = 0;
	m_header.numBuf = 1;
	m_header.varBuf[0].tickCount = 0;

	// fake up yaml string, in case we don't add one later
	sprintf(m_sessionInfoString, "---\n...\n");
}

bool irsdkDiskWriter::openFile(const char *path)
{
	assert(m_ibtFile == NULL);

	m_ibtFile = fopen(path, "wb");
	if(m_ibtFile)
	{
		//****FixMe, is this needed?
		m_diskSubHeaderOffset = 0;
		m_isHeaderFinalized = false;

		return true;
	}

	return false;
}

void irsdkDiskWriter::closeFile()
{
	if(m_ibtFile)
	{
		fseek(m_ibtFile, m_diskSubHeaderOffset, SEEK_SET);
		fwrite(&m_diskSubHeader, 1, sizeof(m_diskSubHeader), m_ibtFile);
		fclose(m_ibtFile);
	}
	m_ibtFile = NULL;
}

int getSizeOfVarType(const irsdk_VarType type)
{
	switch(type)
	{
	// 1 byte
	case irsdk_char:
	case irsdk_bool: return 1;

	// 4 bytes
	case irsdk_int:
	case irsdk_bitField:
	case irsdk_float: return 4;

	// 8 bytes
	case irsdk_double: return 8;

	default:
		assert(false);
		return 1;
	}
}

int irsdkDiskWriter::addNewVariable(const char *name, const char *desc, const char *unit, const irsdk_VarType type, int count)
{
	assert(m_ibtFile);
	assert(!m_isHeaderFinalized);
	assert(count >= 1);

	if(m_ibtFile && !m_isHeaderFinalized)
	{
		// room for the variable?
		if(m_header.numVars < MAX_VAR_COUNT && 
			(m_header.bufLen + count) < MAX_VAR_BUF_SIZE)
		{
			int idx = m_header.numVars;
			m_header.numVars++;

			m_varHeaders[idx].type = type;	// irsdk_VarType
			m_varHeaders[idx].offset = m_header.bufLen;		// offset fron start of buffer row
			m_varHeaders[idx].count = count;		// number of entrys (array)
			m_header.bufLen += count * getSizeOfVarType(type);

			m_varHeaders[idx].countAsTime = false;

			strncpy(m_varHeaders[idx].name, name, sizeof(char) * IRSDK_MAX_STRING);
			strncpy(m_varHeaders[idx].desc, desc, sizeof(char) * IRSDK_MAX_DESC);
			strncpy(m_varHeaders[idx].unit, unit, sizeof(char) * IRSDK_MAX_STRING);	// something like "kg/m^2"

			return idx;
		}
	}

	return -1; // bogus index
}

void irsdkDiskWriter::finalizeHeader()
{
	assert(m_ibtFile);
	assert(!m_isHeaderFinalized);

	if(m_ibtFile && !m_isHeaderFinalized)
	{
		int offset = 0;

		// main header
		offset += sizeof(m_header);

		// sub header is written out at end of session
		m_diskSubHeaderOffset = offset;
		offset += sizeof(m_diskSubHeader);

		// pointer to var definitions
		m_header.varHeaderOffset = offset;
		offset += m_header.numVars * sizeof(irsdk_varHeader);

		// pointer to session info string
		m_header.sessionInfoLen = (int)strlen(m_sessionInfoString);
		m_header.sessionInfoOffset = offset;
		offset += m_header.sessionInfoLen;

		// pointer to start of buffered data
		m_header.varBuf[0].bufOffset = offset;

		fwrite(&m_header, 1, sizeof(m_header), m_ibtFile);
		fwrite(&m_diskSubHeader, 1, sizeof(m_diskSubHeader), m_ibtFile);
		fwrite(&m_varHeaders, 1, m_header.numVars * sizeof(irsdk_varHeader), m_ibtFile);
		fwrite(m_sessionInfoString, 1, m_header.sessionInfoLen, m_ibtFile);

		if(ftell(m_ibtFile) != m_header.varBuf[0].bufOffset)
			printf("ERROR: m_ibtFile pointer mismach: %d != %d\n", ftell(m_ibtFile), m_header.varBuf[0].bufOffset);

		m_isHeaderFinalized = true;
	}
}

// write next line to file and clear buffers
void irsdkDiskWriter::writeLine()
{
	assert(m_ibtFile);
	assert(m_isHeaderFinalized);

	if(m_ibtFile && m_isHeaderFinalized)
	{
		fwrite(m_varBuf, 1, m_header.bufLen, m_ibtFile);
		m_diskSubHeader.sessionRecordCount++;

		// zero out data so we are ready for the next line
		memset(m_varBuf, 0, sizeof(m_varBuf));
	}
}

// return how many variables this .ibt file has in the header
int irsdkDiskWriter::getNumVars()
{
	assert(m_ibtFile);

	if(m_ibtFile)
		return m_header.numVars;

	return -1;
}

int irsdkDiskWriter::getVarIdx(const char *name)
{
	assert(m_ibtFile);
	assert(name);

	if(m_ibtFile && name)
	{
		for(int idx=0; idx<m_header.numVars; idx++)
		{
			if(0 == strncmp(name, m_varHeaders[idx].name, IRSDK_MAX_STRING))
			{
				return idx;
			}
		}
	}

	return -1;
}

irsdk_VarType irsdkDiskWriter::getVarType(int idx)
{
	assert(m_ibtFile);

	if(m_ibtFile)
	{
		if(idx >= 0 && idx < m_header.numVars)
		{
			return (irsdk_VarType)m_varHeaders[idx].type;
		}

		//invalid variable index
		assert(false);
	}

	return irsdk_char;
}

// get info on the var
const char* irsdkDiskWriter::getVarName(int idx)
{
	assert(m_ibtFile);

	if(m_ibtFile)
	{
		if(idx >= 0 && idx < m_header.numVars)
		{
			return m_varHeaders[idx].name;
		}

		//invalid variable index
		assert(false);
	}

	return NULL;
}

const char* irsdkDiskWriter::getVarDesc(int idx)
{
	assert(m_ibtFile);

	if(m_ibtFile)
	{
		if(idx >= 0 && idx < m_header.numVars)
		{
			return m_varHeaders[idx].desc;
		}

		//invalid variable index
		assert(false);
	}

	return NULL;
}

const char* irsdkDiskWriter::getVarUnit(int idx)
{
	assert(m_ibtFile);

	if(m_ibtFile)
	{
		if(idx >= 0 && idx < m_header.numVars)
		{
			return m_varHeaders[idx].unit;
		}

		//invalid variable index
		assert(false);
	}

	return NULL;
}

int irsdkDiskWriter::getVarCount(int idx)
{
	assert(m_ibtFile);

	if(m_ibtFile)
	{
		if(idx >= 0 && idx < m_header.numVars)
		{
			return m_varHeaders[idx].count;
		}

		//invalid variable index
		assert(false);
	}

	return 0;
}

//---

bool irsdkDiskWriter::setVar(bool val, int idx, int entry)
{
	assert(m_ibtFile);

	if(m_ibtFile)
	{
		if(idx >= 0 && idx < m_header.numVars)
		{
			if(entry >= 0 && entry < m_varHeaders[idx].count)
			{
				char * data = m_varBuf + m_varHeaders[idx].offset;
				switch(m_varHeaders[idx].type)
				{
				// 1 byte
				case irsdk_char:
				case irsdk_bool:
					((char*)data)[entry] = val;
					break;

				// 4 bytes
				case irsdk_int:
				case irsdk_bitField:
					((int*)data)[entry] = (int)val;
					break;
					
				// technically there is no right conversion...
				case irsdk_float:
					((float*)data)[entry] = (float)val;
					break;

				// 8 bytes
				case irsdk_double:
					((double*)data)[entry] = (double)val;
					break;
				}

				return true;
			}
			else
			{
				// invalid offset
				assert(false);
			}
		}
		else
		{
			//invalid variable index
			assert(false);
		}
	}

	return false;
}

bool irsdkDiskWriter::setVar(int val, int idx, int entry)
{
	assert(m_ibtFile);

	if(m_ibtFile)
	{
		if(idx >= 0 && idx < m_header.numVars)
		{
			if(entry >= 0 && entry < m_varHeaders[idx].count)
			{
				char * data = m_varBuf + m_varHeaders[idx].offset;
				switch(m_varHeaders[idx].type)
				{
				// 1 byte
				case irsdk_char:
				case irsdk_bool:
					((char*)data)[entry] = (bool)val;
					break;

				// 4 bytes
				case irsdk_int:
				case irsdk_bitField:
					((int*)data)[entry] = (int)val;
					break;
					
				case irsdk_float:
					((float*)data)[entry] = (float)val;
					break;

				// 8 bytes
				case irsdk_double:
					((double*)data)[entry] = (double)val;
					break;
				}

				return true;
			}
			else
			{
				// invalid offset
				assert(false);
			}
		}
		else
		{
			//invalid variable index
			assert(false);
		}
	}

	return false;
}

bool irsdkDiskWriter::setVar(float val, int idx, int entry)
{
	assert(m_ibtFile);

	if(m_ibtFile)
	{
		if(idx >= 0 && idx < m_header.numVars)
		{
			if(entry >= 0 && entry < m_varHeaders[idx].count)
			{
				char * data = m_varBuf + m_varHeaders[idx].offset;
				switch(m_varHeaders[idx].type)
				{
				// 1 byte
				case irsdk_char:
				case irsdk_bool:
					((char*)data)[entry] = (bool)val;
					break;

				// 4 bytes
				case irsdk_int:
				case irsdk_bitField:
					((int*)data)[entry] = (int)val;
					break;
					
				case irsdk_float:
					((float*)data)[entry] = (float)val;
					break;

				// 8 bytes
				case irsdk_double:
					((double*)data)[entry] = (double)val;
					break;
				}

				return true;
			}
			else
			{
				// invalid offset
				assert(false);
			}
		}
		else
		{
			//invalid variable index
			assert(false);
		}
	}

	return false;
}

bool irsdkDiskWriter::setVar(double val, int idx, int entry)
{
	assert(m_ibtFile);

	if(m_ibtFile)
	{
		if(idx >= 0 && idx < m_header.numVars)
		{
			if(entry >= 0 && entry < m_varHeaders[idx].count)
			{
				char * data = m_varBuf + m_varHeaders[idx].offset;
				switch(m_varHeaders[idx].type)
				{
				// 1 byte
				case irsdk_char:
				case irsdk_bool:
					((char*)data)[entry] = (bool)val;
					break;

				// 4 bytes
				case irsdk_int:
				case irsdk_bitField:
					((int*)data)[entry] = (int)val;
					break;
					
				case irsdk_float:
					((float*)data)[entry] = (float)val;
					break;

				// 8 bytes
				case irsdk_double:
					((double*)data)[entry] = (double)val;
					break;
				}

				return true;
			}
			else
			{
				// invalid offset
				assert(false);
			}
		}
		else
		{
			//invalid variable index
			assert(false);
		}
	}

	return false;
}
