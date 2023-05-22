import { Context, Telegraf } from "telegraf";
import { Update } from "typegram";

import dotenv from "dotenv";

import db, { COLLECTION_NAME, createUserIfNotExists } from "./db";
import {
    onSnapshot,
    collection,
    updateDoc,
    doc,
    getDoc,
    Timestamp,
    where,
    query,
    getDocs,
    orderBy,
    deleteDoc,
} from "firebase/firestore";
import { ITelegramUser, Meetup } from "./types";
import { addMonths, format, isAfter, isBefore, subMonths } from "date-fns";
import {
    convertTimeIntoAMPM,
    dateParser,
    getDate,
    getNumberOfConsectiveSelectedTimeSlots,
    getTime,
    isSameAsPreviousTimeSlot,
} from "./utils/dates";
import {
    InlineQueryResult,
    InlineQueryResultArticle,
} from "telegraf/typings/core/types/typegram";

import { CronJob } from "cron";

import sanitizeHtml from "sanitize-html";
const sanitizeOptions = {
    allowedTags: [],
    allowedAttributes: {},
};

// console.log(db);
dotenv.config();

const bot: Telegraf<Context<Update>> = new Telegraf(
    process.env.BOT_TOKEN as string
);

const BASE_URL = process.env.BASE_URL;

// TODOs
// Limit message text
// show a specially formatted message when the limit is nearing
// create a webpage where users can view the meetup read-only

const listener = onSnapshot(collection(db, COLLECTION_NAME), {
    next: (querySnapshot) => {
        querySnapshot.docChanges().forEach((change) => {
            // only update if notified = false
            // then set notified = true
            const meetup = change.doc.data() as Meetup;
            meetup.id = change.doc.id;
            if (change.type === "added") {
                // console.log("New: ", change.doc.data());
                if (!meetup.notified) {
                    bot.telegram
                        .sendMessage(
                            meetup.creator.id,
                            generateMessageText(meetup),
                            {
                                ...generateCreatorReplyMarkup(meetup),
                                disable_web_page_preview: true,
                            }
                        )
                        .then((msg) => {
                            const msgId = msg.message_id;
                            // console.log(change.doc.id, "---------");
                            // set notified to true
                            updateDoc(
                                doc(
                                    collection(db, COLLECTION_NAME),
                                    change.doc.id
                                ),
                                {
                                    ...meetup,
                                    notified: true,
                                    messages: [
                                        {
                                            chat_id: msg.chat.id,
                                            message_id: msgId,
                                        },
                                    ],
                                } as Meetup
                            );
                            bot.telegram.pinChatMessage(msg.chat.id, msgId);
                        });
                }
            }
            if (change.type === "modified") {
                // console.log("Modified: ", change.doc.data());
                const meetup = change.doc.data() as Meetup;
                meetup.id = change.doc.id;
                editMessages(meetup);
            }
            if (change.type === "removed") {
                console.log("Removed: ", change.doc.data());
                const meetup = change.doc.data() as Meetup;
                meetup.id = change.doc.id;
                editMessagesToMarkDeleted(
                    meetup,
                    `Your meetup has been deleted!`
                );
            }
        });
    },
});

bot.start(async (ctx) => {
    createUserIfNotExists(ctx.message.from);
    if (ctx.startPayload.startsWith("indicate__")) {
        const meetupId = ctx.startPayload.split("__")[1];
        ctx.reply(
            `Please click the button below to indicate your avaiailbilty.`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: "Indicate availability",
                                web_app: {
                                    url: `${BASE_URL}meetup/${meetupId}`,
                                },
                            },
                        ],
                    ],
                },
                disable_web_page_preview: true,
            }
        );
    } else
        ctx.reply("Hello! Click the button below to create a new meetup", {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: "Create a meetup",
                            web_app: {
                                url: `${BASE_URL}create`,
                            },
                        },
                    ],
                ],
            },
        });
});

