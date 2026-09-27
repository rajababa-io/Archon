import { describe, expect, test } from 'bun:test';
import { readOpenChatRequest } from './open-chat';

describe('readOpenChatRequest', () => {
  test('reads the chat and whether it is done', () => {
    expect(readOpenChatRequest({ openChat: 'web-1', done: true })).toEqual({
      openChat: 'web-1',
      done: true,
    });
    expect(readOpenChatRequest({ openChat: 'web-1' })).toEqual({ openChat: 'web-1', done: false });
  });

  test('a navigation that asked for no chat carries no request', () => {
    expect(readOpenChatRequest(null)).toBeNull();
    expect(readOpenChatRequest(undefined)).toBeNull();
    expect(readOpenChatRequest({ openChat: '' })).toBeNull();
    expect(readOpenChatRequest({ other: 1 })).toBeNull();
  });
});
