import { Client } from '@notionhq/client';
import { NotionToMarkdown } from 'notion-to-md';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

export interface NotionPage {
    id: string;
    title: string;
    lastEdited: Date;
    parent?: string;
    url: string;
    content?: string; // Cached content for search
    properties?: { [key: string]: any }; // Database properties like tags, labels, etc.
}

interface CachedPageContent {
    content: string;
    lastEdited: string; // ISO string of last edited time
    cachedAt: string;   // ISO string of when we cached it
    properties?: { [key: string]: any }; // Cached database properties
}

export class NotionService {
    private notion: Client | null = null;
    private n2m: NotionToMarkdown | null = null;
    private notionFolderPath: string;
    private contentCache: Map<string, string> = new Map();
    private persistentCachePath: string;
    private debugCounter: number = 0;

    constructor() {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        // Only create .notion folder in workspace, not in home directory
        this.notionFolderPath = workspaceFolder 
            ? path.join(workspaceFolder.uri.fsPath, '.notion')
            : '';
        
        // Set up persistent cache path
        this.persistentCachePath = path.join(os.homedir(), '.notion-vscode', 'cache');
        
        this.ensureNotionFolder();
        this.ensurePersistentCacheFolder();
    }

    private ensureNotionFolder(): void {
        if (this.notionFolderPath && !fs.existsSync(this.notionFolderPath)) {
            fs.mkdirSync(this.notionFolderPath, { recursive: true });
        }
    }

    private ensurePersistentCacheFolder(): void {
        if (!fs.existsSync(this.persistentCachePath)) {
            fs.mkdirSync(this.persistentCachePath, { recursive: true });
            console.log(`Created persistent cache directory: ${this.persistentCachePath}`);
        } else {
            // Debug: show what's in the cache directory
            try {
                const files = fs.readdirSync(this.persistentCachePath);
                console.log(`Cache directory ${this.persistentCachePath} contains ${files.length} files:`, files.slice(0, 5));
            } catch (error) {
                console.error('Failed to read cache directory:', error);
            }
        }
    }

    private getClient(): Client {
        if (!this.notion) {
            const config = vscode.workspace.getConfiguration('notion');
            const apiKey = config.get<string>('apiKey');
            
            if (!apiKey) {
                throw new Error('Notion API key not configured. Use "Set Notion API Key" command.');
            }
            
            this.notion = new Client({ auth: apiKey });
            this.n2m = new NotionToMarkdown({ notionClient: this.notion });
        }
        return this.notion;
    }

    public resetClient(): void {
        this.notion = null;
        this.n2m = null;
        this.contentCache.clear();
        this.debugCounter = 0; // Reset debug counter
    }

    public clearCache(): number {
        // Clear memory cache
        this.contentCache.clear();
        
        // Clear persistent cache
        try {
            if (fs.existsSync(this.persistentCachePath)) {
                const files = fs.readdirSync(this.persistentCachePath);
                let deletedCount = 0;
                
                for (const file of files) {
                    if (file.endsWith('.json')) {
                        try {
                            fs.unlinkSync(path.join(this.persistentCachePath, file));
                            deletedCount++;
                        } catch (error) {
                            console.error(`Failed to delete cache file ${file}:`, error);
                        }
                    }
                }
                
                console.log(`Cleared ${deletedCount} cache files from ${this.persistentCachePath}`);
                return deletedCount;
            }
        } catch (error) {
            console.error('Failed to clear persistent cache:', error);
        }
        
        return 0;
    }

    private getCacheFilePath(pageId: string): string {
        return path.join(this.persistentCachePath, `${pageId}.json`);
    }

    private loadCachedContent(pageId: string): CachedPageContent | null {
        try {
            const cacheFilePath = this.getCacheFilePath(pageId);
            if (fs.existsSync(cacheFilePath)) {
                const cached = JSON.parse(fs.readFileSync(cacheFilePath, 'utf8'));
                return cached;
            }
        } catch (error) {
            console.error(`Failed to load cached content for ${pageId}:`, error);
        }
        return null;
    }

    private saveCachedContent(pageId: string, content: string, lastEdited: Date, properties?: { [key: string]: any }): void {
        try {
            const cacheFilePath = this.getCacheFilePath(pageId);
            const cached: CachedPageContent = {
                content,
                lastEdited: lastEdited.toISOString(),
                cachedAt: new Date().toISOString(),
                properties
            };
            fs.writeFileSync(cacheFilePath, JSON.stringify(cached, null, 2), 'utf8');
            console.log(`Cached content for ${pageId} (${content.length} chars, ${Object.keys(properties || {}).length} properties)`);
        } catch (error) {
            console.error(`Failed to save cached content for ${pageId}:`, error);
        }
    }

    private isCacheValid(cached: CachedPageContent, currentLastEdited: Date): boolean {
        const cachedLastEdited = new Date(cached.lastEdited);
        return cachedLastEdited >= currentLastEdited;
    }

