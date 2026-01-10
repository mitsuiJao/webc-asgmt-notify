import { Resend } from "resend";

export async function sendNotification(subject, body) {
    const APIKEY = process.env.APIKEY;
    if (!APIKEY) {
        console.warn("APIKEY not set. Skipping email notification.");
        return;
    }
    const sendTo = process.env.SENDTO;
    if (!sendTo) {
        console.warn("SENDTO not set. Skipping email notification.");
        return;
    }

    const resend = new Resend(APIKEY);
    const sendFrom = process.env.SENDFROM

    console.log(`Sending email with subject: "${subject}"`);
    const { data, error } = await resend.emails.send({
        from: `WebClass Notifier <${sendFrom}>`,
        to: sendTo,
        subject: subject,
        html: body,
    });

    if (error) {
        console.error("Failed to send email:", { error });
        throw error; // Re-throw the error to be caught by the caller
    }

    console.log("Email sent successfully:", { data });
}

export async function sendLoginRequiredNotification() {
    const APIKEY = process.env.APIKEY;
    const loginEmail = process.env.USER_ID; // The email used for login

    if (!APIKEY || !loginEmail) {
        console.warn("APIKEY or USER_ID not set. Skipping login required notification.");
        return;
    }

    const resend = new Resend(APIKEY);
    const subject = "WebClass Scraper: Authentication Required";
    const body = `
        <h1>Authentication Required</h1>
        <p>The WebClass scraper requires you to re-authenticate.</p>
        <p>Please run the script manually in your terminal to enter the MFA code:</p>
        <pre>node --env-file=.env src/scraper.js</pre>
        <p>This is a notification for the user: ${loginEmail}</p>
    `;

    console.log(`Sending authentication required email to ${loginEmail}...`);
    const { data, error } = await resend.emails.send({
        from: 'Scraper Alert <notification@mitsuijao.fun>',
        to: loginEmail,
        subject: subject,
        html: body,
    });

    if (error) {
        console.error("Failed to send login required email:", { error });
        throw error;
    }

    console.log("Login required email sent successfully:", { data });
}

