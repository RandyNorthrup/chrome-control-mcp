# Shrink the snapshot, ship `browser_find` first

_The research behind 1.12.0 ([plans/lean-observations.md](../plans/lean-observations.md)), written 2026-11-07. Repository line references are to the tree at `afcbccd`, before that work; the measured sizes in the release notes and [VERIFICATION.md](../VERIFICATION.md) supersede the estimates here._

Chrome Control MCP's agents spend most of their tokens finding things, not doing things. The action replies are already 50-300 bytes each. But the only way to get an element ref is `browser_snapshot`, which takes no parameters and always covers the full page. On a page that hits its 2,000-record cap it is **estimated at 100-140 KB (about 25-35k tokens)**. That is past the 50,000-character point where Claude Code stops inlining a tool reply and diverts it to a file. The other two big costs are a **44,965-byte catalog of 53 tools** (reconstructed from source) and lossless device-pixel PNG screenshots. Those screenshots bill up to **3.6 times the visual tokens** of a CSS-pixel capture on current Claude models. The agents that keep calling a nonexistent `browser_find` are asking for the fix their training points to. Playwright MCP shipped `browser_find` with a `text` parameter in July 2026, and Anthropic's browser toolset defines a natural-language `find` that returns up to 20 refs in the snapshot's own format.

The ranked plan has six steps:

1. **Build a token and latency meter.** This project has never measured the size of one of its own snapshots.
2. **Ship a deterministic, read-only `browser_find`.**
3. **Give the snapshot scope controls.** Add `ref`, `depth`, `filter` and `max_chars`, add slimming that needs no model, and replace today's blind cut at the tail with elision by page region.
4. **Make action tools report what they caused,** with an opt-in snapshot in the same reply.
5. **Capture screenshots at CSS scale,** capped at 1,568 px, with zoom by ref or region.
6. **Remove the 35 copies of one `tab_id` sentence** from the catalog.

The research supports the safe end of that list. Deterministic pruning cut 6-17% of tokens with no loss of success, while blind truncation cost 7-11 points. Every competitor that leads on tokens has already moved this way. Latency matters less than tokens, because a model turn takes seconds. Three measured hot spots still deserve cheap fixes: a 25 ms relay poll that sets the rhythm of every exchange, scrolls with a 2.1 s median, and clicks with a 1.1 s median on the Linux test rig. Four popular ideas should stay unbuilt: structured content, dynamic toolsets, a model-backed find through MCP sampling, and workflow memory on the server.

## The full-page snapshot sets the bill, not the action replies

The baseline audit is a static read of the tree at HEAD afcbccd plus the 1.11.1 work then in progress. Nothing was run against a browser, so its numbers come in three kinds, and this report labels each one:

- **Reconstructed from source:** catalog bytes rebuilt by a script from the C++ catalog code.
- **Measured:** per-case milliseconds in three committed live end-to-end (E2E) evidence files, and the VERIFICATION tables.
- **Estimated:** worked out from caps in the code.

Repository line references follow the audit's snapshot of the tree. In `src/browser_contract.cpp`, every line after 11 has since moved down by one.

