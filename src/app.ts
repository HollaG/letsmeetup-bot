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
} from "firebase/firestore";
import { ITelegramUser, Meetup } from "./types";
import { format } from "date-fns";
import {
    convertTimeIntoAMPM,
    dateParser,
    getDate,
    getNumberOfConsectiveSelectedTimeSlots,
    getTime,
    isSameAsPreviousTimeSlot,
} from "./utils/dates";
// console.log(db);
dotenv.config();

const bot: Telegraf<Context<Update>> = new Telegraf(
    process.env.BOT_TOKEN as string
);

const BASE_URL = `https://www.localtutreg:3000/#/`;

const listener = onSnapshot(collection(db, COLLECTION_NAME), {
    next: (querySnapshot) => {
        querySnapshot.docChanges().forEach((change) => {
            // only update if notified = false
            // then set notified = true
            const data = change.doc.data() as Meetup;
            if (change.type === "added") {
                // console.log("New: ", change.doc.data());
                if (!data.notified) {
                    bot.telegram
                        .sendMessage(
                            data.creator.id,
                            `New meetup created with id ${data.title} at ${data.date_created}`
                        )
                        .then((msg) => {
                            const msgId = msg.message_id;
                            console.log(change.doc.id, "---------");
                            // set notified to true
                            updateDoc(
                                doc(
                                    collection(db, COLLECTION_NAME),
                                    change.doc.id
                                ),
                                {
                                    ...data,
                                    notified: true,
                                    messages: [
                                        {
                                            chat_id: msg.chat.id,
                                            message_id: msgId,
                                        },
                                    ],
                                } as Meetup
                            );
                        });
                }
            }
            if (change.type === "modified") {
                console.log("Modified: ", change.doc.data());
                const meetup = change.doc.data() as Meetup;
                meetup.id = change.doc.id;
                editMessages(change.doc.data() as Meetup);
            }
            // if (change.type === "removed") {
            //     console.log("Removed: ", change.doc.data());
            // }
        });
    },
});

bot.start(async (ctx) => {
    console.log(ctx.message.from);
    createUserIfNotExists(ctx.message.from);
    if (ctx.startPayload.startsWith("indicate__")) {
        const meetupId = ctx.startPayload.split("__")[1];
        console.log(`${BASE_URL}meetup/${meetupId}`);

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
            }
        );
    } else ctx.reply("Hello! Click the button below to create a new meetup");
});

bot.on("inline_query", async (ctx) => {
    const query = ctx.inlineQuery.query;
    if (!query.includes("_")) return;
    const type = query.split("_")[0];
    const meetupId = query.split("_")[1];

    if (type == "share") {
        // find a document where docId = meetupId and creatorId = senderId
        const meetupRef = doc(db, COLLECTION_NAME, meetupId);
        const querySnapshot = await getDoc(meetupRef);
        const data = querySnapshot.data() as Meetup;
        if (!data) {
            return; // todo: handle error
        } else {
            const msgId = await ctx.answerInlineQuery(
                [
                    {
                        type: "article",
                        id: meetupId,
                        title: data.title,
                        input_message_content: {
                            message_text: `Title: ${data.title}\nDescription: ${
                                data.description
                            }\nDate: ${(
                                data.date_created as unknown as Timestamp
                            ).toDate()}\nCreator: @${data.creator.username}`,
                        },
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    {
                                        text: "Indicate availability",
                                        url: `https://t.me/${process.env.BOT_USERNAME}?start=indicate__${meetupId}`,
                                    },
                                ],
                            ],
                        },
                    },
                ],
                {
                    cache_time: 0,
                }
            );

            console.log({ msgId });
        }
    }
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
                        ...generateSharedInlineReplyMarkup(meetup.id!),
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
                        ...generateSharedInlineReplyMarkup(meetup.id!),
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
    let msg = `<b><u>${meetup.title}</u></b>\n${meetup.description}\n\n`;

    const numResponded = meetup.users.length;

    if (meetup.isFullDay) {
        msg += `<i>Type: 📅 Full day </i>\n\n`;
    } else {
        msg += `<i>Type: 🕒 Part-day </i>\n\n`;
    }

    msg += `Responded: ${numResponded}\n\n`;

    if (meetup.isFullDay) {
        for (let date in meetup.selectionMap) {
            const people = meetup.selectionMap[date];
            msg += `<b>${format(dateParser(date), "EEEE, d MMMM yyyy")}</b>\n`;
            for (let i in people) {
                const person = people[i];
                msg += `${i + 1}. @${person.username}\n`; // TODO: change this to first_name
            }
            msg += "\n";
        }
    } else {
        // preformat: for each day, check if there is at least one person who is available
        const dates = meetup.dates.filter((date) => {
            // return false if there is no one available on that day
            let atLeastOne = false;
            for (let dateTimeStr in meetup.selectionMap) {
                if (dateTimeStr.includes(date)) {
                    if (meetup.selectionMap[dateTimeStr].length > 0) {
                        atLeastOne = true;
                        break;
                    }
                }
            }
            return atLeastOne;
        });

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

        for (let date in newMap) {
            msg += `<b>${format(dateParser(date), "EEEE, d MMMM yyyy")}</b>\n`;

            for (let dateTimeStr in newMap[date]) {
                if (isSameAsPreviousTimeSlot(dateTimeStr, meetup)) {
                    // ignore
                    continue;
                }
                const startTime = getTime(dateTimeStr);
                const numOfConsecutiveSlots =
                    getNumberOfConsectiveSelectedTimeSlots(dateTimeStr, meetup);

                const endTime = startTime + numOfConsecutiveSlots.length * 30;

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
                    msg += `${i + 1}. @${person.username}\n`; // TODO: change this to first_name
                }
            }
        }

        msg += "\n";
    }

    msg += `Created on ${format(
        (meetup.date_created as unknown as Timestamp).toDate(),
        "dd MMM yyyy hh:mm aaa"
    )}\n`;
    return msg;
};

const generateSharedInlineReplyMarkup = (meetupId: string) => {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: "Indicate availability",
                        url: `https://t.me/${process.env.BOT_USERNAME}?start=indicate__${meetupId}`,
                    },
                ],
            ],
        },
    };
};

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
