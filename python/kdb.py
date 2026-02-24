#!/usr/bin/env python3
"""
KPC Arduino Debugger - Python WebSocket Server
Arduinoとの通信を中継し、.inoファイルの検索・読み込み機能を提供
"""

import asyncio
import websockets
import serial
import serial.tools.list_ports
import json
import os
import glob
import re
from typing import Optional, Dict, List, Any
import struct
import time
import threading
from enum import IntEnum


class KDBOpType(IntEnum):
    """KDBプロトコルの操作タイプ"""

    RETURN = 0
    READ_MEM = 1
    WRITE_MEM = 2
    READ_CAP = 3
    WRITE_CAP = 4
    READ_PIN = 5
    WRITE_PIN = 6
    INIT = 7
    DEBUGGER = 8
    CAPTURE = 9
    READ_MEM_RES = 10
    READ_CAP_RES = 11
    READ_PIN_RES = 12
    PRINT = 13


class KDBSerialHandler:
    """Arduinoとのシリアル通信を処理するクラス"""

    def __init__(self):
        self.serial_port: Optional[serial.Serial] = None
        self.is_connected = False
        self.capture_data: Dict[int, Dict] = {}  # line_number -> capture_info
        self.breakpoints: Dict[int, bool] = {}  # line_number -> enabled
        self.current_line = 0
        self.is_debugging = False
        # スレッドロックを追加してシリアル通信の競合を防ぐ
        self._serial_lock = threading.RLock()

    def connect(self, port: str, baudrate: int = 9600) -> bool:
        """指定されたポートに接続"""
        try:
            with self._serial_lock:
                if self.serial_port and self.serial_port.is_open:
                    self.serial_port.close()

                # タイムアウトをさらに長く設定してCPU負荷を軽減
                self.serial_port = serial.Serial(port, baudrate, timeout=1.0)
                self.is_connected = True
                print(f"Arduino connected on {port}")
                return True
        except Exception as e:
            print(f"Connection failed: {e}")
            return False

    def disconnect(self):
        """接続を切断"""
        try:
            with self._serial_lock:
                if self.serial_port and self.serial_port.is_open:
                    self.serial_port.close()
                self.is_connected = False
                print("Arduino disconnected")
        except Exception as e:
            print(f"Disconnect error: {e}")
            self.is_connected = False

    def send_command(self, op_type: KDBOpType, data: bytes = b"") -> bool:
        """KDBコマンドを送信"""
        if not self.is_connected or not self.serial_port:
            return False

        try:
            with self._serial_lock:
                # パケットフォーマット: 0xA0 | 0x1E | OpType | Size | Data
                packet = bytearray([0xA0, 0x1E, op_type, len(data)])
                packet.extend(data)

                self.serial_port.write(packet)
                self.serial_port.flush()  # 送信バッファをフラッシュ
                return True
        except Exception as e:
            print(f"Send command failed: {e}")
            return False

    def read_response(self, timeout: float = 1.0) -> Optional[bytes]:
        """レスポンスを読み取り（ヘッダー検出特化版）"""
        if not self.is_connected or not self.serial_port:
            return None

        try:
            with self._serial_lock:
                start_time = time.time()
                buffer = bytearray()
                state = 0  # 0: waiting for 0xA0, 1: waiting for 0x1E, 2: reading header, 3: reading data
                expected_size = 0

                while time.time() - start_time < timeout:
                    # データが利用可能かチェック
                    if self.serial_port.in_waiting == 0:
                        time.sleep(0.02)  # データ待ちの際はスリープを長めに
                        continue
                    
                    # 1バイトずつ読み取ってヘッダーを探す
                    byte = self.serial_port.read(1)
                    if not byte:
                        continue
                        
                    b = byte[0]

                    if state == 0:
                        # 0xA0を探す
                        if b == 0xA0:
                            state = 1
                    elif state == 1:
                        # 0x1Eを探す
                        if b == 0x1E:
                            state = 2
                            buffer = bytearray()
                        else:
                            state = 0  # ヘッダー不正、最初から
                    elif state == 2:
                        # OpType + OpValueSizeを読む
                        buffer.append(b)
                        if len(buffer) == 2:  # OpType + OpValueSize
                            expected_size = buffer[1]
                            if expected_size == 0:
                                return bytes(buffer)
                            state = 3
                    elif state == 3:
                        # データ部分を読む
                        buffer.append(b)
                        if len(buffer) >= 2 + expected_size:  # header + data
                            return bytes(buffer)

        except Exception as e:
            print(f"Read response error: {e}")
            
        return None

    def continue_execution(self) -> bool:
        """実行を継続"""
        return self.send_command(KDBOpType.RETURN)

    def read_capture(self, pos: int) -> Optional[bytes]:
        """キャプチャデータを読み取り"""
        with self._serial_lock:
            if self.send_command(KDBOpType.READ_CAP, bytes([pos])):
                response = self.read_response()
                if response and response[0] == KDBOpType.READ_CAP_RES:
                    return response[2:]  # Skip optype and size
        return None

    def write_capture(self, pos: int, data: bytes) -> bool:
        """キャプチャデータを書き込み"""
        payload = bytes([pos]) + data
        return self.send_command(KDBOpType.WRITE_CAP, payload)

    def read_memory(self, address: int, size: int) -> Optional[bytes]:
        """メモリを読み取り"""
        with self._serial_lock:
            addr_bytes = struct.pack(">I", address)  # Big endian 32-bit
            payload = addr_bytes + bytes([size])

            if self.send_command(KDBOpType.READ_MEM, payload):
                response = self.read_response()
                if response and response[0] == KDBOpType.READ_MEM_RES:
                    return response[2:]  # Skip optype and size
        return None

    def write_memory(self, address: int, data: bytes) -> bool:
        """メモリに書き込み"""
        addr_bytes = struct.pack(">I", address)  # Big endian 32-bit
        payload = addr_bytes + bytes([len(data)]) + data
        return self.send_command(KDBOpType.WRITE_MEM, payload)

    def read_pin(self, pin: int) -> Optional[int]:
        """デジタルピンの値を読み取り"""
        with self._serial_lock:
            if self.send_command(KDBOpType.READ_PIN, bytes([pin])):
                response = self.read_response()
                if response and response[0] == KDBOpType.READ_PIN_RES:
                    return response[2] if len(response) > 2 else None
        return None

    def write_pin(self, pin: int, value: int) -> bool:
        """デジタルピンに値を書き込み"""
        return self.send_command(KDBOpType.WRITE_PIN, bytes([pin, value]))


