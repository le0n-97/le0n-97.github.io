import { createRoot } from "react-dom/client";
import Home from "../app/page";
import "../app/globals.css";
import { PasswordReset } from "./password-reset";

const root = document.getElementById("root");
if (!root) throw new Error("Game root is missing.");

const resetPrefix = "#reset=";
if (window.location.hash.startsWith(resetPrefix)) {
  const code = window.location.hash.slice(resetPrefix.length);
  const cleanUrl = new URL(window.location.href);
  cleanUrl.hash = "";
  try {
    window.history.replaceState(window.history.state, "", cleanUrl.href);
  } catch {
    window.location.replace(cleanUrl.href);
    throw new Error("The reset URL could not be cleared.");
  }
  document.title = "重置密码 · Squares Duel";
  createRoot(root).render(<PasswordReset code={code} />);
} else {
  createRoot(root).render(<Home />);
}
