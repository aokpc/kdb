/**
 * KDB Serial Protocol - TypeScript Implementation
 * Arduino との通信プロトコルの実装
 * 
 * Pythonの KDBSerialHandler をTypeScriptに移植
 * Node.js + Electron 環境での使用を想定
 */

import { EventEmitter } from 'events';
import { SerialPort } from 'serialport';


/**
 * KDBプロトコルの操作タイプ
 */
export const KDBOpType = {
    RETURN: 0,
    READ_MEM: 1,
    WRITE_MEM: 2,
    READ_CAP: 3,
    WRITE_CAP: 4,
    READ_PIN: 5,
    WRITE_PIN: 6,
    INIT: 7,
    DEBUGGER: 8,
    CAPTURE: 9,
    READ_MEM_RES: 10,
    READ_CAP_RES: 11,
    READ_PIN_RES: 12,
    PRINT: 13,
}

type KDBOpType = number

/**
 * キャプチャデータの型定義
 */
export interface CaptureData {
    line: number;
    address: number;
    size: number;
    capId: number;
    variable_name?: string;
    data: number;
}

interface KDBSerialHandlerEvent {
    connected: [{ port: string, baudrate: number }],
    open: [],
    disconnected: [],
    error: [{ error: string }],
    debugger_break: [{ line: number }],
    variable_captured: [{ line: number, address: number, size: number, capId: number }],
    debugger_init: [{ line: number }],
    debug_print: [{ line: number, message: string, isPrintln: boolean }],
    read_cap_res: [{ value: number }],
    read_mem_res: [{ value: Buffer }],
    read_pin_res: [{ value: boolean }],

}

/**
 * Arduinoとのシリアル通信を処理するクラス
 */
export class KDBSerialHandler extends EventEmitter<KDBSerialHandlerEvent> {
    private serialPort: any;
    private isConnected: boolean = false;
    private captureData: Map<number, CaptureData> = new Map();
    private breakpoints: Map<number, boolean> = new Map();
    private currentLine: number = 0;
    private isDebugging: boolean = false;
    private isStopped: boolean = false; // デバッガ停止フラグ
    private readTimeout: number = 1000; // ms

    constructor() {
        super();
    }

    /**
     * 指定されたポートに接続
     * @param port ポート名（例: "COM3", "/dev/ttyUSB0"）
     * @param baudrate ボーレート（デフォルト: 9600）
     * @returns 接続成功時はtrue
     */
    async connect(port: string, baudrate: number = 9600): Promise<boolean> {
        try {

            // 既存の接続があれば切断
            if (this.serialPort && this.serialPort.isOpen) {
                await this.disconnect();
            }

            this.serialPort = new SerialPort({
                path: port,
                baudRate: baudrate,
            });

            return new Promise((resolve) => {
                this.serialPort.on('open', () => {
                    this.isConnected = true;
                    // console.log(`Arduino connected on ${port}`);
                    this.emit('connected', { port, baudrate });
                    this.startMonitoring(); // 統合版の常時監視を開始
                    resolve(true);
                });

                this.serialPort.on('error', (error: Error) => {
                    // console.error(`Connection failed: ${error.message}`);
                    this.isConnected = false;
                    this.emit('error', { error: error.message });
                    resolve(false);
                });

                // Timeout
                setTimeout(() => {
                    if (!this.isConnected) {
                        resolve(false);
                    }
                }, 5000);
            });
        } catch (error) {
            // console.error(`Connection failed: ${error}`);
            return false;
        }
    }

