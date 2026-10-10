# Process overview

I started this project with a simple idea: I wanted people to open a website and draw together, without signing up or learning a complicated tool. At first I imagined a large public wall where drawings slowly disappear, plus private rooms for friends who want to keep working on something. I thought getting the canvas on screen would be the hard part. It turned out that making drawing feel natural, especially when two people are using it, was much harder.

## Getting the basic drawing right

I chose Node.js, Express, SQLite and plain JavaScript with HTML Canvas. I wanted a small setup that I could understand and deploy on Fly.io without running several services. SQLite also suited the single persistent volume provided for the project. The downside is that I had to handle drawing history, updates and rendering myself. I used Claude Code to help build and test those parts, but I made the decisions about what the site should feel like.

My first version saved lines as lists of points ([`be1cb23`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/be1cb23)). It worked until I tried using the eraser like a normal drawing tool. The early solution split a line into smaller pieces ([`7827104`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/7827104)). On paper this sounded reasonable, but thick lines did not erase properly. I kept noticing the difference between what the code said was erased and what I expected to see.

Instead of trying to fix that one case at a time, I changed how the drawing was stored. In [`ac96895`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/ac96895), drawing and erasing became saved actions that the app can replay. Each person's artwork is handled separately, so their eraser cannot remove someone else's marks. It gave later features a safer base, but also showed me that passing tests do not mean a tool feels right.

I then added the two kinds of space I had planned. Public marks fade over time ([`e1ee235`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/e1ee235)), while private rooms keep their marks until the room expires. I decided that a private room should expire after being empty for 24 hours, not simply 24 hours after it was created ([`ebbd205`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/ebbd205)). That felt fairer to people still drawing. I also made undo and redo apply only to the person's own actions ([`396068a`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/396068a)).

## Changing direction more than once

One of the biggest struggles was deciding what kind of drawing website I could realistically make. At first, I wanted something closer to a proper drawing application, with different brushes, tools and editing features. I used existing drawing software as a reference and started building a more complete workspace ([`665bc91`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/665bc91)). However, the more I looked into it, the more I realised how much work it would take. There were too many tools and small details to get right, and I also did not have enough time or resources to create the materials needed for a more complete drawing experience.

I thought pixel art might be a better direction. Compared with freehand painting, it seemed simpler because I would not need complicated brushes or as many drawing features. I could focus on a grid, a few basic tools and a cleaner interface. I started building a pixel-grid system ([`b4033b6`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/b4033b6)) and gradually changed the editor to fit this direction ([`d9eccb1`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/d9eccb1)).

Unfortunately, the pixel-art version turned out to be much more troublesome than I expected. The grid sometimes did not line up with the drawing, brushes could freeze or become very slow, and both new and existing lines could lag or appear incorrectly. These were not just missing features or visual problems. They affected the most basic thing the website needed to do: let people draw smoothly. I spent a lot of time trying to fix them, but each improvement seemed to reveal another problem.

Eventually, I decided to abandon the pixel-art direction and return to freehand drawing ([`edff8cd`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/edff8cd)). It was frustrating because I had already spent so much time rebuilding the editor, and almost none of that work is visible in the current website. However, continuing just because I had invested time would probably have made the project worse.

This experience changed how I think about choosing a technical direction. Something that looks simpler from the outside is not always easier to build. I also realised that I needed to judge progress by whether the basic experience was improving, not by how many features or redesigns I had completed.

## What real-time drawing actually meant

The biggest change this week was making the site work while two people are drawing at the same time. At first, I could draw on one computer and see the result on another only after refreshing. Later, updates arrived automatically, but I noticed something odd: the other person's cursor moved while their line did not appear until they released the mouse. Technically it was updating quickly after each completed line, but it did not feel like live drawing.

I asked Claude to fix that specific problem. In [`0dac644`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/0dac644), the app began sending temporary updates while a line is being drawn. The final saved line still comes from the server, so the preview is not treated as another permanent drawing. I tested it with two browsers and could finally watch a line grow on the other screen.

The eraser had almost the same problem, but it was harder to notice at first. While someone erased, the other browser showed a light grey trail. The artwork only disappeared when the mouse was released. I initially considered leaving it because the result was still correct, but it made erasing feel different from drawing. In [`5856804`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/5856804), the remote screen started showing the actual disappearing marks during the gesture. The preview is temporary, so a cancelled action can return to the saved picture.

I also added nicknames and coloured cursors ([`50cd94e`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/50cd94e)). I did not want full accounts. A small name beside a moving cursor was enough to make the shared space feel less anonymous, while keeping drawing permissions tied to the original guest identity.

## Helping people enter the space

After working on the drawing tools for so long, I noticed the site still opened like an editor, not a place someone might want to visit. I wanted newcomers to see the public artwork before being asked to do anything. That led to the landing page, welcome window and online counter ([`e3bb2ff`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/e3bb2ff)).

My first design attempt was not right. The landing page and editor looked unrelated, the dark landing background made drawings hard to see, and returning visitors skipped the welcome information. I fixed those issues in [`4e9a0d3`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/4e9a0d3), but then the editor became too yellow and the title and Enter button were in the wrong places. I used my original layout sketch and restored the simpler editor colours in [`9faff43`](https://github.com/comp4020-agentic-coding-studio/comp4020-final-se-m1ne/commit/9faff43). I learned to specify what must stay unchanged.

## What is still difficult

I use automated tests to catch broken saving, ownership, room separation and update messages. I also test with two real browser windows, because that is where I notice problems the tests miss. Some live updates still seem less reliable when both windows are resized, and remote cursors sometimes appear in the wrong place. I have not solved that yet, so I do not want to describe synchronization as perfect.

I have also reconsidered adding layers. Shared layers could let one person delete somebody else's work, which goes against my original goal. If I add them, I would rather give each person their own editable layers and show everyone else's work as read-only. For now, I am keeping the project focused on drawing together. The main thing I learned is to treat Claude's working code as a starting point for testing, not as the final answer to a design problem.
