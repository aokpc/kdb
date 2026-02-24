class KDBClient {
    constructor() {
        /**
         * @type {WebSocket}
         */
        this.websocket = null;
        this.connected = false;
        this.currentLine = 0;
        this.captures = new Map();
        this.fileContent = [];
        this.breakpoints = new Set();

        this.connect();
    }

    connect() {
        try {
            this.websocket = new WebSocket('ws://localhost:8765');

            this.websocket.onopen = () => {
                this.log('WebSocketサーバーに接続しました', 'info');
                refreshPorts();
                refreshFiles();
            };

            this.websocket.onmessage = (event) => {
                const message = JSON.parse(event.data);
                this.handleMessage(message);
            };

            this.websocket.onclose = () => {
                this.log('WebSocketサーバーから切断されました', 'warning');
                setTimeout(() => this.connect(), 3000);
            };

            this.websocket.onerror = (error) => {
                this.log('WebSocket接続エラー: ' + error, 'error');
            };
        } catch (error) {
            this.log('WebSocket接続失敗: ' + error, 'error');
            setTimeout(() => this.connect(), 3000);
        }
    }

    send(command, data = {}) {
        if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
            this.websocket.send(JSON.stringify({ command, ...data }));
        } else {
            this.log('WebSocketが未接続です', 'error');
        }
    }

    handleMessage(message) {
        const { type } = message;

        switch (type) {
            case 'port_list':
                this.updatePortList(message.ports);
                break;
            case 'connection_status':
                this.updateConnectionStatus(message.connected, message.port);
                break;
            case 'file_list':
                this.updateFileList(message.files);
                break;
            case 'file_loaded':
                this.handleFileLoaded(message);
                break;
            case 'debugger_break':
                this.handleDebuggerBreak(message);
                break;
            case 'variable_captured':
                this.handleVariableCaptured(message);
                break;
            case 'capture_data':
                this.updateCaptureData(message);
                break;
            case 'memory_data':
                this.updateMemoryDisplay(message);
                break;
            case 'pin_value':
                this.updatePinStatus(message);
                break;
            case 'execution_continued':
                this.handleExecutionContinued();
                break;
            case 'debug_print':
                this.handleDebugPrint(message);
                break;
            case 'error':
                this.log('エラー: ' + message.message, 'error');
                break;
            default:
                this.log('メッセージ受信: ' + JSON.stringify(message), 'info');
        }
    }

    updatePortList(ports) {
        const select = document.getElementById('portSelect');
        select.innerHTML = '<option value="">ポートを選択</option>';

        ports.forEach(port => {
            const option = document.createElement('option');
            option.value = port;
            option.textContent = port;
            select.appendChild(option);
        });

        this.log(`シリアルポート検出: ${ports.length}件`, 'info');
    }

    updateConnectionStatus(connected, port = '') {
        const statusEl = document.getElementById('connectionStatus');
        const connectBtn = document.getElementById('connectBtn');

        this.connected = connected;

        if (connected) {
            statusEl.textContent = `接続中: ${port}`;
            statusEl.className = 'connection-status connected';
            connectBtn.textContent = '切断';
            connectBtn.className = 'btn-danger';
            this.log(`Arduino接続成功: ${port}`, 'info');
        } else {
            statusEl.textContent = '未接続';
            statusEl.className = 'connection-status disconnected';
            connectBtn.textContent = '接続';
            connectBtn.className = 'btn-primary';
            this.log('Arduino切断', 'warning');
        }
    }

    updateFileList(files) {
        const fileListEl = document.getElementById('fileList');
        fileListEl.innerHTML = '';

        files.forEach(file => {
            const item = document.createElement('div');
            item.className = 'file-item';
            
            // ファイル名のみを表示（パスが長い場合）
            const fileName = file.includes('/') ? file.split('/').pop() : file;
            item.textContent = fileName;
            
            // フルパスをツールチップとして設定
            item.title = file;
            item.onclick = () => this.loadFile(file);
            fileListEl.appendChild(item);
        });

        this.log(`Arduinoファイル検出: ${files.length}件`, 'info');
    }

    handleFileLoaded(message) {
        if (message.success) {
            this.fileContent = message.file_info.lines;
            this.renderCode();
            
            // ファイルパスの短縮表示
            const fullPath = message.file_info.filepath;
            const fileName = fullPath.includes('/') ? fullPath.split('/').pop() : fullPath;
            const currentFileEl = document.getElementById('currentFile');
            currentFileEl.textContent = fileName;
            currentFileEl.title = fullPath;  // フルパスをツールチップに
            
            this.log(`ファイル読み込み完了: ${message.file_info.filepath}`, 'info');
        } else {
            this.log(`ファイル読み込み失敗: ${message.error}`, 'error');
        }
    }

    handleDebuggerBreak(message) {
        this.currentLine = message.line;
        this.renderCode();
        document.getElementById('continueBtn').disabled = false;
        document.getElementById('debugStatus').textContent = `デバッグ中 (行: ${message.line})`;
        this.log(`デバッガでブレーク: 行 ${message.line}`, 'warning');
    }

    handleVariableCaptured(message) {
        this.captures.set(message.capture_id, {
            line: message.line,
            address: message.address,
            size: message.size,
            variable_name: message.variable_name
        });

        this.renderCaptures();
        const varInfo = message.variable_name ? ` (変数: ${message.variable_name})` : '';
        this.log(`変数キャプチャ: ID ${message.capture_id}, 行 ${message.line}${varInfo}`, 'info');
    }

    updateCaptureData(message) {
        const capture = this.captures.get(message.capture_id);
        if (capture) {
            capture.data = message.data;
            capture.rawHex = message.data;
            
            // Little endianで10進数値を計算
            capture.decimalValue = this.hexToDecimal(message.data);
            
            this.renderCaptures();
        }
    }
    
    hexToDecimal(hexString) {
        if (!hexString || hexString.length === 0 || hexString.length % 2 !== 0) {
            return null;
        }
        
        try {
            // 16進文字列をバイト配列に変換
            const bytes = [];
            for (let i = 0; i < hexString.length; i += 2) {
                const byteValue = parseInt(hexString.substr(i, 2), 16);
                if (isNaN(byteValue)) {
                    return null;
                }
                bytes.push(byteValue);
            }
            
            // ASCII文字表現を作成（印字可能文字のみ）
            const ascii = bytes
                .map(b => (b >= 32 && b <= 126) ? String.fromCharCode(b) : '.')
                .join('');
            
            // Little endianで数値に変換
            let value = 0;
            for (let i = 0; i < bytes.length; i++) {
                value += bytes[i] * Math.pow(256, i);
            }
            
            // 符号付き整数として扱う場合の処理
            const bitLength = bytes.length * 8;
            const maxUnsigned = Math.pow(2, bitLength);
            
            // 符号付き値の計算
            let signedValue = value;
            if (value >= maxUnsigned / 2) {
                signedValue = value - maxUnsigned;
            }
            
            return {
                unsigned: value,
                signed: signedValue,
                bytes: bytes.length,
                binary: value.toString(2).padStart(bitLength, '0'),
                ascii: ascii
            };
        } catch (error) {
            console.warn('16進数変換エラー:', error);
            return null;
        }
    }

    handleExecutionContinued() {
        this.currentLine = 0;
        this.renderCode();
        document.getElementById('continueBtn').disabled = true;
        document.getElementById('debugStatus').textContent = '';
        this.log('実行を継続しました', 'info');
    }

    handleDebugPrint(message) {
        const lineInfo = message.line ? ` (行: ${message.line})` : '';
        const printMessage = `[Arduino出力]${lineInfo} ${message.message}`;
        
        if (message.is_println) {
            this.log(printMessage, 'info');
        } else {
            // print（改行なし）の場合は特別な表示
            const logArea = document.getElementById('logArea');
            const lastItem = logArea.lastElementChild;
            
            if (lastItem && lastItem.className.includes('log-print-continue')) {
                // 前のprintメッセージに続ける
                lastItem.textContent += message.message;
            } else {
                // 新しいprintメッセージ
                const item = document.createElement('div');
                item.className = 'log-item log-info log-print-continue';
                item.textContent = printMessage;
                logArea.appendChild(item);
                logArea.scrollTop = logArea.scrollHeight;
            }
        }
    }

    updateMemoryDisplay(message) {
        const display = document.getElementById('memoryDisplay');
        const data = message.data;
        let formatted = `アドレス: ${message.address}\nサイズ: ${message.size} bytes\n\n`;

        // 16進数表示
        formatted += 'HEX: ';
        for (let i = 0; i < data.length; i += 2) {
            formatted += data.substr(i, 2) + ' ';
            if ((i / 2 + 1) % 16 === 0) formatted += '\n     ';
        }

        display.textContent = formatted;
    }

    updatePinStatus(message) {
        const status = document.getElementById('pinStatus');
        status.textContent = `ピン ${message.pin}: ${message.value === 1 ? 'HIGH' : 'LOW'}`;
        this.log(`ピン${message.pin}の値: ${message.value}`, 'info');
    }

    renderCode() {
        const codeEl = document.getElementById('codeLines');
        codeEl.innerHTML = '';

        this.fileContent.forEach((line, index) => {
            const lineNum = index + 1;
            const lineEl = document.createElement('div');
            lineEl.className = 'line';

            if (lineNum === this.currentLine) {
                lineEl.classList.add('current');
            }

            const numberEl = document.createElement('div');
            numberEl.className = 'line-number';
            numberEl.textContent = lineNum;

            const contentEl = document.createElement('div');
            contentEl.className = 'line-content';
            contentEl.textContent = line;

            lineEl.appendChild(numberEl);
            lineEl.appendChild(contentEl);
            codeEl.appendChild(lineEl);
        });
    }

    renderCaptures() {
        const captureEl = document.getElementById('captureList');
        captureEl.innerHTML = '';

        this.captures.forEach((capture, id) => {
            const item = document.createElement('div');
            item.className = 'capture-item';

            const varInfo = capture.variable_name ? `: ${capture.variable_name}` : '';
            const header = document.createElement('div');
            header.className = 'capture-header';
            header.innerHTML = `
                        <span>L: ${capture.line}${varInfo}</span>
                        <button onclick="kdbClient.readCapture(${id})" class="btn-primary">読み取り</button>
                    `;

            const data = document.createElement('div');
            data.className = 'capture-data';
            
            if (capture.data && capture.data !== 'データ未取得') {
                // HTML構造で表示を改善
                const hexDiv = document.createElement('div');
                hexDiv.className = 'data-hex';
                hexDiv.textContent = `HEX: ${capture.data}`;
                data.appendChild(hexDiv);
                
            // 10進数値がある場合は追加表示
            if (capture.decimalValue) {
                const decimal = capture.decimalValue;
                
                const decUnsignedDiv = document.createElement('div');
                decUnsignedDiv.className = 'data-decimal';
                decUnsignedDiv.textContent = `DEC(unsigned): ${decimal.unsigned}`;
                data.appendChild(decUnsignedDiv);
                
                const decSignedDiv = document.createElement('div');
                decSignedDiv.className = 'data-decimal';
                decSignedDiv.textContent = `DEC(signed): ${decimal.signed}`;
                data.appendChild(decSignedDiv);
                
                // バイナリ表示（4バイト以下の場合のみ）
                if (decimal.bytes <= 4) {
                    const binDiv = document.createElement('div');
                    binDiv.className = 'data-info';
                    binDiv.textContent = `BIN: ${decimal.binary}`;
                    data.appendChild(binDiv);
                }
                
                // ASCII文字表示
                if (decimal.ascii) {
                    const asciiDiv = document.createElement('div');
                    asciiDiv.className = 'data-info';
                    asciiDiv.textContent = `ASCII: "${decimal.ascii}"`;
                    data.appendChild(asciiDiv);
                }
                
                const sizeDiv = document.createElement('div');
                sizeDiv.className = 'data-info';
                sizeDiv.textContent = `Size: ${decimal.bytes} bytes`;
                data.appendChild(sizeDiv);
            }
            } else {
                data.textContent = 'データ未取得';
            }

            item.appendChild(header);
            item.appendChild(data);
            captureEl.appendChild(item);
        });
    }

    loadFile(filepath) {
        this.send('load_file', { filepath });

        // ファイルリストの選択状態を更新
        document.querySelectorAll('.file-item').forEach(item => {
            item.classList.remove('selected');
            if (item.textContent === filepath) {
                item.classList.add('selected');
            }
        });
    }

    readCapture(captureId) {
        this.send('read_capture', { capture_id: captureId });
    }

    log(message, type = 'info') {
        const logArea = document.getElementById('logArea');
        const item = document.createElement('div');
        item.className = `log-item log-${type}`;
        item.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;

        logArea.appendChild(item);
        logArea.scrollTop = logArea.scrollHeight;
    }
}