    /**
     * 接続を切断
     */
    async disconnect(): Promise<void> {
        try {
            if (this.serialPort && this.serialPort.isOpen) {
                return new Promise((resolve) => {
                    this.serialPort.close(() => {
                        this.isConnected = false;
                        this.isStopped = false; // 接続終了時に停止フラグをリセット
                        console.log('[KDBSerialHandler.disconnect] Clearing capture data, isStopped=false');
                        this.captureData.clear();
                        // console.log('Arduino disconnected');
                        this.emit('disconnected');
                        resolve();
                    });
                });
            }
            this.isConnected = false;
            this.isStopped = false; // 接続終了時に停止フラグをリセット
            console.log('[KDBSerialHandler.disconnect] Clearing capture data (no port), isStopped=false');
            this.captureData.clear();
        } catch (error) {
            // console.error(`Disconnect error: ${error}`);
            this.isConnected = false;
            this.isStopped = false; // 接続終了時に停止フラグをリセット
            console.log('[KDBSerialHandler.disconnect] Clearing capture data (error), isStopped=false');
            this.captureData.clear();
        }
    }

    /**
     * KDBコマンドを送信
     * @param opType 操作タイプ
     * @param data ペイロード
     * @returns 送信成功時はtrue
     */
    sendCommand(opType: KDBOpType, data: Buffer = Buffer.alloc(0)): boolean {
        if (!this.isConnected || !this.serialPort) {
            return false;
        }

        try {
            // パケットフォーマット: 0xA0 | 0x1E | OpType | Size | Data
            const packet = Buffer.alloc(4 + data.length);
            packet[0] = 0xa0;
            packet[1] = 0x1e;
            packet[2] = opType;
            packet[3] = data.length;
            data.copy(packet, 4);

            this.serialPort.write(packet);
            return true;
        } catch (error) {
            // console.error(`Send command failed: ${error}`);
            return false;
        }
    }


    /**
     * 実行を継続
     */
    continueExecution(): boolean {
        console.log(`[continueExecution] デバッガ停止フラグをfalseに設定`);
        this.isStopped = false;
        return this.sendCommand(KDBOpType.RETURN);
    }

    readCaptureCallbacks: ((value: number) => void)[] = [];

    /**
     * キャプチャデータを読み取り
     * @param pos ポジション
     * @returns キャプチャデータ
     */
    readCapture(pos: number): Promise<number> | null {
        if (!this.isStopped) {
            console.log(`[readCapture] デバッガが停止していません（isStopped=${this.isStopped}）`);
            return null;
        }
        const payload = Buffer.from([pos]);
        if (this.sendCommand(KDBOpType.READ_CAP, payload)) {
            return new Promise<number>((resolve, reject) => {
                this.readCaptureCallbacks.push(resolve);
                console.log(`[readCapture] CAP ${pos} の読み取りをリクエスト`);
            })
        }
        return null;
    }

    /**
     * キャプチャデータを書き込み
     * @param pos ポジション
     * @param data 書き込みデータ
     * @returns 成功時はtrue
     */
    writeCapture(pos: number, data: Buffer): boolean {
        const payload = Buffer.concat([Buffer.from([pos]), data]);
        return this.sendCommand(KDBOpType.WRITE_CAP, payload);
    }

    readMemoryCallbacks: ((value: Buffer) => void)[] = [];


    /**
     * メモリを読み取り
     * @param address メモリアドレス
     * @param size 読み取りサイズ
     * @returns メモリデータ
     */
    readMemory(address: number, size: number): Promise<Buffer> | null {
        const addrBytes = Buffer.alloc(4);
        addrBytes.writeUInt32BE(address, 0);
        const payload = Buffer.concat([addrBytes, Buffer.from([size])]);

        if (this.sendCommand(KDBOpType.READ_MEM, payload)) {
            return new Promise<Buffer>((resolve, reject) => {
                this.readMemoryCallbacks.push(resolve);
            })
        }
        return null;
    }

    /**
     * メモリに書き込み
     * @param address メモリアドレス
     * @param data 書き込みデータ
     * @returns 成功時はtrue
     */
    writeMemory(address: number, data: Buffer): boolean {
        const addrBytes = Buffer.alloc(4);
        addrBytes.writeUInt32BE(address, 0);
        const payload = Buffer.concat([
            addrBytes,
            Buffer.from([data.length]),
            data,
        ]);
        return this.sendCommand(KDBOpType.WRITE_MEM, payload);
    }

