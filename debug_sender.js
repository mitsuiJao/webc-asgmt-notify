import { Resend } from "resend";

async function main() {
  const subject = "Test Email";
  const body = "<p>This is a test email from the notifier.</p>";

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
  const sendFrom = process.env.SENDFROM;
  if (!sendFrom) {
    console.warn("SENDFROM not set. Skipping email notification.");
    return;
  }

  const resend = new Resend(APIKEY);

  try {
    console.log(`Sending email with subject: "${subject}"`);
    const { data, error } = await resend.emails.send({
      from: `WebClass Notifier <${sendFrom}>`,
      to: sendTo,
      subject: subject,
      html: body,
    });

    if (error) {
      console.error("Failed to send email:", { error });
      throw error;
    }

    console.log("Email sent successfully:", { data });
    console.log("Test email sent successfully!");
  } catch (error) {
    console.error("Failed to send test email:", error);
  }
}

main();
