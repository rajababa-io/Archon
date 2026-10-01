/**
 * What a picture is called under its thumbnail. The topic folder it was
 * published in is the name an agent gave the work, so it is the caption;
 * a picture at the top of the project folder has only its file name.
 *
 * `337-pill-orange` reads `#337 pill orange`: a folder named for an issue
 * leads with its number, the way the chat titles do.
 */
export function pictureCaption(p: { topic: string | null; name: string }): string {
  if (p.topic === null) return p.name.replace(/\.[^.]+$/, '');
  return topicLabel(p.topic);
}

export function topicLabel(topic: string): string {
  const issue = /^(\d+)(?:-(.+))?$/.exec(topic);
  if (issue !== null) {
    const [, n, rest] = issue;
    return rest === undefined ? `#${n ?? ''}` : `#${n ?? ''} ${rest.replace(/-/g, ' ')}`;
  }
  return topic.replace(/-/g, ' ');
}

/** `2h`, `3d`, `just now` — the compact age under a thumbnail. */
export function pictureAge(iso: string, now: number = Date.now()): string {
  const s = Math.floor((now - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${String(Math.floor(s / 60))}m`;
  if (s < 86400) return `${String(Math.floor(s / 3600))}h`;
  return `${String(Math.floor(s / 86400))}d`;
}