    readPinCallbacks: ((value: boolean) => void)[] = [];

    /**
     * デジタルピンの値を読み取り
     * @param pin ピン番号
     * @returns ピンの値
     */
    async readPin(pin: number): Promise<boolean | null> {
        if (this.sendCommand(KDBOpType.READ_PIN, Buffer.from([pin]))) {
            return new Promise<boolean>((resolve, reject) => {
                this.readPinCallbacks.push(resolve);
            })
        }
        return null;
    }

    /**
     * デジタルピンに値を書き込み
     * @param pin ピン番号
     * @param value 書き込み値（0または1）
     * @returns 成功時はtrue
     */
    writePin(pin: number, value: number): boolean {
        return this.sendCommand(KDBOpType.WRITE_PIN, Buffer.from([pin, value]));
    }

    /**
     * キャプチャデータを保存
     * @param id キャプチャID
     * @param data キャプチャ情報
     */
    setCaptureData(id: number, data: CaptureData): void {
        this.captureData.set(id, data);
    }

    /**
     * キャプチャデータを取得
     * @param id キャプチャID
     */
    getCaptureData(id: number): CaptureData | undefined {
        return this.captureData.get(id);
    }

    /**
     * すべてのキャプチャデータを取得
     */
    getAllCaptureData(): Map<number, CaptureData> {
        console.log(`[KDBSerialHandler.getAllCaptureData] Returning ${this.captureData.size} captures: ${Array.from(this.captureData.keys()).join(', ')}`);
        return new Map(this.captureData);
    }

    private printBuffer = "";
    private serialBuffer = Buffer.alloc(0); // シリアルデータの累積バッファ

    /**
     * シリアルデータを常時監視して処理
     * - イベント型メッセージ（DEBUGGER、CAPTURE、INIT、PRINT）を解析してイベント発火
     * - レスポンス型メッセージ（READ_*_RES）は readResponseOnce() で待機される
     * - closeするまで継続
     */
    private startMonitoring() {
        if (!this.serialPort) return;

        this.serialPort.on('data', async (data: Buffer) => {
            // console.log(`[SerialMonitor] Received ${data.length} bytes: ${data.toString('hex')}`);

            // 受信したデータを累積バッファに追加
            this.serialBuffer = Buffer.concat([this.serialBuffer, data]);
            // console.log(`[SerialMonitor] Buffer size now: ${this.serialBuffer.length} bytes`);

            // 完全なパケットを抽出して処理
            this.processSerialBuffer();
        });
    }

    /**
     * 累積バッファから完全なパケットを抽出して処理
     */
    private processSerialBuffer() {
        while (this.serialBuffer.length >= 4) {
            // ヘッダーを探す
            let headerPos = -1;
            for (let i = 0; i <= this.serialBuffer.length - 2; i++) {
                if (this.serialBuffer[i] === 0xa0 && this.serialBuffer[i + 1] === 0x1e) {
                    headerPos = i;
                    break;
                }
            }

            if (headerPos === -1) {
                // ヘッダーが見つからない、バッファをクリア
                // console.warn(`[SerialBuffer] No header found. Buffer: ${this.serialBuffer.toString('hex')} (${this.serialBuffer.length} bytes)`);
                this.serialBuffer = Buffer.alloc(0);
                return;
            }

            // ヘッダーより前のデータを捨てる
            if (headerPos > 0) {
                // console.warn(`[SerialBuffer] Skipping ${headerPos} bytes before header`);
                this.serialBuffer = this.serialBuffer.slice(headerPos);
            }

            // パケットサイズを取得
            if (this.serialBuffer.length < 4) {
                return; // サイズ情報が不足
            }

            const opType = this.serialBuffer[2];
            const dataSize = this.serialBuffer[3];
            const totalPacketSize = 4 + dataSize;

            // console.log(`[SerialBuffer] OpType: ${opType}, DataSize: ${dataSize}, TotalSize: ${totalPacketSize}, BufferSize: ${this.serialBuffer.length}`);

            if (this.serialBuffer.length < totalPacketSize) {
                // console.log(`[SerialBuffer] Incomplete packet. Waiting for more data. Need: ${totalPacketSize}, Have: ${this.serialBuffer.length}`);
                return; // パケットが不完全
            }

            // 完全なパケットを抽出
            const completePacket = this.serialBuffer.slice(0, totalPacketSize);
            this.serialBuffer = this.serialBuffer.slice(totalPacketSize);

            // console.log(`[SerialBuffer] Complete packet received: ${completePacket.toString('hex')}`);

            // パケットを処理
            this.handleSerialData(completePacket);
        }
    }

