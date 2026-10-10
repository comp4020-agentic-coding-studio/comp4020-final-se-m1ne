// Shared informational copy: the landing page's onboarding modal (public/
// landing.js) shows this to a new visitor once, and the editor's compact
// Help/About entry (public/help-popover.js, wired from both public/app.js and
// public/pixel-editor.js) shows the exact same wording again later on
// request -- one source of text, so the two can never quietly drift apart.
// Markup only -- no behaviour, no DOM lookups, nothing page-specific.
export const ABOUT_TITLE = "Welcome to our canvas!";
export const ABOUT_INTRO = "A cozy place to draw, share little moments, and create something together.";

export const ABOUT_SECTIONS = [
  {
    heading: "Public Canvas",
    body: "Draw together on a shared canvas. Your strokes gently fade away over 12.5 hours, making room for new ideas.",
  },
  {
    heading: "Private Rooms",
    body: "Create a room and share its code with friends. Draw together without fading. Rooms expire after 24 hours of continuous emptiness.",
  },
  {
    heading: "Create Together",
    body: "See other people's drawing and cursors in real time. Choose your colours, undo mistakes, and erase only your own artwork.",
  },
];

// Renders the shared copy above as a plain DOM fragment (a heading, an intro
// paragraph, then one heading+paragraph per section) -- appended wherever the
// caller needs it (the onboarding modal's own intro area, or the editor's
// Help/About popover body), so the markup structure itself is shared too, not
// just the strings.
export function renderAboutContent() {
  const fragment = document.createDocumentFragment();

  const title = document.createElement("h2");
  title.className = "about-title";
  title.textContent = ABOUT_TITLE;
  fragment.appendChild(title);

  const intro = document.createElement("p");
  intro.className = "about-intro";
  intro.textContent = ABOUT_INTRO;
  fragment.appendChild(intro);

  for (const section of ABOUT_SECTIONS) {
    const heading = document.createElement("h3");
    heading.className = "about-section-heading";
    heading.textContent = section.heading;
    fragment.appendChild(heading);

    const body = document.createElement("p");
    body.className = "about-section-body";
    body.textContent = section.body;
    fragment.appendChild(body);
  }

  return fragment;
}
