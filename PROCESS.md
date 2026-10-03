# Process overview

I began with the smallest version of the final-project idea that could test its central interaction: a stranger opens the homepage and can immediately contribute to a shared drawing. The first version deliberately postponed rooms, fading, real-time synchronisation and editor-like controls. Since then, the project has changed substantially. The public canvas is still the entry point, but the work has increasingly focused on making it behave like a drawing application rather than a technical canvas demo.

## Establishing persistence and ownership

I chose Node.js with Express, SQLite through Node's built-in `node:sqlite`, and a vanilla JavaScript HTML5 Canvas frontend. SQLite fits the single persistent Fly volume and gives the server an authoritative place to order operations. Using the built-in module also avoids an additional native database dependency.

The first working slice, [`be1cb23`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/be1cb23), persisted brush strokes as vector point lists. The server assigned each browser an anonymous identity using an HTTP-only cookie. This established two decisions early: artwork should survive refreshes, and the system should distinguish participants even though it does not require accounts.

The eraser then exposed a weakness in the representation. In [`7827104`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/7827104), I tried spatially cutting vector strokes into surviving fragments. This was better than deleting an entire stroke when the eraser touched it, but it was still modelling a raster drawing interaction as centreline geometry. A thick mark could not be erased naturally by repeatedly splitting its path.

I therefore changed the architecture rather than continuing to patch the fragmentation algorithm. [`ac96895`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/ac96895) moved the drawing history to persistent draw and erase operations. Each participant's content is reconstructed on an owner-specific raster layer, so `destination-out` can erase only that participant's pixels. The visible result is replayed using a server-assigned global sequence, meaning a later drawing appears above an earlier one regardless of owner. Existing vector data was migrated rather than discarded.

This change also exposed a performance problem: correct replay was too expensive to perform for the complete history during every active eraser frame. I used the agent to inspect the rendering path and then kept full replay for authoritative reconstruction while limiting interactive repainting to affected regions. I accepted the correction only after drawing with it again. This established an important division in my workflow: automated tests check persistence, ordering and ownership rules, while I manually judge whether a drawing interaction actually feels usable.

## Expanding the collaboration model

After defining what good meant in [`c228db9`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/c228db9), I began extending the same operation model instead of creating separate systems for each feature.

[`e1ee235`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/e1ee235) made public artwork temporary. Draw operations fade continuously from their original server creation time, while erase masks do not fade. Undoing and redoing an operation therefore cannot restart its lifetime, and erased pixels do not reappear as surrounding artwork fades.

Private rooms followed in [`36b6eb6`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/36b6eb6). A server-generated six-character code identifies a persistent private canvas. Public and private drawing reuse the same operation and ownership model, but private artwork does not inherit public fading. I corrected drawing feedback and navigation in [`7978c44`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/7978c44), then unified Brush and Eraser size controls in [`0e78d75`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/0e78d75).

Undo and redo in [`396068a`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/396068a) were designed around ownership rather than a global canvas history. A participant can undo only their own latest active operation. Redo restores the same database row, preserving its sequence and creation time instead of creating a new operation. A new edit after undo clears only that participant's redo branch.

Private-room lifetime also required a product decision rather than just a timer. In [`ebbd205`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/ebbd205), I implemented per-tab presence leases. A room expires only after it has been continuously empty for 24 hours. Re-entering before expiry cancels that empty period. This avoids deleting a room merely because it is old while somebody is still using it, without requiring accounts or a privileged room owner.

## From canvas demo to drawing workspace

By this stage the backend behaviour was becoming coherent, but the interface still looked too much like a prototype built around an HTML canvas. I changed direction: rather than adding isolated features one button at a time, I began treating the product as a small drawing application.

[`fd8c509`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/fd8c509) reorganised the interface around a Paint-inspired workspace with Tools, Size and Colours groups, light and dark themes, preset colours and a custom colour editor. I used Paint as a reference for familiar organisation rather than copying its interface. [`71f7f09`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/71f7f09) added an Eyedropper that samples the final visible raster, including composited and partially visible pixels, while keeping it separate from persistent drawing operations.

The next architectural problem was more fundamental. The canvas dimensions were still derived from the browser viewport, so the document itself was not independent from the window displaying it. Before adding brushes and layers, I stopped feature work and investigated a proper document/workspace model.

[`665bc91`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/665bc91) establishes a fixed 1920×1080 artwork document inside a separately scalable workspace. Zoom changes only its displayed size; Fit calculates a suitable view; panning moves around the workspace; resizing the browser no longer changes the artwork coordinate system. Brush, Eraser and Eyedropper coordinates were manually tested at 50%, 100% and 200% zoom, including after panning. I also checked persistence across refreshes, private-room re-entry, mobile layout and Undo/Redo after viewport changes.

## Directing the next stage

The latest investigation deliberately produced no implementation. Before adding more tools, I asked the agent to examine how a brush engine would interact with replay, opacity, fading, ownership and future real-time synchronisation. The current plan is to build a coherent brush engine before user layers, then introduce real-time synchronisation after the document and layer models are stable.

This is also why I have not treated feature count as the measure of progress. Pressure sensitivity, accounts, profiles, chat, selection and other editor features remain outside the current implementation. The project has instead repeatedly changed representation when manual use exposed a weak foundation. The most important process lesson so far has been that a passing persistence test can prove an operation survives a reload, but it cannot prove that drawing feels good. I use the agent and automated checks to enforce structural guarantees, while keeping interaction quality as something I must test and judge in the actual application.