bot.on("inline_query", async (ctx) => {
    const searchQuery = ctx.inlineQuery.query;
    let searchStr = "";
    if (!searchQuery.includes("_")) {
        searchStr = searchQuery.trim().toLocaleLowerCase();
    }
    const type = searchQuery.split("_")[0];
    const meetupId = searchQuery.split("_")[1];

    const userMeetupsRef = collection(db, COLLECTION_NAME);
    const q = query(
        userMeetupsRef,
        where("creator.id", "==", ctx.from.id),
        orderBy("date_created", "desc")
    );
    const querySnapshot = await getDocs(q);

    // console.log(querySnapshot)
    let foundDocs: Meetup[] = [];
    querySnapshot.forEach((doc) => {
        // check if doc title contains the search string
        const data = doc.data() as Meetup;
        data.id = doc.id;
        const docTitle = data.title.trim().toLocaleLowerCase();
        if (docTitle.includes(searchStr)) {
            foundDocs.push(data);
        }
    });

    // limit to 45
    const markup: InlineQueryResultArticle[] = foundDocs
        .map((doc) => ({
            type: "article",
            id: doc.id!,
            title: doc.title,
            input_message_content: {
                message_text: generateMessageText(doc),
                parse_mode: "HTML",
                disable_web_page_preview: true,
            },
            ...generateSharedInlineReplyMarkup(doc),
        }))
        .slice(0, 45) as InlineQueryResultArticle[];

    await ctx.answerInlineQuery(markup, {
        cache_time: 0,
    });
});

/* Listen for when the user chooses a result from the inline query to share a chain */
// https://github.com/telegraf/telegraf/issues/465
bot.on("chosen_inline_result", async (ctx) => {
    try {
        // meetup shared with a group
        const meetupId = ctx.chosenInlineResult.result_id;
        const inlineMsgId = ctx.chosenInlineResult.inline_message_id || "";

        const docR = doc(db, COLLECTION_NAME, meetupId);
        const docRef = await getDoc(docR);
        const data = docRef.data() as Meetup;
        const messages = data.messages || [];
        messages.push({
            inline_message_id: inlineMsgId,
        });
        await updateDoc(docR, {
            messages,
        });
    } catch (e) {
        console.log("Error: ", e);
    }
});

bot.on("callback_query", (ctx) => {
    // @ts-ignore
    const cbData = ctx.callbackQuery.data;

    if (cbData.startsWith("end__")) {
        const id = cbData.replace("end__", "");
        const docRef = doc(db, COLLECTION_NAME, id);
        updateDoc(docRef, {
            isEnded: true,
        });
        // deleteDoc(docRef);
    }
});

bot.launch().then(() => console.log("Bot is running!"));

/**
 * On every update from the snapshot listener, update the corresponding telegram chats.
 * Debounce this so we only update once every 5 seconds.
 *
 * @param meetup The meetup that got updated
 */
const editMessages = async (meetup: Meetup) => {
    const messages = meetup.messages;
    if (!messages) return;
    for (let message of messages) {
        try {
            if (message.inline_message_id) {
                await bot.telegram.editMessageText(
                    undefined,
                    undefined,
                    message.inline_message_id,
                    generateMessageText(meetup),
                    {
                        parse_mode: "HTML",
                        ...generateSharedInlineReplyMarkup(meetup),
                        disable_web_page_preview: true,
                    }
                );
            } else {
                await bot.telegram.editMessageText(
                    message.chat_id,
                    message.message_id,
                    undefined,
                    generateMessageText(meetup),
                    {
                        parse_mode: "HTML",
                        ...generateCreatorReplyMarkup(meetup),
                        disable_web_page_preview: true,
                    }
                );
            }
        } catch (e) {
            // potentailly the message content is the same. Just ignore that error
            console.log(e);
        }
    }
};

/**
 * On every update from the snapshot listener, update the corresponding telegram chats.
 * Debounce this so we only update once every 5 seconds.
 *
 * @param meetup The meetup that got deleted
 */
