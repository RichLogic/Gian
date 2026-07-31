import { describe, expect, it } from 'vitest';

import { attachmentInputItem } from '../src/attachments.js';

describe('attachmentInputItem', () => {
  it('keeps images on the multimodal localImage path', () => {
    expect(attachmentInputItem({
      path: '/tmp/shot.png',
      name: 'shot.png',
      mime: 'image/png',
      size: 12,
    })).toEqual({
      type: 'localImage',
      path: '/tmp/shot.png',
      name: 'shot.png',
      mime: 'image/png',
      size: 12,
    });
  });

  it('routes non-images through the generic localFile contract', () => {
    expect(attachmentInputItem({
      path: '/tmp/notes.txt',
      name: 'notes.txt',
      mime: 'text/plain',
      size: 5,
    })).toEqual({
      type: 'localFile',
      path: '/tmp/notes.txt',
      name: 'notes.txt',
      mime: 'text/plain',
      size: 5,
    });
  });

  it('routes unsupported image formats through the generic file contract', () => {
    expect(attachmentInputItem({
      path: '/tmp/diagram.svg',
      name: 'diagram.svg',
      mime: 'image/svg+xml',
      size: 123,
    })).toEqual({
      type: 'localFile',
      path: '/tmp/diagram.svg',
      name: 'diagram.svg',
      mime: 'image/svg+xml',
      size: 123,
    });
  });
});
