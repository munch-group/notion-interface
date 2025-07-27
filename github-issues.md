# GitHub Issues to Implement

## Feature: Update Notion Page Title from YAML Frontmatter

**Issue Title:** Support updating Notion page title when YAML frontmatter title is changed

**Description:**
Currently, when a user modifies the `title` field in the Quarto YAML frontmatter block, the change is not propagated to Notion. The title is extracted and parsed but only the page content is uploaded, leaving the original Notion page title unchanged.

**Expected Behavior:**
When uploading changes to Notion, if the title in the YAML frontmatter differs from the current Notion page title, the extension should update the Notion page title to match.

**Implementation Details:**
1. Modify `updatePageContent()` in `NotionService` to accept an optional title parameter
2. Use Notion API's page update endpoint to modify the page title property (typically the "Name" or "Title" property in database pages)
3. Update all upload functions (`uploadChanges()`, `uploadAllChanges()`, auto-sync) to pass the extracted title
4. Add proper error handling for title update failures
5. Consider adding a user setting to enable/disable automatic title updates

**Files to Modify:**
- `src/notionService.ts` - Update `updatePageContent()` method
- `src/extension.ts` - Update all upload functions to pass title
- `package.json` - Add configuration option for title sync

**Priority:** Medium
**Labels:** enhancement, notion-api, title-sync