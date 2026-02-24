#include <kdb.h>

int count = 0;

void setup()
{
    Serial.begin(9600);
    // init
    kdbinit;
    // capture variable
    kdbcap(count);
    // Serial.println
    kdbprintln("start");
}

void loop() {
    count++;

    // debugger;
    kdbd;
}