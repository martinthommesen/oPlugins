# Control Chrome through the DevTools protocol only

The extension does everything through `chrome.debugger`, snapshots
included (`Accessibility.getFullAXTree`, `DOM`), and ships no content
scripts. The tool set needs trusted input events, screenshots of
background tabs, console and network capture, and JavaScript that ignores a
page's CSP; only the debugger gives all of these. With the debugger already
required, a content script would add an `<all_urls>` host permission, an
install warning, and a second mechanism to test, for capabilities the
debugger already provides.

## Consequences

- Browser control needs no host permissions. The tunnel's proxy
  authentication may still need some; that is verified before the manifest
  is final.
- Chrome shows "oBrowse started debugging this browser" while any agent tab
  is attached. That is the whole time the tab sits in an agent tab group,
  so that console and network history stays complete.
- The Web Store exempts the Debugger API from its remote-code ban, but
  `debugger` lengthens review.
