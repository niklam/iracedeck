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

#ifndef IRSDKDISKCLIENT_H
#define IRSDKDISKCLIENT_H

// A C++ wrapper around the irsdk calls that takes care of reading a .ibt file

#define MAX_YAML_STR_LEN 131072
class irsdkCSVClient
{
public:

	irsdkCSVClient()
		: m_csvFile(NULL)
		, m_varHeaders(NULL)
		, m_varScale(NULL)
		, m_varBuf(NULL)
		, m_varCount(0)
	{
		//****FixMe, need to strip out SessionLogInfo: from preexisting yaml string!
		const char dummyStr[] =  
			"---\n"
			"WeekendInfo:\n"
			"...\n";
		memcpy(yamlStr, dummyStr, strlen(dummyStr) * sizeof(char));
	}

	irsdkCSVClient(const char *path)
		: m_csvFile(NULL)
		, m_varHeaders(NULL)
		, m_varScale(NULL)
		, m_varBuf(NULL)
		, m_varCount(0)
	{
		openFile(path);
	}

	~irsdkCSVClient() { closeFile(); }

	bool isFileOpen() { return m_csvFile != NULL; }
	bool openFile(const char* path,
		// optionally define offsets
		int headerIdx=-1, int descIdx=-1, int unitIdx=-1, int typeIdx=-1, int dataIdx=-1);
	void closeFile();

	// read next line out of file
	bool getNextData();

	int getVarIdx(const char *name);

	float getVarFloat(int idx);
	float getVarFloat(const char *name) { return getVarFloat(getVarIdx(name)); }

	int getVarCount() { return m_varCount; }
	const irsdk_varHeader* getVarHeaders() { return m_varHeaders; }
	const float* getVarArray() { return m_varBuf; }

	const char* getYAMLStr() { return yamlStr; }

protected:
	enum line_type
	{
		ltMisc = 0,		// don't know what this line is, probably nothing
		ltYAMLStart,	// start of yaml string (---)
		ltYAMLContent,	// middle of yaml string ( MaxCount: 4)
		ltYAMLEnd,		// end of yaml string (...)
		ltHeader,		// names of the columns (YawRate, etc)
		ltDescription,	// long description of the columns (x is the product of y...)
		ltUnit,			// unit type for column (f, s, m/s, etc)
		ltType,			// data type of column (integer, float, double, boolean, bitfield)
		ltConvert,		// conversion parameters (+1*5)
		ltData			// what we came here for (1.34)
	};

	bool parseDataLine(char* line);
	void parceNameAndUnit(const char *str, irsdk_varHeader &head, int &varOffset);
	irsdkCSVClient::line_type getLineType(const char *str, bool &hasHeader, bool &hasDesc, bool &hasUnit, bool &hasType, bool &hasConversion, bool &isYAMLStr);
	char* stripEnds(char *st);
	char* getNextElement(char *baseStr);
	float strToFloat(const char *str);


	// o = i * mul + add;
	struct scale
	{
		float mul;
		float add;
	};

	int m_varCount;
	irsdk_varHeader *m_varHeaders;
	scale *m_varScale;
	float *m_varBuf;

	char yamlStr[MAX_YAML_STR_LEN];

	FILE *m_csvFile;
};

#endif // IRSDKDISKCLIENT_H