class KDBFileManager:
    """Arduinoプロジェクトファイルを管理するクラス"""

    def __init__(self, base_path: str = "."):
        # ホームディレクトリ（~）を展開
        self.base_path = os.path.expanduser(base_path)
        self.current_file = None
        self.file_content = ""
        self.file_lines: List[str] = []

    def find_ino_files(self) -> List[str]:
        """カレントディレクトリから.inoファイルを検索"""
        files = []
        # base_pathを展開してからパターンを作成
        expanded_base = os.path.expanduser(self.base_path)
        for i in range(4):
            pattern = os.path.join(expanded_base, "*" + "/*" * i + ".ino")
            files += glob.glob(pattern)
        # 相対パスに変換
        return [os.path.relpath(f, expanded_base) for f in files]

    def load_ino_file(self, filepath: str) -> bool:
        """指定された.inoファイルを読み込み"""
        try:
            # ファイルパスも展開してからjoin
            expanded_filepath = os.path.expanduser(filepath)
            if os.path.isabs(expanded_filepath):
                full_path = expanded_filepath
            else:
                full_path = os.path.join(self.base_path, filepath)

            with open(full_path, "r", encoding="utf-8") as f:
                self.file_content = f.read()
                self.file_lines = self.file_content.split("\n")
                self.current_file = filepath
                return True
        except Exception as e:
            print(f"Failed to load file {filepath}: {e}")
            return False

    def get_file_info(self) -> Dict[str, Any]:
        """現在のファイル情報を取得"""
        return {
            "filepath": self.current_file,
            "content": self.file_content,
            "lines": self.file_lines,
            "line_count": len(self.file_lines),
        }

    def get_line(self, line_number: int) -> str:
        """指定行の内容を取得"""
        if 0 < line_number <= len(self.file_lines):
            return self.file_lines[line_number - 1]
        return ""

    def find_kdbcap_variables(self) -> Dict[int, List[str]]:
        """ファイル内のkdbcap変数を正規表現で検索"""
        # kdbcap(変数名)のパターンを定義
        pattern = r'kdbcap\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\[[^\]]*\])*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\)'
        
        result = {}
        for line_num, line_content in enumerate(self.file_lines, 1):
            matches = re.findall(pattern, line_content)
            if matches:
                result[line_num] = matches
                
        return result

    def get_variable_name_at_line(self, line_number: int) -> Optional[str]:
        """指定行のkdbcap変数名を取得"""
        if 0 < line_number <= len(self.file_lines):
            line_content = self.file_lines[line_number - 1]
            pattern = r'kdbcap\s*\(\s*([a-zA-Z_][a-zA-Z0-9_]*(?:\[[^\]]*\])*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)*)\s*\)'
            match = re.search(pattern, line_content)
            if match:
                return match.group(1)
        return None

    def get_capture_info_with_variables(self) -> Dict[int, Dict[str, Any]]:
        """キャプチャ情報を変数名付きで取得"""
        variables = self.find_kdbcap_variables()
        result = {}
        
        for line_num, var_names in variables.items():
            for i, var_name in enumerate(var_names):
                result[line_num] = {
                    'line': line_num,
                    'variable_name': var_name,
                    'line_content': self.get_line(line_num).strip()
                }
                
        return result


