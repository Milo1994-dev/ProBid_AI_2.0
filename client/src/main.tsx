import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

const rootEl = document.getElementById("root")!;
const appTree = (
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

if (rootEl.dataset.ssr === "true") {
  rootEl.innerHTML = "";
  delete rootEl.dataset.ssr;
}
ReactDOM.createRoot(rootEl).render(appTree);
