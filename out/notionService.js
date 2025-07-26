"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.NotionService = void 0;
const client_1 = require("@notionhq/client");
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
class NotionService {
    constructor() {
        this.notion = null;
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        this.notionFolderPath = workspaceFolder
            ? path.join(workspaceFolder.uri.fsPath, '.notion')
            : path.join(process.env.HOME || process.env.USERPROFILE || '', '.notion');
        this.ensureNotionFolder();
    }
    ensureNotionFolder() {
        if (!fs.existsSync(this.notionFolderPath)) {
            fs.mkdirSync(this.notionFolderPath, { recursive: true });
        }
    }
    getClient() {
        if (!this.notion) {
            const config = vscode.workspace.getConfiguration('notion');
            const apiKey = config.get('apiKey');
            if (!apiKey) {
                throw new Error('Notion API key not configured. Use "Set Notion API Key" command.');
            }
            this.notion = new client_1.Client({ auth: apiKey });
        }
        return this.notion;
    }
    resetClient() {
        this.notion = null;
    }
    async searchPages(query = '') {
        const notion = this.getClient();
        try {
            // Query the specific "Research Tree" database
            const databaseId = '208fd1e7c2e180ee9aacc44071c02889';
            // Always get ALL pages (no filtering at API level for better search)
            let allPages = [];
            let hasMore = true;
            let nextCursor = undefined;
            while (hasMore) {
                const response = await notion.databases.query({
                    database_id: databaseId,
                    // Remove filter to get all pages - filtering will be done locally
                    start_cursor: nextCursor,
                    page_size: 100 // Maximum per request
                });
                allPages = allPages.concat(response.results);
                hasMore = response.has_more;
                nextCursor = response.next_cursor || undefined;
                console.log(`Loaded ${response.results.length} pages, total so far: ${allPages.length}, has more: ${hasMore}`);
            }
            console.log(`Finished loading all pages: ${allPages.length} total`);
            return allPages.map(page => this.convertToNotionPage(page));
        }
        catch (error) {
            throw new Error(`Failed to query Research Tree database: ${error}`);
        }
    }
    async getPageContent(pageId) {
        const notion = this.getClient();
        try {
            const page = await notion.pages.retrieve({ page_id: pageId });
            const blocks = await notion.blocks.children.list({
                block_id: pageId,
                page_size: 100
            });
            const title = this.extractPageTitle(page);
            const content = this.convertBlocksToMarkdown(blocks.results);
            return { title, content };
        }
        catch (error) {
            throw new Error(`Failed to get page content: ${error}`);
        }
    }
    async updatePageContent(pageId, content) {
        const notion = this.getClient();
        try {
            // Get current blocks and delete them
            const blocks = await notion.blocks.children.list({ block_id: pageId });
            // Delete existing blocks (simplified approach)
            for (const block of blocks.results) {
                if ('id' in block) {
                    try {
                        await notion.blocks.delete({ block_id: block.id });
                    }
                    catch (e) {
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
        }
        catch (error) {
            throw new Error(`Failed to update page: ${error}`);
        }
    }
    savePageLocally(pageId, title, content) {
        const fileName = `${this.sanitizeFileName(title)}_${pageId.slice(0, 8)}.md`;
        const filePath = path.join(this.notionFolderPath, fileName);
        const fileContent = `<!-- Notion Page ID: ${pageId} -->\n# ${title}\n\n${content}`;
        fs.writeFileSync(filePath, fileContent, 'utf8');
        return filePath;
    }
    getPageIdFromFile(filePath) {
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            const match = content.match(/<!-- Notion Page ID: ([a-f0-9-]+) -->/);
            return match ? match[1] : null;
        }
        catch {
            return null;
        }
    }
    convertToNotionPage(page) {
        return {
            id: page.id,
            title: this.extractPageTitle(page),
            lastEdited: new Date(page.last_edited_time),
            parent: this.getParentId(page),
            url: page.url
        };
    }
    extractPageTitle(page) {
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
                if (value?.rich_text?.[0]?.text?.content) {
                    return value.rich_text[0].text.content;
                }
            }
        }
        return 'Untitled';
    }
    getParentId(page) {
        // Always check properties first for relation-based hierarchy
        if (page.properties) {
            // Look for common parent/relation properties
            for (const [key, value] of Object.entries(page.properties)) {
                if ((key.toLowerCase().includes('parent') || key.toLowerCase().includes('relation') ||
                    key.toLowerCase().includes('sub') || key.toLowerCase().includes('child')) &&
                    value && typeof value === 'object' && 'relation' in value) {
                    const relation = value.relation;
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
    convertBlocksToMarkdown(blocks) {
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
    convertMarkdownToBlocks(markdown) {
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
                        rich_text: [{ type: 'text', text: { content: line.substring(2) } }]
                    }
                });
            }
            else if (line.startsWith('## ')) {
                blocks.push({
                    object: 'block',
                    type: 'heading_2',
                    heading_2: {
                        rich_text: [{ type: 'text', text: { content: line.substring(3) } }]
                    }
                });
            }
            else if (line.startsWith('### ')) {
                blocks.push({
                    object: 'block',
                    type: 'heading_3',
                    heading_3: {
                        rich_text: [{ type: 'text', text: { content: line.substring(4) } }]
                    }
                });
            }
            else if (line.startsWith('- ') || line.startsWith('* ')) {
                blocks.push({
                    object: 'block',
                    type: 'bulleted_list_item',
                    bulleted_list_item: {
                        rich_text: [{ type: 'text', text: { content: line.substring(2) } }]
                    }
                });
            }
            else if (line.match(/^\d+\.\s/)) {
                blocks.push({
                    object: 'block',
                    type: 'numbered_list_item',
                    numbered_list_item: {
                        rich_text: [{ type: 'text', text: { content: line.replace(/^\d+\.\s/, '') } }]
                    }
                });
            }
            else if (line.startsWith('```')) {
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
            }
            else if (line.startsWith('> ')) {
                blocks.push({
                    object: 'block',
                    type: 'quote',
                    quote: {
                        rich_text: [{ type: 'text', text: { content: line.substring(2) } }]
                    }
                });
            }
            else if (line === '---') {
                blocks.push({
                    object: 'block',
                    type: 'divider',
                    divider: {}
                });
            }
            else {
                blocks.push({
                    object: 'block',
                    type: 'paragraph',
                    paragraph: {
                        rich_text: [{ type: 'text', text: { content: line } }]
                    }
                });
            }
            i++;
        }
        return blocks;
    }
    extractTextFromRichText(richText) {
        return richText
            .map(text => text.plain_text || text.text?.content || '')
            .join('');
    }
    sanitizeFileName(filename) {
        return filename
            .replace(/[<>:"/\\|?*]/g, '_')
            .replace(/\s+/g, '_')
            .substring(0, 50);
    }
}
exports.NotionService = NotionService;
//# sourceMappingURL=notionService.js.map