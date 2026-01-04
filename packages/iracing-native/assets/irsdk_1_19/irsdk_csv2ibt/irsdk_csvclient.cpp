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
#include <stdlib.h>
#include <ctype.h>

#include <assert.h>
#include "irsdk_defines.h"
#include "irsdk_csvclient.h"

#pragma warning(disable:4996)

#define MAX_LINE 20000

int timeOffset = -1;
int sessionTimeOffset = -1;
float timeCount = 0;
bool hasSessionTime = false;

int lapOffset = -1;
bool hasLap = false;


bool irsdkCSVClient::openFile(const char *path, 
	int headerIdx, int descIdx, int unitIdx, int typeIdx, int dataIdx)
{
	closeFile();

	m_csvFile = fopen(path, "r");
	if(m_csvFile)
	{
		char line[MAX_LINE];
		bool hasHeader = false;
		bool hasDesc = false;
		bool hasUnit = false;
		bool hasType = false;
		bool hasConversion = false;
		bool isYAMLStr = false;

		// grab the header
		int lineIdx = 0;
		while(fgets(line, MAX_LINE, m_csvFile) && strlen(line) > 0)
		{
			lineIdx++; // index from 1!
			line[MAX_LINE-1] = '\0';
			line_type type = ltMisc;

			// did they manually specify the data header?, then use that
			if (headerIdx > 0)
			{
				if (lineIdx == headerIdx)
					type = ltHeader;
				else if (lineIdx == descIdx)
					type = ltDescription;
				else if (lineIdx == unitIdx)
					type = ltUnit;
				else if (lineIdx == typeIdx)
					type = ltType;
				else if (lineIdx >= dataIdx)
					type = ltData;
			}
			else // otherwise try to auto detect
				type = getLineType(line, hasHeader, hasDesc, hasUnit, hasType, hasConversion, isYAMLStr);

			// Process the lines, now that we know what they are

			if(type == ltYAMLStart || type == ltYAMLContent || type == ltYAMLEnd)
			{
				// for now only support one yaml string
				if(type == ltYAMLStart)
					yamlStr[0] = '\0';

				strcat(yamlStr, line); //****FixMe, not safe, keep track of string length and don't overflow buffer
			}
			else if(type == ltHeader)
			{
				int len = (int)strlen(line);
				// guess at how many entrys there are
				int count = 3; // there must be at least one, we hope, and we need room for SessionTime and Lap
				for(int i=0; i < len; i++)
				{
					if(line[i] == ',')
					{
						count++;
					}
				}

				// allocate memory
				m_varBuf = new float[count];
				m_varHeaders = new irsdk_varHeader[count];
				m_varScale = new scale[count];


				if(m_varHeaders && m_varBuf && m_varScale)
				{
					memset(m_varBuf, 0, sizeof(float) * count);
					memset(m_varHeaders, 0, sizeof(irsdk_varHeader) * count);
					for(int i=0; i<count; i++)
					{
						m_varScale[i].mul = 1;
						m_varScale[i].add = 0;
						m_varHeaders[i].type = irsdk_float; // assume float data by default
					}
					m_varCount = 0;

					int offset = 0;
					char *st = getNextElement(line);
					while(st != NULL && m_varCount < count)
					{
						parceNameAndUnit(st, m_varHeaders[m_varCount], offset);

						if(strcmp(m_varHeaders[m_varCount].name, "SessionTime") == 0)
							hasSessionTime = true;
						else if(strcmp(m_varHeaders[m_varCount].name, "Time") == 0)
							timeOffset = m_varCount;

						if(strcmp(m_varHeaders[m_varCount].name, "Lap") == 0)
							hasLap = true;

						m_varScale[m_varCount].mul = 1;
						m_varScale[m_varCount].add = 0;
						m_varHeaders[m_varCount].type = irsdk_float; // assume float data by default
						m_varCount++;

						st = getNextElement(NULL);
					}

					// make sure thers is a variabl called SessionTime
					if(!hasSessionTime)
					{
						parceNameAndUnit("SessionTime[s]", m_varHeaders[m_varCount], offset);
						sessionTimeOffset = m_varCount;
						m_varScale[m_varCount].mul = 1;
						m_varScale[m_varCount].add = 0;
						m_varHeaders[m_varCount].type = irsdk_float; // assume float data by default
						m_varCount++;
					}

					// make sure thers is a variabl called Lap
					if(!hasLap)
					{
						parceNameAndUnit("Lap[]", m_varHeaders[m_varCount], offset);
						lapOffset = m_varCount;
						m_varScale[m_varCount].mul = 1;
						m_varScale[m_varCount].add = 0;
						m_varHeaders[m_varCount].type = irsdk_float; // assume float data by default
						m_varCount++;
					}
				}
			}
			else if(type == ltDescription)
			{
					int count = 0;
					char *st = getNextElement(line); 
					while(st != NULL && count < m_varCount)
					{
						st = stripEnds(st);
						strncpy(m_varHeaders[count].desc, st, IRSDK_MAX_DESC);
						m_varHeaders[count].desc[IRSDK_MAX_DESC-1] = '\0';

						count++;
						st = getNextElement(NULL);
					}
			}
			else if(type == ltUnit)
			{
					int count = 0;
					char *st = getNextElement(line); 
					while(st != NULL && count < m_varCount)
					{
						st = stripEnds(st);
						strncpy(m_varHeaders[count].unit, st, IRSDK_MAX_STRING);
						m_varHeaders[count].unit[IRSDK_MAX_STRING-1] = '\0';

						count++;
						st = getNextElement(NULL);
					}
			}
			else if(type == ltType)
			{
					int count = 0;
					char *st = getNextElement(line); 
					while(st != NULL && count < m_varCount)
					{
						//****FixMe, can't set this correctly unless we force parseDataLine() to match, and allocate m_varBuf[] properly
						/*
						if(0 == strcmp(st, "double"))
							m_varHeaders[count].type = irsdk_double;
						else if(0 == strcmp(st, "float"))
							m_varHeaders[count].type = irsdk_float;
						else if(0 == strcmp(st, "bitfield"))
							m_varHeaders[count].type = irsdk_bitField;
						else if(0 == strcmp(st, "integer"))
							m_varHeaders[count].type = irsdk_int;
						else if(0 == strcmp(st, "boolean"))
							m_varHeaders[count].type = irsdk_bool;
						else if(0 == strcmp(st, "string"))
							m_varHeaders[count].type = irsdk_char;
						else
						*/
							m_varHeaders[count].type = irsdk_float;

						count++;
						st = getNextElement(NULL);
					}
			}
			else if(type == ltConvert)
			{
					int count = 0;
					char *st = getNextElement(line); 
					while(st != NULL && count < m_varCount)
					{
						if(st[0])
						{
							char *s;
							s = strchr(st, '*');
							if(s && s[0])
								m_varScale[count].mul = (float)atof((s+1));

							s = strchr(st, '+');
							if(s && s[0])
								m_varScale[count].add = (float)atof((s+1));
						}

						count++;
						st = getNextElement(NULL);
					}
			}
			else if(type == ltData)
			{
				// we eat the rest of the file in this function
				parseDataLine(line);
				return true;
			}
		}
		fclose(m_csvFile);
		m_csvFile = NULL;
	}

	return false;
}

