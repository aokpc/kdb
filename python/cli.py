#!/usr/bin/env python3
"""
KPC Arduino Debugger - CLI Version
kdb.pyの機能を使用したコマンドラインインターフェース
"""

import asyncio
import sys
import os
import time
import json
import re
from typing import Optional, Dict, List
import threading
from concurrent.futures import ThreadPoolExecutor

# kdb.pyからクラスをインポート
from kdb import KDBSerialHandler, KDBFileManager, KDBOpType


# カラー出力のための定数
class Colors:
    """ANSI カラーコード"""

    # 基本色
    BLACK = "\033[30m"
    RED = "\033[31m"
    GREEN = "\033[32m"
    YELLOW = "\033[33m"
    BLUE = "\033[34m"
    MAGENTA = "\033[35m"
    CYAN = "\033[36m"
    WHITE = "\033[37m"

    # 明るい色
    BRIGHT_BLACK = "\033[90m"
    BRIGHT_RED = "\033[91m"
    BRIGHT_GREEN = "\033[92m"
    BRIGHT_YELLOW = "\033[93m"
    BRIGHT_BLUE = "\033[94m"
    BRIGHT_MAGENTA = "\033[95m"
    BRIGHT_CYAN = "\033[96m"
    BRIGHT_WHITE = "\033[97m"

    # スタイル
    BOLD = "\033[1m"
    DIM = "\033[2m"
    ITALIC = "\033[3m"
    UNDERLINE = "\033[4m"

    # リセット
    RESET = "\033[0m"

    @staticmethod
    def colorize(text: str, color: str) -> str:
        """テキストに色を付ける"""
        return f"{color}{text}{Colors.RESET}"

    @staticmethod
    def is_supported() -> bool:
        """カラー出力がサポートされているかチェック"""
        return hasattr(sys.stdout, "isatty") and sys.stdout.isatty()


