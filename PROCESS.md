# Process overview

I began Shared Canvas with a simple goal: let people open a website and draw together without accounts or complicated setup. I imagined a temporary public wall and private rooms for friends. I expected displaying the canvas to be difficult. Instead, the hardest part was making drawing behave predictably when people worked at the same time.

## Choosing a small stack and a trustworthy drawing model

I chose Node.js, Express, SQLite and plain JavaScript with HTML Canvas. One server and a persistent SQLite volume on Fly.io kept deployment manageable, and avoided adding services I could not confidently maintain. The trade-off was that I had to design operation history, rendering and live synchronization myself. Claude Code helped implement and test these parts, while I judged changes against the experience I wanted.

The first version stored lines as point lists ([`be1cb23`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/be1cb23)). My initial eraser split those lines into pieces ([`7827104`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/7827104)), but thick strokes still erased incorrectly. Rather than keep patching individual cases, I changed drawing and erasing into replayable operations ([`ac96895`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/ac96895)). Separating contributions by owner made partial erasing possible without deleting somebody else's marks. It was a larger change, but it protected the project's most important promise.

I added fading public artwork ([`e1ee235`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/e1ee235)) and private rooms that expire after 24 hours of continuous emptiness rather than 24 hours after creation ([`ebbd205`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/ebbd205)). Ownership-restricted undo and redo followed ([`396068a`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/396068a)). These were not just features: they defined what people could safely do in a shared space.

## A direction I chose to abandon

I first explored a fuller painting workspace ([`665bc91`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/665bc91)), then tried pixel art because a grid and a few simple tools seemed easier to control. I built the pixel-grid system ([`b4033b6`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/b4033b6)) and adapted the interface ([`d9eccb1`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/d9eccb1)). In use, however, the grid could misalign, strokes lagged and larger brushes sometimes froze. The simpler-looking alternative was not simpler to make reliable.

I returned to freehand drawing ([`edff8cd`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/edff8cd)). Throwing away work was frustrating, but keeping it just because I had invested time would have made the core interaction worse. I learned to judge a direction by the drawing experience, not by how much code had been written.

## Making collaboration visible while it happens

Initially, one browser saw another person's work only after refresh. Later, completed strokes arrived automatically, but a moving remote cursor with no line behind it still felt disconnected. I directed Claude to stream temporary in-progress strokes while keeping the final server operation authoritative ([`0dac644`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/0dac644)). Testing in two browser sessions made the improvement obvious: I could watch the line grow instead of waiting for mouse release.

Remote erasing exposed a related mismatch. A grey trail appeared during the gesture, but the artwork disappeared only at the end. I changed the preview to show the actual removal immediately ([`5856804`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/5856804)). Nicknames and coloured cursors ([`50cd94e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/50cd94e)) made collaborators easier to notice without requiring accounts.

## Helping newcomers understand the space

The editor worked, but arriving directly in it gave visitors little reason to join. I added a landing page, Welcome flow and online counter ([`e3bb2ff`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/e3bb2ff)). Early designs made the landing page and editor feel unrelated. I unified their appearance ([`4e9a0d3`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/4e9a0d3)), then restored a calmer palette when that change made the workspace too yellow ([`9faff43`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/9faff43)).

The counter also needed more than a visible number: I corrected site-wide visitor counting ([`866e975`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/866e975)) and presence across navigation ([`5f2b4fd`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/5f2b4fd)). Server-side operation audit logs ([`96a8e59`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/96a8e59)) made the multi-user system easier to inspect.

## When passing tests was not enough

After the real-time foundation worked, I added collaborative lines and shapes ([`7dfbd26`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/7dfbd26)). That revealed artifacts and preview misalignment ([`9bcfd97`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/9bcfd97)).

Layer compositing was harder: newer marks could appear above older ones regardless of their selected layer, and some drawing created transparent gaps along outlines. I had Claude repair repaint order and scratch-canvas state ([`4aba466`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/4aba466)), then route live strokes and shapes through the layer compositor ([`7635a4c`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/7635a4c)).

This was where I learned to question the evidence. Mock Canvas tests checked calls and their order, not actual pixels. Even when those tests passed, the browser could still show the wrong stacking. I stopped treating green checks as proof of visual correctness and used overlapping colours, layer visibility and repeated strokes to judge the result. That experience also changed my instructions to Claude: inspect the actual rendering path, preserve working tools and report what was not visually verified.

I then added a paint bucket ([`3b5fefb`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/3b5fefb)). A thin white gap between fills and outlines only became obvious in the actual image, so I extended the fill by one canvas pixel ([`690b028`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/690b028)). The soft-edge airbrush followed ([`b8106d6`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/b8106d6)), then clearer tool icons and a room-code reminder when navigating Home ([`d4a45a7`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/d4a45a7)). I deliberately kept these requests narrow instead of allowing another broad renderer rewrite.

My workflow now combines focused prompts, tests, commit-level evidence and manual interaction checks. I still cannot claim that every multiplayer edge case is solved. What changed most was my role: instead of accepting an agent's report that something works, I define what must remain true, test the visible result and make the agent account for the difference.
