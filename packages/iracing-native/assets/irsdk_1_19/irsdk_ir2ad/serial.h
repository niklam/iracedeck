#ifndef SERIAL_H
#define SERIAL_H

class Serial
{
public:
	Serial()
		: m_serial(NULL)
	{}

	bool openSerial(int port, int baudRate);
	void closeSerial();

	void clearSerial();
	bool serialHasData();

	int readSerial(char *buf, int len);
	int writeSerial(const char *buf);
	int writeSerialPrintf(const char *fmt, ...);

	int enumeratePorts(int list[], int *count);

public:
	static const int m_max_serial_buf = 8192;

protected:

	HANDLE m_serial;
};

#endif // SERIAL_H