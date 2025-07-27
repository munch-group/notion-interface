import * as vscode from 'vscode';
import * as path from 'path';
import { NotionService } from './notionService';
import { NotionTreeProvider } from './notionTreeProvider';
let notionService: NotionService;
let treeProvider: NotionTreeProvider;
let globalContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext) {
    globalContext = context;
    console.log('Notion Interface extension is now active!');

    // Initialize services
    notionService = new NotionService();
    treeProvider = new NotionTreeProvider(notionService);
    
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
        vscode.commands.registerCommand('notion.uploadAllChanges', uploadAllChanges),

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
            const firstPage = treeProvider.getPageById('test') || (treeProvider as any).pages?.[0];
            if (firstPage) {
                vscode.window.showInformationMessage(`First page: "${firstPage.title}", Properties: ${JSON.stringify(firstPage.properties)}`);
                console.log('First page full data:', firstPage);
            } else {
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
    const apiKey = config.get<string>('apiKey');
    vscode.commands.executeCommand('setContext', 'notion.hasApiKey', !!apiKey);
    vscode.commands.executeCommand('setContext', 'notion.loading', false);
    vscode.commands.executeCommand('setContext', 'notion.pageCount', 0);

    // Load pages on startup if API key is configured
    if (apiKey) {
        treeProvider.refresh();
    }
}

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
    } else {
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
        } else {
            vscode.window.showInformationMessage('Showing all pages');
        }
    }
}

async function openPage(pageIdOrItem: string | any) {
    console.log('openPage command called with:', pageIdOrItem);
    try {
        // Handle both direct pageId string and tree item object
        let pageId: string;
        if (typeof pageIdOrItem === 'string') {
            pageId = pageIdOrItem;
            console.log('Using pageId as string:', pageId);
        } else if (pageIdOrItem && pageIdOrItem.page && pageIdOrItem.page.id) {
            pageId = pageIdOrItem.page.id;
            console.log('Using pageId from .page.id:', pageId);
        } else if (pageIdOrItem && pageIdOrItem.id) {
            pageId = pageIdOrItem.id;
            console.log('Using pageId from .id:', pageId);
        } else {
            console.error('Invalid page ID provided:', pageIdOrItem);
            throw new Error('Invalid page ID provided');
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Loading Notion page...",
            cancellable: false
        }, async (progress) => {
            // Get page content as markdown
            console.log('=== OPENING PAGE ===', pageId);
            const result = await notionService.getPageContent(pageId);
            console.log('=== getPageContent result ===', result);
            
            const { title, content } = result;
            console.log('Extracted title:', title, 'content length:', content?.length);
            
            if (!title) {
                throw new Error('Failed to extract page title');
            }
            
            const safeContent = content || '';
            
            // Save to local .notion folder as .qmd file
            const filePath = notionService.savePageLocally(pageId, title, safeContent);
            
            // Open the .qmd file with Quarto's visual editor
            const document = await vscode.workspace.openTextDocument(filePath);
            
            // First open the document in the regular editor
            await vscode.window.showTextDocument(document);
            
            // Then switch to Quarto visual mode
            try {
                await vscode.commands.executeCommand('quarto.editInVisualMode');
            } catch (quartoError) {
                console.log('Quarto visual editor not available:', quartoError);
                vscode.window.showWarningMessage('Quarto extension not available. Install the Quarto extension to use visual editing mode.');
            }
            
            vscode.window.showInformationMessage(`Opened "${title}" from Notion in visual editor`);
        });
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to open page: ${error}`);
    }
}

async function uploadChanges() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showWarningMessage('No active editor found');
        return;
    }

    const content = editor.document.getText();
    const parsed = notionService.parseQuartoFile(content);
    
    if (!parsed.pageId) {
        vscode.window.showWarningMessage('This file is not linked to a Notion page');
        return;
    }

    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Uploading changes to Notion...",
            cancellable: false
        }, async (progress) => {
            await notionService.updatePageContent(parsed.pageId!, parsed.content);
            vscode.window.showInformationMessage('Changes uploaded to Notion successfully!');
        });
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to upload changes: ${error}`);
    }
}

