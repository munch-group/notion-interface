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
        vscode.commands.registerCommand('notion.generateAllFiles', generateAllFiles),

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

        // Tree dump commands
        vscode.commands.registerCommand('notion.dumpTree', dumpTreeAsMarkdown),
        vscode.commands.registerCommand('notion.dumpTreeWithProperties', dumpTreeWithPropertiesAsMarkdown),
        
        // Diagnostic command to find circular references
        vscode.commands.registerCommand('notion.findCircularReferences', findCircularReferences),
        
        // Export command to dump tree with content to JSON
        vscode.commands.registerCommand('notion.exportTreeToJson', exportTreeToJson),
        
        // Command to parse and analyze the exported JSON
        vscode.commands.registerCommand('notion.parseTreeJson', parseTreeJson),


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
            
            // Check if the file is already open in any editor
            const fileUri = vscode.Uri.file(filePath);
            const existingEditor = vscode.window.visibleTextEditors.find(editor => 
                editor.document.uri.fsPath === fileUri.fsPath
            );
            
            if (existingEditor) {
                // File is already open, just focus on it
                console.log('File already open, focusing on existing editor');
                await vscode.window.showTextDocument(existingEditor.document, existingEditor.viewColumn);
                vscode.window.showInformationMessage(`Focused on already open "${title}"`);
                return;
            }
            
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

