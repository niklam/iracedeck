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

//****FixMe, rename to irsdkDiskReader
class irsdkDiskClient 
{
public:

	irsdkDiskClient();
	irsdkDiskClient(const char *path);
	~irsdkDiskClient() { closeFile(); }

	bool isFileOpen() { return m_ibtFile != NULL; }
	bool openFile(const char *path);
	void closeFile();

	// read next line out of file
	bool getNextData(); //****Note, should be called readLine();
	int getDataCount() { return m_diskSubHeader.sessionRecordCount; }

	// return how many variables this .ibt file has in the header
	int getNumVars();

	int getVarIdx(const char *name);

	// get info on the var
	const char* getVarName(int idx);
	const char* getVarDesc(int idx);
	const char* getVarUnit(int idx);

	// what is the base type of the data
	irsdk_VarType getVarType(int idx);
	irsdk_VarType getVarType(const char *name) { return getVarType(getVarIdx(name)); }

	// how many elements in array, or 1 if not an array
	int getVarCount(int idx);
	int getVarCount(const char *name) { return getVarCount(getVarIdx(name)); }

	// idx is the variables index, entry is the array offset, or 0 if not an array element
	// will convert data to requested type
	bool getVarBool(int idx, int entry = 0);
	bool getVarBool(const char *name, int entry = 0) { return getVarBool(getVarIdx(name), entry); }

	int getVarInt(int idx, int entry = 0);
	int getVarInt(const char *name, int entry = 0) { return getVarInt(getVarIdx(name), entry); }
	
	float getVarFloat(int idx, int entry = 0);
	float getVarFloat(const char *name, int entry = 0) { return getVarFloat(getVarIdx(name), entry); }

	double getVarDouble(int idx, int entry = 0);
	double getVarDouble(const char *name, int entry = 0) { return getVarDouble(getVarIdx(name), entry); }

	// 1 success, 0 failure, -n minimum buffer size
	int getSessionStrVal(const char *path, char *val, int valLen);
	// get the whole string
	const char *getSessionStr() { return m_sessionInfoString; }

	// we track session time and lap count in the disk sub header
	time_t getSessionStartDate() { return m_diskSubHeader.sessionStartDate; }
	double getSessionStartTime_s() { return m_diskSubHeader.sessionStartTime; }
	double getSessionEndTime_s() { return m_diskSubHeader.sessionEndTime; }
	int getSessionLapCount() { return m_diskSubHeader.sessionLapCount; }

	long getFileSize() { return m_ibtFileSize; }

protected:

	irsdk_header m_header;
	irsdk_diskSubHeader m_diskSubHeader;

	char *m_sessionInfoString;
	irsdk_varHeader *m_varHeaders;
	char *m_varBuf;

	FILE *m_ibtFile;
	long m_ibtFileSize;
};

class irsdkDiskWriter
{
public:

	irsdkDiskWriter();
	irsdkDiskWriter(const char *path);
	~irsdkDiskWriter() { closeFile(); }

	bool isFileOpen() { return m_ibtFile != NULL; }
	bool openFile(const char *path);
	void closeFile();

	int addNewVariable(const char *name, const char *desc, const char *unit, const irsdk_VarType type, int count = 1);
	bool isHeaderFinalized() { return m_isHeaderFinalized; }
	void finalizeHeader();

	// write next line to file and clear buffers
	void writeLine();
	int getDataCount() { return m_diskSubHeader.sessionRecordCount; }

	// return how many variables this .ibt file has in the header
	int getNumVars();

	int getVarIdx(const char *name);

	// get info on the var
	const char* getVarName(int idx);
	const char* getVarDesc(int idx);
	const char* getVarUnit(int idx);

	// what is the base type of the data
	irsdk_VarType getVarType(int idx);
	irsdk_VarType getVarType(const char *name) { return getVarType(getVarIdx(name)); }

	// how many elements in array, or 1 if not an array
	int getVarCount(int idx);
	int getVarCount(const char *name) { return getVarCount(getVarIdx(name)); }

	// idx is the variables index, entry is the array offset, or 0 if not an array element
	// will convert data to requested type
	bool setVar(bool val, int idx, int entry = 0);
	bool setVar(bool val, const char *name, int entry = 0) { return setVar(val, getVarIdx(name), entry); }

	bool setVar(int val, int idx, int entry = 0);
	bool setVar(int val, const char *name, int entry = 0) { return setVar(val, getVarIdx(name), entry); }
	
	bool setVar(float val, int idx, int entry = 0);
	bool setVar(float val, const char *name, int entry = 0) { return setVar(val, getVarIdx(name), entry); }

	bool setVar(double val, int idx, int entry = 0);
	bool setVar(double val, const char *name, int entry = 0) { return setVar(val, getVarIdx(name), entry); }

	// get the whole string
	char* getSessionStr() { return m_sessionInfoString; }
	void setSessionStr(const char* str)
	{
		strncpy_s(m_sessionInfoString, str, MAX_SESSIONSTR_LEN);
		m_sessionInfoString[MAX_SESSIONSTR_LEN-1] = '\0';
	}

	// we track session time and lap count in the disk sub header
	time_t getSessionStartDate() { return m_diskSubHeader.sessionStartDate; }
	void setSessionStartDate(const time_t date) { m_diskSubHeader.sessionStartDate = date; }

	double getSessionStartTime_s() { return m_diskSubHeader.sessionStartTime; }
	void setSessionStartTime_s(const double time) { m_diskSubHeader.sessionStartTime = time; }

	double getSessionEndTime_s() { return m_diskSubHeader.sessionEndTime; }
	void setSessionEndTime_s(const double time) { m_diskSubHeader.sessionEndTime = time; }

	int getSessionLapCount() { return m_diskSubHeader.sessionLapCount; }
	void setSessionLapCount(const int lap) { m_diskSubHeader.sessionLapCount = lap; }

	int getTickRate() { return m_header.tickRate; }
	void setTickRate(int rate) { m_header.tickRate = rate; }

protected:

	void initialize();

	irsdk_header m_header;
	irsdk_diskSubHeader m_diskSubHeader;
	int m_diskSubHeaderOffset;
	bool m_isHeaderFinalized;

	//****Note, for now static allocate our buffers
	// could easily aquire these at creation time
	const static int MAX_SESSIONSTR_LEN = 1048576;
	const static int MAX_VAR_COUNT = 1000;
	const static int MAX_VAR_BUF_SIZE = MAX_VAR_COUNT * 32;

	char m_sessionInfoString[MAX_SESSIONSTR_LEN];
	irsdk_varHeader m_varHeaders[MAX_VAR_COUNT];
	char m_varBuf[MAX_VAR_BUF_SIZE];

	FILE *m_ibtFile;
};
#endif // IRSDKDISKCLIENT_H
