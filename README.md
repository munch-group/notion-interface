# Notion Interface - VS Code Extension

A VS Code extension to interface with Notion using an Integration API key. Browse your Notion pages, edit them in markdown format, and sync changes back to Notion.

## Features

✅ **Custom Sidebar**: Dedicated Notion sidebar with custom icon
✅ **Browse Pages**: View all your accessible Notion pages in a clean list
✅ **Dual View Modes**: Switch between flat list and nested tree view
✅ **Search & Filter**: Search through your pages by title
✅ **Markdown Editing**: Open Notion pages as markdown files for editing
✅ **Local Storage**: Pages are saved to a local `.notion` folder
✅ **Sync Changes**: Upload modified content back to Notion with a single click
✅ **Auto-sync**: Optional automatic synchronization when saving files

## Setup

1. **Create a Notion Integration**:
   - Go to [https://www.notion.so/my-integrations](https://www.notion.so/my-integrations)
   - Click "New integration"
   - Give it a name and select your workspace
   - Copy the "Internal Integration Token" (starts with `secret_`)

2. **Share Pages with Integration**:
   - Open the Notion pages you want to access
   - Click "Share" → "Invite" → Paste your integration name
   - Grant "Read & Edit" permissions

3. **Configure Extension**:
   - Open VS Code
   - Install this extension
   - Run command: "Notion: Set Notion API Key"
   - Paste your integration token

## Usage

### Browsing Pages
- Open the Notion sidebar (click the Notion icon in the activity bar)
- Your pages will load automatically
- Use the search icon to filter pages
- Toggle between flat list and tree view using the icons

### Editing Pages
- Click on any page in the sidebar to open it
- The page opens as a markdown file in the `.notion` folder
- Edit the content using VS Code's markdown features
- Click the upload icon (cloud) in the editor title to sync changes back

### Commands
- `Notion: Set Notion API Key` - Configure your API key
- `Notion: Refresh Pages` - Reload the page list
- `Notion: Search Pages` - Search/filter pages
- `Notion: Upload Changes to Notion` - Sync current file to Notion

## Settings

- `notion.apiKey`: Your Notion Integration API key
- `notion.viewMode`: Display mode for pages ("flat" or "tree")
- `notion.autoSync`: Automatically sync changes when saving files

## File Structure

The extension creates a `.notion` folder in your workspace (or home directory) where it stores local copies of your Notion pages. Files are named with the format: `PageTitle_ID.md`

Each file includes:
- A comment with the Notion Page ID for syncing
- The page title as an H1 header
- The page content in markdown format

## Requirements

- VS Code 1.74.0 or higher
- A Notion account with integration access
- Internet connection for API calls

## Known Limitations

- Large pages may take time to load
- Complex Notion blocks (embeds, databases) are converted to simple markdown
- Collaborative editing may cause conflicts - always sync before editing

## Support

For issues or feature requests, please visit the GitHub repository.