async function generateAllFiles() {
    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Generating files for all Notion pages...",
            cancellable: false
        }, async (progress) => {
            // Get all pages from Notion
            console.log('=== GENERATING ALL FILES ===');
            const pages = await notionService.searchPages();
            console.log(`Found ${pages.length} pages to generate files for`);

            if (pages.length === 0) {
                vscode.window.showInformationMessage('No Notion pages found to generate files for');
                return;
            }

            let successCount = 0;
            let errorCount = 0;
            const errors: string[] = [];

            for (let i = 0; i < pages.length; i++) {
                const page = pages[i];
                
                progress.report({ 
                    message: `Processing ${page.title} (${i + 1} of ${pages.length})...`,
                    increment: (100 / pages.length)
                });

                try {
                    console.log(`Generating file for page: ${page.title} (${page.id})`);
                    
                    // Get page content from Notion
                    const result = await notionService.getPageContent(page.id);
                    const { title, content } = result;
                    
                    if (!title) {
                        console.warn(`Skipping page ${page.id} - no title found`);
                        continue;
                    }
                    
                    const safeContent = content || '';
                    
                    // Save to local .notion folder as .qmd file
                    const filePath = notionService.savePageLocally(page.id, title, safeContent);
                    console.log(`Generated file: ${filePath}`);
                    
                    successCount++;
                    
                } catch (error) {
                    errorCount++;
                    const shortTitle = page.title.length > 30 ? page.title.substring(0, 30) + '...' : page.title;
                    errors.push(`${shortTitle}: ${error}`);
                    console.error(`Failed to generate file for ${page.title}:`, error);
                }
            }

            // Show results
            if (successCount > 0 && errorCount === 0) {
                vscode.window.showInformationMessage(`Successfully generated ${successCount} file(s) in .notion/ folder!`);
            } else if (successCount > 0 && errorCount > 0) {
                vscode.window.showWarningMessage(`Generated ${successCount} file(s), but ${errorCount} failed. Check output for details.`);
                errors.forEach(error => console.error('Generation error:', error));
            } else {
                vscode.window.showErrorMessage(`Failed to generate all files. ${errorCount} errors occurred.`);
                errors.forEach(error => console.error('Generation error:', error));
            }
        });
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to generate files: ${error}`);
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

async function dumpTreeAsMarkdown() {
    try {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('Please open a file and place cursor where you want to insert the tree.');
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Generating tree markdown...",
            cancellable: false
        }, async (progress) => {
            // Get all pages and tree structure from the tree provider
            const pages = treeProvider.getAllPages();
            const pageTree = treeProvider.getPageTree();
            
            if (pages.length === 0) {
                vscode.window.showErrorMessage('No Notion pages loaded. Please refresh first.');
                return;
            }

            console.log(`Dumping tree with ${pages.length} total pages`);
            console.log('Page tree structure:', Array.from(pageTree.entries()).map(([parent, children]) => 
                `${parent}: ${children.length} children`
            ));

            const databaseId = '208fd1e7c2e180ee9aacc44071c02889';
            
            // Find root pages using the same logic as tree view
            const rootPages = pages.filter(page => {
                const isRootByParent = !page.parent || page.parent === databaseId || 
                                       !pages.find(p => p.id === page.parent);
                
                if (isRootByParent) {
                    return true;
                }
                
                // Only promote pages with children if their parent is NOT a natural root
                const hasChildren = pageTree.has(page.id);
                if (hasChildren && page.parent) {
                    const parentPage = pages.find(p => p.id === page.parent);
                    if (parentPage) {
                        const parentIsNaturalRoot = !parentPage.parent || parentPage.parent === databaseId || 
                                                    !pages.find(p => p.id === parentPage.parent);
                        // Only promote if parent is NOT a natural root
                        if (!parentIsNaturalRoot) {
                            return true;
                        }
                    }
                }
                
                return false;
            });

            console.log(`Found ${rootPages.length} root pages:`, rootPages.map(p => p.title));

            // Generate markdown recursively
            function generateMarkdownTree(pageList: any[], depth: number = 0, visited: Set<string> = new Set()): string {
                let markdown = '';
                const indent = '  '.repeat(depth);
                
                // Sort pages alphabetically
                pageList.sort((a, b) => a.title.localeCompare(b.title));
                
                for (const page of pageList) {
                    // Prevent infinite loops
                    if (visited.has(page.id)) {
                        console.log(`Skipping already visited page: ${page.title}`);
                        continue;
                    }
                    visited.add(page.id);
                    
                    // Add the page as a markdown list item
                    markdown += `${indent}- ${page.title}\n`;
                    
                    // Add children if they exist
                    const children = pageTree.get(page.id) || [];
                    if (children.length > 0) {
                        console.log(`Adding ${children.length} children for ${page.title}`);
                        markdown += generateMarkdownTree(children, depth + 1, new Set(visited));
                    }
                }
                
                return markdown;
            }

            // If we have no root pages but have all pages, just show all pages flat
            let markdownTree: string;
            if (rootPages.length === 0) {
                console.log('No root pages found, showing all pages flat');
                markdownTree = pages
                    .sort((a, b) => a.title.localeCompare(b.title))
                    .map(page => `- ${page.title}`)
                    .join('\n') + '\n';
            } else {
                markdownTree = generateMarkdownTree(rootPages);
            }

            if (!markdownTree.trim()) {
                vscode.window.showWarningMessage('No tree structure found to dump.');
                return;
            }

            // Insert at current cursor position
            const position = editor.selection.active;
            await editor.edit(editBuilder => {
                editBuilder.insert(position, markdownTree);
            });

            vscode.window.showInformationMessage(`Inserted tree with ${pages.length} pages at cursor position.`);
        });
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to dump tree: ${error}`);
    }
}

function cleanImageReferences(markdown: string): string {
    if (!markdown) return markdown;
    
    // Replace various image markdown patterns with "IMAGE"
    let cleaned = markdown;
    
    // Standard markdown images: ![alt text](url)
    cleaned = cleaned.replace(/!\[.*?\]\(.*?\)/g, 'IMAGE');
    
    // Image references: ![alt text][ref]
    cleaned = cleaned.replace(/!\[.*?\]\[.*?\]/g, 'IMAGE');
    
    // Direct image URLs (common patterns)
    cleaned = cleaned.replace(/https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|svg)(\?[^\s]*)?/gi, 'IMAGE');
    
    // Notion image blocks (if any slip through)
    cleaned = cleaned.replace(/```image\n.*?\n```/gs, 'IMAGE');
    
    // HTML img tags
    cleaned = cleaned.replace(/<img[^>]*>/gi, 'IMAGE');
    
    // Clean up multiple consecutive IMAGE words
    cleaned = cleaned.replace(/IMAGE(\s+IMAGE)+/g, 'IMAGE');
    
    return cleaned;
}