**No action tool returns a snapshot, and none needs to shrink.** A click replies `{ok, x, y, button, click_count}` plus `tab_id`. A navigation replies `{ok, url, title, load_complete}`. That is roughly 50-300 bytes each, inferred from the payload shapes ([browser_bridge.cpp:476](../../src/browser_bridge.cpp#L476)). The cost comes one call later. Refs come only from `browser_snapshot`. Any top-frame navigation or same-document URL change bumps a DOM epoch, and ref actions are refused until the agent snapshots again ([background.js:5574](../../browser/extension/background.js#L5574)). So every page move forces an action, then a snapshot, at the price of two model turns.

The snapshot takes **no parameters besides `tab_id`** ([browser_contract.cpp:1377](../../src/browser_contract.cpp#L1377)). Its behaviour:

- It walks the whole accessibility tree in document order, up to 2,000 emitted records ([background.js:104](../../browser/extension/background.js#L104)).
- It emits off-screen nodes, because element bounds are used only to drop zero-size boxes ([browser_contract.cpp:2518](../../src/browser_contract.cpp#L2518)).
- It indents by raw accessibility-tree depth, so dropped wrappers still add up to 40 leading spaces.
- No rule removes a link's or button's StaticText child when the child repeats the parent's name. This comes from a code grep and was not verified live.
- When the cap binds, the output ends with `... (more elements omitted; the page is very large)` ([browser_contract.cpp:2569](../../src/browser_contract.cpp#L2569)). That is a blind cut in document order.

No evidence file records a snapshot's size on any page. The audit estimates **100-140 KB, about 25-35k tokens,** for a page at the cap, with a theoretical ceiling near 0.8 MB.

That estimate collides with the main client's limits. Claude Code warns above 10,000 tokens of MCP output. For a tool without `_meta["anthropic/maxResultSizeChars"]`, it saves any successful text reply longer than **50,000 characters** to a file and gives the model a path instead ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp)). Competitors' full snapshots of Wikipedia's "Web browser" article measured 110,630 B for Chrome DevTools MCP and 135,754 B for Playwright MCP ([chrome-devtools-mcp](https://www.npmjs.com/package/chrome-devtools-mcp); [@playwright/mcp](https://www.npmjs.com/package/@playwright/mcp)). It follows that Chrome Control's snapshots of heavy pages already land in a file in Claude Code (inference). That costs an extra read call at exactly the moment the agent wanted one ref. Clients without the file diversion inline the whole snapshot. Either way the tokens stay in history, and they cost time as well as money. Browser Use measured 29.1 ms of model time per 1,000 input tokens ([Browser Use](https://browser-use.com/posts/speed-matters)), which puts a 30k-token snapshot near 0.9 s of prompt processing on that vendor's model (computed; specific to that model).

**The catalog is the second cost.** The full profile's `tools/list` array is **44,965 bytes for 53 tools, about 11.2k tokens at four characters per token** (reconstructed from source). JSON usually packs more tokens per character than prose, so the real count is higher. The read-only profile is 8,945 bytes for 14 tools, and the `initialize` instructions are 1,740 characters ([mcp_dispatch.cpp:93](../../src/mcp_dispatch.cpp#L93)). Descriptions make up 65% of the bytes. One 191-character `tab_id` description, copied into 35 schemas, accounts for **8,715 bytes, 19% of the catalog** ([browser_contract.cpp:1317](../../src/browser_contract.cpp#L1317)). The catalog is not wordy per tool: **848 bytes per tool, against Playwright MCP's 842 and Chrome DevTools MCP's 927** (computed from the competitor measurements below). The problem is the number of tools and that one repeated sentence.

**Screenshots** are always lossless PNG at device-pixel resolution, of the viewport by default, with no option for format, quality, scale, element or region ([background.js:6526](../../browser/extension/background.js#L6526)). A 2× viewport capture measured 114,526 bytes of PNG, about 153 KB as base64 ([VERIFICATION.md:802](../VERIFICATION.md#L802)). Under Claude's published rule, an image costs ⌈w/28⌉×⌈h/28⌉ visual tokens ([Claude vision docs](https://platform.claude.com/docs/en/build-with-claude/vision)). A 1280×800 viewport captured at a device pixel ratio (DPR) of 2 is 2560×1600 pixels. It bills **4,784 tokens on Claude 4.7 and later models, against 1,334 at CSS scale** (computed). Two smaller faults sit in the same path. The bridge drops the extension's `clipped` and `content_*` fields, so the model is never told a full-page capture was cut ([browser_bridge.cpp:728](../../src/browser_bridge.cpp#L728)). And the reply puts the image block before its text ([mcp_dispatch.cpp:461](../../src/mcp_dispatch.cpp#L461)).

**The latency evidence is real but narrow.** It comes from three live full-browser E2E runs of 177 cases each, on a local test page under WSL2 Linux. Each case's time also includes a follow-up `browser_tabs` check ([full_browser_e2e.mjs:168](../../tests/e2e/full_browser_e2e.mjs#L168)). Fast calls cluster at multiples of about 25.5 ms. `browser_dialog`, which skips the extra check, took exactly 26 ms in all six cases. That pattern matches the relay's wait loop, which sleeps 25 ms between checks and notices a finished reply only on its next tick ([browser_bridge_relay.cpp:157](../../src/browser_bridge_relay.cpp#L157)). This is inferred from the source plus the clustered timings; it was not instrumented directly. The slow outliers are actions. On Linux, clicks have a 1,082 ms median and scrolls a 2,091 ms median. The macOS run on the user's own Chrome recorded clicks and keystrokes at 26-129 ms ([VERIFICATION.md:847](../VERIFICATION.md#L847)).

| Cost item                                           | Value                                                  | Basis                                                                     |
| --------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `tools/list`, full profile                          | 53 tools, 44,965 B (≈11.2k tokens)                     | Reconstructed from source                                                 |
| `tools/list`, read-only profile                     | 14 tools, 8,945 B (≈2.2k tokens)                       | Reconstructed from source                                                 |
| `initialize` instructions                           | 1,740 chars (≈435 tokens)                              | Counted from source                                                       |
| Repeated `tab_id` description                       | 35 copies, 8,715 B (19% of catalog)                    | Reconstructed from source                                                 |
| Snapshot of a page at the 2,000-record cap          | 100-140 KB (≈25-35k tokens)                            | Estimated from caps; never measured                                       |
| Action reply                                        | ≈50-300 B                                              | Inferred from payload shapes                                              |
| `browser_read` ceiling                              | 200,000 chars, JSON-escaped                            | Read from source                                                          |
| Viewport screenshot at 2×                           | 114,526 B PNG                                          | Measured                                                                  |
| Visual tokens, 1280×800 at DPR 2 vs DPR 1           | 4,784 vs 1,334 (Claude 4.7+)                           | Computed from Anthropic's formula                                         |
| Snapshot / read / wait_for latency on the test page | p50 53 / 52 / 52 ms, each including a ≈26 ms tab check | Measured, WSL2                                                            |
| Click / hover / scroll latency                      | p50 1,082 / 980 / 2,091 ms                             | Measured, WSL2                                                            |
| chrome.debugger cost                                | 2.7 ms for an empty call; ≈7 MB/s of base64            | Measured inside the worker ([VERIFICATION.md:43](../VERIFICATION.md#L43)) |

## Competitors converged on scoped trees, cheap find and quiet actions

Every serious competitor now returns an indented accessibility-tree text with short refs. They differ in default scope, pruning and caps, and those differences produce a **6.8× size spread on the same page**. The researchers installed the current npm releases on 2026-11-07, spoke raw MCP over stdio, and measured reply bytes in headless Chrome at 1280×720. Each figure comes from a single run.

| Server (version)                            | `tools/list`                                    | Wikipedia snapshot                         | Find tool                                            | After an action                             | Screenshot defaults                                  |
| ------------------------------------------- | ----------------------------------------------- | ------------------------------------------ | ---------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------- |
| Chrome Control MCP (1.11.x)                 | 44,965 B, 53 tools (reconstructed)              | not measured (est. 100-140 KB when capped) | none                                                 | small JSON; a separate snapshot is needed   | PNG at device pixels, no clip                        |
| Playwright MCP 0.0.84                       | 21,060 B, 25 tools                              | 135,754 B                                  | `browser_find` with `text`/`regex`, ±3 context lines | snapshot written to a file; 237-349 B reply | png/jpeg/webp; `scale` css or device                 |
| Chrome DevTools MCP 1.12.0                  | 29,661 B, 32 tools (`--slim`: 1,201 B, 3 tools) | 110,630 B                                  | none                                                 | opt-in `includeSnapshot`, default false     | format, quality, element clip by uid, max-size flags |
| agent-browser 0.41.2 (MCP mode)             | 88,189 B, 29 tools                              | 20,100 B (interactive default)             | CLI only                                             | small JSON; opt-in `delta`                  | `ifChanged`, selector clip                           |
| BrowserMCP 2.4.0                            | 1,153 B, 1 tool                                 | not measured; 10k-char default cap         | `find "<text>"` with ancestors                       | one ✓ line; URL and title only when changed | JPEG q80, ≤1,568 px, target clip                     |
| Anthropic `browser_toolset_20260801` (spec) | n/a                                             | `read_page` capped at 50,000 chars         | `find`, ≤20 matches in the same format               | screenshot not needed after each call       | `zoom` crop; 1,568 or 2,576 px limits                |

Sources: [@playwright/mcp](https://www.npmjs.com/package/@playwright/mcp), [chrome-devtools-mcp](https://www.npmjs.com/package/chrome-devtools-mcp), [agent-browser](https://www.npmjs.com/package/agent-browser), [@browsermcp/mcp](https://www.npmjs.com/package/@browsermcp/mcp), [Claude API: Browser use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool).

**Scope is the biggest lever on size.** agent-browser's interactive-only default measured 20,100 B on Wikipedia. That is **6.8× smaller than Playwright's full snapshot** and 4.2× smaller than agent-browser's own non-interactive mode. On Hacker News and GitHub, its own ratio was 1.8× and 2.3× ([agent-browser](https://www.npmjs.com/package/agent-browser)). The leaders spent 2026 pruning:

- **Playwright MCP.** Release 0.0.78 "distilled" snapshots "to reduce noise and token usage". Release 0.0.84 now omits unrendered text, inert content, and everything outside the topmost modal `<dialog>` ([Playwright MCP releases](https://github.com/microsoft/playwright-mcp/releases)).
- **Chrome DevTools MCP.** Release 1.11.0 cut "StaticText noise". Release 1.12.0 dropped InlineTextBox nodes and truncated `data:` URLs ([DevTools releases](https://github.com/ChromeDevTools/chrome-devtools-mcp/releases)).
- **Anthropic.** The published `read_page` contract shows only visible elements by default. It adds an `interactive` filter, a depth limit of 15, subtree scoping by `ref`, and a 50,000-character cap that must "say so in the text" so Claude narrows with a smaller depth or a ref ([Claude API: Browser use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool)).
- **BrowserMCP.** It caps snapshots at 10,000 characters by default. A cut snapshot ends with a hint to narrow it with `find`, a target, `--depth` or `-i` ([@browsermcp/mcp](https://www.npmjs.com/package/@browsermcp/mcp)).
- **Browser Use.** Its serializer is the most detailed public pruning stack, and none of it needs a model ([serializer.py](https://raw.githubusercontent.com/browser-use/browser-use/main/browser_use/dom/serializer/serializer.py)):
  - It indexes only interactive elements.
  - It drops children that sit 99% inside a clickable parent's box.
  - It skips nodes hidden behind opaque painted layers.
  - It keeps a short list of attributes, without `class`.
  - It caps values at 100 characters and shows 4 options per select.
  - It marks elements that are new since the last step with `*`.

**Find tools come in two families, and the agents' failed calls match both.** The first family is deterministic:

- **Playwright `browser_find`** (since v0.0.78, 2026-07-09) searches the accessibility snapshot for text or a regex. It returns matches with surrounding context, each shown under its ancestor path, which is "cheaper than capturing the whole snapshot when you only need to locate an element and its ref". The source keeps three context lines and merges overlapping windows. A `maxResults` parameter arrived in 0.0.84 ([Playwright MCP releases](https://github.com/microsoft/playwright-mcp/releases)).
- **BrowserMCP's `find`** prints matching lines with their ancestors, "so you can act on a ref without a full snapshot" ([@browsermcp/mcp](https://www.npmjs.com/package/@browsermcp/mcp)).

The second family uses a model:

- **Anthropic's toolset `find`** "return[s] up to 20 matches in the same tagged format as `read_page`". The refs work directly with click and form tools, and the spec gives an exact error text for stale refs ([Claude API: Browser use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool)). The spec leaves the matching method to the executor.
- **Claude in Chrome v1.0.56** sends the full accessibility tree to `claude-sonnet-4-5` with `max_tokens: 800` and returns up to 20 elements. This comes from a third-party read of the extension source ([sshh12 gist](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b)).
- **Stagehand's `observe`** and AgentQL queries are also backed by a model.

An agent call of `{"text":"View replies (1)"}` is Playwright's shape. `{"query":"Send message button"}` is the natural-language shape. The inference is that models have learned both contracts.

**Post-action snapshots have moved out of the reply.**

- **Playwright 0.0.84** still captures a snapshot after each action. It writes the snapshot to a `.yml` file and returns only a link, so a measured `browser_navigate` reply was 237-349 B ([@playwright/mcp](https://www.npmjs.com/package/@playwright/mcp)). The playwright-cli launch notes expected token use to fall "since snapshots are no longer forced into the LLM" ([Playwright MCP releases](https://github.com/microsoft/playwright-mcp/releases)).
- **Chrome DevTools MCP** makes the snapshot opt-in through `includeSnapshot`, default false, on click, drag, fill, fill_form, hover, press_key, upload_file and click_at ([DevTools tool reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md)).
- **BrowserMCP** prints one ✓ line per action. It adds URL and title only when they changed, plus notes for new console errors, opened tabs or dialogs.
- **agent-browser's opt-in `delta`** returned **558-572 B for an unchanged page**, against 20-85 KB for full state ([agent-browser](https://www.npmjs.com/package/agent-browser)).
- **Playwright's own incremental mode** became its default in December 2025 and is absent from 0.0.84. The researchers found no release note explaining why ([Playwright MCP releases](https://github.com/microsoft/playwright-mcp/releases)).

**Screenshots and catalogs follow the same discipline.**

- **BrowserMCP** captures JPEG at quality 80, capped at 1,568 px on the long side. Claude in Chrome downsizes to the same 1,568 px ([sshh12 gist](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b)).
- **Chrome DevTools MCP** has server-wide format, quality and max-size flags. Its configuration doc notes that image tokens scale with dimensions ([DevTools configuration](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/configuration.md)).
- **Playwright** captures at CSS scale by default.
- **Anthropic's `zoom`** returns a full-resolution crop scaled into the usual screenshot size, so detail costs a second small image rather than a bigger default ([computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)).
- **Catalogs.** BrowserMCP fits its whole surface into one 1,153-byte tool that takes a command script. DevTools offers `--slim` and opt-in categories. Playwright has `--caps`. agent-browser is the warning: 88 KB, because every tool repeats about 14 session properties ([agent-browser](https://www.npmjs.com/package/agent-browser)). That is the same failure as Chrome Control's 35 copies of `tab_id`, at a larger scale.

## Papers and protocol limits point the same way

The research literature supports the cheap, deterministic end of observation shaping and punishes the crude end.

| Technique (source)                                                                                           | Observation tokens      | Success effect                                                      |
| ------------------------------------------------------------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------- |
| Drop StaticText that repeats the parent's name ([Hajimiri et al. 2026](https://arxiv.org/html/2606.15017v1)) | −6% to −17% per task    | +0.5 to +2.9 points at a 10-step budget                             |
| AgentOccam observation refinements ([AgentOccam](https://arxiv.org/html/2410.13825))                         | −14% per step           | 30.0% → 34.7% (development set)                                     |
| Region selection plus change tracking, PageDigest ([Region4Web](https://arxiv.org/html/2605.07134))          | −43% average            | +1.7 to +3.0 points across four backbones                           |
| LLM retriever pruning ([FocusAgent](https://arxiv.org/html/2510.03204v1))                                    | −51% to −59%            | −1.5 to −4.7 points                                                 |
| Blind truncation to 5k tokens (FocusAgent baseline)                                                          | −38% to −46%            | −7.4 to −11.2 points                                                |
| BM25 top-k pruning (FocusAgent baseline, WorkArena L1)                                                       | −54%                    | −12.4 points                                                        |
| Model-chosen keywords, scoring done in code ([Prune4Web](https://arxiv.org/html/2511.21398v1))               | 25-50× fewer candidates | 80.65% vs 70.84% grounding accuracy with GPT-4o doing it end to end |
| Re-grounding on a crop ([ScreenSpot-Pro](https://arxiv.org/html/2504.07981))                                 | crop only               | 18.9% → 40.2% with a 1,024 px crop                                  |
| Masking old observations ([Complexity Trap](https://arxiv.org/html/2508.21433))                              | cost about −50%         | flat in 4 of 5 configurations                                       |

Five conclusions follow, and the recommendations below rest on them:

- **Deterministic rules are cheap and do no harm.** A study from NEC timed rule-based accessibility-tree pruning at **0.04-0.27 s per observation**, against 20-106 s for LLM-based methods ([NEC](https://arxiv.org/html/2605.29397)).
- **Never cap a snapshot by blind truncation.** If a cap is needed, cut by relevance or region and leave stubs. FocusAgent's best result kept the id and role of each pruned line, reaching 53.9% at 22% pruned, against 51.5% with those lines fully removed.
- **Don't page a snapshot by scrolling.** AgentOccam's switch from scrolling to loading the full page raised development-set success from 25.8% to 30.0%, even though tokens per step doubled.
- **Within a page, most actions change little.** In Mind2Web, **52.9% of within-page steps changed nothing in the DOM** and 74.4% changed under 5% ([Region4Web](https://arxiv.org/html/2605.07134)). That is the case for reporting what changed. PageDigest's change tracking came with a success gain, but no paper isolates diff-only observations against full re-snapshots.
- **Text beats screenshots for general models, and crops are the screenshot lever.** In OSWorld, accessibility-tree input scored 12.24% with GPT-4 against 5.26% for screenshots alone with GPT-4V ([OSWorld](https://arxiv.org/html/2404.07972)). In WorkArena, Set-of-Mark screenshots added nothing over text, 41.8 against 42.7 ([WorkArena](https://arxiv.org/html/2403.07718)). Screenshots helped only on visually grounded tasks. Region crops are the consistent win (ScreenSpot-Pro above; RegionFocus gained 28% or more ([RegionFocus](https://arxiv.org/abs/2505.00684))). The caveat is age: most modality comparisons used 2023-2024 models, and no 2025-2026 ablation with frontier computer-use models was found.

**The protocol and the clients set hard edges that the design must respect.**

- **Claude Code defers MCP tools by default.** Only tool names and server instructions load at session start. Instructions are cut at 4,096 characters. Tool search "reads only the part within the shorter limit", so the words a search would match belong near the start of each description. A tool can opt into loading upfront with `_meta["anthropic/alwaysLoad"]`. Error text over about 11,000 characters keeps only its first and last 5,000 ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp)).
- **Tool count hurts selection.** Anthropic's tool-search docs say Claude's ability to pick the right tool "degrades once you exceed 30-50 available tools", and recommend keeping the 3-5 most-used tools loaded upfront ([tool search docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)).
- **Definitions must stay byte-stable.** Prompt caching covers tools, then system, then messages. Any change to a definition invalidates everything after it, while tool results do not ([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)).
- **MCP 2026-07-28** asks servers for a deterministic `tools/list` order, explicitly "to improve LLM prompt cache hit rates". It forbids lists that vary per connection, and it deprecates Sampling ([MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog); [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)).
- **Codex** sends the JSON of `structuredContent` whenever it is present, and drops the text content ([Codex PR #2594](https://github.com/openai/codex/pull/2594)). It filters tools by name through `enabled_tools`/`disabled_tools` and has a default `tool_timeout_sec` of 60. Those two facts come from a third-party write-up ([Codex MCP write-up](https://codex.danielvaughan.com/2026/04/11/codex-cli-mcp-maturation-resource-reads-outputschema/)).
- **Cursor** enables or disables whole servers only and asks for approval per tool by default ([Cursor MCP docs](https://cursor.com/docs/context/mcp)).
- **VS Code** lets users turn tools on and off one by one ([VS Code MCP docs](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)).

## Twelve changes, ranked by tokens saved per unit of risk

The order weighs the expected token or turn savings and the strength of the evidence against the risk to the project's "no regressions, all clients" rule. Effort ratings are rough engineering judgment, not estimates from data.

| #   | Change                                                                                                      | Token or turn effect                                                                          | Latency effect                                         | Basis                                    | Main risk                                      | Effort |
| --- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------- | ---------------------------------------------- | ------ |
| R0  | Token and latency meter, per-hop timing                                                                     | Makes every A/B possible                                                                      | none                                                   | n/a                                      | none (release-time live tier only)             | S      |
| R1  | `browser_find` (text or query, regex, role, max_results)                                                    | Locate step: est. 1-4 KB vs est. 100-140 KB snapshot                                          | same capture; removes Claude Code's file detour        | measured at competitors; sizes estimated | new name missing from client allow-lists       | M      |
| R2  | Snapshot `ref`/`depth`/`filter`/`max_chars`, slimming, elision by region                                    | −6% to −17% from StaticText dedupe (measured elsewhere); worst case est. 25-35k → ≤10k tokens | unchanged; a scoped capture is faster (unmeasured)     | papers and competitors                   | default output changes; stage the cap          | M-L    |
| R3  | Consequence summary and opt-in `snapshot` on actions                                                        | Skips one call and one turn per look                                                          | saves a model turn (≈3 s, vendor-measured)             | competitors; Mind2Web change statistics  | settle wait only when opted in                 | M      |
| R4  | Screenshots at CSS scale, 1,568 px cap, text first, zoom by ref or clip, format and quality, 8,000 px guard | −72% visual tokens at DPR 2 on Claude 4.7+ (computed)                                         | fewer bytes over the ≈7 MB/s pipe                      | Claude formula; measured bytes           | coordinate mapping in `click_at`/`box`         | M      |
| R5  | Catalog diet, stable instructions, opt-in core toolset                                                      | −5 KB from `tab_id` alone; catalog target ≈30 KB                                              | none                                                   | reconstructed sizes                      | one-time prompt-cache rewrite                  | S      |
| R6  | `browser_read` as scoped, capped plain text with offsets                                                    | worst case est. 50k → ≤10k tokens                                                             | none                                                   | Anthropic guidance; Claude Code limits   | reply shape changes                            | S-M    |
| R7  | Settle scrolls by a position-stable check; find the cause of 1 s Linux clicks                               | none                                                                                          | scroll p50 2,091 ms (measured) → est. 100-200 ms       | measured E2E                             | background-tab timers                          | M      |
| R8  | Wake the relay on the reply instead of polling every 25 ms                                                  | none                                                                                          | est. 20-25 ms per exchange, more with several profiles | measured timing clusters                 | cancel forwarding                              | S      |
| R9  | Overlay installed once per document; ref resolution in one call; parallel snapshot reads; `wait_until`      | none                                                                                          | est. 30-40 ms per ref action; snapshot gain unmeasured | measured 2.7 ms per CDP call             | overlay correctness; occlusion rules           | M      |
| R10 | Opt-in `if_changed` and new-ref markers                                                                     | unchanged page: ≈0.1-0.6 KB vs full                                                           | none                                                   | agent-browser measured 558-572 B         | compaction leaves the agent without a baseline | S      |
| R11 | `browser_fill_form` now; `browser_batch` behind a flag                                                      | fewer calls per form; −37% tokens from programmatic tool calling (Anthropic)                  | fewer turns                                            | Anthropic, Playwright, BrowserMCP        | a batch bypasses per-tool permissions          | M      |

Ship in two waves to honour the no-regressions rule. **Wave one** adds every new tool and parameter with today's defaults intact, plus slimming rules that only remove duplicated text. **Wave two** flips defaults (the snapshot cap and the screenshot scale) only after the meter shows equal or better task results on the test page and the public pages. Live measurements belong in the release-time `live.yml` workflow, never in the per-push quality gates. Each wave proves it caused no regression in its own plan ledger under `docs/plans/evidence/`.

### R0. Build the meter before touching the snapshot

**What changes.** Add a meter script beside [`scripts/mcp_smoke.mjs`](../../scripts/mcp_smoke.mjs). It drives the built server over stdio and records bytes, line count, wall-clock time and an approximate token count (bytes/4) for each reply. It covers:

- `tools/list` in both profiles;
- `browser_snapshot`, `browser_read` and `browser_screenshot` on the E2E test page;
- the same calls on the three public pages the competitor study measured at a 1280×720 viewport: en.wikipedia.org/wiki/Web_browser, news.ycombinator.com and github.com/microsoft/playwright-mcp. That puts Chrome Control's numbers in the same table as Playwright's, DevTools' and agent-browser's.

Add per-hop timestamps to the internal frame metadata the server already strips before the model sees it ([background.js:2154](../../browser/extension/background.js#L2154)): server send, relay forward, worker receive, time in CDP, and worker reply. Write them into the evidence file. The logged-in heavy pages where agents reached for `browser_find` (X, YouTube Studio) need the owner's accounts. Run them by hand and record them as evidence, not as a gate.

**Expected effect.** None on its own. It turns every "estimated" in this report into a measurement, and it is the verification tool for R1-R11.

**Compatibility.** No client sees a change. Public-site numbers drift as the sites change, so gate only on thresholds measured on the local test page. Run live measurements on a disposable test PC (`ssh testpc1`) rather than the shared Chrome other agents are using. Exact tokenizer counts need an API key for a token-counting endpoint. Bytes are enough for A/B ratios, so minting a key is the owner's decision, not a default step.

**Verify.** Two consecutive runs on the test page agree within noise. The catalog numbers match the audit's reconstruction to the byte: 44,965 B for the full profile, 8,945 B for read-only.

### R1. Ship a deterministic `browser_find` that speaks the snapshot's format

**What changes.** Add a read-only tool named exactly `browser_find`.

_Schema._ Two optional strings: `text` (Playwright's name) and `query` (the natural-language name). They mean the same thing. Add optional `regex`, `role` and `max_results` (default and maximum 20, matching Anthropic's contract), plus the automatic `tab_id`. Keep the schema flat and have the server check that one of `text`, `query` or `regex` is present, so no client needs `anyOf` support. An unknown or missing argument should return an `isError` result that names the accepted parameters, because the spec treats input errors as tool errors so models can correct themselves ([MCP 2025-11-25 changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog)).

_Matching._ It runs the same capture as `browser_snapshot`, so it searches the whole page, off-screen nodes included. It then scores records in C++, in this order: exact accessible-name match, then prefix, whole word, substring and token overlap. Interactive and in-viewport nodes get a boost. Role words in the query ("button", "link", "field", "checkbox", "tab", "menu") become a role filter and are stripped from the text. This is the Prune4Web split: the model supplies the words and code does the scoring.

_Output._ The reply opens with `Found N matches (showing M)`. Each hit prints in the exact snapshot line format with the same ref, such as `- button "Send message" [ref=e212] (clickable)`, under its landmark, heading or dialog ancestors, as in Playwright's ancestor-path snippets, plus an `off-screen` flag. With zero hits, the reply lists the three closest names, so the agent can correct itself without another call, and names `browser_snapshot` with `filter` as the fallback.

_Refs._ Matched refs merge into the tab's server-side ref index ([browser_bridge.cpp:528](../../src/browser_bridge.cpp#L528)) without evicting refs from the last snapshot. So `browser_click ref=e212` works with no snapshot in between. Cross-origin frames stay unsearched, as they are for snapshots, and the reply says so.

_Instructions._ Add one line to the `initialize` instructions: to locate an element, call `browser_find` before taking a full snapshot.

**Expected effect.** On a page where the snapshot hits its cap (est. 100-140 KB), a 20-match reply with ancestor lines should land around 1-4 KB (estimate: 20 matches × 2-4 lines × ≈60 characters). That is a reduction above 95% for every "locate, then act" step. Playwright measured 1,017 B against a 1,802 B full snapshot on a near-empty page, and the gap grows with page size ([@playwright/mcp](https://www.npmjs.com/package/@playwright/mcp)). Capture time is unchanged (snapshots on the test page have a 53 ms median, including the tab check). Rule-based matching adds little: NEC timed rule-based pruning at 0.04-0.27 s per observation even in Python ([NEC](https://arxiv.org/html/2605.29397)). In Claude Code, find also removes the file detour for oversized snapshots.

The accuracy risk is paraphrase. A deterministic match misses "Send message button" if the accessible name is just "Send". Token overlap, role-word handling and the near-miss list cover part of that gap. Prune4Web's model-chosen keywords with scoring done in code beat end-to-end GPT-4o pruning, 80.65% against 70.84% grounding accuracy ([Prune4Web](https://arxiv.org/html/2511.21398v1)). FocusAgent's finding that BM25 pruning cost 12 points does not carry over directly. It applies when the pruned tree is all the model sees, and here the full snapshot stays one call away.

**Compatibility.** The tool is additive. The full profile grows from 53 to 54 tools and the read-only profile from 14 to 15. The smoke test pins both counts ([mcp_smoke.mjs:79](../../scripts/mcp_smoke.mjs#L79)), and the read-only allow-list must name the new tool ([mcp_dispatch.cpp:391](../../src/mcp_dispatch.cpp#L391)). Claude Code users discover it through tool search, so its description should open with the words a search would match: "Find elements on the page by visible text or name and return their refs." Codex users with an explicit `enabled_tools` list, and VS Code users who curate their tools, will not see it until they add it, so the release notes must say so. For several agents sharing the server, the refs are bound to the tab like snapshot refs, a tab held by another session is refused as it is today, and routing across profiles follows `tab_id`.

**Verify.** C++ unit tests on recorded capture JSON cover the ranking order, role-word extraction, the near-miss list on zero hits, ref identity with a snapshot of the same capture, and index merging (snapshot, then find, then a click on a ref from the snapshot). A live E2E case clicks a find result without a prior snapshot, and gets the epoch refusal after a navigation. The two logged agent calls, `{"query":"Send message button"}` and `{"text":"View replies (1)"}`, become regression cases on test pages with those labels. The meter compares find bytes against snapshot bytes on the three public pages.

### R2. Give `browser_snapshot` scope controls, model-free slimming and elision by region

**What changes.** Four steps.

_New optional parameters._

- `ref` roots the outline at any ref. Refs stay identical to the full snapshot's.
- `depth` limits depth below that root.
- `filter` takes `all` (the default, today's content), `interactive`, or `viewport`. `interactive` keeps nodes that have a ref, plus landmarks and headings as structure, like agent-browser's and BrowserMCP's `-i`. `viewport` keeps nodes that intersect the viewport, plus one count line per off-screen landmark.
- `max_chars` caps the output.

_Refs for containers._ Give refs to landmarks, dialogs, forms, tables and named regions, so they can be scoped. Today only interactive or value-bearing nodes get refs ([browser_contract.cpp:149](../../src/browser_contract.cpp#L149)).

_Slimming, applied to every filter._

- Drop a StaticText child whose text already appears in its parent's accessible name (the rule Hajimiri et al. tested).
- Indent by the depth of emitted ancestors instead of raw accessibility-tree depth.
- Fold unnamed, non-interactive wrappers that have a single emitted child into that child.

_Elision instead of the tail cut._ Replace the cut at 2,000 records with elision by region. When the output would exceed `max_chars`, keep the header, every node in the viewport, and every landmark and heading line. Collapse the largest off-screen subtrees to stubs such as `- region "Comments" [ref=e900] (312 elements omitted: browser_snapshot ref=e900 or browser_find)`. End with one line that names the remedies, in the shape Anthropic's `read_page` contract trains models to follow.

Later, port two Browser Use rules that need only CDP data the extension already fetches: omit content outside the topmost open modal dialog, as Playwright 0.0.84 does, and skip nodes fully covered by opaque painted layers ([paint_order.py](https://raw.githubusercontent.com/browser-use/browser-use/main/browser_use/dom/serializer/paint_order.py)).

**Expected effect.**

- **StaticText dedupe.** The rule cut 6-17% of tokens per task on WebArena sites, with success up 0.5-2.9 points at a 10-step budget ([Hajimiri et al.](https://arxiv.org/html/2606.15017v1)). AgentOccam's observation refinements cut 14% per step while raising development-set success from 30.0% to 34.7% ([AgentOccam](https://arxiv.org/html/2410.13825)). Chrome DevTools MCP shipped the same StaticText and InlineTextBox removals in October 2026 ([DevTools releases](https://github.com/ChromeDevTools/chrome-devtools-mcp/releases)).
- **Indentation.** Relative indentation removes many bytes but fewer tokens, because runs of spaces tokenize compactly. Measure it with a tokenizer before claiming a number.
- **The `interactive` filter.** Its gain for this project is unmeasured. agent-browser's own interactive-versus-full ratio ran 1.8-4.2× ([agent-browser](https://www.npmjs.com/package/agent-browser)), and Chrome Control's default output is already partly filtered, so expect less.
- **The cap.** A 30,000-character default would bound today's estimated 25-35k-token worst case at roughly 7.5-10k tokens, assuming 3-4 characters per token. That stays under Claude Code's 10,000-token warning and its 50,000-character file threshold (estimate).
- **Why elide by region.** Stubs, not truncation, are the evidence-backed way to cap. FocusAgent's truncation to 5k tokens lost 7.4-11.2 points, while keeping the ids and roles of pruned lines held success at 53.9% ([FocusAgent](https://arxiv.org/html/2510.03204v1)).

**Compatibility.** The text format stays `- role "name" [ref=eN] (flags)`, so every client parses it as before. The slimming rules change the default output, and the golden strings in the tests change with them ([test_browser_bridge_relay.cpp:847](../../tests/test_browser_bridge_relay.cpp#L847)). The cap is the one change agents could notice. So wave one ships `max_chars` with no default, and wave two sets 30,000 only after the meter's task A/B shows no loss. `max_chars: 0` keeps the uncapped view. On heavy pages, today's behaviour is already a blind cut at 2,000 records in every client, and a file path in Claude Code, so stubs improve on both. For several agents sharing the server, `ref` scoping honours the tab binding and the epoch check, and nothing is shared across sessions.

**Verify.** Golden tests for each rule on recorded captures: a link with a duplicate text child, a deep wrapper chain, and a page over the cap. E2E cases for `ref`, `depth`, both filters and the elision stub, plus a click on a ref taken from a scoped snapshot. The meter records bytes and line counts before and after, on the test page and the three public pages.

### R3. Make action replies report consequences, with an opt-in snapshot

**What changes.** Every action tool (click, click_at, js_click, type, press_key, select, set_value, hover, drag, upload, scroll, navigate, back, forward, reload) adds a compact `changes` object to its reply. Each key appears only when its event happened:

- `url` and `title` when they changed;
- `dialog` when one opened;
- the existing `opened_tabs` and `file_chooser`;
- `console_errors`, the number of new error entries in the tab's existing console buffer;
- `focus`, the role and name of the newly focused element;
- `dom`, set to `none`, `some` or `many` from a mutation counter.

Install the counter alongside the scripts that already run on every new document when the extension attaches. It stores counts only, not mutation records.

Add an optional `snapshot` parameter: `none` (the default), `interactive` or `all`, plus `snapshot_ref` for a subtree. When set, the action waits for a bounded settle and then appends the slimmed snapshot to its reply. The settle is 100 ms without mutations, capped at 1.5 s. Chrome DevTools MCP uses 100 ms of DOM stability within 3 s.

Update `browser_hover`'s description, which today tells agents to take a fresh snapshot ([browser_contract.cpp:1553](../../src/browser_contract.cpp#L1553)).

**Expected effect.** The default path adds about 30-120 bytes when something changed, and nothing when nothing did (estimate). The value is in turns:

- In Mind2Web, 52.9% of within-page steps changed nothing and 74.4% changed under 5% ([Region4Web](https://arxiv.org/html/2605.07134)). So `dom: none` lets an agent skip a re-snapshot about half the time. That is an inference about how agents will behave, not a measured effect.
- An opted-in `snapshot` saves one tool call and one model turn per look, about 3 s per step on Browser Use's measurement with its strongest model ([Browser Use](https://browser-use.com/posts/speed-matters)). Anthropic notes that ending a batch of actions with an observation "saves a round trip" ([computer use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool)).
- Shipped precedents: Chrome DevTools MCP's opt-in `includeSnapshot`, and BrowserMCP's replies that report only what changed ([DevTools tool reference](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md); [@browsermcp/mcp](https://www.npmjs.com/package/@browsermcp/mcp)).

**Compatibility.** New JSON keys break no client. The default path adds no settle wait, so default latency is unchanged. Asynchronous changes can arrive after the reply, so the summary reports what was seen by reply time, and the description says so. The counter's overhead on heavy single-page apps is unmeasured, so the meter should time actions on a busy single-page app before and after. For several agents sharing the server, counters live per document, and an opted-in snapshot refreshes that session's ref index for the tab exactly as a separate snapshot call would.

**Verify.** E2E cases on the test page where a click opens a dialog, navigates, adds nodes, or does nothing, each asserting the expected `changes`. One opted-in snapshot asserting its refs work immediately. Per-action times on the test page before and after, confirming no default slowdown.

### R4. Capture screenshots at CSS scale, cap them, and add zoom

**What changes.**

_Defaults._ Capture at CSS-pixel scale using the `scale` field of the CDP clip, keep aspect ratio, and cap the long edge at 1,568 px. The `scale` field is unverified against the protocol definition. If it fails, screencast's documented `maxWidth` and `maxHeight` are the fallback.

_New parameters._

- `scale`: `css` (the default) or `device`.
- `ref` and `clip {x, y, width, height}`: element and region captures at device resolution, the equivalent of Anthropic's `zoom`.
- `format`: `png` (the default), `jpeg` or `webp`, with `quality`.

_Reply._ Put the summary text before the image, and have it state the scale, so an agent knows what one image pixel means. Pass the extension's `clipped` and `content_*` fields through the bridge as a text line.

_Coordinates._ Record the scale of the most recent screenshot per tab, and make `browser_click_at` and `browser_box`'s `screenshot_center` use it. Today `clickAt` divides screenshot pixels by devicePixelRatio ([background.js:17](../../browser/extension/background.js#L17)), which is right only while screenshots are captured at device pixels.

_Full page._ Guard full-page output so no side exceeds 8,000 px, Claude's maximum, by scaling down or by refusing with a hint to use `clip`. Today's guard allows 16,384 px per edge ([background.js:6526](../../browser/extension/background.js#L6526)).

_Encoding._ Benchmark `optimizeForSpeed` before adopting it.

**Expected effect.**

- **Tokens.** At DPR 2 on Claude 4.7 and later models, a 1280×800 viewport drops from 4,784 to 1,334 visual tokens, a 72% cut (computed from the published formula). On standard-tier models the API or client downsizes to at most 1,568 tokens either way. There the saving is upload bytes: quartering the pixel count shrinks the measured 114,526-byte PNG several-fold (estimate).
- **Two hard failures removed.** Claude rejects images over 8,000 px per side. Once a request holds more than 20 images, each must be at most 3,000 px per side ([Claude vision docs](https://platform.claude.com/docs/en/build-with-claude/vision)), and a DPR-2 capture of a 1,920-px-wide viewport is 3,840 px wide. Claude Code says images "may be scaled down or compressed" ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp)), but other clients document nothing.
- **Accuracy from region capture.** This is the strongest accuracy evidence in this literature. Re-grounding on a 1,024-px crop lifted OS-Atlas-7B from 18.9% to 40.2% on ScreenSpot-Pro ([ScreenSpot-Pro](https://arxiv.org/html/2504.07981)). A 1024×1024 crop costs 1,369 tokens and a 768×768 crop 784 (computed).
- **Format.** Format changes bytes, not tokens. Playwright's JPEG without a quality setting came out larger than PNG on three of four pages, while DevTools' default-quality JPEG was 6-49% smaller ([chrome-devtools-mcp](https://www.npmjs.com/package/chrome-devtools-mcp)). So PNG stays the default.
- **Encoding speed.** A Chromium engineer measured roughly a 2× PNG speedup from fast compression settings, at the cost of bigger output ([headless-dev thread](https://groups.google.com/a/chromium.org/g/headless-dev/c/aVZw00nzxTU)). Over a pipe that carries about 7 MB/s, that trade has to be measured.

**Compatibility.** The coordinate mapping is the main risk. Changing the scale without the per-tab record would make every `browser_click_at` miss by the DPR factor. Agents that need crisp small text pass `scale: "device"` or zoom by `ref`. Cursor attaches returned images to the chat ([Cursor MCP docs](https://cursor.com/docs/context/mcp)), so smaller images also lighten its transcript. Swapping the block order is invisible to clients that render both blocks. For several agents sharing the server nothing changes, and the overlay stays hidden by default.

**Verify.** Unit tests for the scale arithmetic and for `click_at` and `box` mapping at DPR 1 and 2, with and without the cap. The existing 2× 390×844 E2E screenshot case asserts the new dimensions. A new case clicks a point read from a screenshot at DPR 2, and a long test page exercises the full-page guard. The meter records bytes and capture time for each format.

### R5. Put the catalog on a diet and keep it byte-stable

**What changes.**

_Shorten._ Cut the `tab_id` property description to one clause, such as "Your tab from browser_new_tab (see server instructions).", since the instructions already explain tab ownership. Trim the longest descriptions to a first sentence that leads with search keywords, plus the parameter facts. The longest are `browser_upload` (805 characters), `browser_update_apply` (671), `browser_clipboard` (660), `browser_extension_install` (629), `browser_record_start` (574) and `browser_release` (558). Move shared safety and ownership prose into the instructions, which can grow from 1,740 characters to at most 4,096, Claude Code's truncation point.

_Keep it stable._ Assert in a test that tool order and bytes are identical across runs and restarts. Confirm that the four `profile` sentences built with `.arg()` ([browser_contract.cpp:1287](../../src/browser_contract.cpp#L1287)) and the instructions embed no runtime data such as profile names or versions.

_Optional._ Add a toolset switch at process level, an environment variable or CLI flag such as a `core` set, modelled on Playwright's `--caps` and Chrome DevTools MCP's `--category-*` and `--slim`. Today's full set stays the default. Trial `_meta["anthropic/alwaysLoad"]` on `browser_new_tab`, `browser_snapshot`, `browser_find` and `browser_click`. Keep it only if the meter shows a saved tool-search round trip worth the always-loaded definitions.

**Expected effect.** The `tab_id` change alone saves about 5 KB, roughly 1.3k tokens (estimate from the reconstructed sizes). With description trimming, about 30 KB is a reasonable target, close to Chrome DevTools MCP's 29,661 bytes for 32 tools. That is a target, not a measurement. Clients that load every definition upfront pay the catalog once per session and then read it from the prompt cache. In Claude Code, which loads only tool names and instructions at start ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp)), the instructions and each description's first sentence carry the weight. Anthropic's finding that selection degrades past 30-50 tools, and its advice to keep the 3-5 most-used tools loaded upfront ([tool search docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)), are the case for the opt-in core set and the `alwaysLoad` trial.

**Compatibility.** No tool names change, so allow-lists in Codex, VS Code and Claude Code keep working. Changed descriptions rewrite clients' prompt caches once, at upgrade. MCP 2026-07-28 says `tools/list` must not vary per connection ([MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)), so the toolset switch must be process configuration, never per profile or per agent. Cursor enables or disables only whole servers ([Cursor MCP docs](https://cursor.com/docs/context/mcp)), so it gains the most from a smaller core set. Users with one profile and users with several see the same catalog.

**Verify.** A quality-gate test asserts that the catalog stays within a byte budget, that the order is deterministic, and that the instructions stay at or under 4,096 characters. The smoke test keeps pinning the tool counts.

### R6. Return `browser_read` as scoped, capped plain text

**What changes.**

- Return the content as a plain text block: a short header (url, title, truncated, next offset) followed by the raw text. Today it is a JSON string full of `\n` and `\"` escapes ([browser_bridge.cpp:621](../../src/browser_bridge.cpp#L621)).
- Add `ref` or `selector` scoping.
- Add `max_chars` (default 30,000) with `offset` continuation and an explicit "call again with offset=N" line.
- Add `mode: "main"`, which picks the longest of `article`, `main`, `[role=main]` and common content containers, as Claude in Chrome's `get_page_text` does ([sshh12 gist](https://gist.github.com/sshh12/e352c053627ccbe1636781f73d6d715b)).
- Keep `format: "html"`, capped the same way.

**Expected effect.** The worst case falls from 200,000 characters (est. 50k tokens before escaping) to about 8-10k tokens per call (estimate). The escape savings are unmeasured and small for prose. Scoping saves the most when the agent needs one section of a long page. Anthropic's tool-writing guidance prescribes exactly this pattern: sensible defaults, pagination, and truncation that tells the agent how to get more ([Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)).

**Compatibility.** The reply changes from JSON to text, which models read either way. Claude Code already diverts anything over 50,000 characters to a file, so the cap changes behaviour mainly in other clients, and `max_chars` up to 200,000 restores the old reach. Agents sharing the server and users with several profiles see no change.

**Verify.** Golden tests for escaping, scoping and offsets. The 15 existing read E2E cases pass with the new shape. Meter bytes on the three public pages.

### R7. Fix the multi-second scroll settle and find the cause of the 1-second Linux click

**What changes.**

_Scroll._ Today `browser_scroll` waits up to 2,000 ms for a `scrollend` event, and adds a 600 ms start grace when nothing moved ([background.js:6770](../../browser/extension/background.js#L6770); [background.js:10067](../../browser/extension/background.js#L10067)). Replace that with whichever comes first: `scrollend`, or a scroll position unchanged across two consecutive page-timed samples about 50 ms apart. Cap it at 1,000 ms, and apply the grace only when the page uses smooth scrolling. Use the extension's page-timed delays, not `requestAnimationFrame`, which background tabs throttle. The background-tab work cut scroll from 10,133 to 52 ms precisely by avoiding throttled timers ([VERIFICATION.md:847](../VERIFICATION.md#L847)).

_Click._ First instrument which branch spends the ≈1 s on Linux. There are two candidates:

- The audit suspects that `mouseMoved` events are paced to the frame rate.
- This report adds a second. Whenever only the page root covers the target, `reachablePoint` re-polls every 100 ms for up to `SCROLLBAR_FADE_MS = 1000`, to wait out an overlay scrollbar's fade ([background.js:7394](../../browser/extension/background.js#L7394)). The Linux click median of 1,082 ms sits just above that bound. When the window expires, the loop throws an error instead of clicking, so successful clicks would mean the cover cleared late in the window. That is an inference to test, not a finding.

**Expected effect.** The "scroll nested region" case already completes in 102 ms, so a fast path exists. Bringing the page-scroll cases (2,091-3,123 ms) toward 100-200 ms is an estimate, based on the fit with a 2,000 ms wait plus the 600 ms grace. If the click delay is the scrollbar poll or frame pacing, Linux clicks, hovers and drags (medians of 980-1,157 ms) could approach macOS's 26-129 ms. On a ten-click task that is about ten seconds of wall clock, more than any other server-side item in this report (estimate).

**Compatibility.** Pages that load content on scroll can need longer to settle, so keep `browser_wait_for` as the explicit wait and say so in the scroll description. The scrollbar-fade wait exists for a measured macOS behaviour, so any change must keep macOS clicks from landing on a fading scrollbar. For several agents, shorter actions free the single in-flight command slot sooner ([browser_bridge.cpp:408](../../src/browser_bridge.cpp#L408)).

**Verify.** Per-branch timing in the meter's evidence. The existing 12 scroll and 15 click E2E cases, on Linux and macOS, plus the drag, scroll and hover cases in the background-tab table, must stay at or below their recorded times.

### R8. Wake the relay on the reply instead of polling every 25 ms

**What changes.**

- **Windows.** Replace the loop's `Sleep(kCancelPollMs)` with `WaitForSingleObject` on an event the reader thread sets when the reply arrives. Keep the 25 ms timeout, so `PeekNamedPipe` still checks for a `cancel` ([browser_bridge_relay.cpp:157](../../src/browser_bridge_relay.cpp#L157)).
- **POSIX.** Add a self-pipe or eventfd, which the reader writes to, to the existing `poll` set through the new `posix_poll.h` helpers ([browser_bridge_relay_posix.cpp:78](../../src/browser_bridge_relay_posix.cpp#L78)).

**Expected effect.** Fast exchanges that now cost a full 25 ms tick should finish in a few milliseconds. That estimate comes from the 26 ms `browser_dialog` measurement and the 2.7 ms in-worker cost of an empty CDP call. Across the E2E suite's roughly 350 exchanges, that is several seconds of a 22.6-25.4 s run (estimate). With two or more Chrome profiles, routing adds internal exchanges before the real command ([browser_control.cpp:326](../../src/browser_control.cpp#L326)), and each one pays the tick, so users with several profiles gain more than single-profile users. Against model turns that take seconds this is small, but it is a contained change that no client can see.

**Compatibility.** Cancel forwarding must keep working mid-command.

**Verify.** The ≈25.5 ms clustering disappears from the evidence files, `browser_dialog` drops well below 26 ms, and the existing relay cancel tests pass on both platforms.

### R9. Trim per-command CDP work in the extension

**What changes.**

- **Overlay.** Stop re-sending the ≈2 KB overlay script on every call; input commands send it twice ([background.js:4999](../../browser/extension/background.js#L4999); [background.js:6973](../../browser/extension/background.js#L6973)). Install the overlay function once per document through the attach-time `addScriptToEvaluateOnNewDocument`, call a short refresh, and skip even that when the presence state is unchanged.
- **Ref resolution.** Today a ref click takes 15-18 sequential CDP round trips ([background.js:7432](../../browser/extension/background.js#L7432)). Collapse them into one `Runtime.callFunctionOn` that scrolls into view, settles on page-timed samples, reads the box and runs the hit test. Then send the three mouse events back to back.
- **Snapshot reads.** Issue the snapshot's independent reads concurrently, as Browser Use does: `DOMSnapshot.captureSnapshot`, `Accessibility.getFullAXTree`, `Page.getFrameTree`, and the media and file-input queries. Batch its per-element `DOM.describeNode` calls ([browser-use dom/service.py](https://github.com/browser-use/browser-use/blob/main/browser_use/dom/service.py)).
- **Navigation.** Add `wait_until` (`load` as the default, `domcontentloaded`, `commit`). Today navigation waits for the `complete` status for up to 15 s ([background.js:10312](../../browser/extension/background.js#L10312)).

**Expected effect.** At the measured 2.7 ms per empty chrome.debugger call, the overlay change saves about 3-6 ms per command, and one-call ref resolution about 30-40 ms per ref action, more on busy pages (estimates). Parallel snapshot reads matter on heavy pages, where megabytes of accessibility-tree JSON crossing a pipe of about 7 MB/s most likely dominate capture time (inference; unmeasured). `wait_until` helps sites full of ads, where load completes late (unmeasured). If the meter shows tree transport dominating heavy-page capture, the next step is Playwright's design: an in-page walker that ships only the compact result instead of the full tree ([ariaSnapshot.ts](https://github.com/microsoft/playwright/blob/main/packages/injected/src/ariaSnapshot.ts)). That is a large rewrite, justified only by data.

**Compatibility.** The overlay frames are how agents and the user see which session owns a tab. The refresh must stay correct across navigations and tab-group colour changes. One-call resolution must keep today's occlusion rules, which refuse clicks that a cookie banner would intercept ([background.js:7443](../../browser/extension/background.js#L7443)), and must keep the background-tab timing fixes. `wait_until` is additive, and today's behaviour stays the default.

**Verify.** CDP call counts per command in the meter's per-hop log. The click, hover, drag and overlay E2E cases pass. The cases in the background-tab table stay at or below their recorded times.

### R10. Offer change tracking as an opt-in, not a default

**What changes.** Add `if_changed: true` to `browser_snapshot`. The server hashes the rendered outline per session and tab. When nothing changed, it replies `unchanged since snapshot 7 (412 elements)`. Mark refs that are new since that tab's previous snapshot with a leading `*`, as Browser Use does ([serializer.py](https://raw.githubusercontent.com/browser-use/browser-use/main/browser_use/dom/serializer/serializer.py)). This is cheap, because ref numbers already only grow from a high-water mark ([browser_contract.cpp:2486](../../src/browser_contract.cpp#L2486)). A later experiment is a line-level delta against the snapshot taken on page entry, in PageDigest's style, falling back to a full snapshot when more than about 30% of lines changed, as one open-source agent does ([open-web-agent PR #204](https://github.com/junyeong-nero/open-web-agent/pull/204)).

**Expected effect.** agent-browser's unchanged reply measured 558-572 B against 20-85 KB of full state ([agent-browser](https://www.npmjs.com/package/agent-browser)). Chrome Control's text form would be smaller, about 100 B (estimate). It pays off for polling and for "did my action do anything?" checks. R3's `dom` field covers much of the same need.

**Compatibility.** Opt-in only, for two reasons. First, Playwright MCP made incremental snapshots its default in December 2025 and has since removed them without a stated reason ([Playwright MCP releases](https://github.com/microsoft/playwright-mcp/releases)). Second, if a client has compacted the earlier snapshot out of context, an "unchanged" reply leaves the agent with nothing to compare against. Revisions are kept per session, so two agents never get each other's baselines.

**Verify.** Unit tests on hash stability, so volatile header text never makes a page look changed. E2E: an unchanged page returns the short form, and a changed page returns a full snapshot with `*` on the new refs.

### R11. Add `browser_fill_form` now, and keep a general batch tool behind a flag

**What changes.** Add `browser_fill_form` with `fields: [{ref, value}]`. It sets text inputs, selects (by visible option text), checkboxes and radios in one call, and stops at the first failure with the field named. That matches Playwright's `browser_fill_form`, Chrome DevTools MCP's `fill_form` and Anthropic's `form_input`. A general `browser_batch` should ship only behind a process flag. Its shape: `steps: [{tool, args}]`, at most 20 steps, stopping at the first error, navigation, dialog or file chooser, and returning one ✓ line per step plus the R3 summary.

**Expected effect.** One call per form instead of one per field. Anthropic measured programmatic tool calling cutting tokens 37% on complex tasks ([Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)). Playwright added a code-running tool so the model "can speed up repetitive operations and save on context tokens" ([Playwright MCP releases](https://github.com/microsoft/playwright-mcp/releases)). No study isolates multi-action steps on a web benchmark, so the saving in turns is inferred.

**Compatibility.** `browser_fill_form` is additive and narrow. A general batch is a permission problem. Users allow tools by name in Claude Code, in Codex (`enabled_tools`) and in VS Code, and Cursor approves per tool ([Cursor MCP docs](https://cursor.com/docs/context/mcp)). A batch that wraps `browser_click` would let an agent act through a tool the user never allowed. The batch must also stay out of the read-only profile, and must finish under Codex's default 60 s tool timeout ([Codex MCP write-up](https://codex.danielvaughan.com/2026/04/11/codex-cli-mcp-maturation-resource-reads-outputschema/)). It holds the single in-flight command slot for its whole run, which delays every other agent queued on the bridge.

**Verify.** An E2E form fill across all four control types, including how a failure mid-form is reported. The meter counts calls per task on the test page, with and without the tool.

## Structured content, dynamic toolsets and a sampling-backed find stay unbuilt

Several popular ideas would cost this project tokens, compatibility or both.

- **`structuredContent` on existing tools.** It doubles reply tokens in clients that forward both blocks, because the spec says a tool returning structured content SHOULD also return the serialized JSON as text. And Codex sends only the structured JSON when it is present, dropping any curated text summary ([MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools); [Codex PR #2594](https://github.com/openai/codex/pull/2594)).
- **Dynamic toolsets driven by `list_changed`.** In clients that load tools upfront, every change invalidates the whole prompt-cache prefix, because caching covers tools first ([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)). Claude Code's `-p` mode refreshes only the tool list ([Claude Code MCP docs](https://code.claude.com/docs/en/mcp)).
- **A model-backed find through MCP sampling.** It is a dead end. The 2026-07-28 revision deprecates Sampling ([MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)). LLM-based pruning measured 20-106 s per observation, against 0.04-0.27 s for rule-based methods ([NEC](https://arxiv.org/html/2605.29397)).
- **Workflow or skill memory on the server.** It loses to a plain agent given more steps and leaner observations. On Gemini 3 Flash, a budget-matched baseline reached 50.74% at 71.9k tokens per task, against 44.98% at 102.0k for Agent Workflow Memory ([Hajimiri et al.](https://arxiv.org/html/2606.15017v1)). The only model-free piece worth revisiting, after R1 ships, is a cache of find results keyed on page and query.
- **Raising `anthropic/maxResultSizeChars`.** It keeps giant snapshots inline by inflating context instead of shrinking replies.
- **Screenshots attached to every action.** Browser Use measured about 0.8 s of added model latency per screenshot ([Browser Use](https://browser-use.com/posts/speed-matters)), and Anthropic's browser spec says a screenshot is not needed after every call ([Claude API: Browser use tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool)).

Two standards are worth watching rather than building on:

- **WebMCP** is in a Chrome 149 origin trial. Its API moved from `navigator.modelContext` to `document.modelContext` during the preview ([Chrome blog](https://developer.chrome.com/blog/ai-webmcp-origin-trial); [WebMCP explainer](https://github.com/webmachinelearning/webmcp)). A probe that detects page tools can wait until that surface settles.
- **WebDriver BiDi** has no published speed advantage over CDP, and an extension cannot reach it ([Chrome blog: WebDriver BiDi](https://developer.chrome.com/blog/webdriver-bidi)).

## Conclusion

This project's token problem is the shape of what the agent observes and how many turns that takes; catalog prose matters much less. Its catalog is already as dense per tool as Playwright's. Its action replies are smaller than most competitors'. Yet its one source of refs makes every "find the button" step pay for a whole page. So the decisive changes make the expensive call avoidable (`browser_find`, consequence summaries) rather than merely cheaper. The failed `browser_find` calls are also free product research: they show which contracts models arrived trained on. Matching Playwright's and Anthropic's names, parameter names, line format and truncation-remedy wording is an accuracy lever that costs nothing and helps every client. That runs against the usual instinct to design an API of one's own.

Two patterns reach beyond these twelve items. First, the project measures latency carefully but has never measured size. And its largest wall-clock costs on the server side are waits built for correctness on one platform, such as the scrollend race and the 1,000 ms scrollbar poll. Every fixed timeout in the audit's table of hot-path waits deserves the same platform-by-platform review. Second, the in-page walker that R9 holds in reserve cuts traffic over the narrow chrome.debugger pipe. It would also keep snapshots working if chrome.debugger were refused wholesale. Chrome 155 briefly did exactly that on managed browsers before Google rolled it back on November 3, 2026 ([Chrome blog: debugger policy](https://developer.chrome.com/blog/debugger-enterprise-policy-restrictions)). If the meter justifies the rewrite, it buys resilience as well as speed. Meanwhile MCP's stateless 2026-07-28 revision now rewards byte-stable, deterministically ordered definitions and explicit state handles, and `tab_id` already is one. The catalog work in R5 lines the server up with where the protocol is heading.
