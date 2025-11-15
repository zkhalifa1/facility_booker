import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { checkAvailability } from "./ubc";

const app = express();
app.use(express.json());

// --- Auth middleware: check Bearer token ---
function requireBearer(req: Request, res: Response, next: NextFunction) {
    const header = req.get("Authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";

    if (!token || token !== process.env.BOOKER_GPT_TOKEN) {
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

const NotifySchema = z.object({
    email: z.string().email().optional(),
    sms: z.string().optional(),
    telegram_chat_id: z.string().optional()
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

// --- helpers for /notify ---
async function sendTelegramMessage(text: string, chatId: string) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        throw new Error("TELEGRAM_BOT_TOKEN is not set");
    }

    // Node 18+ has global fetch
    const resp = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text })
        }
    );

    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Telegram sendMessage failed: ${resp.status} ${body}`);
    }
}

async function sendEmailMessage(to: string, text: string) {
    const host = process.env.SMTP_HOST!;
    const port = parseInt(process.env.SMTP_PORT || "465", 10);
    const user = process.env.SMTP_USER!;
    const pass = process.env.SMTP_PASS!;
    const from = process.env.EMAIL_FROM!;

    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        auth: { user, pass }
    });

    await transporter.sendMail({
        from,
        to,
        subject: "UBC Tennis Booker",
        text
    });
}

// --- /notify ---
// Uses user-provided telegram_chat_id if given, else env TELEGRAM_CHAT_ID.
// Falls back to email if Telegram not configured.
app.post("/notify", requireBearer, async (req: Request, res: Response) => {
    try {
        const parsed = z
            .object({
                notify: NotifySchema.optional(),
                text: z.string(),
                priority: z.enum(["info", "warn", "urgent"]).optional()
            })
            .parse(req.body);

        const { notify, text } = parsed;

        // 1) Prefer Telegram (user chat_id first, then env fallback)
        const userChatId = (notify?.telegram_chat_id || "").trim();
        const envChatId = (process.env.TELEGRAM_CHAT_ID || "").trim();
        const chatIdToUse = userChatId || envChatId;

        if (chatIdToUse && process.env.TELEGRAM_BOT_TOKEN) {
            await sendTelegramMessage(text, chatIdToUse);
            return res.json({
                ok: true,
                via: "telegram",
                chat_id: chatIdToUse
            });
        }

        // 2) Fallback to email (user email first, then EMAIL_TO)
        const smtpReady =
            !!process.env.SMTP_HOST &&
            !!process.env.SMTP_USER &&
            !!process.env.SMTP_PASS &&
            !!process.env.EMAIL_FROM;

        if (smtpReady) {
            const to = (notify?.email || process.env.EMAIL_TO || "").trim();
            if (!to) {
                return res.status(400).json({
                    error:
                        "No email recipient set. Provide notify.email or set EMAIL_TO on the server."
                });
            }

            await sendEmailMessage(to, text);
            return res.json({
                ok: true,
                via: "email",
                to
            });
        }

        // 3) Nothing configured
        return res.status(500).json({
            error:
                "No notifier configured. Set TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID or SMTP_* env vars."
        });
    } catch (err: any) {
        console.error("Notify error:", err?.message || err);
        return res.status(502).json({
            error: "Notify failed",
            detail: String(err?.message || err)
        });
    }
});

// --- start server ---
const PORT = parseInt(process.env.PORT || "8080", 10);
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
