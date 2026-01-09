/**
 * Qodo Adapter - Parses Qodo's persistent issue comment format
 *
 * Qodo posts a single "persistent review" as an issue comment (not inline review)
 * and updates it on each commit. This adapter fetches and parses that comment.
 */

import { createHash } from 'crypto';
import { getOctokit } from '../github/octokit.js';

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
 * Fetch PR files and create a map of diff hash -> file path
 * GitHub uses SHA256 of the file path for diff anchors
 */
async function fetchPRFilesMap(
  owner: string,
  repo: string,
  pr: number
): Promise<Map<string, string>> {
  const fileMap = new Map<string, string>();

  try {
    const octokit = getOctokit();
    const files = await octokit.paginate(
      octokit.pulls.listFiles,
      { owner, repo, pull_number: pr, per_page: 100 }
    );

    for (const file of files) {
      const hash = createHash('sha256').update(file.filename).digest('hex');
      fileMap.set(hash, file.filename);
    }
  } catch {
    // Return empty map on error
  }

  return fileMap;
}

/**
 * Extract file path from Qodo URL using the file hash map
 */
function resolveFileFromUrl(url: string, fileMap: Map<string, string>): string {
  // URL format: .../files#diff-{hash}R{start}-R{end}
  const hashMatch = url.match(/#diff-([a-f0-9]{64})/i);
  if (!hashMatch) return url;

  const hash = hashMatch[1].toLowerCase();
  return fileMap.get(hash) || url;
}

/**
 * Fetch Qodo's persistent review comment from a PR
 */
export async function fetchQodoReview(
  owner: string,
  repo: string,
  pr: number
): Promise<QodoReview | null> {
  // Fetch Qodo comment and PR files in parallel
  const [qodoResult, fileMap] = await Promise.all([
    fetchQodoComment(owner, repo, pr),
    fetchPRFilesMap(owner, repo, pr)
  ]);

  if (!qodoResult) {
    return null;
  }

  return parseQodoComment(qodoResult, owner, repo, pr, fileMap);
}

/**
 * Fetch the raw Qodo comment from issue comments
 */
async function fetchQodoComment(
  owner: string,
  repo: string,
  pr: number
): Promise<{ id: number; html_url: string; updated_at: string; body: string } | null> {
  try {
    const octokit = getOctokit();
    const comments = await octokit.paginate(
      octokit.issues.listComments,
      { owner, repo, issue_number: pr, per_page: 100 }
    );

    // Find Qodo's persistent review comment
    for (const comment of comments) {
      if (comment.user?.login === QODO_BOT && comment.body?.includes(MARKER)) {
        return {
          id: comment.id,
          html_url: comment.html_url,
          updated_at: comment.updated_at,
          body: comment.body
        };
      }
    }
  } catch {
    // Return null on error
  }

  return null;
}

/**
 * Parse Qodo comment body into structured review
 */
function parseQodoComment(
  comment: { id: number; html_url: string; updated_at: string; body: string },
  owner: string,
  repo: string,
  pr: number,
  fileMap: Map<string, string>
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

  // Parse focus areas with file path resolution
  const focusAreas = parseFocusAreas(body, comment.id, owner, repo, pr, fileMap);

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
  pr: number,
  fileMap: Map<string, string>
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

    // Resolve file path from URL hash
    const file = resolveFileFromUrl(url, fileMap);

    // Extract description from the details content
    const afterMatch = body.slice(match.index).match(/<\/summary>\s*([\s\S]*?)<\/details>/);
    const description = afterMatch?.[1]?.replace(/```[\s\S]*?```/g, '').replace(/<[^>]+>/g, ' ').trim().slice(0, 300) || '';

    const issueIndex = index;
    index++;
    comments.push({
      id: `qodo-focus-${commentId}-${issueIndex}`,
      source: 'qodo',
      file, // Now contains actual file path instead of URL
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
