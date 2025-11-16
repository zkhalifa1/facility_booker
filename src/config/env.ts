// src/config/env.ts
import "dotenv/config";
import { z } from "zod";

//
// 1. Define schema for all environment variables
//
const EnvSchema = z.object({
    PORT: z.string().default("8080"),

    // Auth
    BOOKER_GPT_TOKEN: z.string().min(10, "BOOKER_GPT_TOKEN is missing"),

    // UBC credentials
    UBC_USER: z.string().min(1, "UBC_USER missing"),
    UBC_PASS: z.string().min(1, "UBC_PASS missing"),

    // Email notifications
    EMAIL_FROM: z.string().email().optional(),
    EMAIL_TO: z.string().email().optional(),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.string().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),

    // Telegram
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_CHAT_ID: z.string().optional(),
});

//
// 2. Parse + validate + fail fast if anything critical is missing
//
const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
    console.error("❌ Invalid or missing environment variables:");
    console.error(parsed.error.format());
    process.exit(1); // stop server immediately
}

const raw = parsed.data;

//
// 3. Convert/normalize types
//
export const env = {
    port: Number(raw.PORT),

    // auth
    bookerToken: raw.BOOKER_GPT_TOKEN,

    // UBC
    ubc: {
        user: raw.UBC_USER,
        pass: raw.UBC_PASS,
    },

    // email
    smtp: raw.SMTP_HOST
        ? {
            host: raw.SMTP_HOST,
            port: Number(raw.SMTP_PORT ?? 465),
            user: raw.SMTP_USER!,
            pass: raw.SMTP_PASS!,
            from: raw.EMAIL_FROM!,
            to: raw.EMAIL_TO,
        }
        : null,

    // telegram
    telegram: raw.TELEGRAM_BOT_TOKEN
        ? {
            botToken: raw.TELEGRAM_BOT_TOKEN,
            chatId: raw.TELEGRAM_CHAT_ID,
        }
        : null,
} as const;