void irsdkCSVClient::closeFile()
{
	if(m_varBuf)
		delete [] m_varBuf;
	m_varBuf = NULL;

	if(m_varHeaders)
		delete [] m_varHeaders;
	m_varHeaders = NULL;

	if(m_varScale)
		delete [] m_varScale;
	m_varScale = NULL;

	if(m_csvFile)
		fclose(m_csvFile);
	m_csvFile = NULL;
}


bool irsdkCSVClient::parseDataLine(char* line)
{
	if(m_varBuf != NULL)
	{
		// clear out old data
		memset(m_varBuf, 0, sizeof(float)*m_varCount);

		if(line)
		{
			int i = 0;
			char *st = getNextElement(line);
			while(st != NULL && i < m_varCount)
			{
				//****FixMe, convert based on unit type, if set
				m_varBuf[i] = strToFloat(st);
				m_varBuf[i] = m_varBuf[i] * m_varScale[i].mul;
				m_varBuf[i] = m_varBuf[i] + m_varScale[i].add;
				i++;

				st = getNextElement(NULL);
			}

			// copy or fake up a session time entry
			if(!hasSessionTime)
			{
				if(timeOffset > -1)
					m_varBuf[sessionTimeOffset] = m_varBuf[timeOffset];
				else
				{
					m_varBuf[sessionTimeOffset] = timeCount;
					timeCount += (1.0f / 60.0f);
				}
			}

			// fake up a lap entry
			if(!hasLap)
				m_varBuf[lapOffset] = 0;

			return true;
		}
	}

	return false;
}