async function exportTreeToJson() {
    try {
        const pages = treeProvider.getAllPages();
        if (pages.length === 0) {
            vscode.window.showErrorMessage('No Notion pages loaded. Please refresh first.');
            return;
        }

        console.log('📊 Exporting tree with content to JSON...');
        
        // Get tree structure
        const pageTree = treeProvider.getPageTree();
        
        // Load all page content first
        console.log('📄 Loading page content...');
        const pagesWithContent = new Map<string, any>();
        let contentLoaded = 0;
        
        for (const page of pages) {
            try {
                // Get page content from NotionService
                let content = '';
                try {
                    const pageContent = await notionService.getPageContentForSearch(page.id, page.lastEdited, page.properties);
                    content = pageContent || '';
                } catch (error) {
                    console.warn(`Failed to load content for "${page.title}": ${error}`);
                    content = '[Content unavailable]';
                }

                // Clean up markdown content - replace images with "IMAGE"
                const cleanedContent = cleanImageReferences(content);
                
                pagesWithContent.set(page.id, {
                    id: page.id,
                    title: page.title,
                    markdown: cleanedContent,
                    type: page.properties?.Type?.select?.name || '',
                    parent: page.parent,
                    originalPage: page
                });
                
                contentLoaded++;
                if (contentLoaded % 10 === 0) {
                    console.log(`  Loaded content for ${contentLoaded}/${pages.length} pages...`);
                }
            } catch (error) {
                console.error(`Error processing page "${page.title}": ${error}`);
                const errorContent = cleanImageReferences('[Error loading content]');
                
                pagesWithContent.set(page.id, {
                    id: page.id,
                    title: page.title,
                    markdown: errorContent,
                    type: page.properties?.Type?.select?.name || '',
                    parent: page.parent,
                    originalPage: page
                });
            }
        }

        // Build nested tree structure
        console.log('🌳 Building nested tree structure...');
        
        function buildNestedPage(pageId: string, visited = new Set<string>()): any {
            // Cycle detection
            if (visited.has(pageId)) {
                console.warn(`Cycle detected at page ${pageId}, breaking recursion`);
                return null;
            }
            visited.add(pageId);
            
            const pageData = pagesWithContent.get(pageId);
            if (!pageData) {
                console.warn(`Page ${pageId} not found in loaded content`);
                return null;
            }
            
            // Get children from the page tree
            const childrenPages = pageTree.get(pageId) || [];
            const children: any[] = [];
            
            for (const childPage of childrenPages) {
                const nestedChild = buildNestedPage(childPage.id, new Set(visited));
                if (nestedChild) {
                    children.push(nestedChild);
                }
            }
            
            // Sort children by title for consistent ordering
            children.sort((a, b) => a.title.localeCompare(b.title));
            
            visited.delete(pageId);
            
            return {
                title: pageData.title,
                markdown: pageData.markdown,
                type: pageData.type,
                children: children
            };
        }
        
        // Find root pages (pages with no parent or parent not in our dataset)
        const allPageIds = new Set(pages.map(p => p.id));
        const rootPageIds = pages
            .filter(page => !page.parent || !allPageIds.has(page.parent))
            .map(page => page.id);
            
        console.log(`📌 Found ${rootPageIds.length} root pages`);
        
        // Build the nested structure starting from roots
        const exportData: any[] = [];
        for (const rootId of rootPageIds) {
            const rootPage = buildNestedPage(rootId);
            if (rootPage) {
                exportData.push(rootPage);
            }
        }
        
        // Sort root pages by title
        exportData.sort((a, b) => a.title.localeCompare(b.title));

        // Write to JSON file in workspace
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open. Cannot save JSON file.');
            return;
        }

        const jsonPath = vscode.Uri.joinPath(workspaceFolder.uri, 'notion_tree.json');
        const jsonContent = JSON.stringify(exportData, null, 2);
        
        await vscode.workspace.fs.writeFile(jsonPath, Buffer.from(jsonContent, 'utf8'));
        
        console.log('✅ Export completed');
        console.log(`📊 Exported ${exportData.length} root pages with full hierarchy`);
        
        vscode.window.showInformationMessage(
            `Exported ${exportData.length} root pages (${pages.length} total) with nested hierarchy to notion_tree.json`,
            'Open File'
        ).then(selection => {
            if (selection === 'Open File') {
                vscode.window.showTextDocument(jsonPath);
            }
        });

    } catch (error) {
        console.error('Export failed:', error);
        vscode.window.showErrorMessage(`Failed to export tree: ${error}`);
    }
}

