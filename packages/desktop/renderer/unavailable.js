const params = new URLSearchParams(window.location.search);
const reason = params.get('reason');
const host = params.get('host') || 'the Gian host';
const web = params.get('web') || host;

const title = document.querySelector('#title');
const message = document.querySelector('#message');
const target = document.querySelector('#target');
const retry = document.querySelector('#retry');
const logs = document.querySelector('#logs');
const status = document.querySelector('#status');

if (reason === 'web') {
  title.textContent = 'The Gian interface is unavailable';
  message.textContent =
    'The host is healthy, but the desktop app could not load the interface.';
  target.textContent = web;
} else {
  title.textContent = 'The Gian host is unavailable';
  message.textContent =
    'The desktop app could not reach the background service. Gian sessions were not stopped.';
  target.textContent = host;
}

retry.addEventListener('click', async () => {
  retry.disabled = true;
  logs.disabled = true;
  status.textContent = 'Connecting...';
  try {
    const ready = await window.gianDesktop.retryConnection();
    if (!ready) status.textContent = 'Still unavailable. Check the Gian host logs.';
  } catch {
    status.textContent = 'Could not retry the connection.';
  } finally {
    retry.disabled = false;
    logs.disabled = false;
  }
});

logs.addEventListener('click', async () => {
  status.textContent = '';
  try {
    const result = await window.gianDesktop.openLogs();
    if (result) status.textContent = 'The log directory could not be opened.';
  } catch {
    status.textContent = 'The log directory could not be opened.';
  }
});