    async cacheAllPageContent(pages: NotionPage[], progressCallback?: (loaded: number, total: number) => void): Promise<void> {
        console.log(`Starting background caching of ${pages.length} pages...`);
        
        let loaded = 0;
        const batchSize = 5; // Load 5 pages at a time to avoid overwhelming the API
        
        for (let i = 0; i < pages.length; i += batchSize) {
            const batch = pages.slice(i, i + batchSize);
            
            // Process batch in parallel
            await Promise.all(
                batch.map(async (page) => {
                    if (!this.contentCache.has(page.id)) {
                        try {
                            const content = await this.getPageContentForSearch(page.id, page.lastEdited, page.properties);
                            page.content = content; // Also update the page object
                            loaded++;
                            console.log(`Cached content for "${page.title}" (${loaded}/${pages.length})`);
                        } catch (error) {
                            console.error(`Failed to cache content for "${page.title}":`, error);
                            this.contentCache.set(page.id, ''); // Cache empty content to avoid retrying
                            page.content = '';
                            loaded++;
                        }
                        
                        // Report progress
                        if (progressCallback) {
                            progressCallback(loaded, pages.length);
                        }
                    } else {
                        loaded++;
                    }
                })
            );
            
            // Small delay between batches to be nice to the API
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        console.log(`Background caching completed: ${loaded}/${pages.length} pages cached`);
    }

    loadCachedContentForPages(pages: NotionPage[]): void {
        console.log(`Loading cached content for ${pages.length} pages...`);
        let cacheHits = 0;
        
        pages.forEach(page => {
            const cachedContent = this.loadCachedContent(page.id);
            if (cachedContent && this.isCacheValid(cachedContent, page.lastEdited)) {
                page.content = cachedContent.content;
                // Also load cached properties if they exist
                if (cachedContent.properties) {
                    page.properties = { ...page.properties, ...cachedContent.properties };
                }
                this.contentCache.set(page.id, cachedContent.content);
                cacheHits++;
            }
        });
        
        console.log(`Loaded ${cacheHits}/${pages.length} pages from persistent cache`);
        
        // Debug: Check properties in first cached page
        if (pages.length > 0) {
            const firstPage = pages[0];
            console.log(`CACHE DEBUG: First page "${firstPage.title}" properties:`, firstPage.properties);
            console.log(`CACHE DEBUG: Properties keys:`, Object.keys(firstPage.properties || {}));
            if (firstPage.properties?.Type) {
                console.log(`CACHE DEBUG: Type property value:`, firstPage.properties.Type);
            }
        }
        
        if (cacheHits > 0) {
            vscode.window.showInformationMessage(
                `✓ Loaded ${cacheHits} pages from cache. Search ready!`,
                { modal: false }
            );
        }
    }

    async searchPages(query: string = ''): Promise<NotionPage[]> {
        console.log('🔄 Loading pages from Notion...');
        this.debugCounter = 0; // Reset debug counter for each search
        const notion = this.getClient();
        
        try {
            // Query the specific "Research Tree" database
            const databaseId = '208fd1e7c2e180ee9aacc44071c02889';
            
            // Always get ALL pages (no filtering at API level for better search)
            let allPages: any[] = [];
            let hasMore = true;
            let nextCursor: string | undefined = undefined;
            
            while (hasMore) {
                const response: any = await notion.databases.query({
                    database_id: databaseId,
                    // Remove filter to get all pages - filtering will be done locally
                    start_cursor: nextCursor,
                    page_size: 100, // Maximum per request
                    // Explicitly request all properties
                    filter_properties: undefined // This ensures all properties are returned
                });
                
                allPages = allPages.concat(response.results);
                hasMore = response.has_more;
                nextCursor = response.next_cursor || undefined;
                
                }
            
            console.log(`✅ Loaded ${allPages.length} pages total from Notion database`);
            
            const convertedPages = allPages.map(page => this.convertToNotionPage(page as any));
            
            // Check for duplicate page IDs - CRITICAL for data integrity
            const pageIds = convertedPages.map(p => p.id);
            const uniqueIds = new Set(pageIds);
            
            if (pageIds.length !== uniqueIds.size) {
                console.error('🚨 DUPLICATE PAGE IDs DETECTED during page loading!');
                
                // Find and report duplicates
                const duplicates: Map<string, string[]> = new Map();
                convertedPages.forEach(page => {
                    const existing = duplicates.get(page.id) || [];
                    existing.push(page.title);
                    duplicates.set(page.id, existing);
                });
                
                // Show only the actual duplicates
                const actualDuplicates = Array.from(duplicates.entries()).filter(([id, titles]) => titles.length > 1);
                
                console.error('Duplicate page IDs found:');
                actualDuplicates.forEach(([id, titles]) => {
                    console.error(`   ID: ${id} appears ${titles.length} times:`);
                    titles.forEach(title => console.error(`      - "${title}"`));
                });
                
                // Show error message to user and prevent loading
                const duplicateList = actualDuplicates.map(([id, titles]) => 
                    `• ID: ${id.substring(0, 8)}... (${titles.join(', ')})`
                ).join('\n');
                
                const errorMessage = `🚨 DUPLICATE PAGE IDs DETECTED!\n\n` +
                    `Found ${actualDuplicates.length} page(s) with duplicate IDs in your Notion database:\n\n` +
                    duplicateList + '\n\n' +
                    `This must be fixed in Notion before the database can be loaded properly.\n` +
                    `Each page must have a unique ID.`;
                
                // Show blocking error dialog
                await vscode.window.showErrorMessage(
                    `Duplicate Page IDs Found! Found ${actualDuplicates.length} duplicates that must be fixed in Notion before loading.`,
                    { modal: true },
                    'Show Details'
                ).then(async (selection) => {
                    if (selection === 'Show Details') {
                        // Show detailed error in output channel
                        const outputChannel = vscode.window.createOutputChannel('Notion Duplicate IDs');
                        outputChannel.clear();
                        outputChannel.appendLine(errorMessage);
                        outputChannel.show();
                    }
                });
                
                // Throw error to prevent loading corrupted data
                throw new Error(`Database contains ${actualDuplicates.length} duplicate page IDs. Fix in Notion first.`);
            }
            
            console.log(`✅ All ${convertedPages.length} page IDs are unique - proceeding with load`);
            
            // Debug: Show parent type distribution
            const parentTypes = {
                page_id: 0,
                database_id: 0,
                workspace: 0,
                none: 0,
                other: 0
            };
            
            convertedPages.forEach(page => {
                if (page.parent) {
                    // Find original page to check parent type
                    const originalPage = allPages.find(p => p.id === page.id);
                    if (originalPage?.parent?.type === 'page_id') {
                        parentTypes.page_id++;
                    } else if (originalPage?.parent?.type === 'database_id') {
                        parentTypes.database_id++;
                    } else if (originalPage?.parent?.type === 'workspace') {
                        parentTypes.workspace++;
                    } else {
                        parentTypes.other++;
                    }
                } else {
                    parentTypes.none++;
                }
            });
            
            console.log('=== PARENT TYPE DISTRIBUTION ===');
            console.log(`Pages with page parents (nested): ${parentTypes.page_id}`);
            console.log(`Pages with database parents (top-level): ${parentTypes.database_id}`);
            console.log(`Pages with workspace parents: ${parentTypes.workspace}`);
            console.log(`Pages with no parent: ${parentTypes.none}`);
            console.log(`Pages with other parent types: ${parentTypes.other}`);
            
            return convertedPages;
        } catch (error) {
            throw new Error(`Failed to query Research Tree database: ${error}`);
        }
    }

    async getPageContentForSearch(pageId: string, pageLastEdited?: Date, pageProperties?: { [key: string]: any }): Promise<string> {
        // Check memory cache first
        if (this.contentCache.has(pageId)) {
            const cached = this.contentCache.get(pageId)!;
            console.log(`Retrieved memory cached content for ${pageId}: ${cached.length} characters`);
            return cached;
        }

        // Check persistent cache
        if (pageLastEdited) {
            const cachedContent = this.loadCachedContent(pageId);
            if (cachedContent && this.isCacheValid(cachedContent, pageLastEdited)) {
                console.log(`Retrieved persistent cached content for ${pageId}: ${cachedContent.content.length} characters`);
                // Also store in memory cache for this session
                this.contentCache.set(pageId, cachedContent.content);
                return cachedContent.content;
            }
        }

        try {
            console.log(`Loading fresh content for page ${pageId}`);
            const { content } = await this.getPageContent(pageId);
            console.log(`Loaded content for ${pageId}: ${content ? content.length : 0} characters`);
            
            // Ensure content is a string
            const contentString = content || '';
            
            // Cache the content in memory
            this.contentCache.set(pageId, contentString);
            
            // Save to persistent cache if we have the last edited date
            if (pageLastEdited) {
                this.saveCachedContent(pageId, contentString, pageLastEdited, pageProperties);
            }
            
            return contentString;
        } catch (error) {
            console.error(`Failed to load content for page ${pageId}:`, error);
            return ''; // Return empty string on error
        }
    }

    async getPageContent(pageId: string): Promise<{ title: string; content: string }> {
        const notion = this.getClient();
        
        try {
            const page = await notion.pages.retrieve({ page_id: pageId });
            const title = this.extractPageTitle(page);
            
            // Get all blocks for the page
            const blocksResponse = await notion.blocks.children.list({ block_id: pageId });
            const blocks = blocksResponse.results;
            
            // Convert blocks to markdown with embedded metadata
            const content = this.convertBlocksToMarkdownWithMetadata(blocks);
            
            return { title, content };
        } catch (error) {
            throw new Error(`Failed to get page content: ${error}`);
        }
    }

    async getPageContentForWebview(pageId: string): Promise<{ title: string; content: string; blocks: any[] }> {
        const notion = this.getClient();
        
        try {
            const page = await notion.pages.retrieve({ page_id: pageId });
            const title = this.extractPageTitle(page);
            
            // Get raw blocks for webview rendering
            const blocksResponse = await notion.blocks.children.list({ block_id: pageId });
            const blocks = blocksResponse.results;
            
            // Also get markdown content for toggle functionality
            if (!this.n2m) {
                this.n2m = new NotionToMarkdown({ notionClient: notion });
            }
            
            const mdBlocks = await this.n2m.pageToMarkdown(pageId);
            const content = this.n2m.toMarkdownString(mdBlocks).parent;
            
            return { title, content, blocks };
        } catch (error) {
            throw new Error(`Failed to get page content for webview: ${error}`);
        }
    }

    async updatePageContent(pageId: string, content: string): Promise<void> {
        const notion = this.getClient();
        
        try {
            let notebook: any;
            
            // Parse the content as notebook JSON
            try {
                notebook = JSON.parse(content);
            } catch {
                // If not valid JSON, might be legacy format - convert it
                throw new Error('Invalid notebook format');
            }
            
            // Get current blocks from Notion
            const blocksResponse = await notion.blocks.children.list({ block_id: pageId });
            const currentBlocks = blocksResponse.results;
            
            // Map preserved blocks by ID
            const preservedBlocksMap = new Map<string, any>();
            const blocksToDelete: string[] = [];
            
            for (const block of currentBlocks) {
                if ('id' in block && 'type' in block) {
                    if (block.type === 'child_database' || 
                        block.type === 'link_to_page' ||
                        block.type === 'synced_block' ||
                        block.type === 'table' ||
                        block.type === 'column_list' ||
                        block.type === 'child_page') {
                        preservedBlocksMap.set(block.id, block);
                    } else {
                        blocksToDelete.push(block.id);
                    }
                }
            }
            
            // Delete all content blocks
            for (const blockId of blocksToDelete) {
                try {
                    await notion.blocks.delete({ block_id: blockId });
                } catch (e) {
                    console.error(`Failed to delete block ${blockId}:`, e);
                }
            }
            
            // Convert notebook cells to Notion blocks
            const newBlocks: any[] = [];
            
            for (const cell of notebook.cells || []) {
                // Skip title cell
                if (cell.metadata?.is_title) {
                    continue;
                }
                
                // Skip preserved blocks (they already exist in Notion)
                if (cell.metadata?.notion_block_id && preservedBlocksMap.has(cell.metadata.notion_block_id)) {
                    continue;
                }
                
                // Convert cell to Notion block(s)
                const blocks = this.convertCellToNotionBlocks(cell);
                newBlocks.push(...blocks);
            }
            
            // Append all new blocks
            if (newBlocks.length > 0) {
                await notion.blocks.children.append({
                    block_id: pageId,
                    children: newBlocks
                });
            }
            
        } catch (error: any) {
            console.error('=== UPDATE PAGE CONTENT ERROR ===');
            console.error('Full error:', error);
            throw new Error(`Failed to update page: ${error.message || error}`);
        }
    }
    
    private convertCellToNotionBlocks(cell: any): any[] {
        const blocks: any[] = [];
        const content = Array.isArray(cell.source) ? cell.source.join('\n') : cell.source;
        
        if (!content || !content.trim()) {
            return blocks;
        }
        
        // Handle code cells
        if (cell.cell_type === 'code') {
            const language = cell.metadata?.language || 'python';
            blocks.push({
                object: 'block',
                type: 'code',
                code: {
                    language: language,
                    rich_text: [{ type: 'text', text: { content: content } }]
                }
            });
            return blocks;
        }
        
        // Handle markdown cells - parse and convert each line/block
        const lines = content.split('\n');
        let i = 0;
        
        while (i < lines.length) {
            const block = this.convertLineToBlock(lines[i], lines, i);
            if (block) {
                blocks.push(block.block);
                i = block.newIndex;
            } else {
                i++;
            }
        }
        
        return blocks;
    }

    savePageLocally(pageId: string, title: string, content: string): string {
        if (!this.notionFolderPath) {
            throw new Error('No workspace folder open. Please open a folder/workspace to save Notion pages locally.');
        }
        
        const fileName = `${this.sanitizeFileName(title)}_${pageId.slice(0, 8)}.ipynb`;
        const filePath = path.join(this.notionFolderPath, fileName);
        
        // Convert content to notebook format
        const notebook = this.createNotebookFromContent(pageId, title, content);
        
        fs.writeFileSync(filePath, JSON.stringify(notebook, null, 2), 'utf8');
        
        return filePath;
    }

    getPageIdFromFile(filePath: string): string | null {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            
            // Handle .ipynb files
            if (filePath.endsWith('.ipynb')) {
                const notebook = JSON.parse(content);
                return notebook.metadata?.notion_page_id || null;
            }
            
            // Legacy .qmd support
            const match = content.match(/<!-- Notion Page ID: ([a-f0-9-]+) -->/);
            return match ? match[1] : null;
        } catch {
            return null;
        }
    }