const editMessagesToMarkDeleted = async (meetup: Meetup, reason: string) => {
    const messages = meetup.messages;
    if (!messages) return;
    for (let message of messages) {
        try {
            if (message.inline_message_id) {
                await bot.telegram.editMessageText(
                    undefined,
                    undefined,
                    message.inline_message_id,
                    `<b><u>❗️ ${reason}</u></b>\n\n${generateMessageText(
                        meetup
                    )}`,
                    {
                        parse_mode: "HTML",

                        disable_web_page_preview: true,
                    }
                );
            } else {
                await bot.telegram.editMessageText(
                    message.chat_id,
                    message.message_id,
                    undefined,
                    `<b><u>❗️ ${reason}</u></b>\n\n${generateMessageText(
                        meetup
                    )}`,
                    {
                        parse_mode: "HTML",

                        disable_web_page_preview: true,
                    }
                );
            }
        } catch (e) {
            // potentailly the message content is the same. Just ignore that error
            console.log(e);
        }
    }
};

/**
 * Generates the message text that is sent to people when sharing the meetup
 *
 * @param meetup The meetup to generate the message text for
 * @returns
 */
const generateMessageText = (meetup: Meetup) => {
    // sanitize title and descp
    // title at most 256 chars
    // description at most 1024 chars
    const title = sanitizeHtml(meetup.title.trim(), sanitizeOptions).slice(
        0,
        256
    );
    const description = sanitizeHtml(
        meetup.description?.trim() || "",
        sanitizeOptions
    ).slice(0, 1024);
    let msg = ``;

    if (meetup.isEnded)
        msg += `<b><u>❗️ This meetup has ended ❗️</u></b>\n\n`;
    msg += `<b><u>${title}</u></b>\n`;
    if (description) msg += `${meetup.description}\n`;
    msg += "\n";

    const numResponded = meetup.users.length;

    if (meetup.isFullDay) {
        msg += `<i>Type: 📅 Full day </i>\n\n`;
    } else {
        msg += `<i>Type: 🕒 Part-day </i>\n\n`;
    }

    msg += `Responded: ${numResponded}\n\n`;

    let defaultMsg = msg;

    if (meetup.isFullDay) {
        const dates = Object.keys(meetup.selectionMap).sort();
        for (let date of dates) {
            const people = meetup.selectionMap[date];
            msg += `<b>${format(dateParser(date), "EEEE, d MMMM yyyy")}</b>\n`;
            for (let i in people) {
                const person = people[i];
                msg += `${Number(i) + 1}. <a href="t.me/${person.username}">${
                    person.first_name
                }</a>\n`; // TODO: change this to first_name
            }
            msg += "\n";
        }
    } else {
        // preformat: for each day, check if there is at least one person who is available

        // split selectionMap into a Map containing key=date, value=times for that day
        const newMap: {
            [date: string]: {
                [dateTimeStr: string]: ITelegramUser[];
            };
        } = {};
        for (let dateTimeStr in meetup.selectionMap) {
            const d = getDate(dateTimeStr);
            if (!newMap[d]) {
                newMap[d] = {
                    [dateTimeStr]: meetup.selectionMap[dateTimeStr],
                };
            } else {
                newMap[d][dateTimeStr] = meetup.selectionMap[dateTimeStr];
            }
        }

        // Sort by date
        const ordered = Object.keys(newMap).sort();

        for (let date of ordered) {
            msg += `<b><u>${format(
                dateParser(date),
                "EEEE, d MMMM yyyy"
            )}</u></b>\n`;

            if (newMap[date]) {
                // if we iterate according to the natural iteration, it uses ascii sorting (1000 comes before 999 for e.g)
                const dateTimeKeys = Object.keys(newMap[date])
                    .map(getTime)
                    .sort((a, b) => a - b)
                    .map((e) => `${e}::${date}`);

                for (let dateTimeStr of dateTimeKeys) {
                    if (isSameAsPreviousTimeSlot(dateTimeStr, meetup)) {
                        // ignore
                        continue;
                    }
                    const startTime = getTime(dateTimeStr);
                    const numOfConsecutiveSlots =
                        getNumberOfConsectiveSelectedTimeSlots(
                            dateTimeStr,
                            meetup
                        );

                    // just trust me on the + 1
                    const endTime =
                        startTime + (numOfConsecutiveSlots.length + 1) * 30;

                    const numFreeThisDate = newMap[date][dateTimeStr].length;
                    const percent = Math.round(
                        (numFreeThisDate / numResponded) * 100
                    );
                    msg += `<b>${convertTimeIntoAMPM(
                        startTime
                    )} - ${convertTimeIntoAMPM(endTime)} (${
                        newMap[date][dateTimeStr].length
                    } / ${numResponded}, ${percent}%)</b>\n`;

                    for (let i in newMap[date][dateTimeStr]) {
                        const person = newMap[date][dateTimeStr][i];
                        msg += `${Number(i) + 1}. <a href="t.me/${
                            person.username
                        }">${person.first_name}</a>\n`; // TODO: change this to first_name
                    }
                    msg += "\n";
                }
            }
        }

        msg += "\n";
    }

    const usersWithComments = meetup.users.filter((u) => u.comments.length);
    if (usersWithComments.length) {
        msg += `<b><u>Comments (${usersWithComments.length})</u></b>\n`;
        // there is at least one comment
        for (let userObj of usersWithComments) {
            const user = userObj.user;

            // max 512 chars
            const comment = sanitizeHtml(
                userObj.comments.trim(),
                sanitizeOptions
            ).slice(0, 512);
            msg += `<a href="t.me/${user.username}"><b>${user.first_name}</b></a>\n${comment}\n\n`;
        }
    }

    let footer = `Created on ${format(
        (meetup.date_created as unknown as Timestamp).toDate(),
        "dd MMM yyyy h:mm aaa"
    )} by <a href='t.me/${meetup.creator.username}'>${
        meetup.creator.first_name
    }</a>\n`;

    msg += footer;
    if (msg.length > 3000) {
        return (
            defaultMsg +
            "❗️ Please view the meetup details by clicking the button below.\n\n" +
            footer
        );
    }
    return msg;
};

