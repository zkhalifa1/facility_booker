// src/config/env.ts
import "dotenv/config";
import { z } from "zod";

// 1. Describe all env vars and which ones are required
const EnvSchema = z.object({
    PORT: z.string().default("8080"),

    // GPT -> backend auth
    BOOKER_GPT_TOKEN: z.string().min(10, "BOOKER_GPT_TOKEN is missing"),

    // UBC credentials
    UBC_USER: z.string().min(1, "UBC_USER is missing"),
    UBC_PASS: z.string().min(1, "UBC_PASS is missing"),
    UBC_BASE_URL: z.string().optional(),

    // Email notifications (optional)
    EMAIL_FROM: z.string().email().optional(),
    EMAIL_TO: z.string().email().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.string().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),

    // Telegram notifications (optional)
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_CHAT_ID: z.string().optional()
});

// 2. Parse + validate
const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
    console.error("❌ Invalid or missing environment variables:");
    console.error(parsed.error.format());
    process.exit(1);
}

const raw = parsed.data;

// 3. Normalized, typed config object
export const env = {
    port: Number(raw.PORT),

    bookerToken: raw.BOOKER_GPT_TOKEN,

    ubc: {
        user: raw.UBC_USER,
        pass: raw.UBC_PASS,
        baseUrl: raw.UBC_BASE_URL
    },

    smtp: raw.SMTP_HOST
        ? {
            host: raw.SMTP_HOST,
            port: Number(raw.SMTP_PORT || 465),
            user: raw.SMTP_USER!,
            pass: raw.SMTP_PASS!,
            from: raw.EMAIL_FROM!,
            to: raw.EMAIL_TO || raw.EMAIL_FROM || undefined
        }
        : null,

    telegram: raw.TELEGRAM_BOT_TOKEN
        ? {
            botToken: raw.TELEGRAM_BOT_TOKEN,
            chatId: raw.TELEGRAM_CHAT_ID || undefined
        }
        : null
} as const;
