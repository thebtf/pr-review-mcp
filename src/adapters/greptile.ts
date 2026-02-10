/**
 * Greptile Adapter - Parses Greptile's issue comment format
 *
 * Greptile posts:
 * 1. One issue comment with overview (Summary, Confidence Score, Files)
 * 2. Multiple inline review comments with code suggestions
 *
 * This adapter handles the issue comment parsing. Inline comments are
 * handled by the standard review thread mechanism.
 */

import { getOctokit } from '../github/octokit.js';

export interface GreptileComment {
  id: string;
  source: 'greptile';
  file: string;
  line: number | null;
  lineEnd: number | null;
  severity: 'CRIT' | 'MAJOR' | 'MINOR' | 'N/A';
  title: string;
  body: string;
  url: string;
  resolved: false; // Greptile comments can't be resolved via thread API
}

export interface GreptileReview {
  commentId: number;
  commentUrl: string;
  updatedAt: string;
  confidenceScore: number; // 1-5
  summary: string;
  criticalIssues: string[];
  importantFiles: GreptileComment[];
}

const GREPTILE_BOT = 'greptile-apps';
const MARKER = 'Greptile Overview';

/**
 * Fetch Greptile's overview comment from a PR
 */
export async function fetchGreptileReview(
  owner: string,
  repo: string,
  pr: number
): Promise<GreptileReview | null> {
  const greptileComment = await fetchGreptileComment(owner, repo, pr);

  if (!greptileComment) {
    return null;
  }

  return parseGreptileComment(greptileComment, owner, repo, pr);
}

/**
 * Fetch the raw Greptile comment from issue comments
 */
async function fetchGreptileComment(
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

    // Find Greptile's overview comment
    for (const comment of comments) {
      if (comment.user?.login === GREPTILE_BOT && comment.body?.includes(MARKER)) {
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
 * Parse Greptile comment body into structured review
 */
function parseGreptileComment(
  comment: { id: number; html_url: string; updated_at: string; body: string },
  owner: string,
  repo: string,
  pr: number
): GreptileReview {
  const body = comment.body;

  // Extract confidence score (format: "Confidence Score: X/5")
  const confidenceMatch = body.match(/Confidence Score:\s*(\d)\/5/i);
  const confidenceScore = confidenceMatch ? parseInt(confidenceMatch[1]) : 3;

  // Extract summary (text between "Greptile Summary" and "Critical Issues")
  const summaryMatch = body.match(/<h3>Greptile Summary<\/h3>\s*([\s\S]*?)(?:<h3>|\*\*Critical Issues|$)/i);
  const summary = summaryMatch?.[1]
    ?.replace(/<[^>]+>/g, ' ')
    .replace(/\*\*/g, '')
    .trim()
    .slice(0, 500) || '';

  // Parse critical issues (bullet points after "Critical Issues Found:")
  const criticalIssues = parseCriticalIssues(body);

  // Parse important files table
  const importantFiles = parseImportantFiles(body, comment.id, owner, repo, pr);

  return {
    commentId: comment.id,
    commentUrl: comment.html_url,
    updatedAt: comment.updated_at,
    confidenceScore,
    summary,
    criticalIssues,
    importantFiles
  };
}

/**
 * Parse critical issues from the summary section
 */
function parseCriticalIssues(body: string): string[] {
  const issues: string[] = [];

  // Find "Critical Issues Found:" section
  const criticalMatch = body.match(/\*\*Critical Issues Found:\*\*\s*([\s\S]*?)(?:\n\n|\*\*|<h3>)/i);
  if (!criticalMatch) return issues;

  const section = criticalMatch[1];

  // Extract bullet points (lines starting with -)
  const bulletRegex = /^-\s+(.+)$/gm;
  let match;

  while ((match = bulletRegex.exec(section)) !== null) {
    const issue = match[1]
      .replace(/<[^>]+>/g, '')
      .replace(/\*\*/g, '')
      .trim();
    if (issue) {
      issues.push(issue);
    }
  }

  return issues;
}

/**
 * Parse important files from the table section
 */
function parseImportantFiles(
  body: string,
  commentId: number,
  owner: string,
  repo: string,
  pr: number
): GreptileComment[] {
  const comments: GreptileComment[] = [];

  // Find table rows (format: | filename | description |)
  const tableMatch = body.match(/<h3>Important Files Changed<\/h3>[\s\S]*?<\/summary>([\s\S]*?)<\/details>/i);
  if (!tableMatch) return comments;

  const tableContent = tableMatch[1];
  const rowRegex = /\|\s*([^\|]+?)\s*\|\s*([^\|]+?)\s*\|/g;
  let match;
  let index = 0;

  while ((match = rowRegex.exec(tableContent)) !== null) {
    const filename = match[1].trim();
    const overview = match[2].trim();

    // Skip header row
    if (filename === 'Filename' || filename.includes('---')) continue;

    // Determine severity based on keywords in overview
    let severity: 'CRIT' | 'MAJOR' | 'MINOR' | 'N/A' = 'MAJOR';
    const overviewLower = overview.toLowerCase();
    if (overviewLower.includes('critical') || overviewLower.includes('syntax error') || overviewLower.includes('runtime failure')) {
      severity = 'CRIT';
    } else if (overviewLower.includes('minor') || overviewLower.includes('copy-paste error')) {
      severity = 'MINOR';
    }

    comments.push({
      id: `greptile-file-${commentId}-${index}`,
      source: 'greptile',
      file: filename,
      line: null,
      lineEnd: null,
      severity,
      title: `File: ${filename}`,
      body: overview.slice(0, 500),
      url: `https://github.com/${owner}/${repo}/pull/${pr}#issuecomment-${commentId}`,
      resolved: false
    });

    index++;
  }

  return comments;
}

/**
 * Convert Greptile review to normalized comment format
 */
export function greptileToNormalizedComments(review: GreptileReview): GreptileComment[] {
  const comments: GreptileComment[] = [];

  // Add summary as a comment
  if (review.summary) {
    // Map confidence score to severity (1-2 = CRIT, 3 = MAJOR, 4-5 = MINOR)
    let severity: 'CRIT' | 'MAJOR' | 'MINOR' = 'MAJOR';
    if (review.confidenceScore <= 2) {
      severity = 'CRIT';
    } else if (review.confidenceScore >= 4) {
      severity = 'MINOR';
    }

    comments.push({
      id: `greptile-summary-${review.commentId}`,
      source: 'greptile',
      file: '',
      line: null,
      lineEnd: null,
      severity,
      title: `Greptile Overview (Confidence: ${review.confidenceScore}/5)`,
      body: review.summary,
      url: review.commentUrl,
      resolved: false
    });
  }

  // Add critical issues
  review.criticalIssues.forEach((issue, index) => {
    comments.push({
      id: `greptile-critical-${review.commentId}-${index}`,
      source: 'greptile',
      file: '',
      line: null,
      lineEnd: null,
      severity: 'CRIT',
      title: 'Critical Issue',
      body: issue,
      url: review.commentUrl,
      resolved: false
    });
  });

  // Add important files
  comments.push(...review.importantFiles);

  return comments;
}
