echo "installing..."

echo "installing arduino library"
cp -r ./kdb-arduino ~/Documents/Arduino/libraries/

echo "installing arduino extension"
cp ./extension/kdb-ext-0.0.1.vsix ~/.arduinoIDE/plugins/

echo "done."