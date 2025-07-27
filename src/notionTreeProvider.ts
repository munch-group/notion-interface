import * as vscode from 'vscode';
import { NotionService, NotionPage } from './notionService';

const Fuse = require('fuse.js');

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
    private cachingInProgress: boolean = false;

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
            console.log('=== REFRESHING NOTION PAGES ===');
            vscode.commands.executeCommand('setContext', 'notion.loading', true);
            
            // Force fresh data by clearing any cached pages first
            this.pages = [];
            this.filteredPages = [];
            
            this.pages = await this.notionService.searchPages();
            console.log(`Loaded ${this.pages.length} pages from Notion`);
            console.log(`REFRESH DEBUG: First page properties:`, this.pages[0]?.properties);
            
            // Load cached content immediately for instant search
            this.notionService.loadCachedContentForPages(this.pages);
            
            await this.applyFilter();
            this.buildPageTree();
            
            vscode.commands.executeCommand('setContext', 'notion.loading', false);
            vscode.commands.executeCommand('setContext', 'notion.pageCount', this.filteredPages.length);
            this._onDidChangeTreeData.fire();
            
            // Start background caching after pages are loaded and UI is updated
            this.startBackgroundCaching();
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

    private startBackgroundCaching(): void {
        if (this.cachingInProgress || this.pages.length === 0) {
            return;
        }

        this.cachingInProgress = true;
        
        // Start caching in background with progress notification
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Caching page content for faster search...",
            cancellable: false
        }, async (progress) => {
            try {
                await this.notionService.cacheAllPageContent(
                    this.pages,
                    (loaded, total) => {
                        const percentage = Math.round((loaded / total) * 100);
                        progress.report({ 
                            message: `${loaded}/${total} pages cached`,
                            increment: percentage / total 
                        });
                    }
                );
                
                vscode.window.showInformationMessage(
                    `✓ Content cached for ${this.pages.length} pages. Search is now faster!`,
                    { modal: false }
                );
            } catch (error) {
                console.error('Background caching failed:', error);
                vscode.window.showWarningMessage('Background content caching failed. Search may be slower.');
            } finally {
                this.cachingInProgress = false;
            }
        });
    }

    async searchPages(query: string): Promise<void> {
        console.log(`searchPages called with query: "${query}"`);
        this.searchQuery = query.toLowerCase();
        await this.applyFilter();
        this.buildPageTree();
        console.log(`Firing tree data change event. Filtered pages: ${this.filteredPages.length}`);
        this._onDidChangeTreeData.fire();
    }

    private async applyFilter(): Promise<void> {
        if (!this.searchQuery) {
            this.filteredPages = [...this.pages];
        } else {
            console.log(`Starting search for "${this.searchQuery}"...`);
            
            // Use pages with cached content (or load on-demand if not cached)
            const searchablePages = await Promise.all(
                this.pages.map(async (page) => {
                    // Load content if not already cached (fallback for immediate search)
                    if (!page.content) {
                        try {
                            page.content = await this.notionService.getPageContentForSearch(page.id, page.lastEdited, page.properties);
                        } catch (error) {
                            console.error(`Failed to load content for page ${page.title}:`, error);
                            page.content = '';
                        }
                    }
                    return page;
                })
            );
            
            console.log(`Search using ${searchablePages.length} pages with content`);

            // Configure Fuse.js for fuzzy search including properties
            const fuseOptions = {
                keys: [
                    { name: 'title', weight: 3 }, // Title matches are most important
                    { name: 'content', weight: 2 }, // Content matches are second
                    { name: 'properties', weight: 1 } // Property matches are third
                ],
                threshold: 0.6, // Higher = more fuzzy (was 0.3, now more lenient)
                includeScore: true,
                includeMatches: true,
                minMatchCharLength: 1, // Allow single character matches (was 2)
                // Custom function to get searchable text from properties
                getFn: (obj: any, path: string) => {
                    if (path === 'properties') {
                        // Use the extracted/converted properties from our NotionPage object, not raw Notion properties
                        const extractedProperties = obj.properties; // This should be our cleaned properties
                        
                        if (!extractedProperties) {
                            console.log(`No extracted properties found for "${obj.title}"`);
                            return [];
                        }
                        
                        const propertyStrings: string[] = [];
                        
                        for (const [key, value] of Object.entries(extractedProperties)) {
                            // Add property values
                            if (Array.isArray(value) && value.length > 0) {
                                const arrayValues = (value as string[]).map(v => String(v).toLowerCase());
                                propertyStrings.push(...arrayValues);
                            } else if (value && typeof value === 'string' && value.trim()) {
                                const stringValue = value.toLowerCase();
                                propertyStrings.push(stringValue);
                            } else if (value && typeof value !== 'object' && value !== null) {
                                const otherValue = String(value).toLowerCase();
                                propertyStrings.push(otherValue);
                            }
                            // Also include the property name as searchable (lowercase)
                            propertyStrings.push(key.toLowerCase().replace(/\s+/g, ' '));
                        }
                        return propertyStrings;
                    }
                    // Default behavior for other paths
                    return (obj as any)[path];
                }
            };

            // Debug: Check for pages with "not started" status (case-insensitive)
            const notStartedPages = searchablePages.filter(p => {
                if (!p.properties) return false;
                const statusValue = p.properties.Status;
                if (typeof statusValue === 'string') {
                    return statusValue.toLowerCase() === 'not started';
                } else if (Array.isArray(statusValue)) {
                    return statusValue.some(s => s.toLowerCase() === 'not started');
                }
                return false;
            });
            console.log(`Found ${notStartedPages.length} pages with "not started" status`);
            
            // Debug: Show all unique Status values to see what's actually in the database
            const allStatusValues = new Set();
            searchablePages.forEach(p => {
                if (p.properties?.Status) {
                    if (Array.isArray(p.properties.Status)) {
                        p.properties.Status.forEach(status => allStatusValues.add(status));
                    } else {
                        allStatusValues.add(p.properties.Status);
                    }
                }
            });
            console.log(`All Status values in database:`, Array.from(allStatusValues));
            
            if (this.searchQuery.toLowerCase().includes('not started')) {
                console.log(`Searching for "not started" - found ${notStartedPages.length} matching pages`);
                if (notStartedPages.length > 0) {
                    console.log('Sample "not started" page properties:', notStartedPages[0].properties);
                }
            }

            const fuse = new Fuse(searchablePages, fuseOptions);
            console.log(`Fuse.js initialized with ${searchablePages.length} pages`);
            
            // Property search is now working
            
            const results = fuse.search(this.searchQuery);
            console.log(`Fuse.js search for "${this.searchQuery}" returned ${results.length} results`);
            
            // Extract the pages from search results
            this.filteredPages = results.map((result: any) => {
                const page = result.item;
                // Add match information for debugging/display
                (page as any).searchScore = result.score;
                (page as any).matches = result.matches;
                return page;
            });
            
            console.log(`Search for "${this.searchQuery}" found ${this.filteredPages.length} results out of ${this.pages.length} total pages`);
            
            // Log some details about matches
            if (this.filteredPages.length > 0) {
                const titleMatches = results.filter((r: any) => r.matches?.some((m: any) => m.key === 'title')).length;
                const contentMatches = results.filter((r: any) => r.matches?.some((m: any) => m.key === 'content')).length;
                console.log(`  - ${titleMatches} title matches, ${contentMatches} content matches`);
            }
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
            
            // Only refresh if we have no pages loaded at all (not just filtered pages)
            if (this.pages.length === 0) {
                console.log('No pages loaded, calling refresh...');
                await this.refresh();
                if (this.pages.length === 0) {
                    console.log('Still no pages after refresh');
                    return [];
                }
            }
            
            // If we have a search query but no filtered results, show empty state
            if (this.filteredPages.length === 0 && this.searchQuery) {
                console.log(`Search for "${this.searchQuery}" returned no results`);
                return [];
            }
            
            console.log(`Returning ${this.filteredPages.length} pages in ${this.viewMode} mode`);
            console.log(`Search query: "${this.searchQuery}"`);
            console.log(`Filtered pages: ${this.filteredPages.map(p => p.title).slice(0, 5).join(', ')}${this.filteredPages.length > 5 ? '...' : ''}`);
            
            // Debug: Show properties before calling view functions
            if (this.filteredPages.length > 0) {
                console.log(`VIEW DEBUG: About to display ${this.viewMode} view`);
                console.log(`VIEW DEBUG: First page properties:`, this.filteredPages[0].properties);
                console.log(`VIEW DEBUG: Type property exists:`, !!this.filteredPages[0].properties?.Type);
            }
            
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
                    .map(page => new NotionPageItem(page, this.hasChildren(page.id), this.searchQuery));
            }
        }
        
        return [];
    }

    private getFlatView(): NotionPageItem[] {
        // Debug: Show properties of first few pages when displaying them
        if (this.filteredPages.length > 0) {
            console.log(`FLAT VIEW DEBUG: First page "${this.filteredPages[0].title}" has properties:`, this.filteredPages[0].properties);
            console.log(`FLAT VIEW DEBUG: Type property:`, this.filteredPages[0].properties?.Type);
        }
        
        return this.filteredPages
            .sort((a, b) => b.lastEdited.getTime() - a.lastEdited.getTime())
            .map(page => new NotionPageItem(page, false, this.searchQuery));
    }

    private getTreeView(): NotionPageItem[] {
        // Debug: Show properties of first few pages when displaying tree view
        if (this.filteredPages.length > 0) {
            console.log(`TREE VIEW DEBUG: First page "${this.filteredPages[0].title}" has properties:`, this.filteredPages[0].properties);
            console.log(`TREE VIEW DEBUG: Type property:`, this.filteredPages[0].properties?.Type);
            console.log(`TREE VIEW DEBUG: All property keys:`, Object.keys(this.filteredPages[0].properties || {}));
        }
        
        // If we have a search query, show all filtered pages as root-level for better visibility
        if (this.searchQuery) {
            console.log(`Tree view with search: showing all ${this.filteredPages.length} filtered pages as root-level`);
            return this.filteredPages
                .sort((a, b) => a.title.localeCompare(b.title))
                .map(page => new NotionPageItem(page, false, this.searchQuery)); // No children in search mode
        }
        
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
                return new NotionPageItem(page, hasChildren, this.searchQuery);
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
        return new NotionPageItem(parentPage, hasChildren, this.searchQuery);
    }


}

