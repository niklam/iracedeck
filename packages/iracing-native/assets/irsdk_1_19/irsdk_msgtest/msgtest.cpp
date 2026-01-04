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

// Simple demo that sends messages to the iracing sim
//
#define MIN_WIN_VER 0x0501

#ifndef WINVER
#	define WINVER			MIN_WIN_VER
#endif

#ifndef _WIN32_WINNT
#	define _WIN32_WINNT		MIN_WIN_VER 
#endif

#pragma warning(disable:4996) //_CRT_SECURE_NO_WARNINGS

#include <windows.h>
#include <stdio.h>
#include <conio.h>
#include <signal.h>

#include "irsdk_defines.h"


void ex_program(int sig) 
{
	(void)sig;

	printf("recieved ctrl-c, exiting\n\n");

	signal(SIGINT, SIG_DFL);
	exit(0);
}

int main()
{
	//trap ctrl-c
	signal(SIGINT, ex_program);
	printf("iRacing remote control demo:\n");
	printf(" - press 'a' to swithc cameras by position.\n");
	printf(" - press 'b' to swithc cameras by driver #.\n");
	printf(" - press 'c' to swithc cameras but not driver.\n");
	printf(" - press 'd' to cycle replay playback speed.\n");
	printf(" - press 'e' to cycle replay search mode.\n");
	printf(" - press 'f' to cycle replay set playback position.\n");
	printf(" - press 'g' to cycle camera state.\n");
	printf(" - press 'h' to clear the replay tape.\n");
	printf("\n");
	printf(" - press 'i' to clear the chat window.\n");
	printf(" - press 'j' to reply to a private chat.\n");
	printf(" - press 'k' to activate the chat window.\n");
	printf(" - press 'l' to activate a chat macro.\n");
	printf("\n");
	printf(" - press 'm' to clear all pitstop commands.\n");
	printf(" - press 'n' to add fuel.\n");
	printf(" - press 'o' to change tires.\n");
	printf(" - press 'p' to clean windows.\n");
	printf(" - press 'q' to clear tire pitstop commands.\n");
	printf("\n");
	printf(" - press 'r' to reload the custom car textures for all cars.\n");
	printf(" - press 's' to reload the custom car textures for a specific carIdx.\n");
	printf("\n");
	printf(" - press 't' to play at normal speed.\n");
	printf(" - press 'u' to play at 1/16th speed.\n");
	printf(" - press 'v' to pause the replay.\n");
	printf("\n");
	printf(" - press 'w' to stop recording telemetry to disk.\n");
	printf(" - press 'x' to start recording telemetry to disk.\n");
	printf(" - press 'y' to save out the old telemetry file and start a new one.\n");
	printf(" - press 'z' to toggle 'true' FFB mode.\n");
	printf(" - press 'A' to go to session 1, time 100 seconds.\n");
	printf("\n");
	printf(" - press 'B' to request a fast repair.\n");
	printf(" - press 'C' to uncheck clear winshield.\n");
	printf(" - press 'D' to uncheck a fast repair.\n");
	printf(" - press 'E' to uncheck add fuel.\n");
	printf("\n");
	printf(" - press 'F' to trigger screen shot\n");
	printf(" - press 'G' to start video capture\n");
	printf(" - press 'H' to stop video capture\n");
	printf(" - press 'I' to toggle video capture\n");
	printf(" - press 'J' to show video timer\n");
	printf(" - press 'K' to hide video timer\n");
	printf("\n");
	printf(" press any other key to exit\n\n");

	bool done = false;
	int playSpeed = 16;
	bool slowMotion = false;
	int replaySearch = 0;
	int replayOffset = 0;
	int replayFrame = 600; // 10 seconds
	int cameraState = 0;
	int carIdx = 0;
	int chatMacro = 0;
	bool trueFFBState = false;

	while(!done)
	{
		char c = (char)_getch();
		switch(c)
		{
		case 'a':
			printf("Switching camera to Pos 1, Group 1\n");
			irsdk_broadcastMsg(irsdk_BroadcastCamSwitchPos, 1, 1, 0);
			break;

		case 'b':
			printf("Switching camera to Driver #64, Group 2\n");
			irsdk_broadcastMsg(irsdk_BroadcastCamSwitchNum, 64, 2, 0);
			break;

		case 'c':
			printf("Switching camera to Group 3\n");
			irsdk_broadcastMsg(irsdk_BroadcastCamSwitchPos, 0, 3, 0);
			break;

		case 'd':
			printf("Set playback speed to %d %d\n", playSpeed, slowMotion);
			irsdk_broadcastMsg(irsdk_BroadcastReplaySetPlaySpeed, playSpeed, slowMotion, 0);
			playSpeed--;
			if(playSpeed < -16)
			{
				playSpeed = 16;
				slowMotion = !slowMotion;
			}
			break;

		case 'e':
			printf("Set replay search to %d\n", replaySearch);
			irsdk_broadcastMsg(irsdk_BroadcastReplaySearch, replaySearch, 0, 0);

			replaySearch++;
			if(replaySearch >= irsdk_RpySrch_Last)
				replaySearch = 0;
			break;

		case 'f':
			printf("Set replay offset to %d %d\n", replayOffset, replayFrame);
			irsdk_broadcastMsg(irsdk_BroadcastReplaySetPlayPosition, replayOffset, replayFrame);

			replayOffset++;
			if(replayOffset >= irsdk_RpyPos_Last)
				replayOffset = 0;

			break;

		case 'g':
			if(cameraState)
				cameraState = 0;
			else
				cameraState = 
					irsdk_CamToolActive |
					irsdk_UIHidden |
					irsdk_UseAutoShotSelection |
					irsdk_UseTemporaryEdits |
					irsdk_UseKeyAcceleration |
					irsdk_UseKey10xAcceleration |
					irsdk_UseMouseAimMode ;

			printf("Set camera state %d\n", cameraState);
			irsdk_broadcastMsg(irsdk_BroadcastCamSetState, cameraState, 0);
			break;

		case 'h':
			printf("Clear replay tape\n");
			irsdk_broadcastMsg(irsdk_BroadcastReplaySetState, irsdk_RpyState_EraseTape, 0);
			break;

		// chat commands
		case 'i':
			printf("Clear chat window\n");
			irsdk_broadcastMsg(irsdk_BroadcastChatComand, irsdk_ChatCommand_Cancel, 0);
			break;

		case 'j':
			printf("Begin reply chat window\n");
			irsdk_broadcastMsg(irsdk_BroadcastChatComand, irsdk_ChatCommand_Reply, 0);
			break;

		case 'k':
			printf("Activate chat window\n");
			irsdk_broadcastMsg(irsdk_BroadcastChatComand, irsdk_ChatCommand_BeginChat, 0);
			break;

		case 'l':
			if(chatMacro > 14)
				chatMacro = 0;

			printf("Sending chat macro %d\n", chatMacro);
			irsdk_broadcastMsg(irsdk_BroadcastChatComand, irsdk_ChatCommand_Macro, chatMacro++, 0);
			break;

		// pit stop commands
		case 'm':
			printf("Clear all pit commands\n");
			irsdk_broadcastMsg(irsdk_BroadcastPitCommand, irsdk_PitCommand_Clear, 0);
			break;
		case 'n':
			printf("Add fuel\n");
			irsdk_broadcastMsg(irsdk_BroadcastPitCommand, irsdk_PitCommand_Fuel, 10); // add 10 liters (2.7 gallon), or pass '0' to leave level at previous value
			break;
		case 'o':
			printf("Change all tires\n");
			irsdk_broadcastMsg(irsdk_BroadcastPitCommand, irsdk_PitCommand_LF, 0); // leave pressure alone
			irsdk_broadcastMsg(irsdk_BroadcastPitCommand, irsdk_PitCommand_RF, 70); // fill tire to 70 KPa (10 psi)
			irsdk_broadcastMsg(irsdk_BroadcastPitCommand, irsdk_PitCommand_LR, 200); // 200 KPa (30 psi)
			irsdk_broadcastMsg(irsdk_BroadcastPitCommand, irsdk_PitCommand_RR, 1000); // Max, whatever that is
			break;
		case 'p':
			printf("Clean window\n");
			irsdk_broadcastMsg(irsdk_BroadcastPitCommand, irsdk_PitCommand_WS, 0);
			break;
		case 'q':
			printf("Clear tire pit commands\n");
			irsdk_broadcastMsg(irsdk_BroadcastPitCommand, irsdk_PitCommand_ClearTires, 0);
			break;

		// etc
		case 'r':
			printf("Reload custom car textures for all cars\n");
			irsdk_broadcastMsg(irsdk_BroadcastReloadTextures, irsdk_ReloadTextures_All, 0, 0);
			break;

		case 's':
			printf("Reload custom car textures for carIdx %d\n", carIdx);
			irsdk_broadcastMsg(irsdk_BroadcastReloadTextures, irsdk_ReloadTextures_CarIdx, 
				carIdx++,  // carIdx
				0); // not currently used
			// loop for fun
			if(carIdx > 20)
				carIdx = 0;
			break;

		case 't':
			printf("Set playback speed to normal speed\n");
			irsdk_broadcastMsg(irsdk_BroadcastReplaySetPlaySpeed, 1, false, 0);
			break;


		case 'u':
			printf("Set playback speed to 1/16th speed\n");
			irsdk_broadcastMsg(irsdk_BroadcastReplaySetPlaySpeed, 16, true, 0);
			break;

		case 'v':
			printf("Pause playback\n");
			irsdk_broadcastMsg(irsdk_BroadcastReplaySetPlaySpeed, 0, 0, 0);
			break;

		case 'w':
			printf("Stop recording telemetry\n");
			irsdk_broadcastMsg(irsdk_BroadcastTelemCommand, irsdk_TelemCommand_Stop, 0, 0);
			break;
		case 'x':
			printf("Start recording telemetry\n");
			irsdk_broadcastMsg(irsdk_BroadcastTelemCommand, irsdk_TelemCommand_Start, 0, 0);
			break;
		case 'y':
			printf("Start new telemetry file\n");
			irsdk_broadcastMsg(irsdk_BroadcastTelemCommand, irsdk_TelemCommand_Restart, 0, 0);
			break;
		case 'z':
			{
			float force = (trueFFBState) ? -1.0f : 20.9998f;
			trueFFBState = !trueFFBState;

			if(force < 0.0f)
				printf("Set wheel to user controlled FFB\n");
			else
				printf("Set wheel to %f Nm\n", force);

			irsdk_broadcastMsg(irsdk_BroadcastFFBCommand, irsdk_FFBCommand_MaxForce, force);
			}

			break;

		case 'A':
			printf("Set replay search to session 1 at 100 seconds\n");
			// this does a search and not a direct jump, may take a while!
			irsdk_broadcastMsg(irsdk_BroadcastReplaySearchSessionTime, 1, 100*1000);

			break;

		case 'B':
			printf("Fast repair pit commands\n");
			irsdk_broadcastMsg(irsdk_BroadcastPitCommand, irsdk_PitCommand_FR, 0);
			break;

		case 'C':
			printf("Clear (uncheck) winshield pit commands\n");
			irsdk_broadcastMsg(irsdk_BroadcastPitCommand, irsdk_PitCommand_ClearWS, 0);
			break;

		case 'D':
			printf("Clear Fast Repair pit commands\n");
			irsdk_broadcastMsg(irsdk_BroadcastPitCommand, irsdk_PitCommand_ClearFR, 0);
			break;

		case 'E':
			printf("Clear Add Fuel pit commands\n");
			irsdk_broadcastMsg(irsdk_BroadcastPitCommand, irsdk_PitCommand_ClearFuel, 0);
			break;

		case 'F':
			printf("Trigger screen shot\n");
			irsdk_broadcastMsg(irsdk_BroadcastVideoCapture, irsdk_VideoCapture_TriggerScreenShot, 0);
			break;

		case 'G':
			printf("Start video capture\n");
			irsdk_broadcastMsg(irsdk_BroadcastVideoCapture, irsdk_VideoCaptuer_StartVideoCapture, 0);
			break;

		case 'H':
			printf("Stop video capture\n");
			irsdk_broadcastMsg(irsdk_BroadcastVideoCapture, irsdk_VideoCaptuer_EndVideoCapture, 0);
			break;

		case 'I':
			printf("Toggle video capture\n");
			irsdk_broadcastMsg(irsdk_BroadcastVideoCapture, irsdk_VideoCaptuer_ToggleVideoCapture, 0);
			break;

		case 'J':
			printf("Show video timer\n");
			irsdk_broadcastMsg(irsdk_BroadcastVideoCapture, irsdk_VideoCaptuer_ShowVideoTimer, 0);
			break;

		case 'K':
			printf("Hide video timer\n");
			irsdk_broadcastMsg(irsdk_BroadcastVideoCapture, irsdk_VideoCaptuer_HideVideoTimer, 0);
			break;

		default:
			done = true;
		}
	}
	return 0;
}

