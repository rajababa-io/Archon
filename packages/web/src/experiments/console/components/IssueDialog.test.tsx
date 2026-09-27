import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { IssueThread } from './IssueDialog';
import { Markdown } from './Markdown';
import type { GithubIssueDetail } from '../skills';

const NOW = Date.parse('2026-09-23T12:00:00Z');

const detail = (over: Partial<GithubIssueDetail> = {}): GithubIssueDetail => ({
  number: 42,
  title: 'A board that cannot say why it is empty',
  state: 'OPEN',
  stateReason: null,
  url: 'https://github.com/o/r/issues/42',
  updatedAt: '2026-09-23T11:00:00Z',
  type: 'Bug',
  labels: [],
  assignees: [],
  openPr: false,
  body: 'The **reason** is missing.',
  author: 'ameet',
  createdAt: '2026-09-23T10:00:00Z',
  comments: [],
  moreComments: 0,
  ...over,
});

describe('IssueThread', () => {
  test('renders the body as markdown, not as the source text', () => {
    const html = renderToStaticMarkup(
      <IssueThread detail={detail()} url="https://github.com/o/r/issues/42" now={NOW} />
    );
    expect(html).toContain('<strong>reason</strong>');
    expect(html).not.toContain('**reason**');
  });

  test('an issue opened with no description says so instead of rendering blank', () => {
    const html = renderToStaticMarkup(
      <IssueThread detail={detail({ body: '   ' })} url="u" now={NOW} />
    );
    expect(html).toContain('No description.');
  });

  test('a deleted account is named, not left undefined', () => {
    const html = renderToStaticMarkup(
      <IssueThread detail={detail({ author: null })} url="u" now={NOW} />
    );
    expect(html).toContain('ghost');
    expect(html).not.toContain('undefined');
  });

  test('comments carry their author and their own timestamp', () => {
    const html = renderToStaticMarkup(
      <IssueThread
        detail={detail({
          comments: [
            { id: 'c1', author: 'rob', createdAt: '2026-09-23T11:30:00Z', body: 'Agreed.' },
          ],
        })}
        url="u"
        now={NOW}
      />
    );
    expect(html).toContain('rob');
    expect(html).toContain('30m ago');
    expect(html).toContain('Agreed.');
  });

  test('comments past the fetched page are counted, with a way to reach them', () => {
    const html = renderToStaticMarkup(
      <IssueThread detail={detail({ moreComments: 7 })} url="https://gh/x" now={NOW} />
    );
    expect(html).toContain('7 more comments on');
    expect(html).toContain('https://gh/x');
  });

  test('a single remaining comment is not pluralised', () => {
    const html = renderToStaticMarkup(
      <IssueThread detail={detail({ moreComments: 1 })} url="u" now={NOW} />
    );
    expect(html).toContain('1 more comment on');
  });

  test('says nothing about more comments when the page held them all', () => {
    const html = renderToStaticMarkup(<IssueThread detail={detail()} url="u" now={NOW} />);
    expect(html).not.toContain('more comment');
  });
});

/**
 * An issue body is written by whoever opened the issue, including someone who
 * is not the operator. It reaches this renderer as raw markdown from GitHub,
 * so the question of whether it can become live HTML is a real one, and the
 * answer has to be enforced rather than assumed.
 */
describe('Markdown', () => {
  test('HTML in an issue body is shown, not executed', () => {
    const html = renderToStaticMarkup(
      <Markdown>{'<img src=x onerror="alert(1)"> and <script>alert(2)</script>'}</Markdown>
    );
    // Escaped, so it is visible as the text someone typed and inert as markup.
    expect(html).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
  });

  test('a javascript: link is not turned into one', () => {
    const html = renderToStaticMarkup(<Markdown>{'[click](javascript:alert(1))'}</Markdown>);
    expect(html).not.toContain('javascript:alert');
  });

  test('GitHub-flavoured extras survive — tables and task lists', () => {
    const html = renderToStaticMarkup(
      <Markdown>{'| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done'}</Markdown>
    );
    expect(html).toContain('<table>');
    expect(html).toContain('type="checkbox"');
  });
});

/**
 * An image scaled into the message column is unreadable, so it has to open at
 * full size. That used to depend on each agent wrapping it in a link by hand.
 */
describe('Markdown images', () => {
  test('a bare image opens its full-size self', () => {
    const html = renderToStaticMarkup(<Markdown>{'![diagram](/files/a/pic.jpg)'}</Markdown>);
    expect(html).toContain('<a href="/files/a/pic.jpg" target="_blank"');
    expect(html).toContain('<img src="/files/a/pic.jpg" alt="diagram"/>');
  });

  test('an image the author already linked keeps that link, and only that one', () => {
    const html = renderToStaticMarkup(
      <Markdown>{'[![diagram](/files/a/pic.jpg)](https://example.com/full.jpg)'}</Markdown>
    );
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('href="https://example.com/full.jpg"');
    expect(html).toContain('<img src="/files/a/pic.jpg"');
  });
});
