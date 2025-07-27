# Always-Ask Mode

Activate "always-ask" operating mode as defined in CLAUDE.md.

In this mode, require confirmation before making ANY changes to files or running ANY commands, except for:
- Reading and analyzing files
- Providing explanations and suggestions
- Running read-only commands (like npm run lint --dry-run)

Ask for explicit permission before:
- Modifying any source code files
- Running build/compile commands
- Installing or updating dependencies
- Creating or deleting files
- Making any changes to project configuration
- Running tests or other commands that might modify state

This mode provides maximum control and oversight for sensitive development work.

Continue with the previous task or await new instructions in this confirmation-required mode.