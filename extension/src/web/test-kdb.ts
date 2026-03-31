// @ts-expect-error
import { KDBSerialHandler } from './kdb.ts';

import { SerialPort } from "serialport";

const PORTSELECT = 3; // 最初のポートを使用

async function main() {
    const list = await SerialPort.list()
    console.log('Available ports:');
    list.forEach((port, idx) => {
        console.log(`  [${idx}] ${port.path} (${port.manufacturer || 'Unknown'})`);
    });

    if (list.length === 0) {
        console.error('No serial ports available');
        process.exit(1);
    }

    const selectedPort = list[PORTSELECT].path;
    console.log(`\n📍 Selected port: ${selectedPort}\n`);

    const kdbSerialHandler = new KDBSerialHandler();

    // イベントリスナーの登録
    kdbSerialHandler.on('connected', (data) => {
        console.log(`✅ Connected: ${data.port} @ ${data.baudrate} baud`);
    });

    kdbSerialHandler.once('debugger_init', (data) => {
        console.log(`🟢 [INIT] Line: ${data.line}`);
        kdbSerialHandler.continueExecution();
    });

    kdbSerialHandler.on('debugger_break', async (data) => {
        console.log(`🔴 [BREAK] Line: ${data.line}`);

        // すべてのキャプチャデータをログ出力
        const allCaptures = kdbSerialHandler.getAllCaptureData();
        console.log(`📊 All Captures (${allCaptures.size} items):`);
        allCaptures.forEach(async (capture, id) => {
            const data = (await kdbSerialHandler.readCapture(id));
            console.log(`  Cap ${id}: line=${capture.line}, addr=0x${capture.address.toString(16)}, size=${capture.size}`);
            if (data) {
                console.log(`    Data: ${data}`);
            }
        });

        // 5秒待機
        console.log('⏳ Waiting 2 seconds...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        // 実行を継続
        console.log('▶️  Continuing execution...');
        kdbSerialHandler.continueExecution();
    });

    kdbSerialHandler.on('variable_captured', (data) => {
        console.log(`📌 [CAPTURE] Line: ${data.line}, CapId: ${data.capId}, Address: 0x${data.address.toString(16)}, Size: ${data.size}`);
    });

    kdbSerialHandler.on('debug_print', (data) => {
        const printType = data.isPrintln ? '📝' : '📄';
        console.log(`${printType} [PRINT] Line: ${data.line}: ${data.message}`);
    });

    kdbSerialHandler.on('error', (data) => {
        console.error(`❌ Error: ${data.error}`);
    });

    kdbSerialHandler.on('disconnected', () => {
        console.log(`⚫ Disconnected`);
    });

    // ポート接続
    console.log(`\n🔌 Connecting to ${selectedPort}...`);
    const connected = await kdbSerialHandler.connect(selectedPort, 9600);

    if (!connected) {
        console.error('❌ Failed to connect');
        process.exit(1);
    }

    // 接続後、デバッガが自動的にイベントを送信するまで待機
    console.log('🟡 Waiting for debugger events...');
    console.log('(Press Ctrl+C to exit)\n');

    // 60秒のタイムアウト
    await new Promise(resolve => setTimeout(resolve, 60000));

    // 切断
    await kdbSerialHandler.disconnect();
    console.log('✋ Test completed');
}

main().catch(console.error);