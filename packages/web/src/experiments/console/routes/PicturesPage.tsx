import { ArrowLeft } from 'lucide-react';
import { useState, type ReactElement } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { EmptyState } from '../components/EmptyState';
import { PictureGrid, TopicChips } from '../components/PicturesBand';
import * as skill from '../skills';
import type { ProjectPicture, ProjectPictures } from '../skills';
import { useEntityViews } from '../store/cache';
import { K } from '../store/keys';
import { useNow } from '../lib/clock';
import { topicLabel } from '../lib/picture-caption';

/** Pictures per request. Each page is its own cache entry, so "Load more" never re-asks for the last. */
const PAGE = 48;
/** Topic chips before "+N more". */
const GALLERY_TOPIC_CHIPS = 16;

/**
 * Every picture a project has published, newest first (#350) — where the
 * Overview band's "See all" goes. The topic filter lives in the URL so a
 * filtered gallery can be linked to.
 */
export function PicturesPage(): ReactElement {
  const { projectId = '' } = useParams<{ projectId: string }>();
  const [params, setParams] = useSearchParams();
  const topic = params.get('topic');
  const [pages, setPages] = useState(1);
  const now = useNow();

  const views = useEntityViews<ProjectPictures>(
    Array.from({ length: pages }, (_, i) => ({
      key: K.pictures(projectId, topic ?? '', PAGE, i * PAGE),
      loader: (): Promise<ProjectPictures> =>
        skill.listProjectPictures(projectId, { limit: PAGE, offset: i * PAGE, topic }),
    }))
  );
  const first = views[0]?.data;
  const failed = views.find(v => v.error !== undefined)?.error;
  const pictures: ProjectPicture[] = views.flatMap(v => v.data?.pictures ?? []);
  const loading = views.some(v => v.data === undefined && v.error === undefined);

  const pickTopic = (next: string | null): void => {
    setPages(1);
    setParams(next === null ? {} : { topic: next }, { replace: true });
  };

  if (projectId === '') return <EmptyState title="No project." />;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6.25 pb-6.25 pt-3">
      <div className="mx-auto flex max-w-[1100px] flex-col gap-3">
        <div className="flex items-center gap-2">
          <Link
            to={`/console/p/${projectId}/overview`}
            className="inline-flex items-center gap-1 text-mini text-text-tertiary hover:text-text-primary"
          >
            <ArrowLeft className="h-3 w-3" />
            Overview
          </Link>
          <h1 className="text-mini font-medium text-text-tertiary">
            · Pictures
            {first !== undefined
              ? topic === null
                ? ` · ${String(first.all)}`
                : ` · ${topicLabel(topic)} · ${String(first.total)} of ${String(first.all)}`
              : ''}
          </h1>
        </div>
        {failed !== undefined ? (
          <EmptyState title="Could not read the pictures." hint={failed.message} />
        ) : first === undefined ? (
          <p className="text-body text-text-tertiary">Loading…</p>
        ) : first.all === 0 ? (
          <EmptyState title="No pictures published for this project yet." />
        ) : (
          <>
            <TopicChips
              topics={first.topics}
              value={topic}
              onChange={pickTopic}
              shown={GALLERY_TOPIC_CHIPS}
            />
            <PictureGrid pictures={pictures} now={now} />
            {pictures.length < first.total ? (
              <button
                type="button"
                disabled={loading}
                onClick={() => {
                  setPages(n => n + 1);
                }}
                className="self-center rounded border border-border px-3 py-1 text-small text-text-secondary transition-colors hover:border-border-bright hover:text-text-primary disabled:opacity-50"
              >
                {loading ? 'Loading…' : `Load more · ${String(first.total - pictures.length)} left`}
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