bool irsdkCSVClient::getNextData()
{
	if(m_csvFile != NULL)
	{
		char line[MAX_LINE];
		if(fgets(line, MAX_LINE, m_csvFile) && strlen(line) > 0)
		{
			line[MAX_LINE-1] = '\0';
			return parseDataLine(line);
		}
	}

	return false;
}

int irsdkCSVClient::getVarIdx(const char *name)
{
	if(m_csvFile && name)
	{
		for(int idx=0; idx<m_varCount; idx++)
		{
			if(0 == strncmp(name, m_varHeaders[idx].name, IRSDK_MAX_STRING))
			{
				return idx;
			}
		}
	}

	return -1;
}

float irsdkCSVClient::getVarFloat(int idx)
{
	if(m_csvFile)
	{
		if(idx >= 0 && idx < m_varCount)
			return m_varBuf[m_varHeaders[idx].offset];
		else //invalid variable index
			assert(false);
	}

	return 0.0f;
}

void irsdkCSVClient::parceNameAndUnit(const char *str, irsdk_varHeader &head, int &varOffset)
{
	// deal with strings like ' name with space [ unit ] '
	// turn it into 'namewithspace' and 'unit'

	head.name[0] = '\0';
	head.unit[0] = '\0';
	head.type = irsdk_float;
	head.count = 1;
	head.desc[0] = '\0';
	head.offset = varOffset;
	varOffset += 4;

	char *buf = head.name;
	int offset = 0;
	bool isUnit = false;

	if(str)
	{
		while(str[0] != '\0')
		{
			if(str[0] == '[')
			{
				buf = head.unit;
				offset = 0;
				isUnit = true;
			}
			else if(str[0] == ']' || str[0] == ' ' || str[0] == '\t' || str[0] == '\n' || str[0] == '\r')
			{
				// do nothing
			}
			else if(isUnit || isalnum((unsigned char)str[0]))
			{
				if(offset < (IRSDK_MAX_STRING-1))
				{
					buf[offset] = str[0];
					offset++;
					buf[offset] = '\0';
				}
			}
			// else throw it away

			str++;
		}
	}
}