async function uploadAllChanges() {
    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Uploading all Notion files...",
            cancellable: false
        }, async (progress) => {
            // Get all .qmd files in the .notion folder
            const notionFiles = await vscode.workspace.findFiles('**/.notion/**/*.qmd');
            
            if (notionFiles.length === 0) {
                vscode.window.showInformationMessage('No Notion files found to upload');
                return;
            }

            let uploadedCount = 0;
            let errorCount = 0;
            const errors: string[] = [];

            for (let i = 0; i < notionFiles.length; i++) {
                const fileUri = notionFiles[i];
                const fileName = fileUri.fsPath;
                
                progress.report({ 
                    message: `Uploading file ${i + 1} of ${notionFiles.length}...`,
                    increment: (100 / notionFiles.length)
                });

                try {
                    // Read file content
                    const document = await vscode.workspace.openTextDocument(fileUri);
                    const content = document.getText();
                    
                    // Parse Quarto file
                    const parsed = notionService.parseQuartoFile(content);
                    
                    if (!parsed.pageId) {
                        console.warn(`Skipping file ${fileName} - no page ID found`);
                        continue;
                    }

                    // Upload to Notion
                    await notionService.updatePageContent(parsed.pageId, parsed.content);
                    uploadedCount++;
                    
                } catch (error) {
                    errorCount++;
                    const shortFileName = fileName.split('/').pop() || fileName;
                    errors.push(`${shortFileName}: ${error}`);
                    console.error(`Failed to upload ${fileName}:`, error);
                }
            }

            // Show results
            if (uploadedCount > 0 && errorCount === 0) {
                vscode.window.showInformationMessage(`Successfully uploaded ${uploadedCount} file(s) to Notion!`);
            } else if (uploadedCount > 0 && errorCount > 0) {
                vscode.window.showWarningMessage(`Uploaded ${uploadedCount} file(s), but ${errorCount} failed. Check output for details.`);
                errors.forEach(error => console.error('Upload error:', error));
            } else {
                vscode.window.showErrorMessage(`Failed to upload all files. ${errorCount} errors occurred.`);
                errors.forEach(error => console.error('Upload error:', error));
            }
        });
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to upload files: ${error}`);
    }
}

async function onDocumentSaved(document: vscode.TextDocument) {
    if (!document.fileName.includes('.notion') || !document.fileName.endsWith('.qmd')) {
        return;
    }

    const content = document.getText();
    const parsed = notionService.parseQuartoFile(content);
    
    if (!parsed.pageId) {
        return;
    }

    const config = vscode.workspace.getConfiguration('notion');
    const autoSync = config.get<boolean>('autoSync', true); // Default to true
    
    if (autoSync) {
        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Auto-syncing to Notion...",
                cancellable: false
            }, async (progress) => {
                await notionService.updatePageContent(parsed.pageId!, parsed.content);
                vscode.window.showInformationMessage('✓ Auto-synced to Notion', { modal: false });
            });
        } catch (error) {
            vscode.window.showWarningMessage(`Auto-sync failed: ${error}. Use manual upload if needed.`);
        }
    }
}

function onDocumentOpened(document: vscode.TextDocument) {
    if (document.fileName.includes('.notion') && document.fileName.endsWith('.qmd')) {
        const pageId = notionService.getPageIdFromFile(document.fileName);
        if (pageId) {
            vscode.commands.executeCommand('setContext', 'notion.isNotionFile', true);
        }
    }
}

export function deactivate() {
    vscode.commands.executeCommand('setContext', 'notion.enabled', false);
    vscode.commands.executeCommand('setContext', 'notion.isNotionFile', false);
}