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
        console.log('=== SEARCHING PAGES IN NOTION API ===');
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
                
                console.log(`Loaded ${response.results.length} pages, total so far: ${allPages.length}, has more: ${hasMore}`);
            }
            
            console.log(`Finished loading all pages: ${allPages.length} total`);
            
            // Debug: Check properties in first few pages
            if (allPages.length > 0) {
                console.log(`PROPERTIES DEBUG: First page properties keys:`, Object.keys(allPages[0].properties || {}));
                console.log(`PROPERTIES DEBUG: First page "Type" property:`, allPages[0].properties?.Type);
                console.log(`PROPERTIES DEBUG: All properties of first page:`, allPages[0].properties);
            }
            
            const convertedPages = allPages.map(page => this.convertToNotionPage(page as any));
            
            // Debug converted pages
            if (convertedPages.length > 0) {
                console.log(`CONVERTED DEBUG: First converted page properties:`, convertedPages[0].properties);
            }
            
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
            
            // Use notion-to-md for better markdown conversion
            if (!this.n2m) {
                this.n2m = new NotionToMarkdown({ notionClient: notion });
            }
            
            const mdBlocks = await this.n2m.pageToMarkdown(pageId);
            const content = this.n2m.toMarkdownString(mdBlocks).parent;
            
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
            // Get current blocks and delete them
            const blocks = await notion.blocks.children.list({ block_id: pageId });
            
            // Delete existing blocks (simplified approach)
            for (const block of blocks.results) {
                if ('id' in block) {
                    try {
                        await notion.blocks.delete({ block_id: block.id });
                    } catch (e) {
                        // Some blocks might not be deletable, continue
                    }
                }
            }
            
            // Convert markdown to blocks and add them
            const newBlocks = this.convertMarkdownToBlocks(content);
            if (newBlocks.length > 0) {
                await notion.blocks.children.append({
                    block_id: pageId,
                    children: newBlocks
                });
            }
        } catch (error) {
            throw new Error(`Failed to update page: ${error}`);
        }
    }

    savePageLocally(pageId: string, title: string, content: string): string {
        if (!this.notionFolderPath) {
            throw new Error('No workspace folder open. Please open a folder/workspace to save Notion pages locally.');
        }
        
        const fileName = `${this.sanitizeFileName(title)}_${pageId.slice(0, 8)}.qmd`;
        const filePath = path.join(this.notionFolderPath, fileName);
        
        const fileContent = `<!-- Notion Page ID: ${pageId} -->
---
title: "${title}"
---

${content}`;
        fs.writeFileSync(filePath, fileContent, 'utf8');
        
        return filePath;
    }

    getPageIdFromFile(filePath: string): string | null {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
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
        console.log(`Page "${this.extractPageTitle(page)}" properties:`, properties);
        
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
        // Always check properties first for relation-based hierarchy
        if (page.properties) {
            // Look for common parent/relation properties
            for (const [key, value] of Object.entries(page.properties)) {
                if ((key.toLowerCase().includes('parent') || key.toLowerCase().includes('relation') || 
                     key.toLowerCase().includes('sub') || key.toLowerCase().includes('child')) && 
                    value && typeof value === 'object' && 'relation' in value) {
                    const relation = (value as any).relation;
                    if (relation && relation.length > 0 && relation[0].id) {
                        return relation[0].id;
                    }
                }
            }
        }
        
        // Fallback to standard parent structure
        if (page.parent?.type === 'page_id') {
            return page.parent.page_id;
        }
        
        // Don't return database as parent since that makes all pages children of database
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
            }
        }
        
        return markdown.trim();
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
        const richTextArray: any[] = [];
        
        // Regular expressions for different formatting (in order of precedence)
        const patterns = [
            { regex: /\*\*(.*?)\*\*/g, annotation: 'bold' },
            { regex: /\*(.*?)\*/g, annotation: 'italic' },
            { regex: /<u>(.*?)<\/u>/g, annotation: 'underline' },
            { regex: /~~(.*?)~~/g, annotation: 'strikethrough' },
            { regex: /`(.*?)`/g, annotation: 'code' }
        ];
        
        // Check if there's any formatting
        let hasFormatting = false;
        for (const pattern of patterns) {
            if (pattern.regex.test(text)) {
                hasFormatting = true;
                break;
            }
        }
        
        if (!hasFormatting) {
            return [{ type: 'text', text: { content: text } }];
        }
        
        // Parse text with formatting
        let remainingText = text;
        let currentPos = 0;
        
        // Find all matches and their positions
        const matches: Array<{start: number, end: number, content: string, annotation: string}> = [];
        
        for (const pattern of patterns) {
            const regex = new RegExp(pattern.regex.source, 'g');
            let match;
            while ((match = regex.exec(text)) !== null) {
                matches.push({
                    start: match.index,
                    end: match.index + match[0].length,
                    content: match[1], // The captured content without markers
                    annotation: pattern.annotation
                });
            }
        }
        
        // Sort matches by start position
        matches.sort((a, b) => a.start - b.start);
        
        // If no matches found after parsing, return plain text
        if (matches.length === 0) {
            return [{ type: 'text', text: { content: text } }];
        }
        
        // Build rich text array
        let lastEnd = 0;
        
        for (const match of matches) {
            // Add plain text before this match
            if (match.start > lastEnd) {
                const plainText = text.substring(lastEnd, match.start);
                if (plainText) {
                    richTextArray.push({
                        type: 'text',
                        text: { content: plainText }
                    });
                }
            }
            
            // Add formatted text
            const annotations: any = {};
            annotations[match.annotation] = true;
            
            richTextArray.push({
                type: 'text',
                text: { content: match.content },
                annotations: annotations
            });
            
            lastEnd = match.end;
        }
        
        // Add any remaining plain text
        if (lastEnd < text.length) {
            const remainingText = text.substring(lastEnd);
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