import { describe, expect, test } from 'bun:test';
import {
  activeProjectTab,
  activityNeedsYou,
  activitySummary,
  allProjectsSubtitle,
  headerPathLabel,
  showsInstallDeployStrip,
} from './project-header';

describe('activitySummary', () => {
  test('an idle project shows nothing, not a zero', () => {
    expect(activitySummary({ running: 0, paused: 0 })).toBeNull();
  });

  test('missing counts show nothing rather than a placeholder', () => {
    expect(activitySummary(null)).toBeNull();
    expect(activitySummary(undefined)).toBeNull();
  });

  test('counts runs in flight', () => {
    expect(activitySummary({ running: 1, paused: 0 })).toBe('1 running');
    expect(activitySummary({ running: 3, paused: 0 })).toBe('3 running');
  });

  test('surfaces paused runs, which are waiting on the user', () => {
    expect(activitySummary({ running: 0, paused: 2 })).toBe('2 paused');
    expect(activitySummary({ running: 2, paused: 1 })).toBe('2 running · 1 paused');
  });
});

describe('activityNeedsYou', () => {
  test('only a paused run is waiting on a person', () => {
    expect(activityNeedsYou({ running: 4, paused: 0 })).toBe(false);
    expect(activityNeedsYou({ running: 0, paused: 1 })).toBe(true);
    expect(activityNeedsYou(null)).toBe(false);
  });
});

describe('allProjectsSubtitle', () => {
  test('always says something, so the header never loses its second line', () => {
    expect(allProjectsSubtitle(5, { running: 0, paused: 0 })).toBe('5 projects');
    expect(allProjectsSubtitle(0, null)).toBe('0 projects');
  });

  test('singular reads as English', () => {
    expect(allProjectsSubtitle(1, null)).toBe('1 project');
  });

  test('appends activity when there is any', () => {
    expect(allProjectsSubtitle(5, { running: 1, paused: 0 })).toBe('5 projects · 1 running');
    expect(allProjectsSubtitle(5, { running: 1, paused: 2 })).toBe(
      '5 projects · 1 running · 2 paused'
    );
  });
});

describe('headerPathLabel', () => {
  test('drops the workspaces prefix every project shares', () => {
    expect(headerPathLabel('/.archon/workspaces/rajababa-io/wix-access/source')).toBe(
      '…/rajababa-io/wix-access/source'
    );
  });

  test('keeps a path that is already short enough to identify itself', () => {
    expect(headerPathLabel('/home/appuser/archon')).toBe('/home/appuser/archon');
    expect(headerPathLabel('/srv/app')).toBe('/srv/app');
  });

  test('a trailing slash does not cost a real segment', () => {
    expect(headerPathLabel('/a/b/c/d/e/')).toBe('…/c/d/e');
  });

  test('an empty path stays empty rather than becoming a bare ellipsis', () => {
    expect(headerPathLabel('')).toBe('');
  });
});

describe('activeProjectTab', () => {
  test('the chat route lights Chat', () => {
    expect(activeProjectTab('/console/p/abc/chat')).toBe('chat');
    expect(activeProjectTab('/console/p/abc/chat/')).toBe('chat');
  });

  test('the runs route lights Runs', () => {
    expect(activeProjectTab('/console/p/abc')).toBe('runs');
  });

  test('a run detail lights Runs — a run belongs to Runs', () => {
    expect(activeProjectTab('/console/p/abc/r/081fe6a1')).toBe('runs');
  });

  test('a run whose id ends in the word chat does not light Chat', () => {
    expect(activeProjectTab('/console/p/abc/r/deadchat')).toBe('runs');
  });
});

describe('showsInstallDeployStrip', () => {
  test('All projects carries the install-wide deploy strip', () => {
    expect(showsInstallDeployStrip(undefined)).toBe(true);
  });

  test("a project's page never carries Archon's own deploy status (#319)", () => {
    // Any project id: another project's page, and the Archon project, whose own
    // deploy row already reports this deploy.
    expect(showsInstallDeployStrip('1f419d47-d581-4deb-b803-713f32414ad2')).toBe(false);
  });
});
