# Bridge Desk 2.2.4

A small local chat UI for BrowserAIBridge. Gemini runs in a separate Chrome profile controlled by Playwright; there is no Gemini API key and no Tampermonkey userscript. The app calls the existing Python bridge for tools.

## Requirements

- Python 3.10+
- Google Chrome
- The existing BrowserAIBridge server configured and running at http://127.0.0.1:5050

## Recommended setup

From the repository folder, double-click `setup.bat`, finish the one-time Gemini sign-in when Chrome opens, then double-click `start.bat`. The app and local bridge start together, and the chat opens in your browser. Double-click `stop.bat` when you're done.

If Gemini needs sign-in again, run `login.bat` from the repository folder. Setup logs are saved under `.local/logs`.

## Manual setup

For a standalone copy, create a virtual environment, install `requirements.txt`, install Chrome with `python -m playwright install chrome`, copy `.env.example` to `.env`, and set `MCP_AUTH_TOKEN` to the value used by the existing bridge. Then run `python app.py --login`, sign in through the regular Chrome window, close it, and run `python app.py`.

The token stays in the local server process and is never sent to the web page. Gemini's browser runs headlessly by default.

## Prototype behavior

- The conversation UI shows only the user's messages and Gemini's final replies by default.
- Turn on Show tool activity to display tool calls and results.
- File changes and shell commands require approval in the app. Read-only tools run through the existing bridge.
- The app binds to 127.0.0.1. Keep the bridge server restricted to localhost too.
- The first message names the chat in the app. The transcript and Gemini conversation link are saved locally, so the same chat can be reopened after refreshing or restarting the app.
- Use **New chat** to start another saved conversation, or select an earlier one in the sidebar. Local chat history is stored in `chats.json`, which is ignored by Git.
- **Delete chat** removes the selected chat and its saved transcript from Bridge Desk only. It does not delete the conversation from Gemini; it remains in Gemini chat history.
- `initial_prompt.md` is sent only with the first message in a Gemini chat. Edit that file to change the agent's starting instructions.

## Known limits

Gemini's page selectors and response structure can change. This prototype uses real browser automation, not a private Gemini API; page changes or Gemini-side automation controls can interrupt it. If headless mode cannot use the saved session, set GEMINI_HEADLESS=false in .env and run the background browser visibly. The regular Chrome login step may still be affected by Google account policies.