const generateSharedInlineReplyMarkup = (meetup: Meetup) => {
    const res = [
        {
            text: "View meetup details",
            url: `${BASE_URL}meetup/${meetup.id}`,
        },
    ];
    if (!meetup.isEnded) {
        res.push({
            text: "Indicate availability",
            url: `https://t.me/${process.env.BOT_USERNAME}?start=indicate__${meetup.id}`,
        });
    }
    return {
        reply_markup: {
            inline_keyboard: [res],
        },
    };
};

const generateCreatorReplyMarkup = (meetup: Meetup) => {
    if (meetup.isEnded) {
        return {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: "View meetup details",
                            url: `${BASE_URL}meetup/${meetup.id}`,
                        },
                    ],
                ],
            },
        };
    }
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        switch_inline_query: meetup.title,
                        text: "Share meetup",
                    },
                    {
                        text: "Indicate availability",
                        web_app: {
                            url: `${BASE_URL}meetup/${meetup.id}`,
                        },
                    },
                ],
                [
                    {
                        text: "End meetup",
                        callback_data: `end__${meetup.id}`,
                    },
                ],
            ],
        },
    };
};

const cleanup = async () => {
    const data = query(collection(db, COLLECTION_NAME));
    const qs = await getDocs(data);
    qs.forEach((doc) => {
        const d = doc.data() as Meetup;
        // if (isAfter((d.date_created as unknown as Timestamp).toDate(), addMonths(new Date(), 3)))
        // if the doc's date_created is more than 3 months ago, delete it
        if (
            isBefore(
                (d.date_created as unknown as Timestamp).toDate(),
                subMonths(new Date(), 3)
            )
        ) {
            deleteDoc(doc.ref);
            console.log("found doc that's expired");
        }
    });
};

// clear stale data every day
const job = new CronJob("0 0 0 * * *", async () => {
    // clear data
    cleanup()
        .then(() => console.log("Clean up done!"))
        .catch(console.log);
});

job.start();
cleanup();

// Enable graceful stop
process.once("SIGINT", () => {
    bot.stop("SIGINT");
    listener();
});
process.once("SIGTERM", () => {
    bot.stop("SIGTERM");
    listener();
});

process.on("uncaughtException", console.log);
process.on("unhandledRejection", console.log);
process.on("warning", console.log);
process.on("error", console.log);