async function parseTreeJson() {
    try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open.');
            return;
        }

        const jsonPath = vscode.Uri.joinPath(workspaceFolder.uri, 'notion_tree.json');
        
        // Check if file exists
        try {
            await vscode.workspace.fs.stat(jsonPath);
        } catch {
            vscode.window.showErrorMessage('notion_tree.json not found. Export the tree first.');
            return;
        }

        console.log('📖 Parsing notion_tree.json...');
        
        // Read and parse the JSON file
        const jsonContent = await vscode.workspace.fs.readFile(jsonPath);
        const jsonString = Buffer.from(jsonContent).toString('utf8');
        const treeData = JSON.parse(jsonString);
        
        console.log('✅ Successfully parsed JSON file');
        
        // Analyze the parsed data
        let totalPages = 0;
        let maxDepth = 0;
        const typeCount = new Map<string, number>();
        
        function analyzeNode(node: any, depth = 0): void {
            totalPages++;
            maxDepth = Math.max(maxDepth, depth);
            
            // Count types
            const type = node.type || 'Unknown';
            typeCount.set(type, (typeCount.get(type) || 0) + 1);
            
            // Show some sample content
            if (totalPages <= 3) {
                console.log(`📄 Sample page: "${node.title}"`);
                console.log(`   Type: ${type}`);
                console.log(`   Content preview: ${node.markdown.substring(0, 100)}${node.markdown.length > 100 ? '...' : ''}`);
                console.log(`   Children: ${node.children.length}`);
                console.log('');
            }
            
            // Recursively analyze children
            for (const child of node.children) {
                analyzeNode(child, depth + 1);
            }
        }
        
        // Analyze all root pages
        for (const rootPage of treeData) {
            analyzeNode(rootPage);
        }
        
        // Generate analysis report
        const report = [
            '=== NOTION TREE JSON ANALYSIS ===',
            '',
            `📊 Total pages parsed: ${totalPages}`,
            `🌳 Root pages: ${treeData.length}`,
            `📏 Maximum depth: ${maxDepth}`,
            '',
            '📈 Page types distribution:',
            ...Array.from(typeCount.entries())
                .sort(([,a], [,b]) => b - a)
                .map(([type, count]) => `   ${type}: ${count} pages`),
            '',
            '✅ JSON parsing successful - all content accessible!'
        ].join('\n');
        
        console.log(report);
        
        // Show results to user
        const outputChannel = vscode.window.createOutputChannel('Notion JSON Analysis');
        outputChannel.clear();
        outputChannel.appendLine(report);
        outputChannel.show();
        
        vscode.window.showInformationMessage(
            `Parsed ${totalPages} pages from notion_tree.json successfully!`,
            'Show Analysis'
        ).then(selection => {
            if (selection === 'Show Analysis') {
                outputChannel.show();
            }
        });

    } catch (error) {
        console.error('Failed to parse JSON:', error);
        vscode.window.showErrorMessage(`Failed to parse notion_tree.json: ${error}`);
    }
}

