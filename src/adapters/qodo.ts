/**
 * Qodo Adapter - Parses Qodo's persistent issue comment format
 * 
 * Qodo posts a single "persistent review" as an issue comment (not inline review)
 * and updates it on each commit. This adapter fetches and parses that comment.
 */

import { spawnSync } from 'child_process';

export interface QodoComment {
  id: string;
  source: 'qodo';
  file: string;
  line: number | null;
  lineEnd: number | null;
  severity: 'CRIT' | 'MAJOR' | 'MINOR' | 'N/A';
  title: string;
  body: string;
  url: string;
  resolved: false; // Qodo comments can't be resolved via thread API
}

export interface QodoReview {
  commentId: number;
  commentUrl: string;
  updatedAt: string;
  commitSha: string;
  effort: number;
  hasTests: boolean;
  securityConcerns: QodoComment[];
  focusAreas: QodoComment[];
}

const QODO_BOT = 'qodo-code-review[bot]';
const MARKER = 'PR Reviewer Guide';

/**
 * Fetch Qodo's persistent review comment from a PR
 */
export async function fetchQodoReview(
  owner: string,
  repo: string,
  pr: number
): Promise<QodoReview | null> {
  // Fetch issue comments from Qodo bot
  const result = spawnSync('gh', [
    'api',
    `repos/${owner}/${repo}/issues/${pr}/comments`,
    '--jq', `.[] | select(.user.login == "${QODO_BOT}") | select(.body | contains("${MARKER}"))`
  ], {
    encoding: 'utf-8',
    maxBuffer: 5 * 1024 * 1024,
    windowsHide: true
  });

  if (result.status !== 0 || !result.stdout.trim()) {
    return null;
  }

  // Parse JSON (gh api with jq returns newline-separated JSON objects)
  const lines = result.stdout.trim().split('\n');
  let comment: { id: number; html_url: string; updated_at: string; body: string } | null = null;
  
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      // Take the first (and should be only) persistent review
      if (parsed.body?.includes(MARKER)) {
        comment = parsed;
        break;
      }
    } catch {
      continue;
    }
  }

  if (!comment) {
    return null;
  }

  return parseQodoComment(comment, owner, repo, pr);
}

/**
 * Parse Qodo comment body into structured review
 */
function parseQodoComment(
  comment: { id: number; html_url: string; updated_at: string; body: string },
  owner: string,
  repo: string,
  pr: number
): QodoReview {
  const body = comment.body;
  
  // Extract commit SHA
  const commitMatch = body.match(/commit\s+(?:https:\/\/github\.com\/[^/]+\/[^/]+\/commit\/)?([a-f0-9]{40})/i);
  const commitSha = commitMatch?.[1] || '';

  // Extract effort (1-5 blue circles)
  const effortMatch = body.match(/Estimated effort[^:]*:\s*(\d)/);
  const effort = effortMatch ? parseInt(effortMatch[1]) : 0;

  // Check for tests
  const hasTests = !body.includes('No relevant tests');

  // Parse security concerns
  const securityConcerns = parseSecurityConcerns(body, comment.id, owner, repo, pr);

  // Parse focus areas
  const focusAreas = parseFocusAreas(body, comment.id, owner, repo, pr);

  return {
    commentId: comment.id,
    commentUrl: comment.html_url,
    updatedAt: comment.updated_at,
    commitSha,
    effort,
    hasTests,
    securityConcerns,
    focusAreas
  };
}

/**
 * Parse security concerns section
 */
function parseSecurityConcerns(
  body: string,
  commentId: number,
  owner: string,
  repo: string,
  pr: number
): QodoComment[] {
  const comments: QodoComment[] = [];
  
  // Find security concerns section
  const securityMatch = body.match(/🔒.*?Security concerns.*?<\/td>/s);
  if (!securityMatch) return comments;

  const section = securityMatch[0];
  
  // Extract title (bold text after the icon)
  const titleMatch = section.match(/<strong>([^<]+)<\/strong>/);
  const title = titleMatch?.[1]?.trim() || 'Security concern';

  // Extract description (text after the title)
  const descMatch = section.match(/<\/strong>:?\s*<br\s*\/?>\s*([\s\S]*?)(?:<\/td>|$)/);
  const description = descMatch?.[1]?.replace(/<[^>]+>/g, ' ').trim() || '';

  if (title || description) {
    comments.push({
      id: `qodo-sec-${commentId}`,
      source: 'qodo',
      file: '', // Security concerns are often general
      line: null,
      lineEnd: null,
      severity: 'CRIT',
      title: title,
      body: description.slice(0, 500),
      url: `https://github.com/${owner}/${repo}/pull/${pr}#issuecomment-${commentId}`,
      resolved: false
    });
  }

  return comments;
}

/**
 * Parse focus areas (details/summary blocks)
 */
function parseFocusAreas(
  body: string,
  commentId: number,
  owner: string,
  repo: string,
  pr: number
): QodoComment[] {
  const comments: QodoComment[] = [];
  
  // Find all details blocks with file links
  const detailsRegex = /<details>\s*<summary>\s*<a\s+href='([^']+)'[^>]*>\s*<strong>([^<]+)<\/strong>/g;
  let match;
  let index = 0;

  while ((match = detailsRegex.exec(body)) !== null) {
    const url = match[1];
    const title = match[2].trim();
    
    // Parse file and line from URL
    // Format: .../files#diff-{hash}R{start}-R{end}
    const lineMatch = url.match(/R(\d+)(?:-R(\d+))?$/);
    const line = lineMatch ? parseInt(lineMatch[1]) : null;
    const lineEnd = lineMatch?.[2] ? parseInt(lineMatch[2]) : line;

    // Extract file path from diff hash (we can't reverse the hash, but we can show the link)
    // Try to find file name in the surrounding context
    const afterMatch = body.slice(match.index).match(/<\/summary>\s*([\s\S]*?)<\/details>/);
    const description = afterMatch?.[1]?.replace(/```[\s\S]*?```/g, '').replace(/<[^>]+>/g, ' ').trim().slice(0, 300) || '';

    comments.push({
      id: `qodo-focus-${commentId}-${index++}`,
      source: 'qodo',
      file: url, // Store URL since we can't easily get file path
      line,
      lineEnd,
      severity: 'MAJOR',
      title,
      body: description,
      url,
      resolved: false
    });
  }

  return comments;
}

/**
 * Convert Qodo review to normalized comment format (for merging with review threads)
 */
export function qodoToNormalizedComments(review: QodoReview): QodoComment[] {
  return [...review.securityConcerns, ...review.focusAreas];
}