    /**
     * Arduinoからのデータを処理
     * OpType に応じてイベント型メッセージを解析して emit
     * 同期処理（完全なパケットのみ受け取る）
     * パケット形式: [0xA0][0x1E][OpType][DataSize][Data...]
     */
    private handleSerialData(data: Buffer) {
        if (data.length < 4) {
            // console.warn(`[HandleSerial] Data too short: ${data.length} bytes (need at least 4)`);
            return;
        }

        // ヘッダーの確認
        if (data[0] !== 0xa0 || data[1] !== 0x1e) {
            // console.warn(`[HandleSerial] Invalid header: 0x${data[0].toString(16)} 0x${data[1].toString(16)}`);
            return;
        }

        const opType = data[2];
        const dataSize = data[3];
        const payload = data.slice(4); // OpType と DataSize をスキップして実データ部分
        // console.log(`[HandleSerial] Processing opType: ${opType}, dataSize: ${dataSize}, payload: ${payload.toString('hex')}`);

        // イベント型メッセージの処理
        switch (opType) {
            case KDBOpType.DEBUGGER:
                // console.log(`[HandleSerial] DEBUGGER packet received`);
                if (payload.length >= 2) {
                    this.currentLine = (payload[0] << 8) | payload[1];
                    this.isDebugging = true;
                    this.isStopped = true; // デバッガ停止フラグをセット
                    console.log(`[handleSerialData] DEBUGGER break at line ${this.currentLine}, isStopped=true`);
                    // console.log(`[HandleSerial] Emitting debugger_break at line ${this.currentLine}`);
                    this.readCaptureCallbacks = [];
                    this.readMemoryCallbacks = [];
                    this.readPinCallbacks = [];
                    this.emit('debugger_break', { line: this.currentLine });
                }
                break;

            case KDBOpType.CAPTURE:
                // console.log(`[HandleSerial] CAPTURE packet received`);
                if (payload.length >= 8) {
                    const line = (payload[0] << 8) | payload[1];
                    const address =
                        ((payload[2] << 24) | (payload[3] << 16) | (payload[4] << 8) | payload[5]) >>> 0;
                    const size = payload[6];
                    const capId = payload[7];

                    const captureInfo: CaptureData = {
                        line,
                        address,
                        size,
                        capId,
                        data: -1
                    };
                    this.captureData.set(capId, captureInfo);
                    // console.log(`[HandleSerial] Emitting variable_captured: capId=${capId}, line=${line}`);
                    this.emit('variable_captured', { line, address, size, capId });
                }
                break;

            case KDBOpType.INIT:
                // console.log(`[HandleSerial] INIT packet received`);
                if (payload.length >= 2) {
                    const line = (payload[0] << 8) | payload[1];
                    // console.log(`[HandleSerial] Emitting debugger_init at line ${line}`);
                    this.emit('debugger_init', { line });
                }
                break;

            case KDBOpType.PRINT:
                // console.log(`[HandleSerial] PRINT packet received`);
                if (payload.length >= 3) {
                    const line = (payload[0] << 8) | payload[1];
                    const printType = payload[2];
                    const message = payload.slice(3).toString('utf-8', 0, 128);
                    if (printType === 1) {
                        // println: 改行フラグ付き
                        // console.log(`[HandleSerial] Emitting debug_print (println) at line ${line}`);
                        this.emit('debug_print', {
                            line,
                            message: this.printBuffer + message,
                            isPrintln: true,
                        });
                        this.printBuffer = "";
                    } else {
                        // print: 改行なし、バッファに蓄積
                        // console.log(`[HandleSerial] Buffering print at line ${line}`);
                        this.printBuffer += message;
                    }
                }
                break;

            case KDBOpType.READ_CAP_RES:
                // console.log(`[HandleSerial] READ_CAP_RES packet received`);
                if (payload.length) {
                    const value = parseInt(payload.reverse().toString("hex"), 16);
                    const cb = this.readCaptureCallbacks.shift();
                    // console.log("_readCaptureCallbacks", this.readCaptureCallbacks.length, value);
                    if (cb) {
                        // console.log("readCaptureCallbacks", this.readCaptureCallbacks.length, value);
                        cb(value);
                    }
                    this.emit('read_cap_res', { value });
                }
                break;
            case KDBOpType.READ_PIN_RES:
                // console.log(`[HandleSerial] READ_PIN_RES packet received`);
                if (payload.length) {
                    const value = Boolean(payload)
                    const cb = this.readPinCallbacks.shift()
                    if (cb) cb(value);
                    this.emit('read_pin_res', { value });
                }
                break;
            case KDBOpType.READ_MEM_RES:
                // console.log(`[HandleSerial] READ_MEM_RES packet received`);
                if (payload.length) {
                    const cb = this.readMemoryCallbacks.shift()
                    if (cb) cb(payload);
                    this.emit('read_mem_res', { value: payload });
                }
                break;

            default:
                // console.warn(`[HandleSerial] Unknown opType: ${opType}`);
                break;

            // レスポンス型メッセージ（READ_*_RES）は readResponseOnce() で待機される
            // それ以外のOpTypeは無視
        }
    }

