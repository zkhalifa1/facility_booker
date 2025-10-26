import express from "express";
import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { sendEmail } from "./notify.js";
import { checkAvailability } from "./ubc.js";

const app = express();
app.use(express.json());

// --- simple bearer check ---
function requireBearer(req: Request, res: Response, next: NextFunction) {
    const header = req.get("Authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || token !== process.env.BOOKER_GPT_TOKEN) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    next();
}

// --- health ---
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// --- /check_now ---
const PreferencesSchema = z.object({
    days_ahead: z.number().min(0).max(14).optional(),
    start_hour: z.number().min(0).max(23).optional(),
    end_hour:   z.number().min(1).max(24).optional(),
    min_minutes:z.number().min(30).max(120).optional(),
    indoor_only:z.boolean().optional(),
    locations:  z.array(z.string()).optional(),
    dates:      z.array(z.string()).optional(),
});

app.post("/check_now", requireBearer, async (req, res) => {
    const parsed = z.object({ preferences: PreferencesSchema }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });
    const slots = await checkAvailability(parsed.data.preferences);
    return res.json({ slots });
});

// --- /notify ---
const NotifySchema = z.object({
    email: z.string().email().optional(),
    sms: z.string().optional(),              // you can add Twilio later
    telegram_chat_id: z.string().optional()  // add Telegram later
});

app.post("/notify", requireBearer, async (req, res) => {
    const parsed = z.object({
        notify: NotifySchema,
        text: z.string(),
        priority: z.enum(["info", "warn", "urgent"]).optional()
    }).safeParse(req.body);

    if (!parsed.success) return res.status(400).json({ error: parsed.error.message });

    const { notify, text } = parsed.data;

    if (notify.email) {
        await sendEmail({
            to: notify.email,
            subject: "UBC Tennis Booker",
            text
        });
    } else if (process.env.EMAIL_TO) {
        // default fallback to EMAIL_TO if provided
        await sendEmail({
            to: process.env.EMAIL_TO!,
            subject: "UBC Tennis Booker",
            text
        });
    }

    return res.json({ ok: true });
});

// --- start ---
const PORT = parseInt(process.env.PORT || "8080", 10);
app.listen(PORT, () => {
    console.log(`Server listening on :${PORT}`);
});
