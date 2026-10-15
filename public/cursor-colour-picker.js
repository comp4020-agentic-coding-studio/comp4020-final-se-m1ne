// Guest cursor colour selector: six presets plus a "Custom" button that opens
// the native colour picker. The existing <input type="color"> stays the single
// source of truth (callers keep reading input.value), so persistence and form
// submission are unchanged; this only renders and drives it.

export const CURSOR_COLOUR_PRESETS = [
  { name: "Soft coral", value: "#E89991" },
  { name: "Warm yellow", value: "#E8B967" },
  { name: "Sage green", value: "#9DB98B" },
  { name: "Soft blue", value: "#8EB9D1" },
  { name: "Lavender", value: "#A99ACD" },
  { name: "Dusty pink", value: "#D69FBC" },
];

const CHECK_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">' +
  '<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const PALETTE_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">' +
  '<path d="M12 3a9 9 0 0 0 0 18c1.2 0 2-.8 2-1.8 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>' +
  '<circle cx="7.5" cy="11" r="1.2" fill="currentColor"/><circle cx="10.5" cy="7.2" r="1.2" fill="currentColor"/><circle cx="15" cy="7.4" r="1.2" fill="currentColor"/></svg>';

// root: the container (role="group", labelled by the caller) that holds the
// native colour input. Returns { setValue } for programmatic updates (setting
// input.value directly does not fire an event, so the selection would go stale).
export function initCursorColourPicker(root, input) {
  root.classList.add("cursor-colour-picker");

  const swatches = CURSOR_COLOUR_PRESETS.map((preset) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cursor-swatch";
    button.style.backgroundColor = preset.value;
    button.setAttribute("aria-label", preset.name);
    button.innerHTML = CHECK_SVG;
    button.addEventListener("click", () => select(preset.value));
    root.appendChild(button);
    return { preset, button };
  });

  const wrap = document.createElement("span");
  wrap.className = "cursor-custom-wrap";
  const customButton = document.createElement("button");
  customButton.type = "button";
  customButton.className = "cursor-custom-button";
  customButton.setAttribute("aria-label", "Custom cursor colour");
  customButton.innerHTML = `${PALETTE_SVG}<span>Custom</span><span class="cursor-custom-preview" aria-hidden="true"></span>`;
  const preview = customButton.querySelector(".cursor-custom-preview");
  customButton.addEventListener("click", () => {
    try {
      if (typeof input.showPicker === "function") input.showPicker();
      else input.click();
    } catch {
      input.click();
    }
  });
  input.classList.add("cursor-colour-native");
  input.tabIndex = -1;
  input.setAttribute("aria-hidden", "true");
  wrap.appendChild(customButton);
  wrap.appendChild(input);
  root.appendChild(wrap);

  function render() {
    const current = (input.value || "").toLowerCase();
    let presetMatched = false;
    for (const { preset, button } of swatches) {
      const selected = preset.value.toLowerCase() === current;
      if (selected) presetMatched = true;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
    customButton.classList.toggle("is-selected", !presetMatched);
    customButton.setAttribute("aria-pressed", String(!presetMatched));
    preview.style.backgroundColor = presetMatched ? "" : current;
  }

  function select(value) {
    input.value = value.toLowerCase();
    render();
  }

  input.addEventListener("input", render);
  input.addEventListener("change", render);
  render();

  return {
    setValue(value) {
      input.value = value;
      render();
    },
  };
}