export class NotionPageItem extends vscode.TreeItem {
    constructor(
        public readonly page: NotionPage,
        hasChildren: boolean,
        searchQuery?: string
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

        // Add description with properties only (no date)
        let description = '';
        const propertyParts: string[] = [];
        
        // Add key properties to description for better visibility  
        if (page.properties) {
            // Handle your specific properties - only show if they have values
            for (const [key, value] of Object.entries(page.properties)) {
                if (key === 'Topics' && Array.isArray(value) && value.length > 0) {
                    propertyParts.push(`${value.slice(0, 2).join(', ')}${value.length > 2 ? '...' : ''}`);
                } else if (key === 'Status' && value && typeof value === 'string') {
                    propertyParts.push(value);
                } else if (key === 'Type' && Array.isArray(value) && value.length > 0) {
                    propertyParts.push(`${value.slice(0, 2).join(', ')}`);
                } else if (key === 'Project' && Array.isArray(value) && value.length > 0) {
                    propertyParts.push(value[0]);
                } else if (key === 'Owner' && value && typeof value === 'string') {
                    propertyParts.push(value);
                }
            }
            
            // Build description with dots as separators
            if (propertyParts.length > 0) {
                description = propertyParts.slice(0, 3).join(' • '); // Show up to 3 properties
            }
        }
        
        // Note: Removed search match indicators as requested
        
        this.description = description;
    }
}