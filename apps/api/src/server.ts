import "./env.js";
import { buildApp } from "./app.js";
import { config } from "./config.js";

const app = buildApp({ logger: true, trustProxy: config.trustProxy });
app.listen({ port: config.port, host: "0.0.0.0" }).then(() => {
  console.log(`zhixing api listening on :${config.port}`);
});
