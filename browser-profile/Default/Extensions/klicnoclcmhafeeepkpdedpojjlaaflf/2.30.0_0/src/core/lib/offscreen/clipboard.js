let cloneDt = [];
let text = '';

document.getElementById('sandbox').addEventListener('paste', (ev) => {
  cloneDt = [];
  try {
    const dt = ev.clipboardData;
    text = dt.getData('text/plain');
    if (dt) {
      for (const element of dt.items) {
        const item = element;
        const itemtype = item.type;
        const blob =
          item.kind === 'file'
            ? URL.createObjectURL(item.getAsFile())
            : dt?.getData(itemtype);
        const type = itemtype;
        if (
          ['text/plain', 'text/html'].includes(type) ||
          type.startsWith('image/')
        ) {
          cloneDt.push({ type, blob });
        }
      }
    }
  } catch (error) {
    console.error('offscreen paste error', error);
  }
});

function onMessage(request) {
  const sandbox = document.getElementById('sandbox');
  sandbox.value = '';
  sandbox.focus();
  cloneDt = [];
  text = '';
  document.execCommand('paste');

  if (request.data?.textOnly) {
    return { text };
  } else return { text, data: cloneDt };
}

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (request.target !== 'offscreen') return;
  const response = onMessage(request);
  if (response === undefined) return;
  sendResponse(response);
});
