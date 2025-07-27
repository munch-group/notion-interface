# Development Guide

This document provides a quick reference for developing the Notion Interface VS Code extension using the pixi environment.

## Pixi Environment

This project uses [pixi](https://prefix.dev/) for managing dependencies and development tasks. Pixi provides a consistent development environment across different machines.

### Setup

First, ensure you have pixi installed, then set up the environment:

```bash
pixi install
```

This will install Node.js >=18.0.0 and set up the development environment.

## Available Pixi Tasks

### Development Workflow

- **`pixi run dev-setup`** - Install dependencies and compile TypeScript
- **`pixi run dev-install`** - Same as dev-setup 
- **`pixi run compile`** - Compile TypeScript to JavaScript
- **`pixi run watch`** - Watch and recompile on changes

### Build & Package

- **`pixi run build`** - Build the extension
- **`pixi run package`** - Create .vsix package file
- **`pixi run full-build`** - Complete pipeline: install, lint, compile, package

### Quality & Testing

- **`pixi run lint`** - Run ESLint (requires ESLint config)
- **`pixi run test`** - Run extension tests
- **`pixi run dev-test`** - Package and install extension for testing in VS Code

### Utilities

- **`pixi run clean`** - Clean build artifacts and cache
- **`pixi install`** - Set up the pixi environment

## Quick Start

1. Set up the development environment:
   ```bash
   pixi run dev-setup
   ```

2. Start development with file watching:
   ```bash
   pixi run watch
   ```

3. Test your changes by packaging and installing the extension:
   ```bash
   pixi run dev-test
   ```

## Task Dependencies

Some tasks depend on others and will run them automatically:

- **`full-build`** runs: install → lint → compile → package
- **`dev-setup`** runs: install → compile

## Environment Details

The pixi environment includes:
- Node.js >=18.0.0
- Cross-platform support (macOS, Linux, Windows)
- Leverages existing npm scripts from package.json

All tasks use the `pixi run <task>` command for a consistent development workflow across different machines.