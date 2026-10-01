import { describe, expect, test } from 'bun:test';
import { pictureAge, pictureCaption, topicLabel } from './picture-caption';

describe('pictureCaption', () => {
  test('a topic folder named for an issue leads with its number', () => {
    expect(pictureCaption({ topic: '337-pill-orange', name: 'a.png' })).toBe('#337 pill orange');
    expect(topicLabel('320')).toBe('#320');
  });

  test('any other topic folder reads with spaces', () => {
    expect(pictureCaption({ topic: 'chat-titles', name: 'a.png' })).toBe('chat titles');
  });

  test('a picture at the top of the project folder is its file name', () => {
    expect(pictureCaption({ topic: null, name: 'deploy-flow.v2.png' })).toBe('deploy-flow.v2');
  });
});

describe('pictureAge', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  test('compact units', () => {
    expect(pictureAge('2026-10-01T11:59:30Z', now)).toBe('just now');
    expect(pictureAge('2026-10-01T11:15:00Z', now)).toBe('45m');
    expect(pictureAge('2026-10-01T10:00:00Z', now)).toBe('2h');
    expect(pictureAge('2026-09-28T12:00:00Z', now)).toBe('3d');
  });
});
