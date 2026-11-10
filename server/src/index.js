import { buildApp } from "./app.js";
import { migrate } from "./db.js";

await migrate();
const app = await buildApp();
const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: "0.0.0.0" });
