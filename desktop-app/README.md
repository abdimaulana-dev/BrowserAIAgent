# Bridge Desk 2.0.0

A small local chat UI for BrowserAIBridge. Gemini runs in a separate Chrome profile controlled by Playwright; there is no Gemini API key and no Tampermonkey userscript. The app calls the existing Python bridge for tools.

## Requirements

- Python 3.10+
- Google Chrome
- The existing BrowserAIBridge server configured and running at http://127.0.0.1:5050

## Setup

1. Create a virtual environment and install this prototype's dependencies:
   python -m venv .venv
   .venv\Scripts\activate
   pip install -r requirements.txt
   python -m playwright install chrome

2. Copy .env.example to .env. Set MCP_AUTH_TOKEN to the same value used in BrowserAIBridge/.env. The token stays in this local server process and is never sent to the web page.

3. Sign in once using a dedicated browser profile in regular Chrome:
   python app.py --login
   Sign in to Gemini, close that Chrome window, then return to the terminal and press Enter. This uses normal Chrome for Google login, which avoids the automated-browser warning.

4. Start the app:
   python app.py

5. Open http://127.0.0.1:5100. Gemini's browser runs headlessly in the background by default.

## Prototype behavior

- The conversation UI shows only the user's messages and Gemini's final replies by default.
- Turn on Show tool activity to display tool calls and results.
- File changes and shell commands require approval in the app. Read-only tools run through the existing bridge.
- The app binds to 127.0.0.1. Keep the bridge server restricted to localhost too.
- The first message names the chat in the app. The transcript and Gemini conversation link are saved locally, so the same chat can be reopened after refreshing or restarting the app.
- Use **New chat** to start another saved conversation, or select an earlier one in the sidebar. Local chat history is stored in `chats.json`, which is ignored by Git.
- `initial_prompt.md` is sent only with the first message in a Gemini chat. Edit that file to change the agent's starting instructions.

## Known limits

Gemini's page selectors and response structure can change. This prototype uses real browser automation, not a private Gemini API; page changes or Gemini-side automation controls can interrupt it. If headless mode cannot use the saved session, set GEMINI_HEADLESS=false in .env and run the background browser visibly. The regular Chrome login step may still be affected by Google account policies.
