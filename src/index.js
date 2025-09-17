import React from "react";
import ReactDOM from "react-dom"; // ← UMD global ReactDOM
import FloatingAgendaWidget from "./App.jsx";
import "./widget.css";

// Export ES (por si lo importas como módulo)
export { default as FloatingAgendaWidget } from "./App.jsx";

// UMD global
if (typeof window !== "undefined") {
  window.MozartAgendaWidget = {
    mount(el = document.body, props = {}) {
      const host = document.createElement("div");
      el.appendChild(host);

      // React 18 UMD trae createRoot en ReactDOM
      if (typeof ReactDOM.createRoot === "function") {
        const root = ReactDOM.createRoot(host);
        root.render(React.createElement(FloatingAgendaWidget, props));
        host.__mozartRoot = root;
      } else {
        // Fallback React 17
        ReactDOM.render(React.createElement(FloatingAgendaWidget, props), host);
        host.__mozartLegacy = true;
      }
      return host;
    },
    unmount(host) {
      if (!host) return;
      try {
        if (host.__mozartRoot) host.__mozartRoot.unmount();
        else if (host.__mozartLegacy) ReactDOM.unmountComponentAtNode(host);
      } catch {}
      if (host.parentNode) host.parentNode.removeChild(host);
      delete host.__mozartRoot;
      delete host.__mozartLegacy;
    },
  };
}

export default window?.MozartAgendaWidget ?? { mount(){} };
