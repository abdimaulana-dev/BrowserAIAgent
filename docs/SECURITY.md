# Security notes

This project can read and write files in a local workspace. Treat it as code that can cause real changes, not as a harmless chat integration.

- **Review tool calls.** Keep automatic execution disabled until you understand the workflow. Auto-execution makes only one attempt per identical call, including when a request fails.
- **Use a dedicated workspace.** Do not point it at your whole home directory, Desktop, Documents, or a folder containing secrets.
- **Keep the server local.** It should bind to `127.0.0.1`, not `0.0.0.0` or a public interface.
- **Protect the token.** The same token is stored in the server environment and the Tampermonkey script. Do not commit it, share screenshots showing it, or paste it into public chats. Anyone who obtains it and can reach the local endpoint may be able to call the exposed tools.
- **Avoid sensitive files.** The read tool returns file content to the browser chat, where it may be processed by the AI service.
- **Shell commands require careful review.** `run_command` runs arbitrary commands with your Windows account's permissions. The userscript displays the exact command and its stated purpose and requires an explicit Accept or Reject choice; shell commands are excluded from auto-execution. Other tool calls do not show this shell approval dialog; file changes run only after you click the execute button. This approval is enforced in the browser UI: a client that already has the token can call the server directly. It is not an OS-level sandbox and cannot prevent an approved command from accessing files or settings outside the configured workspace. Only approve commands you understand.
- **Prototype, not a hardened security sandbox.** Path validation is helpful but does not eliminate all filesystem race conditions or risks from software running under the same Windows account.
- **Inspect responses before sending.** Auto-send is optional; leave it off while testing.

If you suspect the token has been exposed, stop the server, generate a new token, update both the server environment and userscript, and restart it.
