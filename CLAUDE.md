# CLAUDE.md - VS Code Notion Interface Extension

This document provides a comprehensive overview of the Notion Interface VS Code extension for future Claude instances working on this codebase.

## Project Overview

**Name**: Notion Interface  
**Type**: VS Code Extension  
**Version**: 0.1.0  
**Purpose**: Interface with Notion using API key - browse pages, edit in markdown, sync changes

The extension provides a complete interface to browse Notion pages in VS Code, edit them as markdown files, and sync changes back to Notion. It's specifically designed to work with a Notion database called "Research Tree" with configurable properties.

## High-Level Architecture

The extension follows a modular architecture with four main components:

### 1. Extension Entry Point (`/Users/kmt/vscode-extension/vsnotion/src/extension.ts`)
- **Purpose**: Main activation point, command registration, and coordination
- **Key Responsibilities**:
  - Registers all VS Code commands and event handlers
  - Manages extension lifecycle (activate/deactivate)
  - Coordinates between service classes
  - Handles file watching for auto-sync functionality
  - Sets up VS Code context variables for UI state management

### 2. Notion Service (`/Users/kmt/vscode-extension/vsnotion/src/notionService.ts`)
- **Purpose**: Core API integration and data management
- **Key Responsibilities**:
  - Notion API client management using `@notionhq/client`
  - Page content retrieval and conversion using `notion-to-md`
  - Persistent caching system for performance
  - Local file storage in `.notion` folder
  - Property extraction from database pages
  - Markdown ↔ Notion blocks conversion

### 3. Tree Provider (`/Users/kmt/vscode-extension/vsnotion/src/notionTreeProvider.ts`)
- **Purpose**: VS Code tree view management and search functionality
- **Key Responsibilities**:
  - Implements `vscode.TreeDataProvider` for sidebar
  - Dual view modes: flat list and hierarchical tree
  - Advanced search using Fuse.js (fuzzy search across title, content, and properties)
  - Background content caching for faster search
  - Page filtering and organization

### 4. Webview Provider (`/Users/kmt/vscode-extension/vsnotion/src/notionWebviewProvider.ts`)
- **Purpose**: Rich page viewing and editing interface
- **Key Responsibilities**:
  - Renders Notion pages as HTML webviews
  - Converts markdown to HTML for display
  - Toggles between rendered view and markdown editing
  - Manages multiple open pages
  - Handles page-specific state management

## Key Dependencies

### Production Dependencies
- **`@notionhq/client`** (v2.2.15): Official Notion API client
- **`notion-to-md`** (v3.1.9): Converts Notion blocks to markdown
- **`fuse.js`** (v7.1.0): Fuzzy search library for intelligent page searching

### Development Dependencies
- **TypeScript** (v4.9.4): Main development language
- **ESLint** + TypeScript ESLint: Code linting and formatting
- **VSCE** (v2.15.0): VS Code extension packaging tool

## Available NPM Scripts

```bash
# Development
npm run compile          # Compile TypeScript to JavaScript
npm run watch           # Watch mode compilation
npm run lint            # Run ESLint on source files

# Testing & Quality
npm run pretest         # Compile and lint before testing
npm run test            # Run extension tests

# Publishing
npm run vscode:prepublish  # Prepare for publishing (runs compile)
npm run package         # Create .vsix package file
```

## Configuration & Settings

The extension provides these user-configurable settings:

- **`notion.apiKey`** (string): Notion Integration API key
- **`notion.viewMode`** (enum: "flat" | "tree"): Display mode for pages sidebar
- **`notion.autoSync`** (boolean, default: true): Auto-sync changes when saving files

## Commands & Features

### Core Commands
- `notion.setApiKey`: Configure Notion API key
- `notion.refreshPages`: Reload page list from Notion
- `notion.searchPages`: Search/filter pages by content
- `notion.openPage`: Open a page for viewing/editing
- `notion.uploadChanges`: Sync local changes back to Notion
- `notion.clearCache`: Clear persistent cache for fresh data
- `notion.toggleViewMode`: Switch between rendered and markdown views
- `notion.toggleFlatView` / `notion.toggleTreeView`: Switch display modes

### UI Integration
- **Custom Sidebar**: Dedicated activity bar panel with Notion icon
- **Tree View**: Hierarchical or flat page listing with search
- **Context Menus**: Right-click actions on pages
- **Status Bar**: Progress indicators for operations
- **Webview Panels**: Rich page rendering with custom styling

## Database-Specific Implementation