    parseQuartoFile(content: string): { title: string | null, content: string, pageId: string | null } {
        // Extract page ID from comment
        const pageIdMatch = content.match(/<!-- Notion Page ID: ([a-f0-9-]+) -->/);
        const pageId = pageIdMatch ? pageIdMatch[1] : null;

        // Extract title and content from YAML frontmatter
        const yamlMatch = content.match(/^<!-- Notion Page ID: [a-f0-9-]+ -->\s*\n---\s*\ntitle:\s*"([^"]+)"\s*\n---\s*\n([\s\S]*)/);
        
        if (yamlMatch) {
            return {
                title: yamlMatch[1],
                content: yamlMatch[2].trim(),
                pageId
            };
        }

        // Fallback: try to extract from old format (# Title)
        const lines = content.split('\n');
        let contentStart = 0;
        let title = null;

        // Skip the comment line
        if (lines[0]?.startsWith('<!-- Notion Page ID:')) {
            contentStart = 1;
        }

        // Extract title from # header if present
        if (lines[contentStart]?.startsWith('# ')) {
            title = lines[contentStart].substring(2).trim();
            contentStart++;
        }

        // Skip empty lines
        while (contentStart < lines.length && !lines[contentStart].trim()) {
            contentStart++;
        }

        return {
            title,
            content: lines.slice(contentStart).join('\n'),
            pageId
        };
    }

    private convertToNotionPage(page: any): NotionPage {
        const properties = this.extractPageProperties(page);
        
        return {
            id: page.id,
            title: this.extractPageTitle(page),
            lastEdited: new Date(page.last_edited_time),
            parent: this.getParentId(page),
            url: page.url,
            properties: properties
        };
    }

    private extractPageTitle(page: any): string {
        // Handle different page title formats
        if (page.properties) {
            // Try common title property names
            const titleProps = ['Name', 'Title', 'title'];
            for (const prop of titleProps) {
                if (page.properties[prop]?.title?.[0]?.text?.content) {
                    return page.properties[prop].title[0].text.content;
                }
            }
            
            // Try rich_text properties
            for (const [key, value] of Object.entries(page.properties)) {
                if ((value as any)?.rich_text?.[0]?.text?.content) {
                    return (value as any).rich_text[0].text.content;
                }
            }
        }
        
        return 'Untitled';
    }

    private getParentId(page: any): string | undefined {
        const pageTitle = page.properties?.title?.title?.[0]?.plain_text || 'Unknown';
        
        // Show raw parent data for first 3 pages only
        if (this.debugCounter < 3) {
            console.log(`🔍 PARENT DEBUG [${pageTitle}]:`, JSON.stringify(page.parent, null, 2));
            this.debugCounter++;
        }
        
        // PRIORITY 1: Use Notion's built-in parent structure (guaranteed no cycles)
        if (page.parent?.type === 'page_id') {
            console.log(`✅ ${pageTitle}: Using built-in parent ${page.parent.page_id}`);
            return page.parent.page_id;
        }
        
        // PRIORITY 2: For database pages, use "Parent Goal" relation as fallback
        if (page.properties && page.properties['Parent Goal']) {
            const parentGoal = page.properties['Parent Goal'];
            if (parentGoal.type === 'relation' && parentGoal.relation && parentGoal.relation.length > 0) {
                const parentId = parentGoal.relation[0].id;
                console.log(`📎 ${pageTitle}: Using Parent Goal relation ${parentId}`);
                return parentId;
            }
        }
        
        // No parent found
        return undefined;
    }

    private convertBlocksToMarkdown(blocks: any[]): string {
        let markdown = '';
        
        for (const block of blocks) {
            switch (block.type) {
                case 'paragraph':
                    if (block.paragraph?.rich_text) {
                        markdown += this.extractTextFromRichText(block.paragraph.rich_text) + '\n\n';
                    }
                    break;
                case 'heading_1':
                    if (block.heading_1?.rich_text) {
                        markdown += '# ' + this.extractTextFromRichText(block.heading_1.rich_text) + '\n\n';
                    }
                    break;
                case 'heading_2':
                    if (block.heading_2?.rich_text) {
                        markdown += '## ' + this.extractTextFromRichText(block.heading_2.rich_text) + '\n\n';
                    }
                    break;
                case 'heading_3':
                    if (block.heading_3?.rich_text) {
                        markdown += '### ' + this.extractTextFromRichText(block.heading_3.rich_text) + '\n\n';
                    }
                    break;
                case 'bulleted_list_item':
                    if (block.bulleted_list_item?.rich_text) {
                        markdown += '- ' + this.extractTextFromRichText(block.bulleted_list_item.rich_text) + '\n';
                    }
                    break;
                case 'numbered_list_item':
                    if (block.numbered_list_item?.rich_text) {
                        markdown += '1. ' + this.extractTextFromRichText(block.numbered_list_item.rich_text) + '\n';
                    }
                    break;
                case 'code':
                    if (block.code?.rich_text) {
                        const language = block.code.language || '';
                        const code = this.extractTextFromRichText(block.code.rich_text);
                        markdown += `\`\`\`${language}\n${code}\n\`\`\`\n\n`;
                    }
                    break;
                case 'quote':
                    if (block.quote?.rich_text) {
                        markdown += '> ' + this.extractTextFromRichText(block.quote.rich_text) + '\n\n';
                    }
                    break;
                case 'divider':
                    markdown += '---\n\n';
                    break;
                case 'child_database':
                    markdown += `[Database: ${block.child_database?.title || 'Untitled Database'}]\n\n`;
                    break;
                case 'link_to_page':
                    markdown += `[Linked Page/Database View]\n\n`;
                    break;
                case 'synced_block':
                    markdown += `[Synced Block]\n\n`;
                    break;
                case 'table':
                    markdown += `[Table]\n\n`;
                    break;
                case 'column_list':
                    markdown += `[Column Layout]\n\n`;
                    break;
                // Skip child_page as it's handled separately in the tree view
                case 'child_page':
                    break;
                default:
                    // For unknown block types, log them but don't crash
                    console.log(`Unknown block type: ${block.type}`);
                    break;
            }
        }
        
        return markdown.trim();
    }

    private convertLineToBlock(line: string, lines: string[], index: number): {block: any, newIndex: number} | null {
        const trimmedLine = line.trim();
        
        if (!trimmedLine) {
            return null;
        }
        
        // Skip database/view placeholders
        if (trimmedLine.startsWith('[Database:') || 
            trimmedLine === '[Linked Page/Database View]' ||
            trimmedLine === '[Synced Block]' ||
            trimmedLine === '[Table]' ||
            trimmedLine === '[Column Layout]') {
            return null;
        }
        
        let block: any = null;
        let newIndex = index + 1;
        
        if (trimmedLine.startsWith('# ')) {
            block = {
                object: 'block',
                type: 'heading_1',
                heading_1: {
                    rich_text: this.parseMarkdownToRichText(trimmedLine.substring(2))
                }
            };
        } else if (trimmedLine.startsWith('## ')) {
            block = {
                object: 'block',
                type: 'heading_2',
                heading_2: {
                    rich_text: this.parseMarkdownToRichText(trimmedLine.substring(3))
                }
            };
        } else if (trimmedLine.startsWith('### ')) {
            block = {
                object: 'block',
                type: 'heading_3',
                heading_3: {
                    rich_text: this.parseMarkdownToRichText(trimmedLine.substring(4))
                }
            };
        } else if (trimmedLine.startsWith('- ') || trimmedLine.startsWith('* ')) {
            block = {
                object: 'block',
                type: 'bulleted_list_item',
                bulleted_list_item: {
                    rich_text: this.parseMarkdownToRichText(trimmedLine.substring(2))
                }
            };
        } else if (trimmedLine.match(/^\d+\.\s/)) {
            block = {
                object: 'block',
                type: 'numbered_list_item',
                numbered_list_item: {
                    rich_text: this.parseMarkdownToRichText(trimmedLine.replace(/^\d+\.\s/, ''))
                }
            };
        } else if (trimmedLine.startsWith('```')) {
            // Handle code blocks
            const language = trimmedLine.substring(3);
            let i = index + 1;
            const codeLines = [];
            while (i < lines.length && !lines[i].startsWith('```')) {
                codeLines.push(lines[i]);
                i++;
            }
            block = {
                object: 'block',
                type: 'code',
                code: {
                    language: language || 'plain text',
                    rich_text: [{ type: 'text', text: { content: codeLines.join('\n') } }]
                }
            };
            newIndex = i + 1; // Skip past the closing ```
        } else if (trimmedLine.startsWith('> ')) {
            block = {
                object: 'block',
                type: 'quote',
                quote: {
                    rich_text: this.parseMarkdownToRichText(trimmedLine.substring(2))
                }
            };
        } else if (trimmedLine === '---') {
            block = {
                object: 'block',
                type: 'divider',
                divider: {}
            };
        } else {
            block = {
                object: 'block',
                type: 'paragraph',
                paragraph: {
                    rich_text: this.parseMarkdownToRichText(trimmedLine)
                }
            };
        }
        
        return block ? { block, newIndex } : null;
    }
    
    private convertMarkdownToBlocks(markdown: string): any[] {
        const lines = markdown.split('\n');
        const blocks = [];
        let i = 0;
        
        while (i < lines.length) {
            const line = lines[i].trim();
            
            if (!line) {
                i++;
                continue;
            }
            
            // Skip database/view placeholders - these are preserved separately
            if (line.startsWith('[Database:') || 
                line === '[Linked Page/Database View]' ||
                line === '[Synced Block]' ||
                line === '[Table]' ||
                line === '[Column Layout]') {
                i++;
                continue;
            }
            
            if (line.startsWith('# ')) {
                blocks.push({
                    object: 'block',
                    type: 'heading_1',
                    heading_1: {
                        rich_text: this.parseMarkdownToRichText(line.substring(2))
                    }
                });
            } else if (line.startsWith('## ')) {
                blocks.push({
                    object: 'block',
                    type: 'heading_2',
                    heading_2: {
                        rich_text: this.parseMarkdownToRichText(line.substring(3))
                    }
                });
            } else if (line.startsWith('### ')) {
                blocks.push({
                    object: 'block',
                    type: 'heading_3',
                    heading_3: {
                        rich_text: this.parseMarkdownToRichText(line.substring(4))
                    }
                });
            } else if (line.startsWith('- ') || line.startsWith('* ')) {
                blocks.push({
                    object: 'block',
                    type: 'bulleted_list_item',
                    bulleted_list_item: {
                        rich_text: this.parseMarkdownToRichText(line.substring(2))
                    }
                });
            } else if (line.match(/^\d+\.\s/)) {
                blocks.push({
                    object: 'block',
                    type: 'numbered_list_item',
                    numbered_list_item: {
                        rich_text: this.parseMarkdownToRichText(line.replace(/^\d+\.\s/, ''))
                    }
                });
            } else if (line.startsWith('```')) {
                // Handle code blocks
                const language = line.substring(3);
                i++;
                const codeLines = [];
                while (i < lines.length && !lines[i].startsWith('```')) {
                    codeLines.push(lines[i]);
                    i++;
                }
                blocks.push({
                    object: 'block',
                    type: 'code',
                    code: {
                        language: language || 'plain text',
                        rich_text: [{ type: 'text', text: { content: codeLines.join('\n') } }]
                    }
                });
            } else if (line.startsWith('> ')) {
                blocks.push({
                    object: 'block',
                    type: 'quote',
                    quote: {
                        rich_text: this.parseMarkdownToRichText(line.substring(2))
                    }
                });
            } else if (line === '---') {
                blocks.push({
                    object: 'block',
                    type: 'divider',
                    divider: {}
                });
            } else {
                blocks.push({
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: this.parseMarkdownToRichText(line)
                    }
                });
            }
            
            i++;
        }
        
        return blocks;
    }

    private extractTextFromRichText(richText: any[]): string {
        return richText
            .map(textObj => {
                let content = textObj.plain_text || textObj.text?.content || '';
                
                // Apply formatting if annotations exist
                if (textObj.annotations) {
                    const annotations = textObj.annotations;
                    
                    // Apply bold
                    if (annotations.bold) {
                        content = `**${content}**`;
                    }
                    
                    // Apply italic
                    if (annotations.italic) {
                        content = `*${content}*`;
                    }
                    
                    // Apply underline (using HTML since markdown doesn't have native underline)
                    if (annotations.underline) {
                        content = `<u>${content}</u>`;
                    }
                    
                    // Apply strikethrough
                    if (annotations.strikethrough) {
                        content = `~~${content}~~`;
                    }
                    
                    // Apply code
                    if (annotations.code) {
                        content = `\`${content}\``;
                    }
                }
                
                return content;
            })
            .join('');
    }

    private parseMarkdownToRichText(text: string): any[] {
        // Simple approach: just return plain text if no formatting detected
        // This avoids complex regex issues
        if (!text.includes('*') && !text.includes('_') && !text.includes('`') && 
            !text.includes('~') && !text.includes('<u>')) {
            return [{ type: 'text', text: { content: text } }];
        }
        
        // For now, use a simplified approach that handles basic cases
        // Parse bold and italic separately to avoid conflicts
        const richTextArray: any[] = [];
        
        // Simple pattern matching - handle bold first (double asterisk)
        const boldPattern = /\*\*(.+?)\*\*/g;
        const italicPattern = /(?<!\*)\*(?!\*)(.+?)\*(?!\*)/g;
        const codePattern = /`(.+?)`/g;
        const strikePattern = /~~(.+?)~~/g;
        
        // Collect all matches with their positions
        const matches: Array<{start: number, end: number, text: string, type: string}> = [];
        
        let match: RegExpExecArray | null;
        // Find bold
        boldPattern.lastIndex = 0;
        while ((match = boldPattern.exec(text)) !== null) {
            matches.push({
                start: match.index,
                end: match.index + match[0].length,
                text: match[1],
                type: 'bold'
            });
        }
        
        // Find code (before italic to prevent conflicts)
        codePattern.lastIndex = 0;
        while ((match = codePattern.exec(text)) !== null) {
            matches.push({
                start: match.index,
                end: match.index + match[0].length,
                text: match[1],
                type: 'code'
            });
        }
        
        // Find italic (after bold to avoid conflicts)
        italicPattern.lastIndex = 0;
        while ((match = italicPattern.exec(text)) !== null) {
            // Skip if this overlaps with bold or code
            const matchStart = match.index;
            const matchEnd = match.index + match[0].length;
            const overlaps = matches.some(m => 
                (matchStart >= m.start && matchStart < m.end) ||
                (matchEnd > m.start && matchEnd <= m.end)
            );
            if (!overlaps) {
                matches.push({
                    start: matchStart,
                    end: matchEnd,
                    text: match[1],
                    type: 'italic'
                });
            }
        }
        
        // Find strikethrough
        strikePattern.lastIndex = 0;
        while ((match = strikePattern.exec(text)) !== null) {
            const matchStart = match.index;
            const matchEnd = match.index + match[0].length;
            const overlaps = matches.some(m => 
                (matchStart >= m.start && matchStart < m.end) ||
                (matchEnd > m.start && matchEnd <= m.end)
            );
            if (!overlaps) {
                matches.push({
                    start: matchStart,
                    end: matchEnd,
                    text: match[1],
                    type: 'strikethrough'
                });
            }
        }
        
        // Sort matches by position
        matches.sort((a, b) => a.start - b.start);
        
        // Build the rich text array
        let currentPos = 0;
        for (const m of matches) {
            // Add plain text before this match
            if (m.start > currentPos) {
                const plainText = text.substring(currentPos, m.start);
                if (plainText) {
                    richTextArray.push({
                        type: 'text',
                        text: { content: plainText }
                    });
                }
            }
            
            // Add the formatted text
            const annotations: any = {};
            annotations[m.type] = true;
            richTextArray.push({
                type: 'text',
                text: { content: m.text },
                annotations: annotations
            });
            
            currentPos = m.end;
        }
        
        // Add any remaining plain text
        if (currentPos < text.length) {
            const remainingText = text.substring(currentPos);
            if (remainingText) {
                richTextArray.push({
                    type: 'text',
                    text: { content: remainingText }
                });
            }
        }
        
        // If we couldn't parse properly, fall back to plain text
        if (richTextArray.length === 0) {
            return [{ type: 'text', text: { content: text } }];
        }
        
        return richTextArray;
    }

    private convertBlocksToMarkdownWithMetadata(blocks: any[]): string {
        let markdown = '';
        
        for (const block of blocks) {
            if (!('id' in block) || !('type' in block)) continue;
            
            // Only add block ID markers for preserved block types
            const isPreservedBlock = block.type === 'child_database' || 
                                     block.type === 'link_to_page' ||
                                     block.type === 'synced_block' ||
                                     block.type === 'table' ||
                                     block.type === 'column_list' ||
                                     block.type === 'child_page';
            
            if (isPreservedBlock) {
                // Add hidden block ID marker for preserved blocks only
                markdown += `<!-- BLOCK_ID: ${block.id} TYPE: ${block.type} -->\n`;
                // Don't add any placeholder text - just the marker
                continue;
            }
            
            switch (block.type) {
                case 'paragraph':
                    if (block.paragraph?.rich_text) {
                        markdown += this.extractTextFromRichText(block.paragraph.rich_text) + '\n\n';
                    }
                    break;
                case 'heading_1':
                    if (block.heading_1?.rich_text) {
                        markdown += '# ' + this.extractTextFromRichText(block.heading_1.rich_text) + '\n\n';
                    }
                    break;
                case 'heading_2':
                    if (block.heading_2?.rich_text) {
                        markdown += '## ' + this.extractTextFromRichText(block.heading_2.rich_text) + '\n\n';
                    }
                    break;
                case 'heading_3':
                    if (block.heading_3?.rich_text) {
                        markdown += '### ' + this.extractTextFromRichText(block.heading_3.rich_text) + '\n\n';
                    }
                    break;
                case 'bulleted_list_item':
                    if (block.bulleted_list_item?.rich_text) {
                        markdown += '- ' + this.extractTextFromRichText(block.bulleted_list_item.rich_text) + '\n';
                    }
                    break;
                case 'numbered_list_item':
                    if (block.numbered_list_item?.rich_text) {
                        markdown += '1. ' + this.extractTextFromRichText(block.numbered_list_item.rich_text) + '\n';
                    }
                    break;
                case 'code':
                    if (block.code?.rich_text) {
                        const language = block.code.language || '';
                        const code = this.extractTextFromRichText(block.code.rich_text);
                        markdown += `\`\`\`${language}\n${code}\n\`\`\`\n\n`;
                    }
                    break;
                case 'quote':
                    if (block.quote?.rich_text) {
                        markdown += '> ' + this.extractTextFromRichText(block.quote.rich_text) + '\n\n';
                    }
                    break;
                case 'divider':
                    markdown += '---\n\n';
                    break;
                default:
                    console.log(`Unknown block type: ${block.type}`);
                    break;
            }
        }
        
        return markdown.trim();
    }

    private parseMarkdownWithBlockMetadata(content: string): Array<{blockId?: string, blockType?: string, content: string}> {
        const lines = content.split('\n');
        const blocks: Array<{blockId?: string, blockType?: string, content: string}> = [];
        let currentBlock: {blockId?: string, blockType?: string, content: string} = {content: ''};
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            // Check for block metadata marker
            const blockMatch = line.match(/^<!-- BLOCK_ID: ([a-f0-9-]+) TYPE: ([a-z_]+) -->$/);
            if (blockMatch) {
                // Save previous block if it has content
                if (currentBlock.content.trim() || currentBlock.blockId) {
                    blocks.push(currentBlock);
                }
                // Start new block
                currentBlock = {
                    blockId: blockMatch[1],
                    blockType: blockMatch[2],
                    content: ''
                };
            } else {
                // Add line to current block content
                currentBlock.content += line + '\n';
            }
        }
        
        // Add last block
        if (currentBlock.content.trim() || currentBlock.blockId) {
            blocks.push(currentBlock);
        }
        
        return blocks;
    }

    private createBlockFromParsedContent(content: string): any | null {
        const trimmedContent = content.trim();
        if (!trimmedContent) return null;
        
        // Skip placeholders
        if (trimmedContent.startsWith('[Database:') || 
            trimmedContent === '[Linked Page/Database View]' ||
            trimmedContent === '[Synced Block]' ||
            trimmedContent === '[Table]' ||
            trimmedContent === '[Column Layout]' ||
            trimmedContent === '[Child Page]' ||
            trimmedContent.startsWith('[Unknown:')) {
            return null;
        }
        
        // Parse content and create appropriate block
        const lines = trimmedContent.split('\n');
        const firstLine = lines[0].trim();
        
        if (firstLine.startsWith('# ')) {
            return {
                object: 'block',
                type: 'heading_1',
                heading_1: {
                    rich_text: this.parseMarkdownToRichText(firstLine.substring(2))
                }
            };
        } else if (firstLine.startsWith('## ')) {
            return {
                object: 'block',
                type: 'heading_2',
                heading_2: {
                    rich_text: this.parseMarkdownToRichText(firstLine.substring(3))
                }
            };
        } else if (firstLine.startsWith('### ')) {
            return {
                object: 'block',
                type: 'heading_3',
                heading_3: {
                    rich_text: this.parseMarkdownToRichText(firstLine.substring(4))
                }
            };
        } else if (firstLine.startsWith('- ') || firstLine.startsWith('* ')) {
            return {
                object: 'block',
                type: 'bulleted_list_item',
                bulleted_list_item: {
                    rich_text: this.parseMarkdownToRichText(firstLine.substring(2))
                }
            };
        } else if (firstLine.match(/^\d+\.\s/)) {
            return {
                object: 'block',
                type: 'numbered_list_item',
                numbered_list_item: {
                    rich_text: this.parseMarkdownToRichText(firstLine.replace(/^\d+\.\s/, ''))
                }
            };
        } else if (firstLine.startsWith('```')) {
            // Handle code blocks
            const language = firstLine.substring(3);
            const codeLines = [];
            for (let i = 1; i < lines.length; i++) {
                if (lines[i] === '```') break;
                codeLines.push(lines[i]);
            }
            return {
                object: 'block',
                type: 'code',
                code: {
                    language: language || 'plain text',
                    rich_text: [{ type: 'text', text: { content: codeLines.join('\n') } }]
                }
            };
        } else if (firstLine.startsWith('> ')) {
            return {
                object: 'block',
                type: 'quote',
                quote: {
                    rich_text: this.parseMarkdownToRichText(firstLine.substring(2))
                }
            };
        } else if (firstLine === '---') {
            return {
                object: 'block',
                type: 'divider',
                divider: {}
            };
        } else if (trimmedContent) {
            return {
                object: 'block',
                type: 'paragraph',
                paragraph: {
                    rich_text: this.parseMarkdownToRichText(trimmedContent.replace(/\n\n$/, ''))
                }
            };
        }
        
        return null;
    }

    private createNotebookFromContent(pageId: string, title: string, content: string): any {
        const lines = content.split('\n');
        const cells: any[] = [];
        let currentCell: string[] = [];
        let currentBlockId: string | null = null;
        let currentBlockType: string | null = null;
        
        // Add title cell
        cells.push({
            cell_type: 'markdown',
            metadata: {
                notion_page_id: pageId,
                is_title: true
            },
            source: [`# ${title}`]
        });
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            // Check for block ID marker
            const blockMatch = line.match(/^<!-- BLOCK_ID: ([a-f0-9-]+) TYPE: (\w+) -->$/);
            if (blockMatch) {
                // Save current cell if exists
                if (currentCell.length > 0) {
                    const cellContent = currentCell.join('\n').trim();
                    if (cellContent) {
                        cells.push(this.createNotebookCell(cellContent, currentBlockId, currentBlockType));
                    }
                    currentCell = [];
                }
                
                // Start new preserved block
                currentBlockId = blockMatch[1];
                currentBlockType = blockMatch[2];
                continue;
            }
            
            // Check if we need to start a new cell (empty line after content)
            if (line.trim() === '' && currentCell.length > 0 && !currentBlockId) {
                // End current cell on empty line
                const cellContent = currentCell.join('\n').trim();
                if (cellContent) {
                    cells.push(this.createNotebookCell(cellContent, currentBlockId, currentBlockType));
                }
                currentCell = [];
                currentBlockId = null;
                currentBlockType = null;
                continue;
            }
            
            currentCell.push(line);
        }
        
        // Add final cell if exists
        if (currentCell.length > 0) {
            const cellContent = currentCell.join('\n').trim();
            if (cellContent) {
                cells.push(this.createNotebookCell(cellContent, currentBlockId, currentBlockType));
            }
        }
        
        return {
            cells: cells,
            metadata: {
                kernelspec: {
                    display_name: 'Notion',
                    language: 'markdown',
                    name: 'notion'
                },
                language_info: {
                    name: 'markdown',
                    version: '1.0'
                },
                notion_page_id: pageId
            },
            nbformat: 4,
            nbformat_minor: 4
        };
    }
    
    private createNotebookCell(content: string, blockId: string | null, blockType: string | null): any {
        // For database and special blocks
        if (blockId && blockType) {
            return {
                cell_type: 'raw',
                metadata: {
                    notion_block_id: blockId,
                    notion_block_type: blockType
                },
                source: content.split('\n')
            };
        }
        
        // Check if this is a code block
        if (content.startsWith('```')) {
            const lines = content.split('\n');
            const language = lines[0].substring(3) || 'python';
            const code = lines.slice(1, -1).join('\n');
            return {
                cell_type: 'code',
                execution_count: null,
                metadata: {
                    language: language
                },
                outputs: [],
                source: code.split('\n')
            };
        }
        
        // Default to markdown cell
        return {
            cell_type: 'markdown',
            metadata: {},
            source: content.split('\n')
        };
    }
    
    private sanitizeFileName(filename: string): string {
        return filename
            .replace(/[<>:"/\\|?*]/g, '_')
            .replace(/\s+/g, '_')
            .substring(0, 50);
    }

    private extractPageProperties(page: any): { [key: string]: any } {
        const properties: { [key: string]: any } = {};
        
        console.log(`Extracting properties for page. Raw properties:`, page.properties);
        
        if (!page.properties) {
            console.log('No properties object found in page');
            return properties;
        }
        
        // List all available property names for debugging
        const propertyNames = Object.keys(page.properties);
        console.log(`Available property names: [${propertyNames.join(', ')}]`);
        
        // Check specifically for "Type" property
        if (page.properties.Type) {
            console.log('Found "Type" property:', page.properties.Type);
        }

        for (const [key, value] of Object.entries(page.properties)) {
            const propertyValue = value as any;
            
            // Skip the title property as it's handled separately
            if (propertyValue.type === 'title') {
                continue;
            }

            try {
                switch (propertyValue.type) {
                    case 'multi_select':
                        properties[key] = propertyValue.multi_select?.map((item: any) => item.name) || [];
                        break;
                    case 'select':
                        properties[key] = propertyValue.select?.name || null;
                        break;
                    case 'rich_text':
                        properties[key] = propertyValue.rich_text?.map((item: any) => item.plain_text).join('') || '';
                        break;
                    case 'number':
                        properties[key] = propertyValue.number;
                        break;
                    case 'checkbox':
                        properties[key] = propertyValue.checkbox;
                        break;
                    case 'date':
                        properties[key] = propertyValue.date?.start || null;
                        break;
                    case 'people':
                        properties[key] = propertyValue.people?.map((person: any) => person.name || person.id) || [];
                        break;
                    case 'files':
                        properties[key] = propertyValue.files?.map((file: any) => file.name || file.file?.url) || [];
                        break;
                    case 'url':
                        properties[key] = propertyValue.url;
                        break;
                    case 'email':
                        properties[key] = propertyValue.email;
                        break;
                    case 'phone_number':
                        properties[key] = propertyValue.phone_number;
                        break;
                    case 'formula':
                        // Handle formula results based on their type
                        if (propertyValue.formula?.string) {
                            properties[key] = propertyValue.formula.string;
                        } else if (propertyValue.formula?.number !== undefined) {
                            properties[key] = propertyValue.formula.number;
                        } else if (propertyValue.formula?.boolean !== undefined) {
                            properties[key] = propertyValue.formula.boolean;
                        } else if (propertyValue.formula?.date) {
                            properties[key] = propertyValue.formula.date.start;
                        }
                        break;
                    case 'relation':
                        properties[key] = propertyValue.relation?.map((rel: any) => rel.id) || [];
                        break;
                    case 'rollup':
                        // Handle rollup based on the rollup type
                        if (propertyValue.rollup?.array) {
                            properties[key] = propertyValue.rollup.array;
                        } else if (propertyValue.rollup?.number !== undefined) {
                            properties[key] = propertyValue.rollup.number;
                        } else if (propertyValue.rollup?.date) {
                            properties[key] = propertyValue.rollup.date.start;
                        }
                        break;
                    case 'created_time':
                        properties[key] = propertyValue.created_time;
                        break;
                    case 'created_by':
                        properties[key] = propertyValue.created_by?.name || propertyValue.created_by?.id;
                        break;
                    case 'last_edited_time':
                        properties[key] = propertyValue.last_edited_time;
                        break;
                    case 'last_edited_by':
                        properties[key] = propertyValue.last_edited_by?.name || propertyValue.last_edited_by?.id;
                        break;
                    default:
                        // For unknown types, try to extract any meaningful value
                        properties[key] = propertyValue;
                        break;
                }
            } catch (error) {
                console.error(`Failed to extract property ${key}:`, error);
                properties[key] = null;
            }
        }

        console.log(`Extracted properties result:`, properties);
        return properties;
    }
}