    // Getter/Setter

    get port(): any {
        return this.serialPort;
    }

    get connected(): boolean {
        return this.isConnected;
    }

    get stopped(): boolean {
        return this.isStopped;
    }

    get currentLineNumber(): number {
        return this.currentLine;
    }

    set currentLineNumber(value: number) {
        this.currentLine = value;
    }

    get debugging(): boolean {
        return this.isDebugging;
    }

    set debugging(value: boolean) {
        this.isDebugging = value;
    }
}

/**
 * KDBプロトコルパーサー
 * Arduino からのレスポンスを解析
 */
export class KDBProtocolParser {
    /**
     * DEBUGGER メッセージを解析
     * @param data レスポンスデータ
     */
    static parseDebuggerMessage(data: Buffer): {
        line: number;
    } | null {
        if (data.length < 4) {
            return null;
        }
        const line = (data[2] << 8) | data[3];
        return { line };
    }

    /**
     * CAPTURE メッセージを解析
     * @param data レスポンスデータ
     */
    static parseCaptureMessage(data: Buffer): {
        line: number;
        address: number;
        size: number;
        capId: number;
    } | null {
        if (data.length < 10) {
            return null;
        }
        const line = (data[2] << 8) | data[3];
        const address =
            ((data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7]) >>> 0;
        const size = data[8];
        const capId = data[9];
        return { line, address, size, capId };
    }

    /**
     * INIT メッセージを解析
     * @param data レスポンスデータ
     */
    static parseInitMessage(data: Buffer): {
        line: number;
    } | null {
        if (data.length < 4) {
            return null;
        }
        const line = (data[2] << 8) | data[3];
        return { line };
    }

    /**
     * PRINT メッセージを解析
     * @param data レスポンスデータ
     */
    static parsePrintMessage(data: Buffer): {
        line: number;
        printType: number;
        message: string;
    } | null {
        if (data.length < 5) {
            return null;
        }
        const line = (data[2] << 8) | data[3];
        const printType = data[4];
        const message = data.slice(5).toString('utf-8');
        return { line, printType, message };
    }
}
