# Development rules for Shared Canvas

## Project goal

Shared Canvas is a real-time collaborative drawing website, not a professional painting application.

The three priorities are:

1. **Easy to join:** Visitors can enter without creating an account.
2. **Drawing together:** People should be able to see each other's work while it happens.
3. **Respecting contributions:** One participant must not be able to erase or undo another participant's work.

Every change should support these priorities. Do not add features simply to make the editor look more complete.

## Before making changes

- Read the relevant existing code and tests before editing.
- Identify the actual cause of a problem instead of immediately replacing large parts of the implementation.
- Make the smallest change that solves the reported problem.
- Preserve working behaviour that is unrelated to the task.
- Do not introduce a new drawing model, framework, library or major UI redesign without explicit approval.
- If a request is unclear, ask rather than inventing extra requirements.
- Do not refactor, reformat or optimize unrelated code while implementing a focused request.

## Drawing behaviour

- Drawing must follow the pointer smoothly and use consistent coordinates.
- Browser resizing, zooming and panning must not change where existing artwork belongs.
- Brush, airbrush, paint bucket and eraser behaviour must remain predictable at different zoom levels.
- An eraser must remove only the affected parts of the current participant's artwork, not entire strokes or other people's pixels.
- Undo and redo must affect only the current participant's own actions.
- Preserve the distinction between the pixel-art editor and the legacy freehand editor. Do not modify one editor when a request concerns only the other.
- Freehand drawing must respect the selected layer, fixed layer stacking order and per-user layer visibility.
- Drawing on a lower layer must never cover artwork on a visible upper layer, regardless of operation order.
- Preserve the existing paint bucket fill behaviour, including its one-pixel coverage expansion.
- Live previews, committed operations and replayed artwork must produce consistent results.
- Do not introduce pressure sensitivity, additional painting tools or other advanced features unless specifically requested.
- A visual improvement is not successful if it makes basic drawing slower or less reliable.

## Real-time collaboration

- Two separate browsers must be able to draw on the same canvas and see each other's changes without refreshing.
- Aim for updates to appear in other open sessions within approximately one second.
- Show in-progress brush strokes and erasing effects, not only the final result after pointer release.
- Temporary previews must not become duplicate permanent artwork.
- Completed drawing operations must be saved by the server and remain consistent across clients.
- Remote cursors must use the correct canvas coordinates, including when browser sizes differ.
- Keep public and private room updates separate. A private room must never receive another room's drawing events.
- A disconnected client must be able to recover the correct saved drawing state after reconnecting.

## Persistence and ownership

- Keep SQLite as the persistent source of truth for drawing operations.
- Do not rely on browser memory alone for artwork that must survive refreshes or server restarts.
- Keep server-assigned operation ordering consistent between users.
- Preserve anonymous participant ownership without requiring permanent accounts.
- Public drawing operations fade according to their original creation time over 12.5 hours. Undo and redo must not restart this time.
- Erase effects must not fade in a way that makes removed artwork reappear.
- Private artwork does not fade.
- Private rooms expire only after 24 hours of continuous emptiness. Returning before expiry must cancel the empty period.
- Never allow one participant's undo, redo or eraser to change another participant's saved operations.

## Interface and accessibility

- The landing page must make it clear that this is a shared drawing website.
- Visitors must be able to see the public artwork before entering the editor.
- The Welcome flow must explain public and private drawing and allow a guest nickname and cursor colour.
- Keep the drawing workspace simple and readable. Avoid adding unnecessary controls or panels.
- Keep the public canvas visually clear in both light and dark system themes.
- Preserve the existing layout, icons and colour choices unless a redesign is explicitly requested.
- Support mouse, touch and keyboard interactions where applicable.
- Check the desktop and mobile layouts after changes that affect the interface.
- Private-room navigation must preserve the existing confirmation that reminds users to save their room code before leaving.

## Testing and checking

Automated tests are necessary, but they are not enough to prove drawing feels right or that canvas pixels are rendered correctly.

For changes affecting drawing or collaboration:

1. Run the relevant automated tests and typecheck.
2. Check drawing, erasing, undo and redo.
3. Test with two separate browser sessions when browser testing is explicitly permitted.
4. Check whether remote strokes and erasing appear during the action.
5. Resize the browser and check cursor positions and existing artwork.
6. Refresh and confirm saved artwork remains correct.
7. Check that public and private rooms remain isolated.
8. For layer-related changes, check actual visible stacking, layer visibility and repeated drawing across different layers.

Tests that mock Canvas APIs or only inspect drawing-call order do not establish pixel-level correctness. If manual or real-browser verification is unavailable, report it as unverified rather than claiming visual success.

### Browser safety

- Do not launch, navigate, refresh, automate or close Microsoft Edge without explicit permission.
- Never close the user's existing Edge windows, tabs or browser processes.
- Do not use Playwright, Puppeteer or other browser automation without explicit permission.
- Do not terminate browser processes or interfere with the user's current browser session.
- Prefer non-browser automated tests unless browser testing has been specifically requested.

## Working with the agent

- Explain what was changed, why it was changed, and what was tested.
- Report remaining problems instead of hiding them behind a passing test result.
- Do not describe an issue as fixed unless the relevant behaviour has been checked.
- When a bug reveals a missing guarantee, add or update an appropriate test in `spec/`.
- Keep `README.md`, `CLAUDE.md` and the tests consistent with the actual application.
- Do not rewrite `README.md`, `PROCESS.md`, reflections or the COMP8020 research note unless explicitly instructed.
- Do not deploy after every small change. Deploy when preparing a requested release.
- Do not change or move existing crit tags.
- Do not commit local IDE settings, credentials, `.claude*` files or unrelated temporary files.
- Preserve unrelated uncommitted changes. Do not reset, restore, stash or discard them.
- After each completed logical change, stage only task-related files and create a focused Git commit with a descriptive message.
- Do not use `git add .`. Do not push or deploy unless explicitly requested.
- Keep final reports concise: changed files, verification results, blockers and commit hash.

## Definition of done

A change is complete only when the requested behaviour works, relevant tests pass, unrelated features still behave correctly, and any known limitations are reported.

A feature that passes tests but makes drawing harder to use is not finished. If real-browser visual verification has not been performed, state that limitation explicitly.
