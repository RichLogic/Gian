import assert from 'node:assert/strict';
import test from 'node:test';

import { captureFromCdpNode } from '../src/browser-element.js';

test('Browser element capture keeps bounded semantic context and strips URL secrets', () => {
  const capture = captureFromCdpNode({
    pageUrl: 'https://user:secret@example.com/account?token=secret#billing',
    pageTitle: '  Account   settings  ',
    node: {
      backendNodeId: 42,
      nodeName: 'BUTTON',
      localName: 'button',
      attributes: [
        'class', 'primary large',
        'data-testid', 'save-account',
        'onclick', 'steal()',
        'style', 'background:red',
        'aria-label', 'Save changes',
      ],
    },
    axNodes: [{
      backendDOMNodeId: 42,
      role: { value: 'button' },
      name: { value: 'Save changes' },
    }],
  });

  assert.deepEqual(capture, {
    pageUrl: 'https://example.com/account',
    pageTitle: 'Account settings',
    tagName: 'button',
    selector: 'button[data-testid="save-account"]',
    role: 'button',
    name: 'Save changes',
    attributes: {
      'aria-label': 'Save changes',
      class: 'primary large',
      'data-testid': 'save-account',
    },
    contentOmitted: false,
    snippet: '<button aria-label="Save changes" class="primary large" data-testid="save-account">Save changes</button>',
  });
});

test('Browser element capture never includes editable values or content', () => {
  const capture = captureFromCdpNode({
    pageUrl: 'https://example.com/login',
    pageTitle: 'Login',
    node: {
      backendNodeId: 7,
      localName: 'input',
      attributes: [
        'id', 'password',
        'type', 'password',
        'value', 'super-secret',
        'autocomplete', 'current-password',
        'placeholder', 'Password',
      ],
    },
    axNodes: [{
      backendDOMNodeId: 7,
      role: { value: 'textbox' },
      name: { value: 'super-secret' },
    }],
  });

  assert.ok(capture);
  assert.equal(capture.contentOmitted, true);
  assert.equal(capture.name, undefined);
  assert.deepEqual(capture.attributes, {
    id: 'password',
    placeholder: 'Password',
    type: 'password',
  });
  assert.doesNotMatch(JSON.stringify(capture), /super-secret|autocomplete/);
  assert.equal(capture.snippet, '<input id="password" placeholder="Password" type="password">');
});

test('Browser element capture drops unsafe attributes and rewrites project origins', () => {
  const capture = captureFromCdpNode({
    pageUrl: 'gian-browser://unguessable/site/index.html?preview=1',
    pageTitle: 'Preview',
    node: {
      backendNodeId: 9,
      localName: 'a',
      attributes: [
        'href', '../docs/readme.html?secret=1#top',
        'data-private', 'do-not-copy',
        'id', 'docs-link',
      ],
    },
    axNodes: [{ backendDOMNodeId: 9, role: { value: 'link' }, name: { value: 'Read docs' } }],
  });

  assert.ok(capture);
  assert.equal(capture.pageUrl, 'gian-browser://project/site/index.html');
  assert.equal(capture.attributes.href, 'gian-browser://project/docs/readme.html');
  assert.equal(capture.selector, 'a[id="docs-link"]');
  assert.doesNotMatch(JSON.stringify(capture), /secret|data-private|unguessable/);
});
