# Default Mode

Activate "default" operating mode as defined in CLAUDE.md.

This is the balanced mode with specific rules for when to ask for confirmation vs. when to proceed automatically.

**Auto-approved actions:**
- Build & test workflow (compile, package, install extension)
- Code maintenance (remove debug logs, fix TypeScript errors, cleanup)
- Documentation updates (comments, CLAUDE.md updates)

**Requires confirmation:**
- Dependency changes (npm install/uninstall)
- Extension configuration (package.json contributes section)
- Breaking changes (API modifications, schema changes)
- File operations (creating new files, deleting files)

Follow the development preferences and context-specific rules defined in CLAUDE.md.

Continue with the previous task or await new instructions in this balanced mode.