(function () {
  const port = chrome.runtime.connect({ name: 'aidr:interstitial' });
  port.onMessage.addListener(function (message) {
    if (message?.type !== 'aidr:get_post_data' || !message.postUrl) return;
    var form = document.createElement('form');
    form.method = 'POST';
    form.action = message.postUrl;
    new URLSearchParams(message.postBody || '').forEach(function (value, key) {
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = key;
      input.value = value;
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
  });
})();