/**
 * @type {KDBClient}
 */
let kdbClient;

window.onload = () => {
    kdbClient = new KDBClient();
};

function refreshPorts() {
    kdbClient.send('list_ports');
}

function toggleConnection() {
    if (kdbClient.connected) {
        kdbClient.send('disconnect');
    } else {
        const port = document.getElementById('portSelect').value;
        const baudrate = parseInt(document.getElementById('baudRate').value);

        if (!port) {
            alert('ポートを選択してください');
            return;
        }

        kdbClient.send('connect', { port, baudrate });
    }
}

function refreshFiles() {
    kdbClient.send('list_files');
}

function continueExecution() {
    kdbClient.send('continue');
}

function readMemory() {
    const address = document.getElementById('memoryAddress').value;
    const size = parseInt(document.getElementById('memorySize').value);

    if (!address) {
        alert('アドレスを入力してください');
        return;
    }

    kdbClient.send('read_memory', { address, size });
}

function readPin() {
    const pin = parseInt(document.getElementById('pinNumber').value);
    kdbClient.send('read_pin', { pin });
}

function writePin() {
    const pin = parseInt(document.getElementById('pinNumber').value);
    const value = parseInt(document.getElementById('pinValue').value);
    kdbClient.send('write_pin', { pin, value });
}

function switchTab(tabName) {
    // タブボタンの状態更新
    document.querySelectorAll('.tab').forEach(tab => {
        tab.classList.remove('active');
    });

    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });

    event.target.classList.add('active');
    document.getElementById(tabName + 'Tab').classList.add('active');
}