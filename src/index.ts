import "./lib/loadEnv.js";
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Request, type Response } from "express";

import { adminsRouter } from "./routes/admins.js";
import { aiRouter } from "./routes/ai.js";
import { authRouter } from "./routes/auth.js";
import { drillsRouter } from "./routes/drills.js";
import { hrmsRouter } from "./routes/hrms.js";
import { invitesRouter } from "./routes/invites.js";
import { orgsRouter } from "./routes/orgs.js";
import { profileRouter } from "./routes/profile.js";
import { verifyRouter } from "./routes/verify.js";

const app = express();
const PORT = Number(process.env["PORT"]) || 3000;

const APP_ORIGIN = process.env["APP_ORIGIN"] ?? "http://localhost:5173";

app.use(
  cors({
    origin: APP_ORIGIN,
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());


app.get("/", (_req: Request, res: Response) => {
  res.json({ message: "AgilityOS API" });
});

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.use("/api/auth", authRouter);
app.use("/api/orgs", orgsRouter);
app.use("/api/hrms", hrmsRouter);
app.use("/api/invites", invitesRouter);
app.use("/api/admins", adminsRouter);
app.use("/api/verify", verifyRouter);
app.use("/api/profile", profileRouter);
app.use("/api/ai", aiRouter);
app.use("/api/drills", drillsRouter);

// ---------------------------------------------------------------------------
// Listen
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});