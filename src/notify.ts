// src/notify.ts
import { env } from "./config/env";

export type NotifyTarget = {
    email?: string;
    sms?: string; // reserved for future use
    telegram_chat_id?: string;
};

export type NotifyPayload = {
    notify?: NotifyTarget;
    text: string;
    priority?: "info" | "warn" | "urgent";
};

async function sendTelegram(text: string, chatId: string) {
    if (!env.telegram) {
        throw new Error("Telegram is not configured");
    }

    const resp = await fetch(
        `https://api.telegram.org/bot${env.telegram.botToken}/sendMessage`,
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

async function sendEmail(to: string, text: string) {
    if (!env.smtp) {
        throw new Error("SMTP is not configured");
    }

    const { host, port, user, pass, from } = env.smtp;
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

/**
 * High-level notify entrypoint used by /notify route.
 * - Prefers Telegram (user chat_id, then default env chat ID)
 * - Falls back to email (user email, then EMAIL_TO/EMAIL_FROM)
 */
export async function notify(payload: NotifyPayload) {
    const { notify, text } = payload;

    // 1) Telegram path
    if (env.telegram) {
        const userChat = notify?.telegram_chat_id?.trim();
        const defaultChat = env.telegram.chatId?.trim();
        const chatId = userChat || defaultChat;

        if (chatId) {
            await sendTelegram(text, chatId);
            return { via: "telegram" as const, chat_id: chatId };
        }
    }

    // 2) Email fallback path
    if (env.smtp) {
        const to = (notify?.email || env.smtp.to || "").trim();
        if (to) {
            await sendEmail(to, text);
            return { via: "email" as const, to };
        }
    }

    // 3) Nothing available
    throw new Error(
        "No notifier configured or no recipient provided (Telegram and SMTP both unavailable)."
    );
}
