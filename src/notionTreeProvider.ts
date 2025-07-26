import * as vscode from 'vscode';
import { NotionService, NotionPage } from './notionService';

export type ViewMode = 'flat' | 'tree';

export class NotionTreeProvider implements vscode.TreeDataProvider<NotionPageItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<NotionPageItem | undefined | null | void> = new vscode.EventEmitter<NotionPageItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<NotionPageItem | undefined | null | void> = this._onDidChangeTreeData.event;

    private pages: NotionPage[] = [];
    private filteredPages: NotionPage[] = [];
    private pageTree: Map<string, NotionPage[]> = new Map();
    private viewMode: ViewMode = 'flat';
    private searchQuery: string = '';
    private visitedNodes: Set<string> = new Set();

    constructor(private notionService: NotionService) {
        // Listen for configuration changes
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('notion.viewMode')) {
                this.updateViewMode();
            }
        });
        this.updateViewMode();
    }

    private updateViewMode(): void {
        const config = vscode.workspace.getConfiguration('notion');
        const newMode = config.get<ViewMode>('viewMode', 'flat');
        if (newMode !== this.viewMode) {
            this.viewMode = newMode;
            vscode.commands.executeCommand('setContext', 'notion.viewMode', newMode);
            this._onDidChangeTreeData.fire();
        }
    }

    async refresh(): Promise<void> {
        try {
            console.log('Refreshing Notion pages...');
            vscode.commands.executeCommand('setContext', 'notion.loading', true);
            
            this.pages = await this.notionService.searchPages();
            console.log(`Loaded ${this.pages.length} pages from Notion`);
            this.applyFilter();
            this.buildPageTree();
            
            vscode.commands.executeCommand('setContext', 'notion.loading', false);
            vscode.commands.executeCommand('setContext', 'notion.pageCount', this.filteredPages.length);
            this._onDidChangeTreeData.fire();
        } catch (error) {
            console.error('Failed to load Notion pages:', error);
            vscode.commands.executeCommand('setContext', 'notion.loading', false);
            vscode.commands.executeCommand('setContext', 'notion.pageCount', 0);
            vscode.window.showErrorMessage(`Failed to load Notion pages: ${error}`);
            this.pages = [];
            this.filteredPages = [];
            this.pageTree.clear();
            this._onDidChangeTreeData.fire();
        }
    }

    setViewMode(mode: ViewMode): void {
        const config = vscode.workspace.getConfiguration('notion');
        config.update('viewMode', mode, vscode.ConfigurationTarget.Global);
        this.viewMode = mode;
        vscode.commands.executeCommand('setContext', 'notion.viewMode', mode);
        this._onDidChangeTreeData.fire();
        
        if (mode === 'tree') {
            vscode.window.showInformationMessage(`Switched to tree view (Note: search is disabled in tree view due to complexity)`);
        } else {
            vscode.window.showInformationMessage(`Switched to ${mode} view`);
        }
    }

    async searchPages(query: string): Promise<void> {
        this.searchQuery = query.toLowerCase();
        this.applyFilter();
        this.buildPageTree();
        this._onDidChangeTreeData.fire();
    }

    private applyFilter(): void {
        if (!this.searchQuery) {
            this.filteredPages = [...this.pages];
        } else {
            // More comprehensive search - split query into words and search for any of them
            const searchTerms = this.searchQuery.split(/\s+/).filter(term => term.length > 0);
            
            this.filteredPages = this.pages.filter(page => {
                const titleLower = page.title.toLowerCase();
                
                // Check if any search term matches
                return searchTerms.some(term => titleLower.includes(term));
            });
            
            console.log(`Search for "${this.searchQuery}" found ${this.filteredPages.length} results out of ${this.pages.length} total pages`);
        }
    }

    getTreeItem(element: NotionPageItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: NotionPageItem): Promise<NotionPageItem[]> {
        console.log('getChildren called, element:', element ? element.page.title : 'root');
        
        if (!element) {
            // Root level - reset visited nodes for new traversal
            this.visitedNodes.clear();
            
            if (this.filteredPages.length === 0) {
                console.log('No filtered pages, calling refresh...');
                await this.refresh();
                if (this.filteredPages.length === 0) {
                    console.log('Still no pages after refresh');
                    return [];
                }
            }
            
            console.log(`Returning ${this.filteredPages.length} pages in ${this.viewMode} mode`);
            
            let result;
            if (this.viewMode === 'flat') {
                result = this.getFlatView();
            } else {
                result = this.getTreeView();
            }
            
            console.log(`getChildren returning ${result.length} items to VS Code`);
            return result;
        } else {
            // Child pages in tree view
            if (this.viewMode === 'tree' && element.page) {
                // Prevent infinite recursion by tracking visited nodes
                if (this.visitedNodes.has(element.page.id)) {
                    console.warn(`Cycle detected: Already visited "${element.page.title}" (${element.page.id}), returning empty children`);
                    return [];
                }
                
                this.visitedNodes.add(element.page.id);
                
                console.log(`Getting children for page "${element.page.title}" with ID: ${element.page.id}`);
                console.log('Available parent IDs in pageTree:', Array.from(this.pageTree.keys()));
                
                const children = this.pageTree.get(element.page.id) || [];
                console.log(`Found ${children.length} children for ${element.page.title}`);
                
                if (children.length > 0) {
                    console.log('Child titles:', children.map(child => child.title));
                }
                
                return children
                    .sort((a, b) => a.title.localeCompare(b.title))
                    .map(page => new NotionPageItem(page, this.hasChildren(page.id)));
            }
        }
        
        return [];
    }

    private getFlatView(): NotionPageItem[] {
        return this.filteredPages
            .sort((a, b) => b.lastEdited.getTime() - a.lastEdited.getTime())
            .map(page => new NotionPageItem(page, false));
    }

    private getTreeView(): NotionPageItem[] {
        // For database pages, treat pages whose parent is the database as root-level
        const databaseId = '208fd1e7c2e180ee9aacc44071c02889';
        
        const rootPages = this.filteredPages.filter(page => {
            // Root pages are those whose parent is the database itself, or have no parent,
            // OR whose parent is not in our filtered pages (external parent)
            const isRootByParent = !page.parent || page.parent === databaseId || 
                                   !this.filteredPages.find(p => p.id === page.parent);
            
            // ALSO include any page that has children (should be shown as expandable)
            const hasChildren = this.pageTree.has(page.id);
            
            return isRootByParent || hasChildren;
        });

        console.log(`Tree view: Found ${rootPages.length} root pages out of ${this.filteredPages.length} total pages`);
        console.log('Root page IDs:', rootPages.map(p => p.id));
        console.log('Pages with children (should be in root):', Array.from(this.pageTree.keys()));
        
        return rootPages
            .sort((a, b) => a.title.localeCompare(b.title))
            .map(page => {
                const hasChildren = this.hasChildren(page.id);
                return new NotionPageItem(page, hasChildren);
            });
    }

    private hasChildren(pageId: string): boolean {
        const children = this.pageTree.get(pageId) || [];
        const result = children.length > 0;
        if (result) {
            console.log(`  hasChildren(${pageId}): ${result} (${children.length} children)`);
        }
        return result;
    }

    private buildPageTree(): void {
        this.pageTree.clear();
        
        console.log('Building page tree from', this.filteredPages.length, 'pages');
        
        // First pass: collect all page IDs to detect cycles
        const allPageIds = new Set(this.filteredPages.map(p => p.id));
        
        // Group pages by their parent, but avoid cycles
        for (const page of this.filteredPages) {
            console.log(`Page "${page.title}" has parent:`, page.parent);
            if (page.parent && allPageIds.has(page.parent)) {
                // Check for direct cycle (page being its own parent)
                if (page.parent === page.id) {
                    console.warn(`Cycle detected: Page "${page.title}" is its own parent, skipping`);
                    continue;
                }
                
                // Check for simple 2-node cycle (A->B->A)
                const parentPage = this.filteredPages.find(p => p.id === page.parent);
                if (parentPage && parentPage.parent === page.id) {
                    console.warn(`Cycle detected: "${page.title}" and "${parentPage.title}" are mutual parents, skipping child relationship`);
                    continue;
                }
                
                if (!this.pageTree.has(page.parent)) {
                    this.pageTree.set(page.parent, []);
                }
                this.pageTree.get(page.parent)!.push(page);
                console.log(`Added "${page.title}" as child of ${page.parent}`);
            }
        }
        
        console.log('Page tree built:', Array.from(this.pageTree.entries()).map(([parent, children]) => 
            `${parent}: ${children.length} children`
        ));
    }

    getPageById(pageId: string): NotionPage | undefined {
        return this.pages.find(page => page.id === pageId);
    }

    getParent(element: NotionPageItem): vscode.ProviderResult<NotionPageItem> {
        if (!element.page.parent) {
            return null;
        }
        
        const parentPage = this.getPageById(element.page.parent);
        if (!parentPage) {
            return null;
        }
        
        const hasChildren = this.hasChildren(parentPage.id);
        return new NotionPageItem(parentPage, hasChildren);
    }

}

