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

//A sample app that demonstrates how to integrate the iRacing telemetry server side api in your own product
// by default data is transmitted to a memory mapped file, and written to c:\temp\*.ibt


// don't warn about stdlib
#pragma warning(disable: 4996) 

#include <windows.h>
#include <stdio.h>
#include <conio.h>
#include <signal.h>
#include <time.h>
#include <assert.h>

#include "irsdk_defines.h"
#include "yaml_parser.h"

#include "irsdk_server.h"

// forward decleration
void irsdkUpdateSessionInfo();

// add an output based on a static var, 
// nothing more is needed here the irsdk server 
// will automatically poll the variable every tick
static float g_staticVariable[10] = { 0.0f };
static irsdkVar irsdkStaticVariable("StaticVariable", &g_staticVariable, irsdk_float, 10, "Static variable array that is auto polled", "m/s", IRSDK_LOG_ALL);

// add an output that is manually updated every tick.
// You can use the call iradkDynamicVar->setValue(x) to update it.
static irsdkVar irsdkManualSet("ManualSet", NULL, irsdk_bool, 1, "Manually set a value to telemetry every tick", "", IRSDK_LOG_LIVE);

// for now these are mandatory variables, feel free to rewrite the disk writer as needed
static double g_sessionTime = 0.0;
static irsdkVar irsdkSessionTime("SessionTime", &g_sessionTime, irsdk_double, 1, "Disk writer currently hardwired to use session time", "s", IRSDK_LOG_ALL);
static int g_lap = 0;
static irsdkVar irsdkLap("Lap", &g_lap, irsdk_int, 1, "Disk writer currently hardwired to use lap", "", IRSDK_LOG_ALL);

void main()
{
	printf("irsdk_server 1.0\n");
	printf(" demo program to show how to setup your own telemetry server\n\n");
	printf("press enter to exit:\n\n");

	// hook a variable up dynamically at runtime.  
	// This is only needed if you don't know what the variable name is at compile time
	// or you want to selectively output the variable
	// In either case you still must register the variable before calling irsdkServer::instance()->finalizeHeader()
	int dynamicVar = 1;
	int dynamicVarIndex = irsdkServer::instance()->regVar("dynamicVar", &dynamicVar, irsdk_int, 1, "hook a variable up dynamically at runtime", "m", IRSDK_LOG_ALL);
	// same as above, but don't add a pointer to the variable, instead we will update it on the fly
	int dynamicVar2Index = irsdkServer::instance()->regVar("dynamicVar2", NULL, irsdk_int, 1, "hook a variable up dynamically at runtime", "m", IRSDK_LOG_ALL);

	// do your game initialization...

	while(!_kbhit())
	{
		// before going into your main data output loop, you must mark the headers as final
		// it is possible for finalizeHeader() to fail, so try every tick, just in case
		if(!irsdkServer::instance()->isHeaderFinalized())
			irsdkServer::instance()->finalizeHeader();

		// reset the data for this pass, if something is not updated
		// we will output zero for that tick
		if(irsdkServer::instance()->isInitialized())
			irsdkServer::instance()->resetSampleVars();

		if(irsdkServer::instance()->isHeaderFinalized())
		{
			//update the session string, but only once a second
			static int tickCount = 0;
			if(0 == (tickCount++ % TICKS_PER_SEC))
			{
				irsdkUpdateSessionInfo();
			}

			// read out variables that have registered with pointers back to them
			irsdkServer::instance()->pollSampleVars();

			// update our data...
			g_staticVariable[0] = 1.0f;
			irsdkManualSet.setVar(true);

			dynamicVar = 1;
			int data = 1;
			irsdkServer::instance()->setVar(dynamicVar2Index, &data);

			g_sessionTime += 1.0/TICKS_PER_SEC;

			// use these to turn disk based logging on and off
			if(!irsdkServer::instance()->isDiskLoggingEnabled()) // disk logging is turned on
				irsdkServer::instance()->toggleDiskLogging(); // turn logging on or off
			//irsdkServer::instance()->isDiskLoggingActive(); // disk logging is actively writting to disk
		}
	}

	// if you passed a pointer to the dynamic variable, then release the pointer before your variable disapears
	irsdkServer::instance()->reRegVar(dynamicVarIndex, NULL);

	// otherwise there is no need to deconstruct anything

	printf("Shutting down.\n\n");
}		
			

// our YAML string of 'slow' changing data and hirarchical data
void irsdkUpdateSessionInfo()
{
	static const int m_len = irsdkServer::sessionStrLen;
	int len = 0;
	char tstr[m_len] = "";

	// Start of YAML file
	len += _snprintf(tstr+len, m_len-len,"---\n");

	// YAML uses spaces at the front to mark nested values
	len += _snprintf(tstr+len, m_len-len,"Section1:\n");
	len += _snprintf(tstr+len, m_len-len," SubVal1: %s\n", "value");
	len += _snprintf(tstr+len, m_len-len," SubVal2: %d\n", 1);
	len += _snprintf(tstr+len, m_len-len," SubSection1:\n");
	len += _snprintf(tstr+len, m_len-len,"  SubVal3: %d\n", 1);

	len += _snprintf(tstr+len, m_len-len,"Section2:\n");
	len += _snprintf(tstr+len, m_len-len," SubSectionArray:\n");

	// arrays of data use '-' to mark the start of a new element
	for(int i=0; i< 10; i++)
	{
		len += _snprintf(tstr+len, m_len-len," - Element1: %d\n", i);
		len += _snprintf(tstr+len, m_len-len,"   Element2: value\n");
		len += _snprintf(tstr+len, m_len-len,"   Element3: %d\n", i*2);
	}
	len += _snprintf(tstr+len, m_len-len,"\n");

	// End of YAML file
	len += _snprintf(tstr+len, m_len-len,"...\n");

	tstr[m_len-1] = '\0';

	// make sure we are not close to running out of room
	assert(len < (m_len-256)); 

	// and push it out
	irsdkServer::instance()->regSessionInfo(tstr);
}

