/*
 * KPC Arduino Debugger Implementation
 * Arduino用デバッガライブラリの実装
 */

#include "kdb.h"

// グローバルインスタンス定義
_KDB __KDB;

// コンストラクタ
_KDB::_KDB() {
    for (int i = 0; i < 32; i++) {
        caps[i] = {0, 0};
    }
    capsize = 0;
    for (int i = 0; i < 32; i++) {
        readbuf[i] = 0;
    }
    loops = false;
}
// デバッガメソッドの実装
void _KDB::debugger(unsigned line)
{
	readbuf[0] = line >> 8;
	readbuf[1] = line;
	sendOp(_KDB_DEBUGGER, 2);
	loops = true;
	readOp();
}

void _KDB::capture(unsigned line, void *x, uint8_t size)
{
	readbuf[0] = line >> 8;
	readbuf[1] = line;

	size_t px = (size_t)x;

	readbuf[2] = px >> 24;
	readbuf[3] = px >> 16;
	readbuf[4] = px >> 8;
	readbuf[5] = px;

	readbuf[6] = size;
	readbuf[7] = capsize;

	caps[capsize].ptr = (uint8_t *)x;
	caps[capsize].size = size;
	sendOp(_KDB_CAPTURE, 8);
	capsize++;
}

void _KDB::init(unsigned line)
{
	loops = true;
	capsize = 0;
	while (loops)
	{
		readbuf[0] = line >> 8;
		readbuf[1] = line;
		sendOp(_KDB_INIT, 2);
		readOp(200);
		delay(100);
	}
}
// print関数群の実装
void _KDB::print(unsigned line, const char* str)
{
	uint8_t len = strlen(str);
	if (len > 29) len = 29; // バッファサイズ制限 (line用に2バイト、type用に1バイト使用)
	readbuf[0] = line >> 8;
	readbuf[1] = line;
	readbuf[2] = 0; // print type: 0=print, 1=println
	memcpy(readbuf + 3, str, len);
	sendOp(_KDB_PRINT, len + 3);
}

void _KDB::print(unsigned line, int val)
{
	char buffer[12];
	itoa(val, buffer, 10);
	print(line, buffer);
}

void _KDB::print(unsigned line, long val)
{
	char buffer[12];
	ltoa(val, buffer, 10);
	print(line, buffer);
}

void _KDB::print(unsigned line, unsigned int val)
{
	char buffer[12];
	utoa(val, buffer, 10);
	print(line, buffer);
}

void _KDB::print(unsigned line, double val, int digits)
{
	char buffer[32];
	dtostrf(val, 0, digits, buffer);
	print(line, buffer);
}
// println関数群の実装
void _KDB::println(unsigned line, const char* str)
{
	uint8_t len = strlen(str);
	if (len > 29) len = 29; // バッファサイズ制限
	readbuf[0] = line >> 8;
	readbuf[1] = line;
	readbuf[2] = 1; // print type: 0=print, 1=println
	memcpy(readbuf + 3, str, len);
	sendOp(_KDB_PRINT, len + 3);
}

void _KDB::println(unsigned line, int val)
{
	char buffer[12];
	itoa(val, buffer, 10);
	println(line, buffer);
}

void _KDB::println(unsigned line, long val)
{
	char buffer[12];
	ltoa(val, buffer, 10);
	println(line, buffer);
}

void _KDB::println(unsigned line, unsigned int val)
{
	char buffer[12];
	utoa(val, buffer, 10);
	println(line, buffer);
}

void _KDB::println(unsigned line, double val, int digits)
{
	char buffer[32];
	dtostrf(val, 0, digits, buffer);
	println(line, buffer);
}

void _KDB::println(unsigned line)
{
	println(line, "");
}
// 内部メソッドの実装
void _KDB::sendOp(uint8_t opType, uint8_t opSize)
{
	_KDB_Serial.write(0xA0);
	_KDB_Serial.write(0x1E);
	_KDB_Serial.write(opType);
	_KDB_Serial.write(opSize);
	for (uint8_t i = 0; i < opSize; i++)
	{
		_KDB_Serial.write(readbuf[i]);
	}
}

void _KDB::doOp()
{
	readSize(2);
	uint8_t opType = readbuf[0];
	uint8_t opSize = readbuf[1];
	readSize(opSize);
	size_t addr;
	uint8_t size;
	uint8_t pin;
	uint8_t pos;
	_KDB_PtrWithSize *ptr;
	switch (opType)
	{
	case _KDB_RETURN:
		loops = false;
		break;
	case _KDB_READ_MEM:
		addr = readbuf[0] << 24 | readbuf[1] << 16 | readbuf[2] << 8 | readbuf[3];
		size = readbuf[4];
		memcpy(readbuf, (void *)addr, size);
		sendOp(_KDB_READ_MEM_RES, size);
		break;
	case _KDB_WRITE_MEM:
		addr = readbuf[0] << 24 | readbuf[1] << 16 | readbuf[2] << 8 | readbuf[3];
		size = readbuf[4];
		memcpy((void *)addr, (readbuf + 5), size);
		break;
	case _KDB_READ_PIN:
		pin = readbuf[0];
		readbuf[0] = digitalRead(pin);
		sendOp(_KDB_READ_PIN_RES, 1);
		break;
	case _KDB_WRITE_PIN:
		pin = readbuf[0];
		digitalWrite(pin, readbuf[1]);
		break;
	case _KDB_READ_CAP:
		pos = readbuf[0];
		ptr = (caps + pos);
		memcpy(readbuf, ptr->ptr, ptr->size);
		sendOp(_KDB_READ_CAP_RES, ptr->size);
		break;
	case _KDB_WRITE_CAP:
		pos = readbuf[0];
		ptr = (caps + pos);
		memcpy(ptr->ptr, (readbuf + 1), ptr->size);
		break;
	default:
		break;
	}
}
void _KDB::readOp(uint8_t maxloop)
{
	uint8_t isOp = 0;
	while (loops)
	{
		if (maxloop != 255)
		{
			maxloop--;
			if (maxloop == 0)
			{
				return;
			}
		}

		if (_KDB_Serial.available())
		{
			uint8_t res = _KDB_Serial.read();
			if (res == 0xA0)
			{
				isOp = 1;
			}
			else if (res == 0x1E)
			{
				if (isOp == 1)
				{
					doOp();
					isOp = 0;
				}
			}
		}
	}
}

void _KDB::readSize(uint8_t size)
{
	if (size == 0)
	{
		return;
	}
	size--;
	uint8_t pos = 0;
	while (true)
	{
		if (_KDB_Serial.available())
		{
			readbuf[pos] = _KDB_Serial.read();
			if (pos == size)
				return;
			pos++;
		}
	}
}