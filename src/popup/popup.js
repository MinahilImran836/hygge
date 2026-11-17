document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("cozy-toggle");
  const status = document.getElementById("cozy-status");

  const render = (enabled) => {
    toggle.checked = enabled;
    status.textContent = enabled ? "Cozy room is on" : "Cozy room is off";
  };

  chrome.storage.local.get({ cozyEnabled: true }, (data) => render(data.cozyEnabled));

  // Every open YouTube tab listens for this storage change and updates itself.
  toggle.addEventListener("change", () => {
    const enabled = toggle.checked;
    render(enabled);
    chrome.storage.local.set({ cozyEnabled: enabled });
  });
});
