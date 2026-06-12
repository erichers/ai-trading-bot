import { useEffect, useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { api } from '@/api/client';
import type { NewsItem } from '@/api/types';
import { timeAgo } from '@/lib/format';
import { Panel, Spinner, Empty, ErrorState, Badge, Toggle } from '@/components/ui';
import { useAppData } from '@/hooks/useAppData';
import { useWebSocket } from '@/hooks/useWebSocket';
import { usePolling } from '@/hooks/usePolling';

type Filter = 'all' | 'watchlist';

const NEWS_LIMIT = 40;

const ts = (item: NewsItem): number => {
  const t = new Date(item.created_at).getTime();
  return Number.isNaN(t) ? 0 : t;
};

const mergeNews = (base: NewsItem[], extra: NewsItem[]): NewsItem[] => {
  const byId = new Map<string, NewsItem>();
  for (const it of [...extra, ...base]) {
    const key = String(it.id);
    if (!byId.has(key)) byId.set(key, it);
  }
  return Array.from(byId.values()).sort((a, b) => ts(b) - ts(a));
};

function Thumbnail({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return null;
  return (
    <img
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      className="w-16 h-16 shrink-0 rounded object-cover border border-border bg-panel-2"
      loading="lazy"
    />
  );
}

function NewsCard({ item }: { item: NewsItem }) {
  return (
    <article className="flex gap-3 px-3 py-3 border-b border-border hover:bg-panel-2/50 transition-colors">
      {item.image ? <Thumbnail src={item.image} alt={item.headline} /> : null}
      <div className="flex-1 min-w-0">
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="group inline-flex items-start gap-1 text-sm font-medium text-text hover:text-amber leading-snug"
        >
          <span>{item.headline}</span>
          <ExternalLink className="w-3 h-3 mt-0.5 shrink-0 opacity-0 group-hover:opacity-60" />
        </a>
        {item.summary ? (
          <p className="mt-1 text-xs text-text-dim line-clamp-2 leading-relaxed">{item.summary}</p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted">
          {item.source ? (
            <span className="uppercase tracking-wider text-text-dim">{item.source}</span>
          ) : null}
          {item.author ? (
            <>
              <span className="text-border-2">·</span>
              <span>{item.author}</span>
            </>
          ) : null}
          <span className="text-border-2">·</span>
          <span>{timeAgo(item.created_at)}</span>
          {item.symbols?.length ? (
            <span className="flex flex-wrap items-center gap-1 ml-1">
              {item.symbols.slice(0, 8).map((s) => (
                <Badge key={s} tone="amber">
                  {s}
                </Badge>
              ))}
            </span>
          ) : null}
        </div>
      </div>
    </article>
  );
}

export function News() {
  const { watchlist } = useAppData();
  const { lastNews } = useWebSocket();
  const [filter, setFilter] = useState<Filter>('all');
  const [pushed, setPushed] = useState<NewsItem[]>([]);

  const symbols = filter === 'watchlist' ? watchlist : undefined;

  const {
    data,
    error,
    loading,
    refetch,
  } = usePolling<NewsItem[]>(
    () => api.news(symbols, NEWS_LIMIT),
    30000,
    [filter, watchlist.join(',')],
  );

  // Reset ws-pushed items when the filter changes so they don't bleed across views.
  useEffect(() => {
    setPushed([]);
  }, [filter, watchlist.join(',')]);

  // Merge each new ws push into local state (deduped by id).
  useEffect(() => {
    if (!lastNews) return;
    const id = String(lastNews.id);
    // If watchlist filter is active, only keep pushes touching a watched symbol.
    if (filter === 'watchlist') {
      const set = new Set(watchlist);
      if (!lastNews.symbols?.some((s) => set.has(s))) return;
    }
    setPushed((prev) =>
      prev.some((p) => String(p.id) === id) ? prev : [lastNews, ...prev],
    );
  }, [lastNews, filter, watchlist]);

  const items = useMemo(() => mergeNews(data ?? [], pushed), [data, pushed]);

  const onChange = (v: string) => setFilter(v as Filter);

  const right = (
    <Toggle
      value={filter}
      onChange={onChange}
      options={[
        { value: 'all', label: 'All' },
        { value: 'watchlist', label: 'Watchlist' },
      ]}
    />
  );

  let body;
  if (loading && items.length === 0) {
    body = <Spinner label="Loading news" />;
  } else if (error && items.length === 0) {
    body = <ErrorState label={error.message || 'Failed to load news'} onRetry={refetch} />;
  } else if (items.length === 0) {
    body = (
      <Empty
        label={filter === 'watchlist' ? 'No news for watchlist' : 'No news'}
      />
    );
  } else {
    body = (
      <div className="h-full overflow-y-auto">
        {items.map((item) => (
          <NewsCard key={String(item.id)} item={item} />
        ))}
      </div>
    );
  }

  return (
    <div className="h-full p-2">
      <Panel title="News Feed" right={right} className="h-full" bodyClassName="overflow-hidden">
        {body}
      </Panel>
    </div>
  );
}
