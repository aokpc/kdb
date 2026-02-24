# KDB Arduino Debugger Library

Arduino用デバッグライブラリ - リアルタイム変数監視とブレークポイント機能を提供

## ファイル構成

- `kdb.h` - ヘッダーファイル（宣言）
- `kdb.cpp` - 実装ファイル
- `kdb.py` - Python WebSocketサーバー
- `cli.py` - コマンドラインインターフェース
- `index.html` - Web UI

## Arduino側の使用方法

### 1. ライブラリのインクルード

```cpp
#include "kdb.h"
```

### 2. 基本的な使用例

```cpp
#include "kdb.h"

int counter = 0;
float temperature = 25.5;

void setup() {
    Serial.begin(9600);
    kdbinit;  // デバッガ初期化
}

void loop() {
    counter++;
    temperature += 0.1;
    
    // 変数をキャプチャ
    kdbcap(counter);
    kdbcap(temperature);
    
    // ブレークポイント
    kdbd;
    
    // デバッグ出力
    kdbprint("Counter: ");
    kdbprintln(counter);
    
    delay(1000);
}
```

## 主要マクロ

| マクロ | 説明 |
|--------|------|
| `kdbinit` | デバッガ初期化（setup()で実行） |
| `kdbd` | ブレークポイント設定 |
| `kdbcap(var)` | 変数キャプチャ |
| `kdbprint(...)` | デバッグ出力 |
| `kdbprintln(...)` | デバッグ出力（改行付き） |

## サポートするデータ型

### print/println関数
- `const char*` - 文字列
- `int` - 整数
- `long` - 長整数
- `unsigned int` - 符号なし整数
- `double` - 浮動小数点数（桁数指定可能）

### capture関数
- 任意の変数型（sizeof()で自動サイズ検出）
- 構造体、配列も対応

## PC側での使用

### WebUI使用
```bash
python3 kdb.py
# ブラウザで http://localhost:8765 にアクセス
```

### CLI使用
```bash
python3 cli.py <inoファイル> <シリアルポート>
# 例: python3 cli.py sketch.ino /dev/ttyUSB0
```

## プロトコル仕様

```
パケット形式: 0xA0 | 0x1E | OpType | DataSize | Data...
```

### オペレーションタイプ
- `_KDB_INIT (7)` - 初期化
- `_KDB_DEBUGGER (8)` - ブレークポイント
- `_KDB_CAPTURE (9)` - 変数キャプチャ
- `_KDB_PRINT (13)` - デバッグ出力
- その他メモリ操作、ピン操作など

## インストール方法

1. `kdb.h`と`kdb.cpp`をArduinoプロジェクトフォルダにコピー
2. Python側環境構築:
   ```bash
   pip install pyserial websockets asyncio
   ```
3. ライブラリをインクルードして使用開始

## トラブルシューティング

- **シリアル接続エラー**: ポート名とボーレートを確認
- **変数が表示されない**: `kdbcap()`が実行されているか確認
- **ブレークしない**: `kdbd`マクロの配置を確認
- **CPU負荷が高い**: 最新版のkdb.pyを使用（効率化済み）

## ライセンス

MIT License - 自由に改変・配布可能