export class NotionPageItem extends vscode.TreeItem {
    constructor(
        public readonly page: NotionPage,
        hasChildren: boolean
    ) {
        super(
            page.title,
            hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
        );
        
        // Remove verbose logging to reduce noise
        // if (hasChildren) {
        //     console.log(`*** NotionPageItem PARENT created: "${page.title}", hasChildren: ${hasChildren}, collapsibleState: ${this.collapsibleState}`);
        // }
        
        this.tooltip = `${page.title}\nLast edited: ${page.lastEdited.toLocaleDateString()}\nID: ${page.id}`;
        this.contextValue = 'notionPage';
        // Use file icons for both files and folders for better alignment
        try {
            this.iconPath = new vscode.ThemeIcon('file');
            console.log(`Set icon for "${page.title}": file`);
        } catch (error) {
            console.error(`Error setting icon for "${page.title}":`, error);
            // Fallback to no icon
            this.iconPath = undefined;
        }
        
        // Only add command to pages without children (leaf nodes)
        if (!hasChildren) {
            this.command = {
                command: 'notion.openPage',
                title: 'Open Page',
                arguments: [page.id]
            };
        } else {
            console.log(`Not adding command to parent page: ${page.title}`);
        }

        // Add description with last edited date
        this.description = page.lastEdited.toLocaleDateString();
    }
}