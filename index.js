import { scrapeAssignments } from "./src/scraper.js";
import { sendNotification, sendLoginRequiredNotification } from "./src/sender.js";
import { processNotifications } from "./src/notifier.js";
import fs from "fs/promises";
import path from "path";


async function run() {
    try {
        const outputDir = "./output";
        const files = await fs.readdir(outputDir);
        for (const file of files) {
            if (file.startsWith("debug_")) {
                await fs.unlink(path.join(outputDir, file));
                console.log(`Deleted ${file}`);
            }
        }

        console.log("Running scraper...");
        const scrapeResult = await scrapeAssignments();

        if (scrapeResult?.loginRequired) {
            console.log("Login is required. Sending notification...");
            await sendLoginRequiredNotification();
            return;
        }

        const notifications = await processNotifications(scrapeResult);

        if (notifications && notifications.length > 0) {
            console.log(`Found ${notifications.length} notifications to send.`);
            for (const notification of notifications) {
                await sendNotification(notification.subject, notification.body);
            }
        }

    } catch (error) {
        console.error("An error occurred in the main process:", error);
        process.exit(1);
    }
}

run();