**Important**: The extension is currently hardcoded to work with a specific Notion database:
- **Database ID**: `208fd1e7c2e180ee9aacc44071c02889` (Research Tree)
- **Expected Properties**: Type, Status, Topics, Project, Owner
- **Search**: Includes property-based search (e.g., search for "not started" status)

## File System Organization

The extension uses two distinct storage systems for different purposes:

### Working Files (`.notion/` folder)
- **Location**: Created in workspace root only (requires open workspace)
- **Purpose**: Stores actual **editable files** that you work with in VS Code
- **File naming**: `PageTitle_ID.qmd` format (Quarto markdown files)
- **File format**: 
  ```markdown
  <!-- Notion Page ID: [page-id] -->
  ---
  title: "Page Title"
  ---
  
  [Page content in markdown]
  ```
- **Usage**: These are the files you open, edit, and sync back to Notion
- **Workflow**: 
  1. Click "Open Page" → Creates `.qmd` file in `.notion/` folder
  2. Edit the file in VS Code (with Quarto visual editor if available)
  3. Save file → Auto-syncs changes back to Notion (if enabled)

### Performance Cache (`~/.notion-vscode/cache/`)
- **Location**: `~/.notion-vscode/cache/` in home directory
- **Purpose**: JSON cache for fast search, browsing, and offline viewing
- **Format**: JSON files named `{pageId}.json`
- **Contents**: Page metadata, content, properties, and timestamps
- **Usage**: Background caching to avoid blocking UI during search operations
- **Note**: This is performance-only storage - you don't directly interact with these files

### Key Differences
- **`.notion/` folder**: Your actual working files that you edit and save
- **`.notion-vscode/cache/`**: Background performance cache for search/browsing
- **Without `.notion/` folder**: Cannot open and edit pages in VS Code
- **Without cache folder**: Search and browsing will be slower but still functional

## Development Patterns & Conventions

### Error Handling
- Comprehensive try-catch blocks with user-friendly error messages
- Graceful degradation when API calls fail
- Console logging for debugging with clear prefixes

### Performance Optimizations
- Background content caching to avoid blocking UI
- Batch API requests (5 pages at a time)
- Persistent caching with timestamp validation
- Lazy loading of page content

### VS Code Integration Patterns
- Context variables for conditional UI (`notion.enabled`, `notion.viewMode`, etc.)
- Progress notifications for long-running operations
- Workspace configuration integration
- File watching for auto-sync

## Common Development Tasks

### Adding New Commands
1. Register command in `extension.ts` activate function
2. Add to `package.json` contributes.commands
3. Implement handler function
4. Add to appropriate menus in `package.json`

### Modifying Search Behavior
- Edit `notionTreeProvider.ts` `applyFilter()` method
- Adjust Fuse.js configuration in search options
- Modify property extraction in `notionService.ts`

### Changing Database Integration
- Update hardcoded database ID in `notionService.ts`
- Modify property extraction logic for different schemas
- Update search field mappings

### Adding New View Modes
- Extend `ViewMode` type in `notionTreeProvider.ts`
- Implement new view logic in `getFlatView()` or `getTreeView()`
- Add corresponding commands and UI elements

## Testing & Debugging

### Debug Logging
The extension includes extensive console logging with prefixes:
- `=== SEARCHING PAGES IN NOTION API ===`
- `PROPERTIES DEBUG:`
- `CACHE DEBUG:`
- `VIEW DEBUG:`

### Common Issues
- **API Rate Limits**: Extension implements batching and delays
- **Circular Hierarchies**: Tree view includes cycle detection
- **Cache Invalidation**: Timestamp-based validation prevents stale data
- **Property Extraction**: Robust handling of different Notion property types

## Extension Lifecycle

### Activation
1. Initialize service instances
2. Register commands and providers
3. Set up file watchers
4. Load configuration and set context variables
5. Auto-refresh pages if API key is configured

### Deactivation
1. Dispose webview panels
2. Clear context variables
3. Clean up event listeners

## Claude Code Operating Rules

### Operating Modes

You can request a specific operating mode at any time:

#### 🤖 **"Go-It-Alone" Mode**
*Activate by saying: "Use go-it-alone mode" or "Operate autonomously"*

**Auto-approved actions** (anything that only affects project content):
- All build/test workflow commands (compile, package, install)
- Code changes, refactoring, and bug fixes
- Adding/removing/modifying source code files
- Debugging and performance improvements  
- Documentation updates (comments, CLAUDE.md, README)
- TodoWrite progress tracking
- TypeScript error fixes and code cleanup

