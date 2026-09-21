import { CHAT_UI_DEFAULT_EN } from '@gian/chat-ui';
import type { Messages } from './messages.js';

/**
 * English table. The `@gian/chat-ui` keys come from the package's own English
 * fallback so transcript copy stays identical to local Gian; remote-web keys
 * (shell, pairing, settings, connection states) are defined here.
 */
export const EN: Messages = {
  ...CHAT_UI_DEFAULT_EN,

  // Brand / trust
  'remote.brand': 'Gian Remote',
  'pair.trust.note':
    'Self-hosted: this page is served by your own Remote Server. Never share a pairing code.',

  // Pairing — PC short code
  'pair.code.title': 'Pair this device',
  'pair.code.desc':
    'Open Gian › Settings › Remote on your Mac to see the 8-character pairing code. ' +
    'After entering the code you still have to confirm in Gian on the Mac before a connection is made.',
  'pair.code.field': 'Pairing code',
  'pair.code.submit': 'Pair',
  'pair.code.qrHint': 'On a phone, skip the code — scan the QR code shown on the Mac',

  // Pairing — QR landing
  'pair.qr.title': 'Pairing requested for this device',
  'pair.qr.hostLabel': 'Target Host',
  'pair.qr.deviceLabel': 'Name of this device',
  'pair.qr.desc':
    'Once paired, this device can remotely view and operate sessions on this Host. ' +
    'After confirming you still have to allow this device in Gian on the Mac. You can revoke it at any time.',
  'pair.qr.confirm': 'Confirm pairing',
  'pair.qr.browserHint': 'Want to use Safari or another browser? Open this page there before confirming, or copy the pairing link below. Pairing applies only to the browser that confirms.',
  'pair.qr.link': 'Pairing link',
  'pair.qr.copyLink': 'Copy pairing link',
  'pair.qr.linkCopied': 'Pairing link copied.',
  'pair.qr.copyFailed': 'Could not copy. Select the link and copy it manually.',

  // Pairing — waiting for the local confirmation
  'pair.wait.title': 'Pairing request sent',
  'pair.wait.body': 'Waiting for Gian — allow this device in Gian on the Mac',
  'pair.wait.hint': 'The request is valid for 5 minutes · this page continues automatically',

  // Pairing — failure terminals
  'pair.fail.cancelled.title': 'Pairing cancelled',
  'pair.fail.cancelled.desc': 'This pairing request was cancelled in Gian on the Mac.',
  'pair.fail.expired.title': 'Code expired',
  'pair.fail.expired.desc': 'Codes are valid for 5 minutes. Generate a new one in Gian › Settings › Remote.',
  'pair.fail.rejected.title': 'Pairing rejected',
  'pair.fail.rejected.desc': 'Gian on the Mac rejected this device. If this was not you, you can ignore it.',
  'pair.fail.rateLimited.title': 'Too many attempts',
  'pair.fail.rateLimited.desc': 'Pairing is locked for 10 minutes after 5 failed attempts.',
  'pair.fail.hostOffline.title': 'Host is offline',
  'pair.fail.hostOffline.desc': '{host} is not online, so pairing cannot complete.',
  'pair.fail.alreadyClaimed.title': 'Code already used',
  'pair.fail.alreadyClaimed.desc': 'This code was already claimed by another device. Generate a new code on the Mac.',
  'pair.action.retry': 'Try again',
  'pair.action.restart': 'Start over',
  'pair.action.reenter': 'Re-enter code',
  'pair.action.later': 'Try later',

  // Device revoked
  'pair.revoked.title': 'Pairing for this device was revoked',
  'pair.revoked.desc':
    'This device was removed in Gian › Settings › Remote on the Mac. All local credentials are invalid — pair again to continue.',
  'pair.revoked.action': 'Pair again',
  // App shell
  'shell.sidebar.toggle': 'Show/hide sidebar',
  'shell.back': 'Back',
  'shell.forward': 'Forward',
  'shell.menu': 'Session list',

  // Host selector
  'host.selector.label': 'Switch Host',
  'host.select': 'Choose computer',
  'host.selectHint': 'Choose a paired computer from the menu above, or add another computer.',
  'host.add': 'Add computer',
  'conn.phase.auth': 'Authenticating this browser with the Remote Server…',
  'conn.phase.relay': 'Connecting to the computer and establishing encryption…',
  'conn.phase.sync': 'Waiting for the computer to send its sessions…',
  'conn.failedHint': 'Connection failed at this stage. Retrying automatically; you can switch or add a computer above.',
  'host.status.online': 'online',
  'host.status.offline': 'offline',
  'host.status.reconnecting': 'reconnecting',
  'host.status.connected': 'connected',
  'host.row.sessions': '{count} sessions',
  'host.row.lastSeen': 'last online {time}',

  // Rail
  'rail.title': 'Tasks',
  'rail.tasks': 'Tasks',
  'rail.doing': 'Doing',
  'rail.newChat': 'new chat',
  'rail.newChat.title': 'New chat',
  'rail.newChatForTask': 'New Chat (preselect this Task)',
  'rail.settings': 'Settings',
  'session.status.running': 'Running',
  'session.status.pending': 'Needs approval',
  'session.status.error': 'Error',
  'session.status.done': 'Done',
  'session.status.stale': 'Stale snapshot',

  // Chat / composer
  'chat.placeholder.idle': 'Message…',
  'chat.placeholder.busy': 'Turn running — sending queues the message…',
  'chat.placeholder.offline': 'Host offline — sending is unavailable; your draft is kept locally…',
  'chat.send.title': 'Send',
  'chat.send.title.busy': 'Send (queued while the turn is running)',
  'chat.stop.title': 'Stop (empty input while the turn is running)',
  'chat.attach.title': 'Add attachment / context / document',
  'chat.attach.attachment': 'Attachment',
  'chat.attach.context': 'Context item',
  'chat.attach.document': 'Document',
  'chat.model.title': 'Model / Thinking / Fast (remote change via session.update)',
  'chat.history.loading': 'Loading message history…',
  'chat.model.menu': 'Choose model',
  'chat.model.loading': 'Loading models…',
  'chat.model.unavailable': 'No models are available for this Agent.',
  'chat.sheet.title': 'Model / Thinking / Fast',
  'chat.sheet.model': 'Model',
  'chat.sheet.effort': 'Thinking',
  'chat.sheet.mode': 'Mode',
  'chat.sheet.mode.default': 'Default',
  'chat.sheet.mode.fast': 'Fast',
  'chat.sheet.advanced': 'Advanced',
  'chat.approval.title': 'Approval mode',
  'chat.mode.plan': 'Plan',
  'chat.mode.ask': 'Ask for approval',
  'chat.mode.auto': 'Auto',
  'chat.mode.custom': 'Custom',
  'chat.mode.fullAccess': 'Full access',
  'chat.unknown.banner':
    'The last command outcome is unconfirmed — refresh the state; it is not retried automatically.',
  'chat.unknown.refresh': 'Refresh state',
  'chat.stale.note': 'mutations disabled · the server rejects new commands (HOST_OFFLINE); payloads are not stored',

  // Queue
  'queue.title': 'Queued',
  'queue.sendNow': 'Send now',
  'queue.clear': 'Clear',
  'queue.edit': 'Edit',
  'queue.remove': 'Remove',
  'queue.save': 'Save',
  'queue.notice.replaced': 'Queue was updated elsewhere — refreshed',
  'queue.collapsed': '{count} queued messages',
  'queue.expand': 'Expand',

  // Connection states
  'conn.browserOffline':
    'Browser is offline — unsent content stays in local drafts and resumes when the network returns',
  'conn.relayReconnecting': 'Connection to the Relay dropped, reconnecting (attempt {n})…',
  'conn.resyncing': 'Connection restored, rebuilding the snapshot — synced {done}/{total} sessions…',
  'conn.initial.title': 'Connecting to Gian…',
  'conn.initial.desc': 'Restoring your secure Remote session.',
  'conn.hostOffline':
    'Host offline — showing the snapshot from {time}; sending and approvals are unavailable until it reconnects',
  'conn.versionMismatch':
    'Protocol version mismatch — Remote Web needs Gian ≥ {required}, this Host is {actual}',
  'conn.versionMismatch.action': 'How to upgrade',
  'conn.tag.offline': 'offline',
  'conn.tag.reconnecting': 'reconnecting',
  'conn.tag.resync': 'resync',
  'conn.tag.stale': 'stale snapshot',

  // New chat
  'newchat.title': 'New chat',
  'newchat.workspace': 'Workspace',
  'newchat.agent': 'Agent',
  'newchat.task': 'Task',
  'newchat.name': 'Name',
  'newchat.model': 'Model / config',
  'newchat.required': 'required',
  'newchat.optional': 'optional',
  'newchat.modelDefault': 'Default ({model})',
  'newchat.create': 'Create and start',
  'newchat.creating': 'Creating — waiting for the Host to confirm…',
  'newchat.agentUnavailable': 'This Agent is currently unavailable',
  'newchat.catalogInvalidated': 'The Agent catalog changed on the Host — refresh before creating.',
  'newchat.catalogRefresh': 'Refresh catalog',
  'newchat.hostOffline': 'Host offline — sessions cannot be created right now.',
  'newchat.failed': 'Create failed: {message}',
  'newchat.change': 'Change…',

  // Settings
  'settings.title': 'Settings',
  'settings.back': 'Back to chat',
  'settings.appearance': 'Appearance',
  'settings.hosts': 'Host connections',
  'settings.host.current': 'current',
  'settings.host.disconnect': 'Disconnect this Host',
  'settings.host.disconnectHint':
    'Disconnecting removes the pairing, key and local cache for this (device × Host) pair and asks for confirmation; disconnecting the current Host switches to another online Host.',
  'settings.host.disconnectConfirm':
    'Disconnect {name}? This deletes the pairing, device key and local cache for this Host.',
  'settings.logout': 'Sign out of this browser',
  'settings.logoutHint':
    'Signing out only ends this browser\'s session and clears decrypted local caches; it does not revoke the device pairing.',
  'settings.logoutConfirm':
    'Sign out of this browser? Only the refresh session and decrypted caches are cleared; the device pairing stays.',
  'settings.connectedMeta': 'Connected (E2EE) · {latency}ms latency',

  // File viewer
  'file.readonly': 'Read-only',
  'file.download': 'Download',
  'file.close': 'Close',
  'file.back': 'Back',
  'file.backToChat': 'Back to chat',
  'file.loading': 'Loading file…',
  'file.binary': 'Binary files cannot be previewed; download to view.',
  'file.changed': 'The file changed on the Host — showing the previous version.',
  'file.reload': 'Reload',
  'file.expired': 'This file reference expired; open it again from the chat.',
  'file.tooLarge': 'File exceeds the preview limit ({limit}); download to view.',
  'file.downloading': 'Downloading… {pct}%',
  'file.downloadError': 'Download failed: {message}',

  // Interactions
  'interaction.resolvedHere': 'Resolved on this device',
  'interaction.resolvedElsewhere': 'Resolved on another device',
  'interaction.expired': 'Expired',
  'interaction.respondFailed': 'Response failed',
};
