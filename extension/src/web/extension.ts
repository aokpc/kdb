import * as vscode from 'vscode';
import type { ArduinoContext } from 'vscode-arduino-api';
import { KDBOpType, KDBProtocolParser, KDBSerialHandler, CaptureData } from './kdb';


/**
 * KDBデバッガコントローラー
 */
class KDBDebuggerController {
    public serialHandler: KDBSerialHandler;
    private greenDecorationType: vscode.TextEditorDecorationType;
    private redDecorationType: vscode.TextEditorDecorationType;
    private yellowDecorationType: vscode.TextEditorDecorationType;
    private captureLines: Map<number, number[]> = new Map(); // line -> capIds
    private captureDecorations: Map<number, vscode.Range[]> = new Map(); // capId -> ranges
    private outputChannel: vscode.OutputChannel;
    private captureTreeProvider: CaptureTreeProvider | null = null;

    constructor() {
        this.serialHandler = new KDBSerialHandler();

        this.greenDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(0, 255, 0, 0.2)',
            isWholeLine: true,
            overviewRulerColor: 'green',
            overviewRulerLane: vscode.OverviewRulerLane.Full,
        });

        this.redDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 0, 0, 0.3)',
            isWholeLine: true,
            overviewRulerColor: 'red',
            overviewRulerLane: vscode.OverviewRulerLane.Full,
        });

        this.yellowDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 234, 0, 0.3)',
            isWholeLine: true,
            overviewRulerColor: 'yellow',
            overviewRulerLane: vscode.OverviewRulerLane.Full,
        });

        // 出力チャネルを作成
        this.outputChannel = vscode.window.createOutputChannel('KDB Debugger');

        this.setupEventHandlers();
    }

    /**
     * イベントハンドラーの設定
     */
    private setupEventHandlers() {
        this.serialHandler.on('connected', (args) => {
            const { port } = args;
            const timestamp = new Date().toLocaleTimeString();
            this.outputChannel.appendLine(`[${timestamp}] Connected to ${port}`);
            this.outputChannel.show();
            vscode.window.showInformationMessage(`Arduino connected on ${port}`);
        });

        this.serialHandler.on('error', (args) => {
            const { error } = args;
            const timestamp = new Date().toLocaleTimeString();
            this.outputChannel.appendLine(`[${timestamp}] Serial error: ${error}`);
            this.outputChannel.show();
            vscode.window.showErrorMessage(`Serial error: ${error}`);
        });

        this.serialHandler.on('debugger_break', (args) => {
            const { line } = args;
            const timestamp = new Date().toLocaleTimeString();
            this.outputChannel.appendLine(`[${timestamp}] Debugger break at line ${line}`);
            this.outputChannel.show();
            this.handleDebuggerBreak(line);
        });

        this.serialHandler.on('variable_captured', (args) => {
            const { line, capId } = args;
            const timestamp = new Date().toLocaleTimeString();
            this.outputChannel.appendLine(`[${timestamp}] Variable captured: CAP ${capId} at line ${line}`);
            this.outputChannel.show();
            this.handleVariableCaptured(line, capId);
        });

        this.serialHandler.once('debugger_init', () => {
            // INIT時は自動的に実行継続
            const timestamp = new Date().toLocaleTimeString();
            this.outputChannel.appendLine(`[${timestamp}] Debugger initialized, continuing execution...`);
            this.outputChannel.show();
            this.serialHandler.continueExecution();
        });

        this.serialHandler.on('debug_print', (args) => {
            const { message, line } = args;
            const timestamp = new Date().toLocaleTimeString();
            this.outputChannel.appendLine(`[${timestamp}] print@${line}> ${message}`);
            this.outputChannel.show();
        });

        this.serialHandler.on('disconnected', () => {
            const timestamp = new Date().toLocaleTimeString();
            this.outputChannel.appendLine(`[${timestamp}] Disconnected`);
            this.outputChannel.show();
        });
    }    /**
     * デバッガブレーク時の処理
     */
    private async handleDebuggerBreak(line: number): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        this.highlightKDBMarkers(editor.document);

        // 現在行をYでハイライト
        const range = new vscode.Range(
            new vscode.Position(line - 1, 0),
            new vscode.Position(line - 1, 0)
        );
        editor.setDecorations(this.yellowDecorationType, [range]);

        // すべてのキャプチャデータを読み取り
        const timestamp = new Date().toLocaleTimeString();
        this.outputChannel.appendLine(`[${timestamp}] Reading all capture data...`);
        await this.readAllCaptures();
        this.outputChannel.appendLine(`[${timestamp}] Capture data updated`);

        vscode.window.showWarningMessage(`Debugger break at line ${line}`);
    }

    /**
     * 変数キャプチャ時の処理
     */
    private handleVariableCaptured(line: number, capId: number) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        if (!this.captureLines.has(line)) {
            this.captureLines.set(line, []);
        }
        this.captureLines.get(line)!.push(capId);

        const ranges: vscode.Range[] = [];
        this.captureLines.forEach((capIds, lineNum) => {
            ranges.push(
                new vscode.Range(
                    new vscode.Position(lineNum - 1, 0),
                    new vscode.Position(lineNum - 1, 0)
                )
            );
        });

        const match = editor.document.lineAt(line - 1).text.match(/kdbcap\((.*?)\)/);
        if (match) {
            const cap = this.serialHandler.getCaptureData(capId)
            if (cap) cap.variable_name = (match[1]);
        }


        editor.setDecorations(this.greenDecorationType, ranges);
    }

    /**
     * すべてのキャプチャデータを読み取り
     */
    private async readAllCaptures(): Promise<void> {
        console.log(`[readAllCaptures] Debugger stopped: ${this.serialHandler['stopped']}`);
        if (!this.serialHandler['stopped']) {
            console.log(`[readAllCaptures] デバッガが停止していないため、読み取りをスキップ`);
            this.outputChannel.appendLine(`    (debugger not stopped)`);
            return;
        }

        const allCaptures = this.serialHandler.getAllCaptureData();
        console.log(`[readAllCaptures] Total captures: ${allCaptures.size}`);
        let captureCount = 0;

        for (const [capId, capture] of allCaptures) {
            console.log(`[readAllCaptures] Reading CAP ${capId}...`);
            const data = await this.serialHandler.readCapture(capId);
            console.log(`[readAllCaptures] CAP ${capId} data received: ${data}`);
            if (data !== null && data !== undefined) {
                capture.data = data;
                this.captureTreeProvider?.refreshCapture(capId);
                const varName = capture.variable_name ? ` (${capture.variable_name})` : '';
                this.outputChannel.appendLine(`    CAP ${capId}${varName}: ${capture.data}`);
                captureCount++;
            } else {
                console.log(`[readAllCaptures] CAP ${capId} data is null/undefined`);
            }
        }

        console.log(`[readAllCaptures] Total successfully read: ${captureCount}`);
        if (captureCount === 0) {
            this.outputChannel.appendLine(`    (no captures)`);
        }
    }

    /**
     * キャプチャデータに書き込み
     */
    async writeCapture() {
        const capIdStr = await vscode.window.showInputBox({
            prompt: 'キャプチャID を入力',
            placeHolder: '0',
        });

        if (!capIdStr) return;

        const capId = parseInt(capIdStr);
        const capture = this.serialHandler.getCaptureData(capId);

        if (!capture) {
            this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Capture ${capId} not found`);
            vscode.window.showErrorMessage(`キャプチャID ${capId} が見つかりません`);
            return;
        }

        const intValueStr = await vscode.window.showInputBox({
            prompt: `書き込む10進値を入力 (キャプチャID: ${capId})`,
            placeHolder: '0',
        });

        if (!intValueStr) return;

        try {
            let value = BigInt(intValueStr);
            let hex = value.toString(16);

            // 有効なサイズになるように0パディング
            const requiredLength = capture.size * 2;
            if (hex.length < requiredLength) {
                hex = hex.padStart(requiredLength, '0');
            }

            const buffer = Buffer.from(hex, 'hex');
            const success = this.serialHandler.writeCapture(capId, buffer);

            if (success) {
                const timestamp = new Date().toLocaleTimeString();
                this.outputChannel.appendLine(`[${timestamp}] Write to CAP ${capId}: ${intValueStr} (0x${hex})`);
                this.outputChannel.show();
                vscode.window.showInformationMessage(
                    `キャプチャ${capId}に書き込みました: ${intValueStr}`
                );
            } else {
                this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Failed to write to CAP ${capId}`);
                vscode.window.showErrorMessage(`キャプチャ${capId}への書き込みに失敗しました`);
            }
        } catch (error) {
            this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Invalid value: ${error}`);
            vscode.window.showErrorMessage(`無効な数値です: ${error}`);
        }
    }

    /**
     * キャプチャデータに書き込み
     */
    async writeCaptureById(capId: number) {
        const capture = this.serialHandler.getCaptureData(capId);

        if (!capture) {
            this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Capture ${capId} not found`);
            vscode.window.showErrorMessage(`キャプチャID ${capId} が見つかりません`);
            return;
        }

        const intValueStr = await vscode.window.showInputBox({
            prompt: `書き込む10進値を入力 (キャプチャID: ${capId})`,
            placeHolder: '0',
        });

        if (!intValueStr) return;

        try {
            let value = BigInt(intValueStr);
            let hex = value.toString(16);
            if (hex.length % 2) {
                hex = '0' + hex;
            }

            // 有効なサイズになるように0パディング
            const requiredLength = capture.size * 2;
            if (hex.length < requiredLength) {
                hex = hex.padEnd(requiredLength, '0');
            }

            const buffer = Buffer.from(hex, 'hex');
            const success = this.serialHandler.writeCapture(capId, buffer);

            if (success) {
                const timestamp = new Date().toLocaleTimeString();
                this.outputChannel.appendLine(`[${timestamp}] Write to CAP ${capId}: ${intValueStr} (0x${hex})`);
                this.outputChannel.show();
                vscode.window.showInformationMessage(
                    `キャプチャ${capId}に書き込みました: ${intValueStr}`
                );
            } else {
                this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Failed to write to CAP ${capId}`);
                vscode.window.showErrorMessage(`キャプチャ${capId}への書き込みに失敗しました`);
            }
        } catch (error) {
            this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Invalid value: ${error}`);
            vscode.window.showErrorMessage(`無効な数値です: ${error}`);
        }
    }

    /**
     * デバッガを開始
     */
    async start() {
        const timestamp = new Date().toLocaleTimeString();

        this.outputChannel.clear();
        this.outputChannel.appendLine(`[${timestamp}] Starting KDB Debugger...`);

        const arduinoContext = tryGetArduinoContext();

        // ArduinoContextからボード情報を取得（プロパティ名は API に依存）
        const port = (arduinoContext).port;

        if (!port) {
            this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] No Arduino board selected`);
            vscode.window.showErrorMessage('Arduinoボードが選択されていません');
            this.outputChannel.show();
            return;
        }

        const address = (port).address;
        if (!port) {
            this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] No serial port found`);
            vscode.window.showErrorMessage('シリアルポートが設定されていません');
            this.outputChannel.show();
            return;
        }

        const baudrates = ['9600', '31250', '115200'];
        const selection = await vscode.window.showQuickPick(baudrates, {
            placeHolder: 'ボーレートを選択',
            canPickMany: false // 複数選択を許可するかどうか
        });

        this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Connecting to ${address}...`);

        if (!selection) {
            this.outputChannel.show();
            return;
        }
        const baudrate = parseInt(selection);

        const connected = await this.serialHandler.connect(address, baudrate);
        if (!connected) {
            this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Failed to connect to ${address}`);
            vscode.window.showErrorMessage(`ポート ${address} に接続できませんでした`);
            this.outputChannel.show();
            return;
        }

        // コード内のkdbinit, kdbcap, kdbdを見つける
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            this.highlightKDBMarkers(editor.document);
        }

        this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] KDB Debugger started successfully`);
        this.outputChannel.show();
    }

    /**
     * KDBマーカー（kdbinit, kdbcap, kdbd）をハイライト
     */
    private highlightKDBMarkers(document: vscode.TextDocument) {
        const text = document.getText();
        const lines = text.split('\n');

        const greenRanges: vscode.Range[] = [];
        const redRanges: vscode.Range[] = [];

        lines.forEach((line: string, index: number) => {
            if (
                line.includes('kdbinit') ||
                line.includes('kdbcap') ||
                line.includes('kdbinit')
            ) {
                greenRanges.push(
                    new vscode.Range(
                        new vscode.Position(index, 0),
                        new vscode.Position(index, line.length)
                    )
                );
            }
            if (line.includes('kdbd')) {
                redRanges.push(
                    new vscode.Range(
                        new vscode.Position(index, 0),
                        new vscode.Position(index, line.length)
                    )
                );
            }
        });

        const editor = vscode.window.activeTextEditor;
        if (editor) {
            editor.setDecorations(this.greenDecorationType, greenRanges);
            editor.setDecorations(this.redDecorationType, redRanges);
        }
    }

    /**
     * ホバー情報を提供
     */
    provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
        const line = document.lineAt(position.line).text;
        const captures = this.serialHandler.getAllCaptureData();

        const hoverContents: vscode.MarkdownString[] = [];

        for (const [capId, capture] of captures) {
            if (
                capture.variable_name &&
                line.includes(capture.variable_name)
            ) {
                const content = new vscode.MarkdownString();
                content.appendMarkdown(`**Capture ID: ${capId}**\n\n`);
                content.appendMarkdown(`- Line: ${capture.line}\n`);
                content.appendMarkdown(`- Address: 0x${capture.address.toString(16)}\n`);
                content.appendMarkdown(`- Size: ${capture.size}\n`);

                if (capture.data) {
                    content.appendMarkdown(
                        `\n**Data:** ${capture.data}\n`
                    );
                }

                hoverContents.push(content);
            }
        }

        if (hoverContents.length > 0) {
            return new vscode.Hover(hoverContents);
        }

        return null;
    }

    /**
     * クリーンアップ（再利用可能）
     * OutputChannel は破棄せず、クリアのみ
     */
    async dispose() {
        await this.serialHandler.disconnect();
        this.greenDecorationType.dispose();
        this.redDecorationType.dispose();
        this.captureTreeProvider = null;
        // OutputChannel は再利用するため破棄しない
        // this.outputChannel.clear();
    }

    /**
     * 終了時にOutputChannelを破棄
     */
    disposeOutputChannel() {
        this.outputChannel.dispose();
    }

    /**
     * すべてのキャプチャを取得
     */
    getAllCaptures(): Map<number, CaptureData> {
        return this.serialHandler.getAllCaptureData();
    }

    /**
     * キャプチャデータを取得
     */
    getCaptureData(capId: number): CaptureData | undefined {
        return this.serialHandler.getCaptureData(capId);
    }

    /**
     * 実行を継続
     */
    continue(): void {
        this.outputChannel.appendLine(`[${new Date().toLocaleTimeString()}] Continue`);
        this.outputChannel.show();
        this.serialHandler.continueExecution();
    }

    /**
     * CaptureTreeProviderを設定
     */
    setCaptureTreeProvider(provider: CaptureTreeProvider): void {
        this.captureTreeProvider = provider;
    }
}

let debuggerController: KDBDebuggerController;

function tryGetArduinoContext(): ArduinoContext {
    const ext = vscode.extensions.getExtension('dankeboy36.vscode-arduino-api');
    const ext2 = vscode.extensions.getExtension('dankeboy36.vscode-arduino-tools');
    const api = ext?.exports as ArduinoContext;
    if (api) {
        ((api as any).tools) = ext2?.exports;
        return api
    };
    throw new TypeError('vscode-arduino-api not found');
}

/**
 * キャプチャビュープロバイダー
 */
class CaptureTreeProvider implements vscode.TreeDataProvider<CaptureTreeItem> {
    private onDidChangeTreeDataEmitter = new vscode.EventEmitter<CaptureTreeItem | undefined>();
    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;
    private captureItemMap: Map<number, CaptureTreeItem> = new Map();

    constructor() { }

    getTreeItem(element: CaptureTreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: CaptureTreeItem): Thenable<CaptureTreeItem[]> {
        if (!element) {
            // ルートノードの場合、すべてのキャプチャを返す
            const captures = debuggerController.getAllCaptures();
            console.log(`[CaptureTreeProvider.getChildren] Total captures from controller: ${captures.size}`);
            const items: CaptureTreeItem[] = [];
            const currentCapIds = new Set(captures.keys());

            console.log(`[CaptureTreeProvider.getChildren] Current cap IDs: ${Array.from(currentCapIds).join(', ')}`);
            console.log(`[CaptureTreeProvider.getChildren] Cached cap IDs: ${Array.from(this.captureItemMap.keys()).join(', ')}`);

            // 削除されたキャプチャをキャッシュから削除
            for (const cachedCapId of this.captureItemMap.keys()) {
                if (!currentCapIds.has(cachedCapId)) {
                    console.log(`[CaptureTreeProvider.getChildren] Deleting cached CAP ${cachedCapId}`);
                    this.captureItemMap.delete(cachedCapId);
                }
            }

            for (const [capId, capture] of captures) {
                let item = this.captureItemMap.get(capId);
                if (!item) {
                    // 新規作成
                    console.log(`[CaptureTreeProvider.getChildren] Creating new item for CAP ${capId}`);
                    item = new CaptureTreeItem(
                        capId,
                        capture,
                        vscode.TreeItemCollapsibleState.Collapsed
                    );
                    this.captureItemMap.set(capId, item);
                } else {
                    // 既存アイテムのキャプチャデータを更新
                    console.log(`[CaptureTreeProvider.getChildren] Updating existing item for CAP ${capId}`);
                    item.updateDescription();
                }
                items.push(item);
            }
            console.log(`[CaptureTreeProvider.getChildren] Returning ${items.length} items`);
            return Promise.resolve(items);
        }
        return Promise.resolve([]);
    }

    refresh(): void {
        this.onDidChangeTreeDataEmitter.fire(undefined);
    }

    refreshCapture(capId: number): void {
        console.log(`[CaptureTreeProvider.refreshCapture] Refreshing CAP ${capId}`);
        // キャッシュから古いアイテムを削除し、次のgetChildren()で新しく作成されるようにする
        this.captureItemMap.delete(capId);
        // ツリー全体をリフレッシュして、すべてのキャプチャが表示されるようにする
        console.log(`[CaptureTreeProvider.refreshCapture] Firing refresh event for CAP ${capId}`);
        this.refresh();
    }
}

/**
 * キャプチャツリーアイテム
 */
class CaptureTreeItem extends vscode.TreeItem {
    constructor(
        public readonly capId: number,
        public readonly capture: CaptureData,
        collapsibleState: vscode.TreeItemCollapsibleState
    ) {
        const label = capture.variable_name
            ? `${capId}: ${capture.variable_name}`
            : `${capId}`;

        super(label, collapsibleState);
        this.updateDescription();
        this.contextValue = 'capture';
        this.command = {
            title: 'Edit Capture Value',
            command: 'kdb-ext.writeCaptureById',
            arguments: [capId],
        };
    }

    /**
     * キャプチャデータに基づいて説明を更新
     */
    updateDescription(): void {
        if (this.capture.data === -1) {
            this.description = 'pending';
        } else {
            this.description = this.capture.data.toString();
        }
    }
}

/**
 * デバッグコントロールプロバイダー
 */
class DebugControlsTreeProvider implements vscode.TreeDataProvider<DebugControlItem> {
    private onDidChangeTreeDataEmitter = new vscode.EventEmitter<DebugControlItem | undefined>();
    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

    constructor() { }

    getTreeItem(element: DebugControlItem): vscode.TreeItem {
        return element;
    }

    getChildren(): Thenable<DebugControlItem[]> {
        return Promise.resolve([
            new DebugControlItem(
                'Start KPC Debugger',
                'kdb-ext.run',
                vscode.TreeItemCollapsibleState.None,
                '$(debug-alt)'
            ),
            new DebugControlItem(
                'Stop KPC Debugger',
                'kdb-ext.stop',
                vscode.TreeItemCollapsibleState.None,
                '$(debug-stop)'
            ),
            new DebugControlItem(
                'Continue Execution',
                'kdb-ext.continue',
                vscode.TreeItemCollapsibleState.None,
                '$(debug-continue)'
            ),
            new DebugControlItem(
                'Write to Capture',
                'kdb-ext.writeCapture',
                vscode.TreeItemCollapsibleState.None,
                '$(edit)'
            ),
        ]);
    }

    refresh() {
        this.onDidChangeTreeDataEmitter.fire(undefined);
    }
}

/**
 * デバッグコントロールアイテム
 */
class DebugControlItem extends vscode.TreeItem {
    public readonly commandId: string;

    constructor(
        label: string,
        commandId: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly icon: string
    ) {
        super(label, collapsibleState);
        this.commandId = commandId;
        this.contextValue = 'debug-control';
        this.command = {
            title: label,
            command: commandId,
        };
        this.iconPath = new vscode.ThemeIcon(icon.replace('$(', '').replace(')', ''));
    }
}

export function activate(context: vscode.ExtensionContext) {
    // 既存のコントローラーがあればクリーンアップ


    // ツリープロバイダーの作成
    const captureTreeProvider = new CaptureTreeProvider();
    const debugControlsTreeProvider = new DebugControlsTreeProvider();



    // ビューの登録
    vscode.window.registerTreeDataProvider('kdb-captures', captureTreeProvider);
    vscode.window.registerTreeDataProvider('kdb-debug-controls', debugControlsTreeProvider);



    // kdb-ext.run コマンド: デバッガを開始
    const runCommand = vscode.commands.registerCommand('kdb-ext.run', async () => {
        if (debuggerController) {
            debuggerController.disposeOutputChannel();
        }

        debuggerController = new KDBDebuggerController();

        // ツリープロバイダーを設定
        debuggerController.setCaptureTreeProvider(captureTreeProvider);

        // serialHandler のイベントリスナーを追加して、キャプチャ更新時に自動リフレッシュ
        debuggerController.serialHandler.on('variable_captured', () => {
            captureTreeProvider.refresh();
        });

        await debuggerController.start();
        captureTreeProvider.refresh();
        debugControlsTreeProvider.refresh();
    });

    // kdb-ext.stop コマンド: デバッガをstop
    const stopCommand = vscode.commands.registerCommand('kdb-ext.stop', async () => {
        await debuggerController.dispose();
        captureTreeProvider.refresh();
        debugControlsTreeProvider.refresh();
        vscode.window.showInformationMessage("デバッガを停止しました");
    });

    // kdb-ext.continue コマンド: 実行継続
    const continueCommand = vscode.commands.registerCommand('kdb-ext.continue', async () => {
        debuggerController.continue();
    });

    // kdb-ext.writeCapture コマンド: キャプチャに書き込み
    const writeCommand = vscode.commands.registerCommand(
        'kdb-ext.writeCapture',
        async () => {
            await debuggerController.writeCapture();
        }
    );
    // kdb-ext.writeCapture コマンド: キャプチャに書き込み
    const writeByIdCommand = vscode.commands.registerCommand(
        'kdb-ext.writeCaptureById',
        async (capId: number) => {
            await debuggerController.writeCaptureById(capId);
        }
    );

    // ホバープロバイダーを登録
    /*
    const hoverProvider = vscode.languages.registerHoverProvider(
        { scheme: 'file', language: 'cpp' },
        {
            provideHover: (document, position) =>
                debuggerController.provideHover(document, position),
        }
    );
    */

    context.subscriptions.push(
        runCommand,
        stopCommand,
        continueCommand,
        writeCommand,
        writeByIdCommand,
        // hoverProvider
    );
}

export function deactivate() {
    if (debuggerController) {
        debuggerController.dispose();
        // 拡張機能終了時にOutputChannelを破棄
        debuggerController.disposeOutputChannel();
    }
}
