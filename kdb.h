#ifndef _KDB_H_
#define _KDB_H_

#include <Arduino.h>

/*
 * KPC Arduino Debugger Header File
 * Arduino用デバッガライブラリ
 */

#ifndef _KDB_Serial
#define _KDB_Serial Serial
#endif

// 前方宣言
struct _KDB_PtrWithSize;
class _KDB;

// オペレーションタイプ列挙型
enum _KDB_OpType
{
    _KDB_RETURN,
    _KDB_READ_MEM,
    _KDB_WRITE_MEM,
    _KDB_READ_CAP,
    _KDB_WRITE_CAP,
    _KDB_READ_PIN,
    _KDB_WRITE_PIN,
    _KDB_INIT,
    _KDB_DEBUGGER,
    _KDB_CAPTURE,
    _KDB_READ_MEM_RES,
    _KDB_READ_CAP_RES,
    _KDB_READ_PIN_RES,
    _KDB_PRINT,
};

// 構造体定義
struct _KDB_PtrWithSize
{
    uint8_t size;
    uint8_t *ptr;
};

// メインデバッガクラス
class _KDB
{
public:
    // 公開メンバ変数
    _KDB_PtrWithSize caps[32];
    uint8_t capsize;
    uint8_t readbuf[32];
    volatile bool loops;

    // コンストラクタ
    _KDB();

    // 公開メソッド
    void debugger(unsigned line);
    void capture(unsigned line, void *x, uint8_t size);
    void init(unsigned line);
    
    // print関数群
    void print(unsigned line, const char* str);
    void print(unsigned line, int val);
    void print(unsigned line, long val);
    void print(unsigned line, unsigned int val);
    void print(unsigned line, double val, int digits = 2);
    
    // println関数群
    void println(unsigned line, const char* str);
    void println(unsigned line, int val);
    void println(unsigned line, long val);
    void println(unsigned line, unsigned int val);
    void println(unsigned line, double val, int digits = 2);
    void println(unsigned line);

private:
    // 内部メソッド
    void sendOp(uint8_t opType, uint8_t opSize);
    void doOp();
    void readOp(uint8_t maxloop = 255);
    void readSize(uint8_t size);
};

// グローバルインスタンス宣言
extern _KDB __KDB;

// マクロ定義
#define kdbcap(x) __KDB.capture(__LINE__, &x, sizeof(x))
#define kdbinit __KDB.init(__LINE__)
#define kdbd __KDB.debugger(__LINE__)
#define kdbprint(...)  __KDB.print(__LINE__, __VA_ARGS__)
#define kdbprintln(...)  __KDB.println(__LINE__, __VA_ARGS__)

/*
 * プロトコル仕様:
 * 0xA0 | 0x1E | OpType | OpValueSize | ...OpValues
 * 
 * 使用例:
 * - kdbinit: デバッガ初期化
 * - kdbd: ブレークポイント設定
 * - kdbcap(variable): 変数キャプチャ
 * - kdbprint("text"): デバッグ出力
 * - kdbprintln(value): デバッグ出力（改行付き）
 */

#endif // _KDB_H_