// irsdk_writeTest outputs a csv with the following sequence
// yaml header (session string)
// column names (header) - single words with no space ie name, name, name
// column descriptions - multiple words with spaces ie desc has many words, this one does too
// column unit type - few characters, possibly with slash and percent symbols ie c, f, m/s, %
// column data type - string descriptors like double, integer, float, bitfield, boolean
// column data - numbers minus sign and decimal points ie 3.14, 23, -56.5
//
// you can also add the units directly to the name by appending it 
// in bracets like this: name[unit],
//
//****FixMe add in conversion support
// conversions would be in the form of +5*7
//
irsdkCSVClient::line_type irsdkCSVClient::getLineType(const char *str, bool &hasHeader, bool &hasDesc, bool &hasUnit, bool &hasType, bool &hasConversion, bool &isYAMLStr)
{
	if(str)
	{
		int delimCount = 0;
		int unitBracketCount = 0;
		int cvtCount = 0;
		int numCount = 0;
		int alphaCount = 0;
		int spaceCount = 0;
		int typeCount = 0;
		int miscCount = 0;

		// check for yaml string first
		if(!hasHeader && !hasUnit && 0 == strncmp(str, "---", 3))
		{
			isYAMLStr = true;
			return ltYAMLStart;
		}

		if(!hasHeader && !hasUnit && 0 == strncmp(str, "...", 3))
		{
			isYAMLStr = false;
			return ltYAMLEnd;
		}

		if(isYAMLStr)
			return ltYAMLContent;

		int len = strlen(str);
		for(int i=0; i<len; i++)
		{
			if(0 == strncmp(&str[i], "double", strlen("double")) ||
			   0 == strncmp(&str[i], "integer", strlen("integer")) ||
			   0 == strncmp(&str[i], "boolean", strlen("boolean")) ||
			   0 == strncmp(&str[i], "bitfield", strlen("bitfield")) ||
			   0 == strncmp(&str[i], "float", strlen("float")) )
			{
			   typeCount++;
			}
			else if(str[i] == ',')
				delimCount++;
			else if(str[i] == '[' || str[i] == ']')
				unitBracketCount++;
			else if(str[i] == '*' || str[i] == '+')
				cvtCount++;
			else if((str[i] >= '0' && str[i] <= '9') || str[i] == '.' || str[i] == '-')
				numCount++;
			else if(str[i] == ' ' || str[i] == '\t')
				spaceCount++;
			else if(isalpha((unsigned char)str[i]))
				alphaCount++;
			else
				miscCount++;
		}

		if(delimCount < 2) // no delimiters, then junk line
			return ltMisc;
		// else it is something

		if(typeCount > 0.5*delimCount) // if we know this is a type line
		{
			hasType = true;
			return ltType;
		}
		else if(alphaCount > delimCount) // not a number if enough characters for every column to have one
		{
			// column names (header) - assume first non junk line is header
			if(!hasHeader)
			{
				// check if we have units declared in brackets after our name like name1[unit1],name2[unit2]
				// technically we should look at unitBracketCount/2, but lets be forgiving of missing units
				if(unitBracketCount > delimCount)
					hasUnit = true;

				hasHeader = true;
				return ltHeader;
			}

			// column descriptions - multiple words with spaces ie desc has many words, this one does too
			if(!hasDesc && alphaCount > 5*delimCount)
			{
				hasDesc = true;
				return ltDescription;
			}

			// column unit type - few characters, possibly with slash and percent symbols ie c, f, m/s, %
			if(!hasUnit && alphaCount < 3*delimCount)
			{
				hasUnit = true;
				return ltUnit;
			}
		}
		else // is a number
		{
			// if we find +* and numbers then assume it is a unit conversion line
			if(!hasConversion && cvtCount > 0 && numCount > 0)
			{
				hasConversion = true;
				return ltConvert;
			}

			// if line is mostly made up of numbers, and there are enough numbers for one in each column
			// then assume this is data.
			if(numCount > delimCount && numCount > (4 * alphaCount))
			{
				return ltData;
			}
		}


		return ltMisc;

	}

	return ltMisc;
}

char* irsdkCSVClient::stripEnds(char *st)
{
	if(st)
	{
		while(st[0] == ' ' || st[0] == '\t')
			st++;
		while(st[0] && (st[strlen(st)-1] == ' ' || st[strlen(st)-1] == '\t' || st[strlen(st)-1] == '\n' || st[strlen(st)-1] == '\r'))
			st[strlen(st)-1] = '\0';
	}

	return st;
}

//****Warning, this modifies baseStr!
char* irsdkCSVClient::getNextElement(char *baseStr)
{
	static char* str = NULL;

	// reset string pointer, if provided
	if(baseStr)
		str = baseStr;

	// check that we have any string left before processing
	if(!str || *str == '\0')
		return NULL;

	// stash off the start of the string
	char *s = str;

	// and search for a delimiter or the end of the string
	while(str[0] && str[0] != ',' && str[0] != '\n' && str[0] != '\r')
	{
		str++;
	}

	// zero the delimiter if we find it
	// making sure to eat them all up
	while(str[0] == ',' || str[0] == '\n' || str[0] == '\r')
	{
		str[0] = '\0';
		str++;
	}

	// strip quotes
	//****Note, this is not optimal, we should be able to embed a comma inside a quote
	if (*s == '"')
		s++;
	for (char* st = s; *st != '\0'; st++)
		if (*st == '"')
			*st = '\0';

	// return the segment we found
	return s;
}

float irsdkCSVClient::strToFloat(const char *str)
{
	if(str)
	{
		while(str[0] && (str[0] == ' ' || str[0] == '\t'))
			str++;
		if(str[0])
			return (float)atof(str);
	}

	return 0.0f;
}