async function findCircularReferences() {
    try {
        console.log('=== ANALYZING CIRCULAR REFERENCES ===');
        const pages = treeProvider.getAllPages();
        console.log(`Found ${pages.length} pages to analyze`);
        
        // Debug: Look for specific problematic page IDs from previous logs
        // Note: Using page IDs instead of titles to handle duplicate names correctly
        const notesOnMDId = "your-notes-on-md-page-id"; // Replace with actual ID if needed
        const whatRolesId = "your-what-roles-page-id";   // Replace with actual ID if needed
        
        const notesOnMD = pages.find(p => p.id === notesOnMDId);
        const whatRoles = pages.find(p => p.id === whatRolesId);
        
        // Check for duplicate page IDs
        const pageIds = pages.map(p => p.id);
        const uniqueIds = new Set(pageIds);
        
        console.log(`Total pages: ${pages.length}, Unique IDs: ${uniqueIds.size}`);
        
        if (pageIds.length !== uniqueIds.size) {
            console.error('⚠️  DUPLICATE PAGE IDs FOUND!');
            
            // Find and report duplicates
            const duplicates: Map<string, string[]> = new Map();
            pages.forEach(page => {
                const existing = duplicates.get(page.id) || [];
                existing.push(page.title);
                duplicates.set(page.id, existing);
            });
            
            // Show only the actual duplicates
            const actualDuplicates = Array.from(duplicates.entries()).filter(([id, titles]) => titles.length > 1);
            
            console.error('Duplicate page IDs:');
            actualDuplicates.forEach(([id, titles]) => {
                console.error(`   ID: ${id} appears ${titles.length} times:`);
                titles.forEach(title => console.error(`      - "${title}"`));
            });
            
            vscode.window.showErrorMessage(`Found ${actualDuplicates.length} duplicate page IDs! This will cause tree structure issues. Check console for details.`);
            return;
        } else {
            console.log('✅ All page IDs are unique');
        }
        
        if (pages.length === 0) {
            console.log('No pages loaded, showing error message');
            vscode.window.showErrorMessage('No Notion pages loaded. Please refresh first.');
            return;
        }
        
        const circularRefs: Array<{pageA: string, pageB: string, pageAId: string, pageBId: string}> = [];
        const selfRefs: Array<{page: string, pageId: string}> = [];
        
        // Check for self-references (page is its own parent)
        console.log('Checking for self-references...');
        pages.forEach(page => {
            if (page.parent === page.id) {
                console.log(`Found self-reference: ${page.title}`);
                selfRefs.push({
                    page: page.title,
                    pageId: page.id
                });
            }
        });
        console.log(`Found ${selfRefs.length} self-references`);
        
        // Check for mutual parent relationships (A->B->A)
        console.log('Checking for mutual parent cycles...');
        for (let i = 0; i < pages.length; i++) {
            const pageA = pages[i];
            if (!pageA.parent) continue;
            
            const pageB = pages.find(p => p.id === pageA.parent);
            if (!pageB || !pageB.parent) continue;
            
            // Check if B's parent is A (creating a cycle)
            if (pageB.parent === pageA.id) {
                console.log(`Found potential cycle: "${pageA.title}" <-> "${pageB.title}"`);
                
                // Avoid duplicates by checking if we already found this pair
                const alreadyFound = circularRefs.some(ref => 
                    (ref.pageAId === pageA.id && ref.pageBId === pageB.id) ||
                    (ref.pageAId === pageB.id && ref.pageBId === pageA.id)
                );
                
                if (!alreadyFound) {
                    console.log(`Adding cycle to results: "${pageA.title}" <-> "${pageB.title}"`);
                    circularRefs.push({
                        pageA: pageA.title,
                        pageB: pageB.title,
                        pageAId: pageA.id,
                        pageBId: pageB.id
                    });
                }
            }
        }
        console.log(`Found ${circularRefs.length} mutual parent cycles`);
        
        // Report findings
        console.log('Generating report...');
        let report = '=== CIRCULAR REFERENCE ANALYSIS ===\n\n';
        
        if (selfRefs.length === 0 && circularRefs.length === 0) {
            console.log('No circular references found');
            report += '✅ No circular references found!\n';
            vscode.window.showInformationMessage('No circular references found in your Notion pages.');
        } else {
            console.log(`Found issues: ${selfRefs.length} self-refs, ${circularRefs.length} cycles`);
            if (selfRefs.length > 0) {
                report += `⚠️  ${selfRefs.length} SELF-REFERENCES FOUND:\n`;
                selfRefs.forEach(ref => {
                    report += `   • "${ref.page}" (ID: ${ref.pageId}) is its own parent\n`;
                });
                report += '\n';
            }
            
            if (circularRefs.length > 0) {
                report += `⚠️  ${circularRefs.length} MUTUAL PARENT CYCLES FOUND:\n`;
                circularRefs.forEach(ref => {
                    report += `   • "${ref.pageA}" ↔ "${ref.pageB}"\n`;
                    report += `     - "${ref.pageA}" has parent "${ref.pageB}"\n`;
                    report += `     - "${ref.pageB}" has parent "${ref.pageA}"\n`;
                    report += `     - IDs: ${ref.pageAId} ↔ ${ref.pageBId}\n\n`;
                });
            }
            
            report += 'FIX: Go to your Notion database and correct the "Parent Goal" properties for these pages.\n';
            report += 'Each page should have only ONE parent, and no page should be its own ancestor.\n';
            
            console.log(report);
            
            // Show in output channel for easy copying
            const outputChannel = vscode.window.createOutputChannel('Notion Circular References');
            outputChannel.clear();
            outputChannel.appendLine(report);
            outputChannel.show();
            
            const totalIssues = selfRefs.length + circularRefs.length;
            vscode.window.showWarningMessage(
                `Found ${totalIssues} circular reference(s) in your Notion pages. Check the output panel for details.`,
                'Show Details'
            ).then(selection => {
                if (selection === 'Show Details') {
                    outputChannel.show();
                }
            });
        }
        
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to analyze circular references: ${error}`);
    }
}

async function dumpTreeWithPropertiesAsMarkdown() {
    try {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('Please open a file and place cursor where you want to insert the tree.');
            return;
        }

        // Get all pages first to determine available properties
        const pages = treeProvider.getAllPages();
        if (pages.length === 0) {
            vscode.window.showErrorMessage('No Notion pages loaded. Please refresh first.');
            return;
        }

        // Collect all unique property names from all pages
        const allPropertyNames = new Set<string>();
        pages.forEach(page => {
            if (page.properties) {
                Object.keys(page.properties).forEach(key => allPropertyNames.add(key));
            }
        });

        const availableProperties = Array.from(allPropertyNames).sort();
        console.log('Available properties:', availableProperties);

        // Prompt user for property names to include
        const propertyInput = await vscode.window.showInputBox({
            prompt: 'Enter property names to include (comma-separated, case-insensitive). Leave empty to include all properties.',
            placeHolder: `Available: ${availableProperties.join(', ')}`,
            value: '', // Empty by default
            ignoreFocusOut: true
        });

        if (propertyInput === undefined) {
            return; // User cancelled
        }

        // Handle empty input - include all properties
        let propertyMapping = new Map<string, string>();
        
        if (!propertyInput || propertyInput.trim() === '') {
            // Empty input: include all available properties
            console.log('Empty input - including all properties');
            availableProperties.forEach(prop => {
                propertyMapping.set(prop.toLowerCase(), prop);
            });
        } else {
            // Parse the input and create case-insensitive mapping
            const requestedProperties = propertyInput
                .split(',')
                .map(prop => prop.trim()) // Strip flanking whitespace
                .filter(prop => prop.length > 0);

            if (requestedProperties.length === 0) {
                vscode.window.showErrorMessage('No valid property names provided.');
                return;
            }

            // Create case-insensitive mapping from requested properties to actual property names
            requestedProperties.forEach(requested => {
                const actualProperty = availableProperties.find(actual => 
                    actual.toLowerCase() === requested.toLowerCase()
                );
                if (actualProperty) {
                    propertyMapping.set(requested.toLowerCase(), actualProperty);
                } else {
                    console.warn(`Property "${requested}" not found in available properties`);
                }
            });

            if (propertyMapping.size === 0) {
                vscode.window.showErrorMessage('None of the requested properties were found. Available properties: ' + availableProperties.join(', '));
                return;
            }
        }

        console.log('Property mapping:', Array.from(propertyMapping.entries()));

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Generating tree with selected properties...",
            cancellable: false
        }, async (progress) => {
            const pageTree = treeProvider.getPageTree();
            const databaseId = '208fd1e7c2e180ee9aacc44071c02889';
            
            // Find root pages using the same logic as tree view
            const rootPages = pages.filter(page => {
                const isRootByParent = !page.parent || page.parent === databaseId || 
                                       !pages.find(p => p.id === page.parent);
                
                if (isRootByParent) {
                    return true;
                }
                
                // Only promote pages with children if their parent is NOT a natural root
                const hasChildren = pageTree.has(page.id);
                if (hasChildren && page.parent) {
                    const parentPage = pages.find(p => p.id === page.parent);
                    if (parentPage) {
                        const parentIsNaturalRoot = !parentPage.parent || parentPage.parent === databaseId || 
                                                    !pages.find(p => p.id === parentPage.parent);
                        // Only promote if parent is NOT a natural root
                        if (!parentIsNaturalRoot) {
                            return true;
                        }
                    }
                }
                
                return false;
            });

            // Helper function to format only the selected properties
            function formatSelectedProperties(properties: any): string[] {
                if (!properties) return [];
                
                const propertyStrings: string[] = [];
                
                // Only include properties that were requested
                propertyMapping.forEach((actualPropertyName, requestedLowerCase) => {
                    const value = properties[actualPropertyName];
                    
                    if (Array.isArray(value) && value.length > 0) {
                        // For arrays, show as "Key: item1, item2"
                        const arrayValue = value.join(', ');
                        propertyStrings.push(`${actualPropertyName}: ${arrayValue}`);
                    } else if (value && typeof value === 'string' && value.trim()) {
                        propertyStrings.push(`${actualPropertyName}: ${value}`);
                    } else if (value && typeof value !== 'object' && value !== null) {
                        propertyStrings.push(`${actualPropertyName}: ${String(value)}`);
                    }
                });
                
                return propertyStrings;
            }

            // Generate markdown recursively with selected properties
            function generateMarkdownTreeWithProperties(pageList: any[], depth: number = 0, visited: Set<string> = new Set()): string {
                let markdown = '';
                const indent = '  '.repeat(depth);
                
                // Sort pages alphabetically
                pageList.sort((a, b) => a.title.localeCompare(b.title));
                
                for (const page of pageList) {
                    // Prevent infinite loops
                    if (visited.has(page.id)) {
                        console.log(`Skipping already visited page: ${page.title}`);
                        continue;
                    }
                    visited.add(page.id);
                    
                    // Format selected properties
                    const properties = formatSelectedProperties(page.properties);
                    const propertiesString = properties.length > 0 ? ` [${properties.join(', ')}]` : '';
                    
                    // Add the page as a markdown list item with properties
                    markdown += `${indent}- ${page.title}${propertiesString}\n`;
                    
                    // Add children if they exist
                    const children = pageTree.get(page.id) || [];
                    if (children.length > 0) {
                        console.log(`Adding ${children.length} children for ${page.title}`);
                        markdown += generateMarkdownTreeWithProperties(children, depth + 1, new Set(visited));
                    }
                }
                
                return markdown;
            }

            // If we have no root pages but have all pages, just show all pages flat
            let markdownTree: string;
            if (rootPages.length === 0) {
                console.log('No root pages found, showing all pages flat with selected properties');
                markdownTree = pages
                    .sort((a, b) => a.title.localeCompare(b.title))
                    .map(page => {
                        const properties = formatSelectedProperties(page.properties);
                        const propertiesString = properties.length > 0 ? ` [${properties.join(', ')}]` : '';
                        return `- ${page.title}${propertiesString}`;
                    })
                    .join('\n') + '\n';
            } else {
                markdownTree = generateMarkdownTreeWithProperties(rootPages);
            }

            if (!markdownTree.trim()) {
                vscode.window.showWarningMessage('No tree structure found to dump.');
                return;
            }

            // Insert at current cursor position
            const position = editor.selection.active;
            await editor.edit(editBuilder => {
                editBuilder.insert(position, markdownTree);
            });

            const selectedProps = Array.from(propertyMapping.values()).join(', ');
            vscode.window.showInformationMessage(`Inserted tree with properties [${selectedProps}] for ${pages.length} pages at cursor position.`);
        });
    } catch (error) {
        vscode.window.showErrorMessage(`Failed to dump tree with properties: ${error}`);
    }
}

export function deactivate() {
    vscode.commands.executeCommand('setContext', 'notion.enabled', false);
    vscode.commands.executeCommand('setContext', 'notion.isNotionFile', false);
}