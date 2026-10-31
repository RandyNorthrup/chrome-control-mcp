# Real editors, live (AC-CLIP-SITES)

Run 2026-10-31 in the dedicated headless Chrome for Testing 153 on Linux (WSL), through
`isolated_run.mjs`, with no accounts and nothing submitted. For each site an agent named `sites`
opened the page, focused the editor (a click, or `browser_focus` when the editor was off screen),
wrote a marker to its own clipboard with `browser_clipboard`, pasted it with Control+V, read the page
to see it arrived, then selected all, cleared its clipboard, copied with Control+C and read the
clipboard back.

| Site                                | Editor framework     | Paste taken by    | Copy came from | Result                                                    | Run                      |
| ----------------------------------- | -------------------- | ----------------- | -------------- | --------------------------------------------------------- | ------------------------ |
| prosemirror.net/examples/basic      | ProseMirror          | page, paste event | page           | pass                                                      | `real-sites-rerun.json`  |
| playground.lexical.dev              | Lexical              | page, paste event | selection      | pass                                                      | `real-sites.json`        |
| slatejs.org/examples/richtext       | Slate                | page, beforeinput | selection      | pass                                                      | `real-sites.json`        |
| quilljs.com                         | Quill                | page, paste event | page           | pass                                                      | `real-sites-rerun2.json` |
| draftjs.org                         | Draft.js             | page, paste event | selection      | pass                                                      | `real-sites.json`        |
| ckeditor.com classic-editor example | CKEditor 5           | page, paste event | selection      | pass                                                      | `real-sites.json`        |
| codemirror.net                      | CodeMirror 6         | page, paste event | page           | pass                                                      | `real-sites.json`        |
| httpbin.org/forms/post              | plain `<input>`      | typed in (field)  | selection      | pass, value checked                                       | `real-sites-rerun.json`  |
| tiny.cloud basic example            | TinyMCE (in a frame) | --                | --             | not tried: the editor's iframe has no ref in the snapshot | `real-sites-rerun2.json` |

Notes on the runs, kept rather than tidied:

- The first run's Quill row drove the playground page's code editor, not Quill; the rerun used
  quilljs.com's own editor, which passed.
- The first run's form-field row failed its check only because an input's value is not page text;
  the rerun asked the field for its value, which held the marker.
- ProseMirror's editable region is not labelled a textbox in the snapshot; the rerun found it as the
  first editable element.
- TinyMCE edits inside a same-origin iframe, which the snapshot lists without a ref, so no agent can
  click into it by ref; it is reachable by screenshot coordinates. The same-origin-frame paste path
  it would exercise is covered by the fixture in `clipboard_e2e.mjs`, and an iframe ref is on
  PLAN.md.
