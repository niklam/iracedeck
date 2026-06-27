// Click-to-enlarge for Mermaid diagrams (astro-mermaid renders into `.mermaid`).
// Dependency-free: clones the rendered SVG into a native <dialog>, closes on
// the button, a backdrop click, or Escape. Uses event delegation on `document`
// so it survives client-side navigation and async diagram rendering.
(function () {
  if (window.__diagramZoom) return;
  window.__diagramZoom = true;

  function open(svg) {
    var dialog = document.createElement("dialog");
    dialog.className = "diagram-zoom";

    var close = document.createElement("button");
    close.className = "diagram-zoom-close";
    close.type = "button";
    close.setAttribute("aria-label", "Close enlarged diagram");
    close.textContent = "✕";

    var content = document.createElement("div");
    content.className = "diagram-zoom-content";

    var clone = svg.cloneNode(true);
    // Drop the inline sizing Mermaid bakes in so CSS can scale it to fit.
    clone.removeAttribute("style");
    clone.removeAttribute("width");
    clone.removeAttribute("height");
    content.appendChild(clone);

    dialog.appendChild(close);
    dialog.appendChild(content);
    document.body.appendChild(dialog);

    function remove() {
      if (dialog.open) dialog.close();
      dialog.remove();
    }

    close.addEventListener("click", remove);
    dialog.addEventListener("cancel", remove); // Escape key
    dialog.addEventListener("click", function (e) {
      // A click whose coordinates fall outside the dialog box is a backdrop click.
      var r = dialog.getBoundingClientRect();
      var inside =
        e.clientX >= r.left &&
        e.clientX <= r.right &&
        e.clientY >= r.top &&
        e.clientY <= r.bottom;
      if (!inside) remove();
    });

    dialog.showModal();
  }

  document.addEventListener("click", function (e) {
    var target = e.target;
    if (!target || !target.closest) return;
    var container = target.closest(".mermaid");
    if (!container) return;
    var svg = container.querySelector("svg");
    if (!svg) return; // diagram not rendered yet
    open(svg);
  });
})();
