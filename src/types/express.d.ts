import type { PublicUser } from "../lib/auth.js";

declare global {
  namespace Express {
    interface Request {
      user?: PublicUser;
      sessionId?: string;
    }
  }
}

export {};