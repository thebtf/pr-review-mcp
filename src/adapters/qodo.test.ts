import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { type Octokit } from '@octokit/rest';
import { fetchQodoReview } from './qodo.js';

type MockComment = {
  id: number;
  html_url: string;
  updated_at: string;
  body: string;
};

type MockFile = {
  filename: string;
};

function createMockOctokit(
  comments: Array<{ id: number; html_url: string; updated_at: string; body: string; user?: { login?: string | null } }>,
  files: Array<{ filename: string }>
): Octokit {
  const listFiles = async (): Promise<MockFile[]> => files;
  const listComments = async (): Promise<MockComment[]> => comments;

  return {
    paginate: async (operation: (...args: unknown[]) => unknown): Promise<unknown> => {
      if (operation === listFiles) {
        return listFiles();
      }

      if (operation === listComments) {
        return listComments();
      }

      return [];
    },
    pulls: {
      listFiles
    },
    issues: {
      listComments
    }
  } as unknown as Octokit;
}

describe('qodo adapter', () => {
  it('parses focus areas from single and double quoted href variants', async () => {
    const fileHash = createHash('sha256').update('src/feature.ts').digest('hex');
    const singleQuoteUrl = `https://github.com/owner/repo/pull/10/files#diff-${fileHash}R10-R12`;
    const doubleQuoteUrl = `https://github.com/owner/repo/pull/10/files#diff-${fileHash}R42`;
    const body = [
      '<h3>## PR Reviewer Guide</h3>',
      `<details><summary><a href='${singleQuoteUrl}'><strong>Single quote focus</strong></a></summary>`,
      'Review this code path',
      '</details>',
      `<details><summary><a href="${doubleQuoteUrl}"><strong>Double quote focus</strong></a></summary>`,
      'Check validation',
      '</details>'
    ].join('\n');

    const octokit = createMockOctokit(
      [
        {
          id: 777,
          html_url: 'https://github.com/owner/repo/pull/10#issuecomment-777',
          updated_at: '2026-03-01T10:00:00Z',
          body,
          user: {
            login: 'qodo-code-review[bot]'
          }
        }
      ],
      [
        {
          filename: 'src/feature.ts'
        }
      ]
    );

    const review = await fetchQodoReview('owner', 'repo', 10, octokit);

    expect(review).not.toBeNull();
    expect(review?.focusAreas).toHaveLength(2);
    expect(review?.focusAreas[0]).toMatchObject({
      title: 'Single quote focus',
      file: 'src/feature.ts',
      line: 10,
      lineEnd: 12,
      url: singleQuoteUrl
    });
    expect(review?.focusAreas[1]).toMatchObject({
      title: 'Double quote focus',
      file: 'src/feature.ts',
      line: 42,
      lineEnd: 42,
      url: doubleQuoteUrl
    });
  });

  it('returns empty focus areas when no details blocks are present', async () => {
    const octokit = createMockOctokit(
      [
        {
          id: 778,
          html_url: 'https://github.com/owner/repo/pull/11#issuecomment-778',
          updated_at: '2026-03-01T10:00:00Z',
          body: '<h3>## PR Reviewer Guide</h3>',
          user: {
            login: 'qodo-code-review[bot]'
          }
        }
      ],
      []
    );

    const review = await fetchQodoReview('owner', 'repo', 11, octokit);

    expect(review).not.toBeNull();
    expect(review?.focusAreas).toHaveLength(0);
    expect(review?.securityConcerns).toHaveLength(0);
  });
});
