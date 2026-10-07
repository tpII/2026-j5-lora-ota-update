import { mount } from "svelte";
import "./app.css";
import App from "./App.svelte";
import { registerServiceWorker } from "./service-worker-registration.ts";

const target = document.getElementById("app");
if (target === null) {
  throw new Error("missing #app element");
}

const app = mount(App, { target });

registerServiceWorker();

export default app;
