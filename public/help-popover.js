// Wires up the editor's compact Help/About entry (#help-button/#help-popover,
// public/index.html) -- shared by public/app.js and public/pixel-editor.js so
// there is exactly one implementation of this popover's open/close/outside-
// click/Escape behaviour for both modes, the same reason public/colour-
// picker-ui.js's initColourPicker is a shared module rather than two copies.
// The body content itself comes from public/about-content.js, the same
// shared copy the landing page's onboarding modal shows a new visitor once --
// this is purely that content's later, on-request home, not a second place
// the wording is written.
import { renderAboutContent } from "./about-content.js";

export function wireHelpPopover() {
  const helpButton = document.getElementById("help-button");
  const helpPopover = document.getElementById("help-popover");
  const helpPopoverClose = document.getElementById("help-popover-close");
  const helpPopoverBody = document.getElementById("help-popover-body");

  helpPopoverBody.appendChild(renderAboutContent());

  function open() {
    // Same positioning approach as public/app.js's own openProfilePopover:
    // anchored under the triggering button, nudged left if it would
    // otherwise overflow the right edge of the viewport.
    const rect = helpButton.getBoundingClientRect();
    const popoverWidth = 280;
    helpPopover.style.top = `${rect.bottom + 6}px`;
    helpPopover.style.left = `${Math.min(rect.left, window.innerWidth - popoverWidth - 8)}px`;
    helpPopover.hidden = false;
    helpButton.setAttribute("aria-expanded", "true");
  }
  function close() {
    helpPopover.hidden = true;
    helpButton.setAttribute("aria-expanded", "false");
  }

  helpButton.addEventListener("click", () => {
    if (helpPopover.hidden) open();
    else close();
  });
  helpPopoverClose.addEventListener("click", close);
  document.addEventListener("pointerdown", (event) => {
    if (helpPopover.hidden) return;
    if (helpPopover.contains(event.target) || helpButton.contains(event.target)) return;
    close();
  });
  window.addEventListener("keydown", (event) => {
    if (!helpPopover.hidden && event.key === "Escape") close();
  });
}
