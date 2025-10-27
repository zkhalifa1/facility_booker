import nodemailer from "nodemailer";

async function sendTelegram(text: string) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return false;
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    await fetch(url, {
        method: "POST",
        headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ chat_id: chatId, text })
    });
    return true;
}

export async function sendEmail({
                                    to,
                                    subject,
                                    text
                                }: { to: string; subject: string; text: string }) {
    const host = process.env.SMTP_HOST!;
    const port = parseInt(process.env.SMTP_PORT || "465", 10);
    const user = process.env.SMTP_USER!;
    const pass = process.env.SMTP_PASS!;
    const from = process.env.EMAIL_FROM!;

    const transporter = nodemailer.createTransport({
        host, port, secure: port === 465,
        auth: { user, pass }
    });

    await transporter.sendMail({ from, to, subject, text });
}

export async function notifyAny({
                                    emailTo,
                                    text
                                }: { emailTo?: string; text: string }) {
    // Try Telegram first (if configured)
    const teleOK = await sendTelegram(text).catch(() => false);
    if (teleOK) return;

    // Fallback to email if Telegram not configured
    if (emailTo && process.env.SMTP_USER && process.env.SMTP_PASS) {
        await sendEmail({ to: emailTo, subject: "UBC Tennis Booker", text });
        return;
    }
    if (process.env.EMAIL_TO && process.env.SMTP_USER && process.env.SMTP_PASS) {
        await sendEmail({ to: process.env.EMAIL_TO, subject: "UBC Tennis Booker", text });
    }
}
