#include <Windows.h>
#include <stdlib.h>
#include <conio.h>

#include "console.h"

// true if any key was hit
bool isKeypress()
{
	return _kbhit(); 
}

// returns character that was hit, or 0 if no key
char getKeypress()
{
	// default to 0 if no key hit
	char c = 0;

	// clear out key buffer, returning last char in it
	while(_kbhit())
		c = _getch();

	return c;
}

// halt execution of program till user presses and releases any key
// returns pressed char
char waitForKeypress()
{
	char c = 0;

	// clear out key buffer
	while(_kbhit())
		_getch();

	while(1)
	{
		// wait for key press
		if(_kbhit())
		{
			c = _getch();

			// wait for key release
			while(_kbhit())
				_getch(); // and clear buffer

			// return pressed key
			return c;
		}
	}

	// can't get hear
	return c;
}

bool getConsoleDimensions(int &w, int &h)
{
	// set to something
	w = h = 0;

	CONSOLE_SCREEN_BUFFER_INFO info;
	HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
	if(GetConsoleScreenBufferInfo(output, &info))
	{
		w = info.srWindow.Right; //info.dwSize.X;
		h = info.srWindow.Bottom; //info.dwSize.Y;
		return true;
	}
	return false;
}

bool getCursorPosition(int &x, int &y)
{
	// set to something
	x = y = 0;

	CONSOLE_SCREEN_BUFFER_INFO info;
	HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
	if(GetConsoleScreenBufferInfo(output, &info))
	{
		x = info.dwCursorPosition.X;
		y = info.dwCursorPosition.Y;
		return true;
	}
	return false;
}

void setCursorPosition(int x, int y)
{
	COORD pos = { (SHORT)x, (SHORT)y };
	HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
	SetConsoleCursorPosition(output, pos);
}

void clearSpace(int x, int y, int count)
{
	setCursorPosition(x, y);
	for(int i=0; i<count; i++)
		_putch(' ');
}

void clearLine(int y)
{
	clearSpace(0, y, 85);
}

void clearScreen()
{
	// lame, do this right
	//for(int y=0; y<25; y++)
	//	clearLine(y);

	// faster?
	system("cls");
}
