// src/index.ts
import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { checkAvailability, bookSlot, type BookingRequest } from "./ubc";
import { notify as notifyService, type NotifyPayload } from "./notify";
import { env } from "./config/env";

const app = express();
app.use(express.json());

// --- Auth middleware: check Bearer token ---
function requireBearer(req: Request, res: Response, next: NextFunction) {
    const header = req.get("Authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";

    if (!token || token !== env.bookerToken) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
}

// --- Friendly root + health ---
app.get("/", (_req, res) => {
    res
        .type("text/plain")
        .send("UBC Tennis Booker API is running. Try GET /health");
});

app.get("/health", (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
});

// --- Schemas ---
const PreferencesSchema = z.object({
    days_ahead: z.number().min(0).max(14).optional(),
    start_hour: z.number().min(0).max(23).optional(),
    end_hour: z.number().min(1).max(24).optional(),
    min_minutes: z.number().min(30).max(120).optional(),
    indoor_only: z.boolean().optional(),
    locations: z.array(z.string()).optional(),
    dates: z.array(z.string()).optional()
});

const NotifyRequestSchema = z.object({
    notify: z
        .object({
            email: z.string().email().optional(),
            sms: z.string().optional(),
            telegram_chat_id: z.string().optional()
        })
        .optional(),
    text: z.string(),
    priority: z.enum(["info", "warn", "urgent"]).optional()
});

// --- /check_now ---
app.post("/check_now", requireBearer, async (req: Request, res: Response) => {
    try {
        const parsed = z
            .object({
                preferences: PreferencesSchema
            })
            .parse(req.body);

        const slots = await checkAvailability(parsed.preferences);
        return res.json({ slots });
    } catch (err: any) {
        console.error("check_now error:", err?.message || err);
        return res
            .status(400)
            .json({ error: "Invalid request", detail: String(err?.message || err) });
    }
});

// --- /notify ---
app.post("/notify", requireBearer, async (req: Request, res: Response) => {
    try {
        const parsed = NotifyRequestSchema.parse(req.body) as NotifyPayload;

        const result = await notifyService(parsed);
        return res.json({
            ok: true,
            ...result
        });
    } catch (err: any) {
        console.error("Notify error:", err?.message || err);
        return res.status(502).json({
            error: "Notify failed",
            detail: String(err?.message || err)
        });
    }
});

// --- Booking Schema ---
const BookingRequestSchema = z.object({
    facility_url: z.string().url(),
    time_24h: z.string().regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format"),
    duration_hours: z.union([z.literal(1), z.literal(2)]),
    num_people: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
});

// --- /book ---
app.post("/book", requireBearer, async (req: Request, res: Response) => {
    try {
        const parsed = BookingRequestSchema.parse(req.body) as BookingRequest;

        console.log("Booking request:", parsed);
        const result = await bookSlot(parsed);

        if (result.success) {
            return res.json({
                ok: true,
                ...result
            });
        } else {
            return res.status(400).json({
                ok: false,
                error: result.message
            });
        }
    } catch (err: any) {
        console.error("Book error:", err?.message || err);
        return res.status(400).json({
            error: "Booking failed",
            detail: String(err?.message || err)
        });
    }
});

// --- start server ---
app.listen(env.port, () => {
    console.log(`Server listening on port ${env.port}`);
});
