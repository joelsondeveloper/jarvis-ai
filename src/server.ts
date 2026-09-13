import "dotenv/config";
import app from "./app.js";

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, "127.0.0.1", () => {
  console.log(`JARVIS online at http://localhost:${PORT}`);
});