class KDBWebSocketServer:
    """WebSocketサーバー"""

    def __init__(self, host: str = "localhost", port: int = 8765):
        self.host = host
        self.port = port
        self.serial_handler = KDBSerialHandler()
        # ホームディレクトリを適切に展開
        self.file_manager = KDBFileManager("~")
        self.clients = set()

        # シリアル通信監視フラグ
        self.should_monitor = False

    async def register(self, websocket):
        """クライアント登録"""
        self.clients.add(websocket)
        print(f"Client connected: {websocket.remote_address}")

    async def unregister(self, websocket):
        """クライアント登録解除"""
        self.clients.remove(websocket)
        print(f"Client disconnected: {websocket.remote_address}")

    async def broadcast(self, message: Dict):
        """全クライアントにメッセージを送信"""
        if self.clients:
            await asyncio.gather(
                *[client.send(json.dumps(message)) for client in self.clients],
                return_exceptions=True,
            )

    def start_serial_monitor(self):
        """シリアル通信監視を開始（CPU負荷軽減版）"""

        async def monitor():
            consecutive_empty_reads = 0
            base_sleep = 0.1   # 基本スリープ時間を100msに増加
            max_sleep = 1.0    # 最大スリープ時間を1秒に増加
            
            while self.should_monitor:
                if self.serial_handler.is_connected and self.serial_handler.serial_port:
                    try:
                        # データ読み取り試行（より短いタイムアウト）
                        response = self.serial_handler.read_response(timeout=0.1)
                        if response:
                            consecutive_empty_reads = 0
                            await self.handle_serial_data(response)
                        else:
                            consecutive_empty_reads += 1
                    except Exception as e:
                        print(f"Serial monitor error: {e}")
                        consecutive_empty_reads += 1
                else:
                    consecutive_empty_reads += 1

                # アダプティブスリープ：データがない場合はスリープ時間をより長く延長
                if consecutive_empty_reads > 5:  # しきい値を下げる
                    sleep_time = min(base_sleep * (consecutive_empty_reads // 5), max_sleep)
                else:
                    sleep_time = base_sleep
                    
                await asyncio.sleep(sleep_time)

        if not self.should_monitor:
            self.should_monitor = True
            # 非同期タスクとして実行
            asyncio.create_task(monitor())

    async def handle_serial_data(self, data: bytes):
        """Arduinoからのデータを処理"""
        if len(data) < 2:
            return

        op_type = data[0]
        op_size = data[1]

        if op_type == KDBOpType.DEBUGGER:
            # デバッガでブレーク
            if len(data) >= 4:
                line_number = (data[2] << 8) | data[3]
                self.serial_handler.current_line = line_number
                self.serial_handler.is_debugging = True

                await self.broadcast(
                    {
                        "type": "debugger_break",
                        "line": line_number,
                        "content": self.file_manager.get_line(line_number),
                    }
                )

        elif op_type == KDBOpType.CAPTURE:
            # 変数キャプチャ
            if len(data) >= 10:  # 最低限必要なデータサイズ
                line_number = (data[2] << 8) | data[3]
                address = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7]
                size = data[8]
                cap_id = data[9]

                # 変数名を取得
                variable_name = self.file_manager.get_variable_name_at_line(line_number)

                self.serial_handler.capture_data[cap_id] = {
                    "line": line_number,
                    "address": address,
                    "size": size,
                    "variable_name": variable_name,
                }

                await self.broadcast(
                    {
                        "type": "variable_captured",
                        "line": line_number,
                        "capture_id": cap_id,
                        "address": hex(address),
                        "size": size,
                        "variable_name": variable_name,
                    }
                )

        elif op_type == KDBOpType.INIT:
            # 初期化
            if len(data) >= 4:
                line_number = (data[2] << 8) | data[3]
                await self.broadcast(
                    {
                        "type": "debugger_init",
                        "message": f"Debugger initialized at line {line_number}",
                    }
                )
                self.serial_handler.continue_execution()

        elif op_type == KDBOpType.PRINT:
            # プリント出力
            if len(data) >= 5:
                line_number = (data[2] << 8) | data[3]
                print_type = data[4]  # 0=print, 1=println
                message = data[5:].decode("utf-8", errors="ignore")

                await self.broadcast(
                    {
                        "type": "debug_print",
                        "line": line_number,
                        "message": message,
                        "is_println": print_type == 1,
                    }
                )

        # その他のレスポンス処理
        elif op_type in [
            KDBOpType.READ_MEM_RES,
            KDBOpType.READ_CAP_RES,
            KDBOpType.READ_PIN_RES,
        ]:
            # これらは直接のレスポンスなので、ここでは特に処理しない
            # 実際のコマンド送信時にread_responseで処理される
            pass

    async def handle_message(self, websocket, message: str):
        """WebSocketメッセージを処理"""
        try:
            data = json.loads(message)
            command = data.get("command")

            if command == "list_ports":
                # シリアルポート一覧を取得
                ports = [port.device for port in serial.tools.list_ports.comports()]
                await websocket.send(json.dumps({"type": "port_list", "ports": ports}))

            elif command == "connect":
                # Arduinoに接続
                port = data.get("port")
                baudrate = data.get("baudrate", 9600)
                success = self.serial_handler.connect(port, baudrate)

                if success:
                    self.start_serial_monitor()

                await websocket.send(
                    json.dumps(
                        {
                            "type": "connection_status",
                            "connected": success,
                            "port": port,
                        }
                    )
                )

            elif command == "disconnect":
                # 接続切断
                self.should_monitor = False  # 先にモニターを停止
                await asyncio.sleep(0.1)  # モニターの停止を待つ
                self.serial_handler.disconnect()

                await websocket.send(
                    json.dumps({"type": "connection_status", "connected": False})
                )

            elif command == "list_files":
                # .inoファイル一覧を取得
                files = self.file_manager.find_ino_files()
                await websocket.send(json.dumps({"type": "file_list", "files": files}))

            elif command == "list_variables":
                # kdbcap変数一覧を取得
                variables = self.file_manager.get_capture_info_with_variables()
                await websocket.send(json.dumps({"type": "variable_list", "variables": variables}))

            elif command == "load_file":
                # ファイル読み込み
                filepath = data.get("filepath")
                success = self.file_manager.load_ino_file(filepath)

                if success:
                    file_info = self.file_manager.get_file_info()
                    await websocket.send(
                        json.dumps(
                            {
                                "type": "file_loaded",
                                "success": True,
                                "file_info": file_info,
                            }
                        )
                    )
                else:
                    await websocket.send(
                        json.dumps(
                            {
                                "type": "file_loaded",
                                "success": False,
                                "error": f"Failed to load {filepath}",
                            }
                        )
                    )

            elif command == "continue":
                # 実行継続
                if self.serial_handler.is_debugging:
                    self.serial_handler.continue_execution()
                    self.serial_handler.is_debugging = False
                    await self.broadcast({"type": "execution_continued"})

            elif command == "read_capture":
                # キャプチャデータ読み取り
                cap_id = data.get("capture_id")
                if cap_id is not None:
                    capture_data = self.serial_handler.read_capture(cap_id)
                    if capture_data:
                        # バイトデータを16進数文字列に変換
                        hex_data = capture_data.hex()
                        await websocket.send(
                            json.dumps(
                                {
                                    "type": "capture_data",
                                    "capture_id": cap_id,
                                    "data": hex_data,
                                    "size": len(capture_data),
                                }
                            )
                        )

            elif command == "read_memory":
                # メモリ読み取り
                address = int(data.get("address", "0"), 16)
                size = data.get("size", 4)
                memory_data = self.serial_handler.read_memory(address, size)

                if memory_data:
                    await websocket.send(
                        json.dumps(
                            {
                                "type": "memory_data",
                                "address": hex(address),
                                "data": memory_data.hex(),
                                "size": len(memory_data),
                            }
                        )
                    )

            elif command == "read_pin":
                # ピン読み取り
                pin = data.get("pin")
                value = self.serial_handler.read_pin(pin)

                if value is not None:
                    await websocket.send(
                        json.dumps({"type": "pin_value", "pin": pin, "value": value})
                    )

            elif command == "write_pin":
                # ピン書き込み
                pin = data.get("pin")
                value = data.get("value")
                success = self.serial_handler.write_pin(pin, value)

                await websocket.send(
                    json.dumps(
                        {
                            "type": "pin_write_result",
                            "pin": pin,
                            "value": value,
                            "success": success,
                        }
                    )
                )

        except Exception as e:
            print(f"Message handling error: {e}")
            await websocket.send(json.dumps({"type": "error", "message": str(e)}))

    async def handler(self, websocket):
        """WebSocket接続ハンドラ"""
        await self.register(websocket)
        try:
            async for message in websocket:
                await self.handle_message(websocket, message)
        except Exception as e:
            print(f"WebSocket error: {e}")
        finally:
            await self.unregister(websocket)

    def start(self):
        """サーバー開始"""
        print(f"KDB WebSocket server starting on {self.host}:{self.port}")

        return websockets.serve(self.handler, self.host, self.port)


async def main():
    """メイン関数"""
    import webbrowser
    import os
    server = KDBWebSocketServer()

    # WebSocketサーバー開始
    start_server = server.start()

    print("KDB Arduino Debugger Server")
    print("WebSocket server: ws://localhost:8765")
    print("Press Ctrl+C to stop")
    
    # index.htmlを自動的に開く
    html_path = os.path.join(os.path.dirname(__file__), "index.html")
    if os.path.exists(html_path):
        webbrowser.open(f"file://{os.path.abspath(html_path)}")
        print(f"Opening {html_path} in browser...")
    else:
        print("index.html not found, please open http://localhost:8765 manually")

    await start_server
    await asyncio.Future()  # 無限待機


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nServer stopped")
