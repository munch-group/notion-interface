import * as vscode from 'vscode';
import { NotionService } from './notionService';

export class NotionWebviewProvider {
    private static readonly viewType = 'notion.pageView';
    private readonly webviews: Map<string, vscode.WebviewPanel> = new Map();
    private readonly panelStates: Map<string, { isMarkdownView: boolean, title: string, blocks: any[], content: string, filePath: string }> = new Map();
    private activePageId: string | null = null;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly notionService: NotionService
    ) {}

    async openPage(pageId: string): Promise<void> {
        // Check if we already have this page open
        const existingPanel = this.webviews.get(pageId);
        if (existingPanel) {
            existingPanel.reveal();
            return;
        }

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Loading Notion page...",
                cancellable: false
            }, async (progress) => {
                // Get page content as markdown first
                console.log('=== OPENING PAGE ===', pageId);
                const result = await this.notionService.getPageContent(pageId);
                console.log('=== getPageContent result ===', result);
                
                const { title, content } = result;
                console.log('Extracted title:', title, 'content length:', content?.length);
                
                if (!title) {
                    throw new Error('Failed to extract page title');
                }
                
                const safeContent = content || '';
                
                // Save to local .notion folder for editing
                const filePath = this.notionService.savePageLocally(pageId, title, safeContent);
                
                // Create webview panel for rendered view
                const panel = vscode.window.createWebviewPanel(
                    NotionWebviewProvider.viewType,
                    title,
                    vscode.ViewColumn.One,
                    {
                        enableScripts: true,
                        retainContextWhenHidden: true,
                        localResourceRoots: [this.context.extensionUri]
                    }
                );

                // Store the panel state
                this.panelStates.set(pageId, {
                    isMarkdownView: false,
                    title,
                    blocks: [], // We'll parse this from markdown when rendering
                    content: safeContent,
                    filePath
                });

                // Render the markdown as HTML
                const htmlContent = this.renderMarkdownAsHtml(title, safeContent);
                panel.webview.html = htmlContent;

                // Track active panel when it becomes visible
                panel.onDidChangeViewState(e => {
                    if (e.webviewPanel.active) {
                        this.activePageId = pageId;
                    }
                });

                // Set as active if it's the first panel
                if (this.webviews.size === 0) {
                    this.activePageId = pageId;
                }

                // Handle messages from webview
                panel.webview.onDidReceiveMessage(
                    async (message) => {
                        switch (message.command) {
                            case 'saveChanges':
                                await this.saveChanges(pageId, message.content);
                                break;
                        }
                    },
                    undefined,
                    this.context.subscriptions
                );

                // Handle panel disposal
                panel.onDidDispose(() => {
                    this.webviews.delete(pageId);
                    this.panelStates.delete(pageId);
                    if (this.activePageId === pageId) {
                        this.activePageId = null;
                    }
                }, null, this.context.subscriptions);

                // Store the panel
                this.webviews.set(pageId, panel);
                
                vscode.window.showInformationMessage(`Opened "${title}" from Notion`);
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to open page: ${error}`);
        }
    }

    private renderMarkdownAsHtml(title: string, markdownContent: string): string {
        const nonce = this.getNonce();
        
        // Convert markdown to HTML
        const htmlContent = this.markdownToHtml(markdownContent);
        
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
            <title>${title}</title>
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    line-height: 1.6;
                    margin: 0;
                    padding: 20px;
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                }
                .header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin-bottom: 20px;
                    padding-bottom: 10px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .title {
                    font-size: 24px;
                    font-weight: 600;
                    margin: 0;
                }
                .content {
                    margin-top: 20px;
                }
                h1, h2, h3, h4, h5, h6 {
                    margin-top: 24px;
                    margin-bottom: 8px;
                    font-weight: 600;
                }
                h1 { font-size: 28px; }
                h2 { font-size: 24px; }
                h3 { font-size: 20px; }
                p {
                    margin: 8px 0;
                }
                ul, ol {
                    margin: 8px 0;
                    padding-left: 20px;
                }
                li {
                    margin: 4px 0;
                }
                code {
                    background: var(--vscode-textCodeBlock-background);
                    padding: 2px 4px;
                    border-radius: 3px;
                    font-family: 'Monaco', 'Courier New', monospace;
                    font-size: 0.9em;
                }
                pre {
                    background: var(--vscode-textBlockQuote-background);
                    border: 1px solid var(--vscode-textBlockQuote-border);
                    border-radius: 4px;
                    padding: 12px;
                    font-family: 'Monaco', 'Courier New', monospace;
                    font-size: 14px;
                    overflow-x: auto;
                    margin: 8px 0;
                }
                pre code {
                    background: none;
                    padding: 0;
                }
                blockquote {
                    border-left: 4px solid var(--vscode-textQuote-border);
                    padding-left: 16px;
                    margin: 8px 0;
                    font-style: italic;
                }
                strong {
                    font-weight: 600;
                }
                em {
                    font-style: italic;
                }
                del {
                    text-decoration: line-through;
                }
                a {
                    color: var(--vscode-textLink-foreground);
                    text-decoration: none;
                }
                a:hover {
                    text-decoration: underline;
                }
                hr {
                    border: none;
                    border-top: 1px solid var(--vscode-panel-border);
                    margin: 16px 0;
                }
            </style>
        </head>
        <body>
            <div class="header">
                <h1 class="title">${title}</h1>
            </div>
            <div class="content">
                ${htmlContent}
            </div>
            
            <script nonce="${nonce}">
                const vscode = acquireVsCodeApi();
            </script>
        </body>
        </html>`;
    }

    private getWebviewContent(title: string, blocks: any[], markdownContent: string, webview: vscode.Webview, showMarkdown: boolean = false): string {
        const nonce = this.getNonce();
        
        return `<!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
            <title>${title}</title>
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    line-height: 1.6;
                    margin: 0;
                    padding: 20px;
                    background-color: var(--vscode-editor-background);
                    color: var(--vscode-editor-foreground);
                }
                .header {
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    margin-bottom: 20px;
                    padding-bottom: 10px;
                    border-bottom: 1px solid var(--vscode-panel-border);
                }
                .title {
                    font-size: 24px;
                    font-weight: 600;
                    margin: 0;
                }
                .content {
                    margin-top: 20px;
                }
                .notion-block {
                    margin-bottom: 8px;
                }
                .notion-heading-1 {
                    font-size: 28px;
                    font-weight: 600;
                    margin: 24px 0 8px 0;
                }
                .notion-heading-2 {
                    font-size: 24px;
                    font-weight: 600;
                    margin: 20px 0 8px 0;
                }
                .notion-heading-3 {
                    font-size: 20px;
                    font-weight: 600;
                    margin: 16px 0 8px 0;
                }
                .notion-paragraph {
                    margin: 8px 0;
                }
                .notion-bulleted-list-item {
                    margin: 4px 0 4px 20px;
                    position: relative;
                }
                .notion-bulleted-list-item::before {
                    content: "•";
                    position: absolute;
                    left: -16px;
                }
                .notion-numbered-list-item {
                    margin: 4px 0 4px 20px;
                    counter-increment: list-counter;
                }
                .notion-numbered-list-item::before {
                    content: counter(list-counter) ".";
                    position: absolute;
                    left: -20px;
                }
                .notion-to-do {
                    margin: 4px 0;
                    display: flex;
                    align-items: flex-start;
                }
                .notion-to-do input {
                    margin-right: 8px;
                    margin-top: 2px;
                }
                .notion-code {
                    background: var(--vscode-textBlockQuote-background);
                    border: 1px solid var(--vscode-textBlockQuote-border);
                    border-radius: 4px;
                    padding: 12px;
                    font-family: 'Monaco', 'Courier New', monospace;
                    font-size: 14px;
                    white-space: pre-wrap;
                    margin: 8px 0;
                }
                .notion-quote {
                    border-left: 4px solid var(--vscode-textQuote-border);
                    padding-left: 16px;
                    margin: 8px 0;
                    font-style: italic;
                }
                .markdown-content {
                    white-space: pre-wrap;
                    font-family: 'Monaco', 'Courier New', monospace;
                    font-size: 14px;
                    background: var(--vscode-textBlockQuote-background);
                    padding: 20px;
                    border-radius: 4px;
                    border: 1px solid var(--vscode-textBlockQuote-border);
                }
                .notion-text-bold {
                    font-weight: 600;
                }
                .notion-text-italic {
                    font-style: italic;
                }
                .notion-text-strikethrough {
                    text-decoration: line-through;
                }
                .notion-text-underline {
                    text-decoration: underline;
                }
                .notion-text-code {
                    background: var(--vscode-textCodeBlock-background);
                    padding: 2px 4px;
                    border-radius: 3px;
                    font-family: 'Monaco', 'Courier New', monospace;
                    font-size: 0.9em;
                }
            </style>
        </head>
        <body>
            <div class="header">
                <h1 class="title">${title}</h1>
            </div>
            <div class="content">
                ${showMarkdown ? 
                    `<div class="markdown-content">${this.escapeHtml(markdownContent)}</div>` : 
                    this.renderNotionBlocks(blocks)
                }
            </div>
            
            <script nonce="${nonce}">
                const vscode = acquireVsCodeApi();
            </script>
        </body>
        </html>`;
    }

    private renderNotionBlocks(blocks: any[]): string {
        return blocks.map(block => this.renderNotionBlock(block)).join('');
    }

    private renderNotionBlock(block: any): string {
        const type = block.type;
        const content = block[type];
        
        if (!content) return '';

        let text = '';
        if (content.rich_text) {
            text = this.renderRichText(content.rich_text);
        } else if (content.text) {
            text = this.renderRichText(content.text);
        }

        switch (type) {
            case 'paragraph':
                return `<div class="notion-block notion-paragraph">${text}</div>`;
            case 'heading_1':
                return `<h1 class="notion-block notion-heading-1">${text}</h1>`;
            case 'heading_2':
                return `<h2 class="notion-block notion-heading-2">${text}</h2>`;
            case 'heading_3':
                return `<h3 class="notion-block notion-heading-3">${text}</h3>`;
            case 'bulleted_list_item':
                return `<div class="notion-block notion-bulleted-list-item">${text}</div>`;
            case 'numbered_list_item':
                return `<div class="notion-block notion-numbered-list-item">${text}</div>`;
            case 'to_do':
                const checked = content.checked ? 'checked' : '';
                return `<div class="notion-block notion-to-do">
                    <input type="checkbox" ${checked} disabled>
                    <span>${text}</span>
                </div>`;
            case 'code':
                const language = content.language || '';
                return `<div class="notion-block notion-code" data-language="${language}">${this.escapeHtml(content.rich_text?.[0]?.plain_text || '')}</div>`;
            case 'quote':
                return `<div class="notion-block notion-quote">${text}</div>`;
            default:
                return `<div class="notion-block notion-paragraph">${text}</div>`;
        }
    }

    private renderRichText(richText: any[]): string {
        if (!richText || !Array.isArray(richText)) return '';
        
        return richText.map(textItem => {
            let text = this.escapeHtml(textItem.plain_text || '');
            
            if (textItem.annotations) {
                const annotations = textItem.annotations;
                if (annotations.bold) text = `<span class="notion-text-bold">${text}</span>`;
                if (annotations.italic) text = `<span class="notion-text-italic">${text}</span>`;
                if (annotations.strikethrough) text = `<span class="notion-text-strikethrough">${text}</span>`;
                if (annotations.underline) text = `<span class="notion-text-underline">${text}</span>`;
                if (annotations.code) text = `<span class="notion-text-code">${text}</span>`;
            }
            
            if (textItem.href) {
                text = `<a href="${textItem.href}" target="_blank">${text}</a>`;
            }
            
            return text;
        }).join('');
    }

    private markdownToHtml(markdown: string): string {
        // Handle undefined or null markdown content
        if (!markdown || typeof markdown !== 'string') {
            console.error('markdownToHtml received invalid input:', markdown);
            return '<p>Error: No content available</p>';
        }
        
        // Simple markdown to HTML converter
        let html = markdown;
        
        // Convert headings
        html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
        html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
        html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');
        
        // Convert bold
        html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        html = html.replace(/__(.*?)__/g, '<strong>$1</strong>');
        
        // Convert italic
        html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
        html = html.replace(/_(.*?)_/g, '<em>$1</em>');
        
        // Convert strikethrough
        html = html.replace(/~~(.*?)~~/g, '<del>$1</del>');
        
        // Convert inline code
        html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
        
        // Convert code blocks
        html = html.replace(/```(\w+)?\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
        html = html.replace(/```\n([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
        
        // Convert links
        html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
        
        // Convert horizontal rules
        html = html.replace(/^---$/gm, '<hr>');
        
        // Convert blockquotes
        html = html.replace(/^> (.*)$/gm, '<blockquote>$1</blockquote>');
        
        // Convert unordered lists
        html = html.replace(/^\* (.*)$/gm, '<li>$1</li>');
        html = html.replace(/^- (.*)$/gm, '<li>$1</li>');
        
        // Convert ordered lists
        html = html.replace(/^\d+\. (.*)$/gm, '<li>$1</li>');
        
        // Wrap consecutive list items in ul/ol tags
        html = html.replace(/(<li>.*<\/li>(?:\n<li>.*<\/li>)*)/g, (match) => {
            return `<ul>${match}</ul>`;
        });
        
        // Convert line breaks to paragraphs
        const lines = html.split('\n');
        const paragraphs: string[] = [];
        let currentParagraph = '';
        
        for (const line of lines) {
            const trimmedLine = line.trim();
            
            // Skip empty lines and HTML block elements
            if (!trimmedLine || 
                trimmedLine.startsWith('<h') || 
                trimmedLine.startsWith('<ul>') || 
                trimmedLine.startsWith('<ol>') || 
                trimmedLine.startsWith('<pre>') || 
                trimmedLine.startsWith('<blockquote>') || 
                trimmedLine.startsWith('<hr>') ||
                trimmedLine.endsWith('</ul>') ||
                trimmedLine.endsWith('</ol>') ||
                trimmedLine.endsWith('</pre>') ||
                trimmedLine.endsWith('</blockquote>')) {
                
                if (currentParagraph) {
                    paragraphs.push(`<p>${currentParagraph}</p>`);
                    currentParagraph = '';
                }
                
                if (trimmedLine) {
                    paragraphs.push(trimmedLine);
                }
            } else {
                if (currentParagraph) {
                    currentParagraph += ' ' + trimmedLine;
                } else {
                    currentParagraph = trimmedLine;
                }
            }
        }
        
        // Add final paragraph if any
        if (currentParagraph) {
            paragraphs.push(`<p>${currentParagraph}</p>`);
        }
        
        return paragraphs.join('\n');
    }

    private escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;');
    }

    private async saveChanges(pageId: string, content: string): Promise<void> {
        try {
            await this.notionService.updatePageContent(pageId, content);
            vscode.window.showInformationMessage('Changes saved to Notion successfully!');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to save changes: ${error}`);
        }
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    async toggleActiveView(): Promise<void> {
        if (!this.activePageId) {
            vscode.window.showWarningMessage('No active Notion page found');
            return;
        }

        const panel = this.webviews.get(this.activePageId);
        const state = this.panelStates.get(this.activePageId);
        
        if (!panel || !state) {
            vscode.window.showWarningMessage('Active Notion page not found');
            return;
        }

        // Toggle the view mode
        state.isMarkdownView = !state.isMarkdownView;
        
        if (state.isMarkdownView) {
            // Switch to markdown editor
            panel.dispose(); // Close the webview
            
            // Open the markdown file in editor
            const doc = await vscode.workspace.openTextDocument(state.filePath);
            await vscode.window.showTextDocument(doc);
            
            // Set context to indicate this is a Notion file
            vscode.commands.executeCommand('setContext', 'notion.isNotionFile', true);
        } else {
            // Switch back to rendered view
            // Re-read the markdown file to get any changes
            const doc = await vscode.workspace.openTextDocument(state.filePath);
            const updatedContent = doc.getText();
            
            // Extract content without header
            const lines = updatedContent.split('\n');
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
            state.content = markdownContent;
            
            // Create new webview panel
            const newPanel = vscode.window.createWebviewPanel(
                NotionWebviewProvider.viewType,
                state.title,
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true,
                    localResourceRoots: [this.context.extensionUri]
                }
            );

            // Render updated markdown as HTML
            newPanel.webview.html = this.renderMarkdownAsHtml(state.title, markdownContent);

            // Update tracking
            this.webviews.set(this.activePageId, newPanel);
            
            // Set up event handlers for new panel
            newPanel.onDidChangeViewState(e => {
                if (e.webviewPanel.active) {
                    this.activePageId = this.activePageId;
                }
            });

            newPanel.onDidDispose(() => {
                this.webviews.delete(this.activePageId!);
                this.panelStates.delete(this.activePageId!);
                if (this.activePageId === this.activePageId) {
                    this.activePageId = null;
                }
            }, null, this.context.subscriptions);

            // Close the markdown editor
            const editors = vscode.window.visibleTextEditors;
            for (const editor of editors) {
                if (editor.document.fileName === state.filePath) {
                    await vscode.window.showTextDocument(editor.document, { preview: true });
                    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
                    break;
                }
            }
        }

        // Update the panel title to show current view mode
        const currentPanel = this.webviews.get(this.activePageId);
        if (currentPanel) {
            currentPanel.title = `${state.title}${state.isMarkdownView ? ' (Markdown)' : ''}`;
        }
    }

    dispose(): void {
        this.webviews.forEach(panel => panel.dispose());
        this.webviews.clear();
        this.panelStates.clear();
    }
}