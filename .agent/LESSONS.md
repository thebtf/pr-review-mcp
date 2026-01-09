# Learned Lessons — PR Review MCP

## MCP Protocol

### ❌ Wrong: Content-Length Framing
```javascript
// This does NOT work with @modelcontextprotocol/sdk
const packet = `Content-Length: ${len}\r\n\r\n${json}`;
server.stdin.write(packet);
```

### ✅ Correct: Newline-Delimited JSON
```javascript
// SDK uses newline-delimited JSON
server.stdin.write(JSON.stringify(msg) + '\n');
```

### ❌ Wrong: Testing via Direct Imports
```javascript
// This tests the function, NOT the MCP server
import { prSummary } from './dist/tools/summary.js';
const result = await prSummary(input, client);
```

### ✅ Correct: Testing via MCP Protocol
```javascript
// Spawn server and communicate via JSON-RPC
const server = spawn('node', ['dist/index.js']);
const result = await send('tools/call', { name: 'pr_summary', arguments: {...} });
```

---

## Agent Detection Patterns

| Agent | Author Login | Comment Type |
|-------|--------------|--------------|
| CodeRabbit | `coderabbitai[bot]` | Review thread |
| Gemini | `gemini-code-assist[bot]` | Review thread |
| Copilot | `copilot-pull-request-reviewer[bot]` | Review thread |
| Sourcery | `sourcery-ai[bot]` | Review thread |
| Codex | `chatgpt-codex-connector[bot]` | Review thread |
| **Qodo** | `qodo-code-review[bot]` | **Issue comment** |

**Key Insight:** Qodo is the outlier — uses issue comments, not review threads.

---

## Qodo Specifics

### Persistent Review Pattern
- Posts ONE comment with marker `## PR Reviewer Guide 🔍`
- Updates that same comment on each new commit
- Notification comments: `**[Persistent review](link)** updated...`

### Parsing Structure
```markdown
## PR Reviewer Guide 🔍
#### (Review updated until commit ...)

<table>
  <tr><td>🔒 Security concerns - CRIT</td></tr>
  <tr><td>⚡ Recommended focus areas:
    <details><summary><a href='...#diff-...R83-R120'>Title</a>
    ```code```
    </details>
  </td></tr>
</table>
```

### Line Number Extraction
URL format: `...files#diff-{hash}R{start}-R{end}`
- `R` = right side (new file)
- Can't reverse hash to get file path

---

## Windows Compatibility

### MSYS Path Conversion Issue
```bash
# Git Bash converts /review to C:/Program Files/Git/review
gh pr comment 1 --body "/review"  # FAILS
```

### Solution
```javascript
const env = process.platform === 'win32'
  ? { ...process.env, MSYS_NO_PATHCONV: '1' }
  : process.env;
spawnSync('gh', args, { env });
```

---

## Architecture Decisions

### Adapter Pattern for Qodo
- **Why**: Different data source (issue comments vs review threads)
- **Benefit**: Isolates parsing complexity
- **Implementation**: `src/adapters/qodo.ts`

### Parallel Fetching
```javascript
const [threads, qodo] = await Promise.all([
  fetchAllThreads(...),
  fetchQodoReview(...)
]);
```
- Reduces latency
- Both are independent API calls

### Fire-and-Forget Invocation
- `pr_invoke` posts comment and returns
- No polling for agent response
- Keeps server stateless

---

## Common Pitfalls

| Pitfall | Solution |
|---------|----------|
| Testing functions directly | Always test via MCP protocol |
| Using `gh` CLI in tests | Use MCP tools |
| Assuming all agents use review threads | Check for issue comments too |
| PowerShell `&&` syntax | Use `cmd` shell or `;` |
| Content-Length framing | Use newline-delimited JSON |

---

## Useful Commands

```bash
# Build
npm run build

# Test with MCP Inspector (interactive)
npx @modelcontextprotocol/inspector node dist/index.js

# Get Qodo comment
gh api repos/OWNER/REPO/issues/PR/comments --jq '.[] | select(.user.login == "qodo-code-review[bot]")'

# List reviews
gh api repos/OWNER/REPO/pulls/PR/reviews --jq '.[] | {user: .user.login, state}'
```
