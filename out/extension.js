"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = require("vscode");
const notionService_1 = require("./notionService");
const notionTreeProvider_1 = require("./notionTreeProvider");
const notionWebviewProvider_1 = require("./notionWebviewProvider");
let notionService;
let treeProvider;
let webviewProvider;
let globalContext;
function activate(context) {
    globalContext = context;
    console.log('Notion Interface extension is now active!');
    // Initialize services
    notionService = new notionService_1.NotionService();
    treeProvider = new notionTreeProvider_1.NotionTreeProvider(notionService);
    webviewProvider = new notionWebviewProvider_1.NotionWebviewProvider(context, notionService);
    // Register tree view provider
    console.log('Registering tree view provider for notion.pageExplorer');
    const treeView = vscode.window.createTreeView('notion.pageExplorer', {
        treeDataProvider: treeProvider,
        showCollapseAll: true
    });
    console.log('Tree view created successfully:', !!treeView);
    console.log('Tree view visible:', treeView.visible);
    // Listen for visibility changes
    treeView.onDidChangeVisibility(e => {
        console.log('Tree view visibility changed:', e.visible);
    });
    // Set context when extension is enabled
    vscode.commands.executeCommand('setContext', 'notion.enabled', true);
    // Initialize view mode context
    const config = vscode.workspace.getConfiguration('notion');
    const viewMode = config.get('viewMode', 'flat');
    vscode.commands.executeCommand('setContext', 'notion.viewMode', viewMode);
    // Register commands
    const disposables = [
        // API Key management
        vscode.commands.registerCommand('notion.setApiKey', setNotionApiKey),
        // Page navigation and refresh
        vscode.commands.registerCommand('notion.refreshPages', () => {
            console.log('refreshPages command called');
            vscode.window.showInformationMessage('Debug: Refresh command called - check console');
            treeProvider.refresh();
        }),
        // View mode toggles
        vscode.commands.registerCommand('notion.toggleFlatView', () => {
            console.log('toggleFlatView command called');
            treeProvider.setViewMode('flat');
        }),
        vscode.commands.registerCommand('notion.toggleTreeView', () => {
            console.log('toggleTreeView command called');
            treeProvider.setViewMode('tree');
        }),
        // Search functionality
        vscode.commands.registerCommand('notion.searchPages', searchPages),
        // Page operations
        vscode.commands.registerCommand('notion.openPage', openPage),
        vscode.commands.registerCommand('notion.uploadChanges', uploadChanges),
        vscode.commands.registerCommand('notion.toggleViewMode', async () => {
            await webviewProvider.toggleActiveView();
        }),
        // Cache management
        vscode.commands.registerCommand('notion.clearCache', async () => {
            const deletedCount = notionService.clearCache();
            vscode.window.showInformationMessage(`Cleared ${deletedCount} cache files. Data will be refreshed on next load.`);
            // Also refresh pages to reload fresh data
            await treeProvider.refresh();
        }),
        // Debug command to check properties
        vscode.commands.registerCommand('notion.debugProperties', async () => {
            console.log('=== DEBUG PROPERTIES COMMAND ===');
            const firstPage = treeProvider.getPageById('test') || treeProvider.pages?.[0];
            if (firstPage) {
                vscode.window.showInformationMessage(`First page: "${firstPage.title}", Properties: ${JSON.stringify(firstPage.properties)}`);
                console.log('First page full data:', firstPage);
            }
            else {
                vscode.window.showInformationMessage('No pages found to debug');
            }
        }),
        // File watching for Notion files
        vscode.workspace.onDidSaveTextDocument(onDocumentSaved),
        vscode.workspace.onDidOpenTextDocument(onDocumentOpened),
        // Tree view
        treeView
    ];
    context.subscriptions.push(...disposables);
    // Set up initial context
    const apiKey = config.get('apiKey');
    vscode.commands.executeCommand('setContext', 'notion.hasApiKey', !!apiKey);
    vscode.commands.executeCommand('setContext', 'notion.loading', false);
    vscode.commands.executeCommand('setContext', 'notion.pageCount', 0);
    // Load pages on startup if API key is configured
    if (apiKey) {
        treeProvider.refresh();
    }
}
exports.activate = activate;
async function setNotionApiKey() {
    const config = vscode.workspace.getConfiguration('notion');
    const apiKey = await vscode.window.showInputBox({
        prompt: 'Enter your Notion API Key',
        password: true,
        value: config.get('apiKey', ''),
        placeHolder: 'secret_... or ntn_...',
        ignoreFocusOut: true,
        validateInput: (value) => {
            if (!value) {
                return 'API key is required';
            }
            if (!value.startsWith('secret_') && !value.startsWith('ntn_')) {
                return 'API key should start with "secret_" or "ntn_"';
            }
            return null;
        }
    });
    if (apiKey) {
        await config.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);
        notionService.resetClient(); // Reset client to use new key
        vscode.commands.executeCommand('setContext', 'notion.hasApiKey', true);
        vscode.window.showInformationMessage('Notion API key saved successfully!');
        // Refresh pages with new key
        treeProvider.refresh();
    }
    else {
        vscode.window.showWarningMessage('Notion API key not saved - no value provided');
    }
}
async function searchPages() {
    const query = await vscode.window.showInputBox({
        prompt: 'Search Notion pages (title and content)',
        placeHolder: 'Enter search terms... (leave empty to show all)',
        ignoreFocusOut: true
    });
    if (query !== undefined) {
        console.log(`Search function called with query: "${query}"`);
        await treeProvider.searchPages(query);
        if (query.trim()) {
            vscode.window.showInformationMessage(`Search results for: "${query}"`);
        }
        else {
            vscode.window.showInformationMessage('Showing all pages');
        }
    }
}
async function openPage(pageIdOrItem) {
    console.log('openPage command called with:', pageIdOrItem);
    try {
        // Handle both direct pageId string and tree item object
        let pageId;
        if (typeof pageIdOrItem === 'string') {
            pageId = pageIdOrItem;
            console.log('Using pageId as string:', pageId);
        }
        else if (pageIdOrItem && pageIdOrItem.page && pageIdOrItem.page.id) {
            pageId = pageIdOrItem.page.id;
            console.log('Using pageId from .page.id:', pageId);
        }
        else if (pageIdOrItem && pageIdOrItem.id) {
            pageId = pageIdOrItem.id;
            console.log('Using pageId from .id:', pageId);
        }
        else {
            console.error('Invalid page ID provided:', pageIdOrItem);
            throw new Error('Invalid page ID provided');
        }
        // Open page in webview instead of markdown file
        await webviewProvider.openPage(pageId);
    }
    catch (error) {
        vscode.window.showErrorMessage(`Failed to open page: ${error}`);
    }
}
async function uploadChanges() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor found');
        return;
    }
    const filePath = editor.document.fileName;
    const pageId = notionService.getPageIdFromFile(filePath);
    if (!pageId) {
        vscode.window.showWarningMessage('This file is not linked to a Notion page');
        return;
    }
    const content = editor.document.getText();
    // Extract content without the header comment and title
    const lines = content.split('\n');
    let contentStart = 0;
    // Skip the comment line
    if (lines[0]?.startsWith('<!-- Notion Page ID:')) {
        contentStart = 1;
    }
    // Skip the title line if it exists
    if (lines[contentStart]?.startsWith('# ')) {
        contentStart++;
    }
    // Skip empty lines
    while (contentStart < lines.length && !lines[contentStart].trim()) {
        contentStart++;
    }
    const markdownContent = lines.slice(contentStart).join('\n');
    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Uploading changes to Notion...",
            cancellable: false
        }, async (progress) => {
            await notionService.updatePageContent(pageId, markdownContent);
            vscode.window.showInformationMessage('Changes uploaded to Notion successfully!');
        });
    }
    catch (error) {
        vscode.window.showErrorMessage(`Failed to upload changes: ${error}`);
    }
}
async function onDocumentSaved(document) {
    if (!document.fileName.includes('.notion')) {
        return;
    }
    const pageId = notionService.getPageIdFromFile(document.fileName);
    if (!pageId) {
        return;
    }
    const config = vscode.workspace.getConfiguration('notion');
    const autoSync = config.get('autoSync', true); // Default to true
    if (autoSync) {
        try {
            // Extract content and upload directly
            const content = document.getText();
            const lines = content.split('\n');
            let contentStart = 0;
            // Skip the comment line
            if (lines[0]?.startsWith('<!-- Notion Page ID:')) {
                contentStart = 1;
            }
            // Skip the title line if it exists
            if (lines[contentStart]?.startsWith('# ')) {
                contentStart++;
            }
            // Skip empty lines
            while (contentStart < lines.length && !lines[contentStart].trim()) {
                contentStart++;
            }
            const markdownContent = lines.slice(contentStart).join('\n');
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Auto-syncing to Notion...",
                cancellable: false
            }, async (progress) => {
                await notionService.updatePageContent(pageId, markdownContent);
                vscode.window.showInformationMessage('✓ Auto-synced to Notion', { modal: false });
            });
        }
        catch (error) {
            vscode.window.showWarningMessage(`Auto-sync failed: ${error}. Use manual upload if needed.`);
        }
    }
}
function onDocumentOpened(document) {
    if (document.fileName.includes('.notion')) {
        const pageId = notionService.getPageIdFromFile(document.fileName);
        if (pageId) {
            vscode.commands.executeCommand('setContext', 'notion.isNotionFile', true);
        }
    }
}
function deactivate() {
    webviewProvider?.dispose();
    vscode.commands.executeCommand('setContext', 'notion.enabled', false);
    vscode.commands.executeCommand('setContext', 'notion.isNotionFile', false);
}
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map