class KDBCLIDebugger:
    """CUI版のKDBデバッガ"""

    def __init__(
        self,
        auto_load_file: Optional[str] = None,
        auto_connect_port: Optional[str] = None,
    ):
        self.serial_handler = KDBSerialHandler()
        self.file_manager = KDBFileManager()
        self.is_running = True
        self.current_line = 0
        self.captures = {}
        self.monitor_thread = None
        
        # シリアル通信の競合を防ぐためのロック
        self.serial_lock = threading.RLock()

        # コマンド履歴
        self.command_history = []

        # カラー出力が有効かチェック
        self.use_colors = Colors.is_supported()

        # ウェルカムメッセージ
        self.print_header()

        # 自動読み込み・接続
        if auto_load_file:
            if auto_load_file.endswith(".ino"):
                self.cmd_load_file(auto_load_file)
            else:
                self.file_manager.base_path = auto_load_file
                self.cmd_list_files()

        if auto_connect_port:
            self.cmd_connect(auto_connect_port, 9600)

    def print_header(self):
        """ヘッダーを表示"""
        header = "=" * 60
        title = "  KPC Arduino Debugger - CLI Version"

        if self.use_colors:
            print(Colors.colorize(header, Colors.BRIGHT_CYAN))
            print(Colors.colorize(title, Colors.BRIGHT_YELLOW + Colors.BOLD))
            print(Colors.colorize(header, Colors.BRIGHT_CYAN))
        else:
            print(header)
            print(title)
            print(header)
        print()

    def log(self, message: str, level: str = "info"):
        """カラー付きログ出力"""
        if not self.use_colors:
            print(message)
            return

        if level == "error":
            print(Colors.colorize(message, Colors.BRIGHT_RED))
        elif level == "warning":
            print(Colors.colorize(message, Colors.BRIGHT_YELLOW))
        elif level == "success":
            print(Colors.colorize(message, Colors.BRIGHT_GREEN))
        elif level == "info":
            print(Colors.colorize(message, Colors.BRIGHT_BLUE))
        elif level == "debug":
            print(Colors.colorize(message, Colors.BRIGHT_MAGENTA))
        elif level == "output":
            print(Colors.colorize(message, Colors.BRIGHT_CYAN))
        else:
            print(message)

    def get_file_link(self, line_number: int) -> str:
        """ファイルパス:行番号の形式でリンクを生成"""
        if self.file_manager.current_file:
            # 絶対パスを取得
            abs_path = (self.file_manager.current_file)
            return f"{abs_path}:{line_number}"
        else:
            return f"行 {line_number}"

    def print_help(self):
        """ヘルプを表示"""
        help_text = """
利用可能なコマンド:

接続関連:
  ports                    - 利用可能なシリアルポートを表示
  connect <port> [baud]    - Arduinoに接続 (デフォルト: 9600)
  disconnect               - 接続を切断
  status                   - 接続状態を表示

ファイル管理:
  files                    - .inoファイルを検索
  load <filepath>          - ファイルを読み込み
  show [start] [end]       - ファイル内容を表示 (行番号指定可能)
  current                  - 現在のファイル情報を表示
  variables                - ファイル内のkdbcap変数を表示

デバッグ制御:
  continue                 - 実行を継続
  captures                 - キャプチャ変数一覧を表示
  read <capture_id>        - キャプチャデータを読み取り
  watch <capture_id>       - キャプチャデータを監視 (Ctrl+Cで停止)

メモリ・ピン操作:
  mem <address> [size]     - メモリを読み取り
  pin <pin_number>         - ピンの値を読み取り
  setpin <pin> <value>     - ピンに値を書き込み (0=LOW, 1=HIGH)

その他:
  log [on|off]             - ログ表示の切り替え
  clear                    - 画面をクリア
  history                  - コマンド履歴を表示
  help                     - このヘルプを表示
  quit, exit               - プログラムを終了

例:
  connect /dev/tty.usbmodem101 9600
  load example.ino
  show 1 10
  read 0
  mem 0x1000 4
"""
        print(help_text)

    def start_monitor(self):
        """Arduinoからの通信を監視するスレッドを開始"""

        def monitor():
            while self.is_running and self.serial_handler.is_connected:
                try:
                    with self.serial_lock:
                        response = self.serial_handler.read_response(timeout=0.1)
                        if response:
                            self.handle_serial_data(response)
                except Exception as e:
                    if self.is_running:  # プログラム終了時以外はエラー表示
                        print(f"\n[エラー] シリアル通信エラー: {e}")
                time.sleep(0.01)

        if self.monitor_thread is None or not self.monitor_thread.is_alive():
            self.monitor_thread = threading.Thread(target=monitor, daemon=True)
            self.monitor_thread.start()

    def handle_serial_data(self, data: bytes):
        """Arduinoからのデータを処理"""
        if len(data) < 2:
            return

        op_type = data[0]
        op_size = data[1]

        if op_type == KDBOpType.DEBUGGER:
            # デバッガでブレーク
            if len(data) >= 4:
                line_number = (data[2] << 8) | data[3]
                self.current_line = line_number
                self.serial_handler.current_line = line_number
                self.serial_handler.is_debugging = True

                # ファイルパス:行番号のリンク形式で表示
                file_link = self.get_file_link(line_number)
                self.log(f"\n[デバッグ] ブレーク: {file_link}", "debug")

                self.log("実行を継続するには 'continue' と入力してください。", "info")

        elif op_type == KDBOpType.CAPTURE:
            # 変数キャプチャ
            if len(data) >= 10:
                line_number = (data[2] << 8) | data[3]
                address = (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7]
                size = data[8]
                cap_id = data[9]

                # 変数名を取得
                variable_name = self.file_manager.get_variable_name_at_line(line_number)

                self.captures[cap_id] = {
                    "line": line_number,
                    "address": address,
                    "size": size,
                    "data": None,
                    "variable_name": variable_name,
                }

                # ファイルパス:行番号のリンク形式で表示
                file_link = self.get_file_link(line_number)
                variable_info = f" 変数: {variable_name}" if variable_name else ""
                self.log(
                    f"\n[キャプチャ] ID: {cap_id}, {file_link}, アドレス: 0x{address:08X}, サイズ: {size}{variable_info}",
                    "success",
                )

        elif op_type == KDBOpType.INIT:
            # 初期化
            if len(data) >= 4:
                line_number = (data[2] << 8) | data[3]
                file_link = self.get_file_link(line_number)
                self.log(
                    f"\n[初期化] デバッガが初期化されました ({file_link})",
                    "success",
                )
                self.captures = {}
                self.cmd_continue()

        elif op_type == KDBOpType.PRINT:
            # プリント出力
            if len(data) >= 5:
                line_number = (data[2] << 8) | data[3]
                print_type = data[4]  # 0=print, 1=println
                message = data[5:].decode("utf-8", errors="ignore")

                file_link = self.get_file_link(line_number)
                if print_type == 1:  # println
                    self.log(f"[出力] {file_link}: {message}", "output")
                else:  # print (改行なし)
                    if self.use_colors:
                        print(
                            f"{Colors.colorize('[出力]', Colors.BRIGHT_BLUE)} {Colors.colorize(file_link, Colors.BRIGHT_CYAN)}: {message}",
                            end="",
                        )
                    else:
                        print(f"[出力] {file_link}: {message}", end="")

    def run_command(self, command_line: str) -> bool:
        """コマンドを実行. 継続する場合はTrue, 終了する場合はFalseを返す"""
        if not command_line.strip():
            return True

        parts = command_line.strip().split()
        cmd = parts[0].lower()
        args = parts[1:] if len(parts) > 1 else []

        # コマンド履歴に追加
        if command_line.strip() not in ["history", "clear"]:
            self.command_history.append(command_line.strip())
            if len(self.command_history) > 50:  # 履歴を50件に制限
                self.command_history.pop(0)

        try:
            if cmd in ["quit", "exit"]:
                return False

            elif cmd == "help":
                self.print_help()

            elif cmd == "clear":
                os.system("clear" if os.name == "posix" else "cls")

            elif cmd == "history":
                self.log("\nコマンド履歴:", "info")
                for i, hist_cmd in enumerate(self.command_history[-20:], 1):
                    if self.use_colors:
                        print(
                            f"  {Colors.colorize(str(i).rjust(2), Colors.BRIGHT_YELLOW)}: {hist_cmd}"
                        )
                    else:
                        print(f"  {i:2d}: {hist_cmd}")
                print()

            elif cmd == "ports":
                self.cmd_list_ports()

            elif cmd == "connect":
                if len(args) >= 1:
                    port = args[0]
                    baudrate = int(args[1]) if len(args) >= 2 else 9600
                    self.cmd_connect(port, baudrate)
                else:
                    self.log("使用法: connect <port> [baudrate]", "error")

            elif cmd == "disconnect":
                self.cmd_disconnect()

            elif cmd == "status":
                self.cmd_status()

            elif cmd == "files":
                self.cmd_list_files()

            elif cmd == "load":
                if len(args) >= 1:
                    self.cmd_load_file(args[0])
                else:
                    self.log("使用法: load <filepath>", "error")

            elif cmd == "show":
                start_line = int(args[0]) if len(args) >= 1 else 1
                end_line = int(args[1]) if len(args) >= 2 else None
                self.cmd_show_file(start_line, end_line)

            elif cmd == "current":
                self.cmd_current_file()

            elif cmd == "variables":
                self.cmd_show_variables()

            elif cmd == "continue":
                self.cmd_continue()

            elif cmd == "captures":
                self.cmd_show_captures()

            elif cmd == "read":
                if len(args) >= 1:
                    cap_id = int(args[0])
                    self.cmd_read_capture(cap_id)
                else:
                    self.log("使用法: read <capture_id>", "error")

            elif cmd == "watch":
                if len(args) >= 1:
                    cap_id = int(args[0])
                    self.cmd_watch_capture(cap_id)
                else:
                    self.log("使用法: watch <capture_id>", "error")

            elif cmd == "mem":
                if len(args) >= 1:
                    address = (
                        int(args[0], 16) if args[0].startswith("0x") else int(args[0])
                    )
                    size = int(args[1]) if len(args) >= 2 else 4
                    self.cmd_read_memory(address, size)
                else:
                    self.log("使用法: mem <address> [size]", "error")

            elif cmd == "pin":
                if len(args) >= 1:
                    pin = int(args[0])
                    self.cmd_read_pin(pin)
                else:
                    self.log("使用法: pin <pin_number>", "error")

            elif cmd == "setpin":
                if len(args) >= 2:
                    pin = int(args[0])
                    value = int(args[1])
                    self.cmd_write_pin(pin, value)
                else:
                    self.log("使用法: setpin <pin> <value>", "error")

            else:
                self.log(f"不明なコマンド: {cmd}", "error")
                self.log("'help' でコマンド一覧を表示します。", "info")

        except Exception as e:
            self.log(f"[エラー] コマンド実行エラー: {e}", "error")

        return True

    def cmd_list_ports(self):
        """シリアルポート一覧を表示"""
        import serial.tools.list_ports

        ports = [port.device for port in serial.tools.list_ports.comports()]

        if ports:
            self.log("\n利用可能なシリアルポート:", "info")
            for i, port in enumerate(ports, 1):
                if self.use_colors:
                    print(
                        f"  {Colors.colorize(str(i), Colors.BRIGHT_YELLOW)}: {Colors.colorize(port, Colors.BRIGHT_GREEN)}"
                    )
                else:
                    print(f"  {i}: {port}")
        else:
            self.log("利用可能なシリアルポートが見つかりません。", "warning")
        print()

    def cmd_connect(self, port: str, baudrate: int):
        """Arduinoに接続"""
        success = self.serial_handler.connect(port, baudrate)
        if success:
            self.log(
                f"[接続] {port} に接続しました (ボーレート: {baudrate})", "success"
            )
            self.start_monitor()
        else:
            self.log(f"[エラー] {port} への接続に失敗しました", "error")

    def cmd_disconnect(self):
        """接続を切断"""
        if self.serial_handler.is_connected:
            self.serial_handler.disconnect()
            self.log("[切断] Arduinoから切断しました", "warning")
        else:
            self.log("Arduinoに接続されていません", "warning")

    def cmd_status(self):
        """接続状態を表示"""
        if self.serial_handler.is_connected:
            self.log("[状態] Arduino接続中", "success")
            debug_status = "はい" if self.serial_handler.is_debugging else "いいえ"
            if self.use_colors:
                debug_color = (
                    Colors.BRIGHT_RED
                    if self.serial_handler.is_debugging
                    else Colors.BRIGHT_GREEN
                )
                print(f"  デバッグ中: {Colors.colorize(debug_status, debug_color)}")
            else:
                print(f"  デバッグ中: {debug_status}")

            if self.current_line > 0:
                file_link = self.get_file_link(self.current_line)
                if self.use_colors:
                    print(
                        f"  現在位置: {Colors.colorize(file_link, Colors.BRIGHT_YELLOW)}"
                    )
                else:
                    print(f"  現在位置: {file_link}")
        else:
            self.log("[状態] Arduino未接続", "error")

        if self.file_manager.current_file:
            if self.use_colors:
                print(
                    f"  読み込みファイル: {Colors.colorize(self.file_manager.current_file, Colors.BRIGHT_CYAN)}"
                )
            else:
                print(f"  読み込みファイル: {self.file_manager.current_file}")
        else:
            print("  読み込みファイル: なし")
        print()

    def cmd_list_files(self):
        """inoファイル一覧を表示"""
        files = self.file_manager.find_ino_files()

        if files:
            self.log("\n見つかった.inoファイル:", "info")
            for i, file in enumerate(files, 1):
                if self.use_colors:
                    print(
                        f"  {Colors.colorize(str(i), Colors.BRIGHT_YELLOW)}: {Colors.colorize(file, Colors.BRIGHT_CYAN)}"
                    )
                else:
                    print(f"  {i}: {file}")
        else:
            self.log("カレントディレクトリに.inoファイルが見つかりません", "warning")
        print()

    def cmd_load_file(self, filepath: str):
        """ファイルを読み込み"""
        success = self.file_manager.load_ino_file(filepath)
        if success:
            self.log(f"[読み込み] {filepath} を読み込みました", "success")
            line_count = len(self.file_manager.file_lines)
            if self.use_colors:
                print(
                    f"  行数: {Colors.colorize(str(line_count), Colors.BRIGHT_GREEN)}"
                )
            else:
                print(f"  行数: {line_count}")
        else:
            self.log(f"[エラー] {filepath} の読み込みに失敗しました", "error")

    def cmd_show_file(self, start_line: int = 1, end_line: Optional[int] = None):
        """ファイル内容を表示"""
        if not self.file_manager.current_file:
            self.log("ファイルが読み込まれていません", "warning")
            return

        lines = self.file_manager.file_lines
        if not lines:
            self.log("ファイルが空です", "warning")
            return

        if end_line is None:
            end_line = min(start_line + 19, len(lines))  # デフォルトで20行表示

        start_line = max(1, start_line)
        end_line = min(len(lines), end_line)

        filename = self.file_manager.current_file
        if self.use_colors:
            print(
                f"\n{Colors.colorize(filename, Colors.BRIGHT_CYAN)} (行 {Colors.colorize(f'{start_line}-{end_line}', Colors.BRIGHT_YELLOW)}):"
            )
            print(Colors.colorize("-" * 60, Colors.DIM))
        else:
            print(f"\n{filename} (行 {start_line}-{end_line}):")
            print("-" * 60)

        for i in range(start_line - 1, end_line):
            line_num = i + 1
            line_content = lines[i]

            if self.use_colors:
                if line_num == self.current_line:
                    prefix = Colors.colorize(">>>", Colors.BRIGHT_RED + Colors.BOLD)
                    num_color = Colors.BRIGHT_RED + Colors.BOLD
                    content_color = Colors.BRIGHT_WHITE + Colors.BOLD
                else:
                    prefix = "   "
                    num_color = Colors.BRIGHT_BLACK
                    content_color = Colors.WHITE

                line_str = Colors.colorize(f"{line_num:3d}", num_color)
                content_str = Colors.colorize(line_content, content_color)
                print(f"{prefix} {line_str}: {content_str}")
            else:
                prefix = ">>>" if line_num == self.current_line else "   "
                print(f"{prefix} {line_num:3d}: {line_content}")

        if end_line < len(lines):
            remaining = len(lines) - end_line
            if self.use_colors:
                print(Colors.colorize(f"... ({remaining} 行続く)", Colors.DIM))
            else:
                print(f"... ({remaining} 行続く)")
        print()

    def cmd_current_file(self):
        """現在のファイル情報を表示"""
        if self.file_manager.current_file:
            info = self.file_manager.get_file_info()
            abs_path = os.path.abspath(info["filepath"])

            if self.use_colors:
                print(
                    f"\n現在のファイル: {Colors.colorize(abs_path, Colors.BRIGHT_CYAN)}"
                )
                print(
                    f"行数: {Colors.colorize(str(info['line_count']), Colors.BRIGHT_GREEN)}"
                )
            else:
                print(f"\n現在のファイル: {abs_path}")
                print(f"行数: {info['line_count']}")

            if self.current_line > 0:
                file_link = self.get_file_link(self.current_line)
                line_content = self.file_manager.get_line(self.current_line)

                if self.use_colors:
                    print(
                        f"現在位置: {Colors.colorize(file_link, Colors.BRIGHT_YELLOW)}"
                    )
                    print(f"内容: {Colors.colorize(line_content, Colors.BRIGHT_WHITE)}")
                else:
                    print(f"現在位置: {file_link}")
                    print(f"内容: {line_content}")
        else:
            self.log("ファイルが読み込まれていません", "warning")
        print()

    def cmd_show_variables(self):
        """ファイル内のkdbcap変数を表示"""
        if not self.file_manager.current_file:
            self.log("ファイルが読み込まれていません", "warning")
            return

        variables = self.file_manager.find_kdbcap_variables()
        
        if not variables:
            self.log("kdbcap変数が見つかりませんでした", "warning")
            return

        self.log(f"\n{self.file_manager.current_file} 内のkdbcap変数:", "info")
        
        if self.use_colors:
            print(f"{Colors.colorize('行番号', Colors.BRIGHT_YELLOW)} | {Colors.colorize('変数名', Colors.BRIGHT_GREEN)} | {Colors.colorize('コード', Colors.BRIGHT_WHITE)}")
            print("-" * 60)
        else:
            print("行番号 | 変数名 | コード")
            print("-" * 60)

        for line_num, var_names in variables.items():
            line_content = self.file_manager.get_line(line_num).strip()
            
            for var_name in var_names:
                if self.use_colors:
                    line_str = Colors.colorize(f"{line_num:6d}", Colors.BRIGHT_YELLOW)
                    var_str = Colors.colorize(f"{var_name:15s}", Colors.BRIGHT_GREEN)
                    code_str = Colors.colorize(line_content, Colors.BRIGHT_WHITE)
                    print(f"{line_str} | {var_str} | {code_str}")
                else:
                    print(f"{line_num:6d} | {var_name:15s} | {line_content}")
        print()

    def cmd_continue(self):
        """実行を継続"""
        with self.serial_lock:
            success = self.serial_handler.continue_execution()
            if success:
                print("[継続] 実行を継続しました")
                self.serial_handler.is_debugging = False
                self.current_line = 0
            else:
                print("[エラー] 継続コマンドの送信に失敗しました")

    def cmd_show_captures(self):
        """キャプチャ変数一覧を表示"""
        if not self.captures:
            self.log("キャプチャされた変数はありません", "warning")
            return

        self.log("\nキャプチャ変数一覧:", "info")
        if self.use_colors:
            print(
                f"{Colors.colorize('ID', Colors.BRIGHT_YELLOW)}  | {Colors.colorize('変数名', Colors.BRIGHT_WHITE)}     | {Colors.colorize('位置', Colors.BRIGHT_CYAN)} | {Colors.colorize('アドレス', Colors.BRIGHT_MAGENTA)}   | {Colors.colorize('サイズ', Colors.BRIGHT_GREEN)} | {Colors.colorize('データ', Colors.BRIGHT_WHITE)}"
            )
            print("-" * 100)
        else:
            print("ID  | 変数名     | 位置 | アドレス   | サイズ | データ")
            print("-" * 100)

        for cap_id, info in self.captures.items():
            data_str = info.get("data", "未取得")
            if isinstance(data_str, bytes):
                data_str = data_str.hex()
                data_str = data_str + " int(" + str(int(data_str, 16)) + ")"
            elif data_str and len(str(data_str)) > 20:
                data_str = str(data_str)[:20] + "..."

            # 変数名を取得
            variable_name = info.get("variable_name", "不明")
            if not variable_name:
                variable_name = "不明"

            # ファイルリンク形式で位置を表示
            file_link = self.get_file_link(info["line"])

            if self.use_colors:
                id_str = Colors.colorize(f"{cap_id:3d}", Colors.BRIGHT_YELLOW)
                var_str = Colors.colorize(f"{variable_name:10s}", Colors.BRIGHT_WHITE)
                addr_str = Colors.colorize(
                    f"0x{info['address']:08X}", Colors.BRIGHT_MAGENTA
                )
                size_str = Colors.colorize(f"{info['size']:6d}", Colors.BRIGHT_GREEN)
                data_display = Colors.colorize(str(data_str), Colors.BRIGHT_WHITE)
                link_str = Colors.colorize(file_link, Colors.BRIGHT_CYAN)
                print(
                    f"{id_str} | {var_str} | {link_str} | {addr_str} | {size_str} | {data_display}"
                )
            else:
                print(
                    f"{cap_id:3d} | {variable_name:10s} | {file_link} | 0x{info['address']:08X} | {info['size']:6d} | {data_str}"
                )
        print()

    def cmd_read_capture(self, cap_id: int):
        """キャプチャデータを読み取り"""
        if cap_id not in self.captures:
            print(f"キャプチャID {cap_id} が見つかりません")
            return

        with self.serial_lock:
            data = self.serial_handler.read_capture(cap_id)
            if data:
                self.captures[cap_id]["data"] = data

                print(f"\nキャプチャID {cap_id} のデータ:")
                print(f"  16進数: {data.hex()}")
                print(f"  バイト数: {len(data)}")

                # 整数として解釈を試行
                if len(data) <= 4:
                    if len(data) == 1:
                        val = data[0]
                        print(f"  8bit整数: {val} ({val:08b}b)")
                    elif len(data) == 2:
                        val = int.from_bytes(data, "little")
                        print(f"  16bit整数: {val}")
                    elif len(data) == 4:
                        val = int.from_bytes(data, "little")
                        print(f"  32bit整数: {val}")
            else:
                print(f"[エラー] キャプチャID {cap_id} のデータ読み取りに失敗")
        print()

    def cmd_watch_capture(self, cap_id: int):
        """キャプチャデータを定期的に監視"""
        if cap_id not in self.captures:
            print(f"キャプチャID {cap_id} が見つかりません")
            return

        print(f"キャプチャID {cap_id} の監視を開始します (Ctrl+Cで停止)")
        try:
            while True:
                with self.serial_lock:
                    data = self.serial_handler.read_capture(cap_id)
                    if data:
                        self.captures[cap_id]["data"] = data

                        # 簡潔な表示
                        hex_str = data.hex()
                        if len(data) <= 4:
                            val = int.from_bytes(data, "little")
                            print(
                                f"[{time.strftime('%H:%M:%S')}] ID:{cap_id} = {val} (0x{hex_str})"
                            )
                        else:
                            print(
                                f"[{time.strftime('%H:%M:%S')}] ID:{cap_id} = 0x{hex_str}"
                            )

                time.sleep(0.5)

        except KeyboardInterrupt:
            print(f"\nキャプチャID {cap_id} の監視を停止しました")

    def cmd_read_memory(self, address: int, size: int):
        """メモリを読み取り"""
        with self.serial_lock:
            data = self.serial_handler.read_memory(address, size)
            if data:
                print(f"\nメモリ読み取り結果:")
                print(f"  アドレス: 0x{address:08X}")
                print(f"  サイズ: {size} bytes")
                print(f"  データ: {data.hex()}")

                # 16進ダンプ形式で表示
                print(f"  ダンプ:")
                for i in range(0, len(data), 16):
                    addr = address + i
                    chunk = data[i : i + 16]
                    hex_part = " ".join(f"{b:02x}" for b in chunk)
                    ascii_part = "".join(chr(b) if 32 <= b <= 126 else "." for b in chunk)
                    print(f"    0x{addr:08X}: {hex_part:<48} |{ascii_part}|")
            else:
                print(f"[エラー] アドレス 0x{address:08X} からのメモリ読み取りに失敗")
        print()

    def cmd_read_pin(self, pin: int):
        """ピンの値を読み取り"""
        with self.serial_lock:
            value = self.serial_handler.read_pin(pin)
            if value is not None:
                state_str = "HIGH" if value == 1 else "LOW"
                print(f"ピン {pin}: {value} ({state_str})")
            else:
                print(f"[エラー] ピン {pin} の読み取りに失敗")

    def cmd_write_pin(self, pin: int, value: int):
        """ピンに値を書き込み"""
        if value not in [0, 1]:
            print("値は 0 (LOW) または 1 (HIGH) である必要があります")
            return

        with self.serial_lock:
            success = self.serial_handler.write_pin(pin, value)
            if success:
                state_str = "HIGH" if value == 1 else "LOW"
                print(f"ピン {pin} に {value} ({state_str}) を書き込みました")
            else:
                print(f"[エラー] ピン {pin} への書き込みに失敗")

    def run(self):
        """メインループを実行"""
        self.log("'help' でコマンド一覧を表示します。", "info")
        print()

        try:
            while self.is_running:
                try:
                    # プロンプト表示
                    if self.use_colors:
                        if self.serial_handler.is_connected:
                            if self.serial_handler.is_debugging:
                                prompt = f"{Colors.colorize('kdb', Colors.BRIGHT_CYAN)}[{Colors.colorize('DEBUG', Colors.BRIGHT_RED)}]> "
                            else:
                                prompt = f"{Colors.colorize('kdb', Colors.BRIGHT_CYAN)}[{Colors.colorize('CONN', Colors.BRIGHT_GREEN)}]> "
                        else:
                            prompt = f"{Colors.colorize('kdb', Colors.BRIGHT_CYAN)}> "
                    else:
                        if self.serial_handler.is_connected:
                            if self.serial_handler.is_debugging:
                                prompt = "kdb[DEBUG]> "
                            else:
                                prompt = "kdb[CONN]> "
                        else:
                            prompt = "kdb> "

                    command = input(prompt)

                    if not self.run_command(command):
                        break

                except KeyboardInterrupt:
                    self.log("\nプログラムを終了しますか? (y/N): ", "warning")
                    try:
                        response = input().strip().lower()
                        if response == "y" or response == "yes":
                            break
                        self.log("継続します...", "info")
                    except (KeyboardInterrupt, EOFError):
                        break

                except EOFError:
                    break

        finally:
            self.cleanup()

    def cleanup(self):
        """終了処理"""
        self.log("\n終了処理中...", "warning")
        self.is_running = False

        if self.serial_handler.is_connected:
            self.serial_handler.disconnect()

        self.log("KDB CLI デバッガを終了しました。", "success")


def main():
    """メイン関数"""
    import argparse

    parser = argparse.ArgumentParser(
        description="KPC Arduino Debugger - CLI Version",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
例:
  python3 cli.py example.ino /dev/ttyUSB0  # ファイル読み込み + ポート接続
  python3 cli.py example.ino               # ファイル読み込みのみ
  python3 cli.py --no-color                # カラー出力無効
  python3 cli.py                           # 通常起動

起動後、'help' コマンドで詳細な使用方法を確認できます。
        """,
    )

    parser.add_argument("ino_file", nargs="?", help="自動読み込みする.inoファイルパス")
    parser.add_argument("port", nargs="?", help="自動接続するシリアルポート")
    parser.add_argument(
        "--no-color", action="store_true", help="カラー出力を無効にする"
    )

    args = parser.parse_args()

    # 引数の検証

    if args.ino_file and not os.path.exists(args.ino_file):
        print(f"エラー: ファイルまたはフォルダ {args.ino_file} が見つかりません")
        return

    debugger = KDBCLIDebugger(args.ino_file, args.port)

    # カラー出力の設定
    if args.no_color:
        debugger.use_colors = False

    debugger.run()


if __name__ == "__main__":
    main()
