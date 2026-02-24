#include <kdb.h>

int count = 0;

void setup()
{
    Serial.begin(9600);
    kdbinit;
    kdbcap(count);
    kdbprint("start");
}

void loop() {
    count++;
    debugger;
}