**Still requires confirmation:**
- External dependencies (npm install/uninstall)
- VS Code extension manifest changes (package.json contributes)
- Breaking changes to public APIs
- Actions that affect files outside the project directory

#### ❓ **"Always-Ask" Mode**  
*Activate by saying: "Use always-ask mode" or "Ask before changes"*

**Requires confirmation for everything except:**
- Reading/analyzing files
- Providing explanations and suggestions
- Running read-only commands (npm run lint --dry-run)

#### 🏗️ **"Default" Mode** (Current)
Follows the specific rules defined below - some actions auto-approved, others require confirmation.

### Mode Switching Commands

**Current Status:** Claude Code only supports built-in slash commands (`/init`, `/pr-comments`, `/review`). Custom slash commands are not yet supported.

**Alternative Methods for Mode Switching:**

1. **Direct Commands** (Recommended):
   - **`"Use go-it-alone mode"`** - Switch to autonomous mode
   - **`"Use always-ask mode"`** - Switch to confirmation-required mode  
   - **`"Use default mode"`** - Return to balanced mode

2. **Reference Mode Files** (For detailed instructions):
   - **`"Execute go-it-alone.md"`** - Reads and activates autonomous mode
   - **`"Execute always-ask.md"`** - Reads and activates confirmation mode
   - **`"Execute default-mode.md"`** - Reads and activates default mode

**Files available for reference:**
- `go-it-alone.md` - Detailed autonomous mode instructions
- `always-ask.md` - Detailed confirmation mode instructions  
- `default-mode.md` - Detailed default mode instructions

**Quick Reference:**
```
"Use go-it-alone mode"     → Autonomous operation on project content
"Use always-ask mode"      → Require confirmation for all changes
"Use default mode"         → Balanced approach with specific rules
```

---

### Auto-Approval Actions (No Confirmation Required in Default Mode)
- **Build & Test Workflow**: 
  - Run `npm run compile` after TypeScript changes
  - Run `npm run package && code --install-extension notion-interface-0.1.0.vsix --force` for testing changes
  - Run `npm run lint` to check code quality
- **Code Maintenance**:
  - Remove debug `console.log` statements after debugging is complete
  - Update TodoWrite progress tracking during development
  - Fix TypeScript compilation errors
  - Clean up unused imports or variables
- **Documentation Updates**:
  - Update inline code comments for clarity
  - Modify this CLAUDE.md file when architecture changes
  - Update JSDoc comments for public methods

### Requires Confirmation First
- **Dependency Changes**:
  - Adding, removing, or updating npm dependencies
  - Modifying `package.json` scripts or metadata
- **Extension Configuration**:
  - Changes to VS Code extension manifest (`package.json` contributes section)
  - Modifying command registration or menu structures
  - Changing extension activation events
- **Breaking Changes**:
  - Altering public API interfaces
  - Modifying database schema expectations
  - Changing file storage formats or cache structure
  - Removing existing functionality or commands
- **File Operations**:
  - Creating new files (prefer editing existing ones)
  - Deleting files or large code sections
  - Restructuring project directories

### Development Preferences
- **Code Style**: Follow existing TypeScript patterns and error handling conventions
- **Debugging**: Use consistent console.log prefixes for debugging (e.g., `=== SECTION ===`, `DEBUG:`)
- **Performance**: Prioritize user experience - batch API calls, use background caching
- **Error Handling**: Always provide user-friendly error messages in VS Code notifications
- **Testing**: Test extension changes by installing the .vsix package in a fresh VS Code window

### Context-Specific Rules
- **Notion API Integration**: Respect rate limits, implement proper error handling for network failures
- **VS Code Integration**: Use proper VS Code APIs, maintain context variables for UI state
- **Caching System**: Preserve cache invalidation logic, maintain timestamp-based validation
- **Search Functionality**: Keep Fuse.js configuration tuned for current performance (threshold: 0.6)

## Future Development Notes

### Potential Improvements
- Multi-database support (remove hardcoded database ID)
- More sophisticated markdown-to-blocks conversion
- Real-time collaboration features
- Enhanced property-based filtering UI
- Export/import functionality

### Architecture Considerations
- The current design is tightly coupled to a specific database schema
- Consider abstracting database configuration into settings
- Property handling could be made more generic
- Caching system could be enhanced with TTL and size limits

---

**Last Updated**: Based on codebase analysis as of extension version 0.1.0
**Key Files**: All source files analyzed in `/Users/kmt/vscode-extension/vsnotion/src/`