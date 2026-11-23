import { connect, disconnect, revoke } from "./oauth.mjs";
import {
  connectEndpoint,
  hasCredential,
  hasEndpointAccess,
  readConnection,
  saveConnection,
} from "./settings.mjs";

const get = (id) => document.getElementById(id);
const report = (error) => {
  get("error").textContent = error.message;
  get("error").hidden = false;
};
/** The connection block: where this profile is connected, and how. */
const describe = (connection) => {
  const connected = hasCredential(connection);
  get("token").placeholder = connection?.token
    ? "Saved locally. Paste a token to replace it."
    : "";
  get("connected").hidden = !connected;
  get("not-connected").hidden = connected;
  get("disconnect").hidden = !connected;
  get("connect").hidden = connected;
  if (!connected) return;
  get("connected-host").textContent = new URL(connection.endpoint).host;
  get("connected-endpoint").textContent = connection.endpoint;
  get("connected-how").textContent = connection.oauth
    ? "Signed in through Valise"
    : "Pasted token";
};

/**
 * `askAccess: false` when the popup opened this page: there is no gesture to
 * ask for site access with, so the grant must already be there.
 */
async function signIn(askAccess) {
  get("error").hidden = true;
  get("status").textContent = "Waiting for approval in the Valise window…";
  try {
    const connection = await connect(chrome, get("endpoint").value, undefined, {
      askAccess,
    });
    describe(connection);
    get("status").textContent = "";
    return connection;
  } catch (error) {
    report(error);
    get("status").textContent = "";
    describe(await readConnection(chrome));
  }
}

get("connect").addEventListener("click", () => signIn(true));
get("token-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  get("error").hidden = true;
  try {
    const replaced = await saveConnection(
      chrome,
      get("endpoint").value,
      get("token").value,
    );
    get("token").value = "";
    describe(await readConnection(chrome));
    get("status").textContent =
      replaced?.oauth && !(await revoke(replaced))
        ? "Token saved. The earlier connection could not be revoked; revoke it in Valise → Connections."
        : "Token saved.";
  } catch (error) {
    report(error);
  }
});
get("disconnect").addEventListener("click", async () => {
  get("error").hidden = true;
  try {
    const revoked = await disconnect(chrome);
    get("token").value = "";
    describe(null);
    get("status").textContent = revoked
      ? "Disconnected. Valise revoked the connection and this browser forgot it."
      : "Forgotten locally. Revoke the token or connection in Valise → Connections too.";
  } catch (error) {
    report(error);
  }
});
try {
  const connection = await readConnection(chrome);
  // Never hydrate a saved secret into a DOM field, even a masked one.
  get("endpoint").value = connectEndpoint(connection);
  describe(connection);
  const opened = new URL(location.href).searchParams;
  if (opened.has("connect")) {
    // Opened by the popup's Connect: finish sign-in, then go back to the page.
    history.replaceState(null, "", location.pathname);
    const endpoint = get("endpoint").value;
    if (!(await hasEndpointAccess(chrome, endpoint))) {
      // A self-hosted endpoint: Chrome asks only on a click, and here a lost
      // focus does not end the script.
      get("status").textContent =
        `Chrome needs site access to ${new URL(endpoint).host}. Choose Connect to Valise to grant it and sign in.`;
      get("connect").focus();
    } else if (await signIn(false)) {
      const back = Number(opened.get("return"));
      if (back) {
        try {
          await chrome.tabs.update(back, { active: true });
          const self = await chrome.tabs.getCurrent();
          if (self?.id) await chrome.tabs.remove(self.id);
        } catch {
          // That page was closed meanwhile; stay here, showing Connected.
        }
      }
    }
  }
} catch (error) {
  report(error);
}
