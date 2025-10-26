import nodemailer from "nodemailer";

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
