#include <Windows.h>
#include <stdio.h>
#include<stdarg.h>

#include "serial.h"

#pragma warning(disable:4996)


void Serial::clearSerial()
{
	PurgeComm (m_serial, PURGE_TXABORT | PURGE_TXCLEAR | PURGE_RXABORT | PURGE_RXCLEAR);
}

bool Serial::openSerial(int port, int baudRate)
{
	char portStr[64] = "";
	sprintf(portStr, "\\\\.\\COM%d", port);

	// open serial port
	m_serial = CreateFileA( portStr, GENERIC_READ|GENERIC_WRITE, 0, NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
	if(m_serial != INVALID_HANDLE_VALUE)
	{
		// setup serial port
		DCB dcbSerialParams = {0};
		if (GetCommState(m_serial, &dcbSerialParams))
		{
			dcbSerialParams.BaudRate=baudRate;
			dcbSerialParams.ByteSize=8;
			dcbSerialParams.StopBits=ONESTOPBIT;
			dcbSerialParams.Parity=NOPARITY;

			if(SetCommState(m_serial, &dcbSerialParams))
			{
				SetupComm (m_serial, m_max_serial_buf, m_max_serial_buf);  /* Set buffer size. */
				
				COMMTIMEOUTS ct = {0};
				ct.ReadIntervalTimeout = MAXDWORD;
				ct.ReadTotalTimeoutMultiplier = 0;
				ct.ReadTotalTimeoutConstant = 0;
				ct.WriteTotalTimeoutMultiplier = 20000L / baudRate;
				ct.WriteTotalTimeoutConstant = 0;
				SetCommTimeouts (m_serial, &ct);

				clearSerial();

				return true;
			}
		}
		CloseHandle(m_serial);
	}

	m_serial = NULL;
	return false;
}
 
void Serial::closeSerial()
{
	if(m_serial)
		CloseHandle(m_serial);
	m_serial = NULL;
}
 
bool Serial::serialHasData()
{
	COMSTAT status;
	DWORD errors;

	//Find out how much data is available to be read.
	ClearCommError(m_serial, &errors, &status);
	if(status.cbInQue)
		return true;

	return false;
}
 
int Serial::readSerial(char *buf, int len)
{
	DWORD bytesRead = 0;
	if(buf && len > 0)
	{
		if(m_serial && serialHasData())
		{
			if(ReadFile(m_serial, buf, len-1, &bytesRead, NULL) && bytesRead > 0)
			{
				if(bytesRead > (DWORD)(len-1))
					bytesRead = len-1;

				buf[bytesRead] = '\0';
			}
		}
	}

	return bytesRead;
}

int Serial::writeSerial(const char *buf)
{
	DWORD bytesWritten = 0;
	if(buf)
	{
		size_t len = strlen(buf);
		if(m_serial)
		{
			if(WriteFile(m_serial, buf, (DWORD)len, &bytesWritten, NULL))
			{
				// success
			}
		}
	}

	return bytesWritten;
}

int Serial::writeSerialPrintf(const char *fmt, ...)
{
	if(fmt)
	{
		static const int tstrLen = 4096;
		char tstr[tstrLen];

	    va_list arglist;
	    va_start(arglist, fmt);

	    //customized operations...
	    vsnprintf_s(tstr, tstrLen, fmt, arglist);
		tstr[tstrLen-1] = '\0';

	    va_end(arglist);

		return writeSerial(tstr);
	}

	return 0;
}

int Serial::enumeratePorts(int list[], int *count)
{
	//What will be the return value
	bool bSuccess = false;

	int bestGuess = -1;
	int maxList = 0;
	if(count)
	{
		maxList = *count;
		*count = 0;
	}

	//Use QueryDosDevice to look for all devices of the form COMx. Since QueryDosDevice does
	//not consitently report the required size of buffer, lets start with a reasonable buffer size
	//of 4096 characters and go from there
	const static int nChars = 40000;
	char pszDevices[nChars];
	DWORD dwChars = QueryDosDeviceA(NULL, pszDevices, nChars);
	if (dwChars == 0)
	{
		DWORD dwError = GetLastError();
		if (dwError == ERROR_INSUFFICIENT_BUFFER)
			printf("needs more room!\n");
	}
	else
	{
		bSuccess = true;
		size_t i=0;

		while (pszDevices[i] != '\0')
		{
			//Get the current device name
			char* pszCurrentDevice = &pszDevices[i];

			//If it looks like "COMX" then
			//add it to the array which will be returned
			size_t nLen = strlen(pszCurrentDevice);
			if (nLen > 3)
			{
				if ((0 == strncmp(pszCurrentDevice, "COM", 3)) && isdigit(pszCurrentDevice[3]))
				{
					//Work out the port number
					int nPort = atoi(&pszCurrentDevice[3]);
					if(list && count && maxList > *count)
					{
						list[*count] = nPort;
						(*count)++;
					}
					if(bestGuess < nPort)
						bestGuess = nPort;
				}
			}

			//Go to next device name
			i += (nLen + 1);
		}
	}
	return bestGuess;
}
