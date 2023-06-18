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
import { ITelegramUser, Meetup, MeetupUserDetail } from "./types";
import {
    addHours,
    addMonths,
    format,
    isAfter,
    isBefore,
    subMonths,
} from "date-fns";
import {
    add30Minutes,
    convertDateIntoHumanReadable,
    convertDateTimeStrIntoHumanReadable,
    convertTimeIntoAMPM,
    dateParser,
    getDate,
    getNumberOfConsectiveSelectedTimeSlots,
    getTime,
    isSameAsPreviousTimeSlot,
} from "./utils/dates";

import { generateProgressBar } from "./utils/functions";
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

            // don't do anything if the meetup is not created through telegram
            if (meetup.creator.type !== "telegram") {
                return;
            }
            if (change.type === "added") {
                // console.log("New: ", change.doc.data());
                if (meetup.creatorInfoMessageId === 0) {
                    bot.telegram
                        .sendMessage(
                            meetup.creator.id,
                            generateMessageText(meetup, true),
                            {
                                ...generateCreatorReplyMarkup(meetup),
                                disable_web_page_preview: true,
                            }
                        )
                        .then((msg) => {
                            const msgId = msg.message_id;
                            updateDoc(
                                doc(
                                    collection(db, COLLECTION_NAME),
                                    change.doc.id
                                ),
                                {
                                    ...meetup,

                                    messages: [
                                        {
                                            chat_id: msg.chat.id,
                                            message_id: msgId,
                                        },
                                    ],
                                    creatorInfoMessageId: msgId,
                                } as Meetup
                            );
                            bot.telegram.pinChatMessage(msg.chat.id, msgId);
                        });
                    previousMeetupMap[meetup.id] = meetup.users;
                }
            }
            if (change.type === "modified") {
                console.log("Modified: ", change.doc.data());
                const meetup = change.doc.data() as Meetup;
                meetup.id = change.doc.id;
                editMessages(meetup);

                // Notification service on reply count hit
                if (
                    !meetup.notified &&
                    meetup.users.length >= meetup.options.notificationThreshold
                ) {
                    notifyCreator(meetup);

                    // note: this updateDoc triggers another onSnapshot
                    updateDoc(
                        doc(collection(db, COLLECTION_NAME), change.doc.id),
                        {
                            ...meetup,
                            notified: true,
                        } as Meetup
                    );

                    // use an else if to prevent the next if from running because updateDoc will trigger
                } else if (meetup.options.notifyOnEveryResponse !== 0) {
                    notifyCreatorOnChange(meetup, change.doc.id);
                }
            }
            if (change.type === "removed") {
                console.log("Removed: ", change.doc.data());
                const meetup = change.doc.data() as Meetup;
                meetup.id = change.doc.id;
                editMessagesToMarkDeleted(
                    meetup,
                    `Your meetup has been deleted!`
                );
                delete previousMeetupMap[meetup.id];
            }
        });
    },
});

bot.start(async (ctx) => {
    // createUserIfNotExists(ctx.message.from);
    if (ctx.startPayload.startsWith("indicate__")) {
        const meetupId = ctx.startPayload.split("__")[1];
        ctx.reply(
            `Please click the button below to indicate your availability.`,
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

    if (searchQuery.trim().length < 2) {
        return await ctx.answerInlineQuery([], {
            // cache_time: 0,
            switch_pm_parameter: "inline",
            switch_pm_text: "Create a new meetup",
        });
    }

    const userMeetupsRef = collection(db, COLLECTION_NAME);
    const q = query(
        userMeetupsRef,
        where("creator.id", "==", ctx.from.id.toString()), // NOTE: this is a string
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
        switch_pm_parameter: "inline",
        switch_pm_text: "Create a new meetup",
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

bot.on("callback_query", async (ctx) => {
    try {
        // @ts-ignore
        const cbData = ctx.callbackQuery.data;
        if (!ctx.from) return;

        if (cbData.startsWith("end__")) {
            const id = cbData.replace("end__", "");
            const docRef = doc(db, COLLECTION_NAME, id);
            updateDoc(docRef, {
                isEnded: true,
            });
            // deleteDoc(docRef);
            ctx.answerCbQuery("Meetup ended!");
        }
        if (cbData.startsWith("stop_notify__")) {
            const id = cbData.replace("stop_notify__", "");
            const docRef = doc(db, COLLECTION_NAME, id);
            updateDoc(docRef, {
                "options.notifyOnEveryResponse": 0,
            });
            ctx.answerCbQuery("Notifications stopped!");
            delete previousMeetupMap[id];
        }

        if (cbData.startsWith("start_notify__")) {
            const id = cbData.replace("start_notify__", "");
            const docRef = doc(db, COLLECTION_NAME, id);
            const meetup = await getDoc(docRef);
            updateDoc(docRef, {
                "options.notifyOnEveryResponse": 1,
            });
            ctx.answerCbQuery("Notifications enabled!");
            previousMeetupMap[id] = (meetup.data() as Meetup).users;
        }

        if (cbData.startsWith("cannot__")) {
            const id = cbData.replace("cannot__", "");
            const userId = ctx.from.id.toString();

            // get meetup
            const docRef = doc(db, COLLECTION_NAME, id);
            const meetup = (await getDoc(docRef)).data() as Meetup;

            const u = meetup.users.find((u) => u.user.id.toString() === userId);

            // TODO: change to structuredClone
            const newSelectionMap: {
                [dateOrTimeStr: string]: ITelegramUser[];
            } = JSON.parse(JSON.stringify(meetup.selectionMap));

            u?.selected.forEach((s) => {
                newSelectionMap[s] = newSelectionMap[s].filter(
                    (user) => user.id.toString() !== userId
                );
                if (newSelectionMap[s].length === 0) {
                    delete newSelectionMap[s];
                }
            });

            const cannotMakeIt =
                [
                    ...meetup.cannotMakeIt,
                    {
                        comments: "",
                        user: {
                            ...ctx.from,
                            id: ctx.from.id.toString(),
                            type: "telegram",
                        },
                    },
                ] || [];

            // remove from users
            const newUsers = meetup.users.filter(
                (u) => u.user.id.toString() !== userId
            );

            updateDoc(docRef, {
                selectionMap: newSelectionMap,
                cannotMakeIt: cannotMakeIt,
                users: newUsers,
            });
        }
    } catch (e: any) {
        ctx.answerCbQuery(`Error: ${e.toString()}`);
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
                    generateMessageText(
                        meetup,
                        message.chat_id?.toString() === meetup.creator.id
                    ),
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
                    generateMessageText(
                        meetup,
                        message.chat_id?.toString() === meetup.creator.id
                    ),
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
const generateMessageText = (meetup: Meetup, admin: boolean = false) => {
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

    // if (meetup.isFullDay) {
    //     msg += `<i>Type: 📅 Full day </i>\n\n`;
    // } else {
    //     msg += `<i>Type: 🕒 Part-day </i>\n\n`;
    // }

    console.log(meetup);
    msg += `👥 <b>Responded: ${numResponded}${
        meetup.options.limitNumberRespondents !== Number.MAX_VALUE
            ? ` / ${meetup.options.limitNumberRespondents}`
            : ""
    }</b>\n\n`;

    // add the advanced settings
    // if any of the advanced settings have changed, let the users know
    if (
        // meetup.options.limitNumberRespondents !== Number.MAX_VALUE ||
        meetup.options.limitPerSlot !== Number.MAX_VALUE ||
        meetup.options.limitSlotsPerRespondent !== Number.MAX_VALUE ||
        (admin && meetup.options.notificationThreshold !== Number.MAX_VALUE)
    ) {
        msg += `<b>⚙️ Advanced settings</b>\n`;

        // if (meetup.options.limitNumberRespondents !== Number.MAX_VALUE) {
        //     msg += `Max. # of respondents: ${meetup.options.limitNumberRespondents}\n`;
        // }
        if (meetup.options.limitPerSlot !== Number.MAX_VALUE) {
            msg += `Max. # of respondents / slot: ${meetup.options.limitPerSlot}\n`;
        }
        // Not in use for now
        // if (meetup.options.limitSlotsPerRespondent !== Number.MAX_VALUE) {
        //     msg += `Maximum number of slots per respondent: ${meetup.options.limitSlotsPerRespondent}\n`;
        // }

        if (
            admin &&
            meetup.options.notificationThreshold !== Number.MAX_VALUE
        ) {
            msg += `Notification threshold: ${meetup.options.notificationThreshold}\n`;
        }
        msg += "\n";
    }

    let defaultMsg = msg;
    if (meetup.isFullDay) {
        const dates = Object.keys(meetup.selectionMap).sort();
        for (let date of dates) {
            const people = meetup.selectionMap[date];
            msg += `<b>${format(dateParser(date), "EEEE, d MMMM yyyy")}</b>\n`;
            const percent = Math.round((people.length / numResponded) * 100);
            msg += `${generateProgressBar(percent)}\n`;
            for (let i in people) {
                const person = people[i];

                if (person.type === "telegram") {
                    msg += `${Number(i) + 1}. <a href="t.me/${
                        person.username
                    }">${person.first_name}</a>\n`; // TODO: change this to first_name
                } else {
                    msg += `${Number(i) + 1}. ${person.first_name}\n`;
                }
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
                    )} - ${convertTimeIntoAMPM(endTime)}</b>\n`;
                    msg += `${generateProgressBar(percent)}\n`;

                    for (let i in newMap[date][dateTimeStr]) {
                        const person = newMap[date][dateTimeStr][i];
                        if (person.type === "telegram") {
                            msg += `${Number(i) + 1}. <a href="t.me/${
                                person.username
                            }">${person.first_name}</a>\n`; // TODO: change this to first_name
                        } else {
                            msg += `${Number(i) + 1}. ${person.first_name}\n`;
                        }
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

    if (meetup.cannotMakeIt.length) {
        // there are people who cannot make it
        msg += `<b><u>Cannot make it (${meetup.cannotMakeIt.length})</u></b>\n`;
        for (let u of meetup.cannotMakeIt) {
            msg += `<a href="t.me/${u.user.username}"><b>${u.user.first_name}</b></a>\n`;
        }
        msg += "\n";
    }

    let footer = ``;

    // footer += `<i>Click <a href='https://t.me/${process.env.BOT_USERNAME}/meetup'>here</a> to create your own meetup!</i>\n\n`;

    if (admin) {
        footer += `<i>🔗 For a sharable link, copy <a href='https://t.me/${process.env.BOT_USERNAME}/meetup?startapp=indicate__${meetup.id}'>this link</a></i>\n\n`;
    }

    footer += `<i><a href='${BASE_URL}meetup/${meetup.id}'>🌐 View this meetup in your browser</a></i>\n\n`;

    footer += `<i><a href='t.me/${process.env.BOT_USERNAME}?start=indicate__${meetup.id}'>ℹ️ Click here if the Indicate button does not work.</a></i>\n\n`;

    // to account for the server having an incorrect timestamp
    // this won't work if the user is not in GMT+8. Server is in UTC0
    if (admin)
        footer += `Created on ${format(
            addHours((meetup.date_created as unknown as Timestamp).toDate(), 8),
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
    const res: any[] = [
        [
            // {
            //     text: "View meetup details",
            //     url: `${BASE_URL}meetup/${meetup.id}`,
            // },
        ],
    ];
    if (!meetup.isEnded) {
        // res[0].push({
        //     text: "Indicate availability (macOS)",
        //     url: `https://t.me/${process.env.BOT_USERNAME}?start=indicate__${meetup.id}`,
        // });
        res[0].push({
            text: "Indicate your availability",
            url: `https://t.me/${process.env.BOT_USERNAME}/l4t?startapp=indicate__${meetup.id}&startApp=indicate__${meetup.id}`,
        });
        res[1] = [
            {
                text: "❌ I cannot make it",
                callback_data: `cannot__${meetup.id}`,
            },
        ];
    } else {
        res[0].push({
            text: "View meetup details",
            url: `${BASE_URL}meetup/${meetup.id}/`,
        });
    }
    return {
        reply_markup: {
            inline_keyboard: res,
            // [
            //     {
            //         text: "test button",
            //         url: `https://t.me/${process.env.BOT_USERNAME}/meetup?startapp=indicate__${meetup.id}`,
            //     },
            // ],
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
                            url: `${BASE_URL}meetup/${meetup.id}/`,
                        },
                    },
                ],
                [
                    {
                        text: "Edit meetup",
                        web_app: {
                            url: `${BASE_URL}meetup/${meetup.id}/edit/`,
                        },
                    },
                    {
                        text: "End meetup",
                        callback_data: `end__${meetup.id}`,
                    },
                ],
                [
                    meetup.options.notifyOnEveryResponse === 0
                        ? {
                              text: "🔔 Get notified on every reply",
                              callback_data: `start_notify__${meetup.id}`,
                          }
                        : {
                              text: "🔕 Stop receiving notifications",
                              callback_data: `stop_notify__${meetup.id}`,
                          },
                ],
            ],
        },
    };
};

/**
 * Notify the creator when the number of people who responded has hit the threshold
 *
 * @param meetup The meetup that got updated
 */
const notifyCreator = (meetup: Meetup) => {
    const creatorId = meetup.creator.id;
    const msgId = meetup.creatorInfoMessageId;

    const msg = `❗️ Your meetup <b><u><a href='${BASE_URL}meetup/${meetup.id}'>${meetup.title}</a></u></b> has reached ${meetup.options.notificationThreshold} responses!`;

    // send message to creator
    bot.telegram.sendMessage(creatorId, msg, {
        parse_mode: "HTML",
    });
};

/**
 * Store the previous meetups so that we can compare the number of responses
 */
const previousMeetupMap: { [meetupId: string]: MeetupUserDetail[] } = {};

/**
 * Notify the creator based on their notification settings
 *
 * @param meetup The meetup that got updated
 *
 */
const notifyCreatorOnChange = (meetup: Meetup, meetupId: string) => {
    // this is a failsafe.
    // if the bot crashed and restarted, we don't want to accidentally notify everybody.
    // the downside of doing is is that the first response after a restart will not be notified
    if (!previousMeetupMap[meetupId]) {
        previousMeetupMap[meetupId] = meetup.users;
        return;
    }

    const previousMeetup = previousMeetupMap[meetupId];
    // get the NEW responses
    const newResponses = meetup.users.filter(
        (u) =>
            !previousMeetupMap[meetupId].find(
                (u2) => u2.user.id.toString() === u.user.id.toString()
            )
    );

    // for every user in the new responses, check to see whether they've changed their responses
    const changes: {
        [userId: string]: {
            added: string[]; // dateTimeStr or dateStr
            removed: string[];
        };
    } = {};

    const batchedChanges: {
        [userId: string]: {
            added: [string, string][];
            removed: [string, string][];
        };
    } = {};

    meetup.users.forEach((nu) => {
        // nu = new user, ou = old user
        const newSelected = nu.selected;
        const oldSelected = previousMeetup.find(
            (ou) => ou.user.id.toString() === nu.user.id.toString()
        )?.selected;

        if (!oldSelected) {
            // if the user is new, set everything to added
            changes[nu.user.id.toString()] = {
                added: newSelected,
                removed: [],
            };
        } else {
            // check what's in newSelected that isn't in oldSelected
            const added = newSelected.filter((s) => !oldSelected?.includes(s));
            // check what's in oldSelected that isn't in newSelected
            const removed = oldSelected?.filter(
                (s) => !newSelected.includes(s)
            );
            changes[nu.user.id.toString()] = {
                added,
                removed,
            };
        }
    });

    // convert batchedChanges
    // only for time-based meetups
    // [930::2023-06-21, 960::2023-06-21, 990::2023-06-21] => [[930::2023-06-21, 1020::2023-06-21]  ]

    if (!meetup.isFullDay) {
        for (const userId in changes) {
            let added: [string, string][] = [];
            let removed: [string, string][] = [];

            if (changes[userId].added.length > 0) {
                let i = 0;
                let tempAdded: [string, string] = ["", ""];

                // we want the loop to run at least once (for the case with 1 element)
                do {
                    let dateTimeStr = changes[userId].added[i];
                    if (!tempAdded[0]) {
                        // set the start to the first date
                        tempAdded[0] = dateTimeStr;
                        i++;
                    } else if (!tempAdded[1]) {
                        // check if we should set the end timing.
                        // condition to set the end timing: the next timing is not consecutive
                        const thisTiming = getTime(dateTimeStr);
                        const nextTiming = getTime(
                            changes[userId].added[i + 1]
                        );
                        if (nextTiming - thisTiming !== 30) {
                            // not consectuive
                            tempAdded[1] = add30Minutes(dateTimeStr); // add 30 mins to this
                            added.push(tempAdded);
                            tempAdded = ["", ""];
                            i++;
                        } else {
                            // consectuive, continue
                            i++;
                        }
                    }
                } while (i < changes[userId].added.length - 1);
                if (tempAdded[0] && !tempAdded[1]) {
                    // if we have a start time but no end time, set the end time to the last time + 30 min
                    tempAdded[1] = add30Minutes(changes[userId].added.at(-1)!); // assert: the last item always exists (array is never empty)
                    added.push(tempAdded);
                }
            }

            if (changes[userId].removed.length > 0) {
                let i = 0;
                let tempRemoved: [string, string] = ["", ""];

                // we want the loop to run at least once (for the case with 1 element)
                do {
                    let dateTimeStr = changes[userId].removed[i];
                    if (!tempRemoved[0]) {
                        // set the start to the first date
                        tempRemoved[0] = dateTimeStr;
                        i++;
                    } else if (!tempRemoved[1]) {
                        // check if we should set the end timing.
                        // condition to set the end timing: the next timing is not consecutive

                        const thisTiming = getTime(dateTimeStr);
                        const nextTiming = getTime(
                            changes[userId].removed[i + 1]
                        );
                        if (nextTiming - thisTiming !== 30) {
                            // not consectuive
                            tempRemoved[1] = add30Minutes(dateTimeStr); // add 30 mins to this
                            removed.push(tempRemoved);
                            tempRemoved = ["", ""];
                            i++;
                        } else {
                            // consectuive, continue
                            i++;
                        }
                    }
                } while (i < changes[userId].removed.length - 1);
                if (tempRemoved[0] && !tempRemoved[1]) {
                    // if we have a start time but no end time, set the end time to the last time + 30 min
                    tempRemoved[1] = add30Minutes(
                        changes[userId].removed.at(-1)!
                    ); // assert: the last item always exists (array is never empty)
                    removed.push(tempRemoved);
                }
            }

            batchedChanges[userId] = {
                added,
                removed,
            };
        }
    }

    // check to see if any users removed their indication
    // only keep the users who removed their indication (aka not in the new users)
    const removed = previousMeetup.filter(
        (ou) =>
            !meetup.users.find(
                (nu) => nu.user.id.toString() === ou.user.id.toString()
            )
    );

    let updateMsg = `<b><u><a href='${BASE_URL}meetup/${meetupId}'> ${meetup.title} has been updated!</a></u></b>\n\n`;

    if (removed.length) {
        updateMsg += `<b>🗑 Users who removed their indication: </b>\n`;
        removed.forEach((ou, index) => {
            updateMsg += `${index + 1}. <a href='https://t.me/${
                ou.user.username
            }'>${ou.user.first_name}</a>\n`;
        });

        updateMsg += `\n`;
    }

    if (Object.keys(batchedChanges).length || Object.keys(changes).length) {
        updateMsg += `<b>✨ Users who changed their indications / new users: </b>\n`;

        if (!meetup.isFullDay)
            Object.keys(batchedChanges).forEach((userId, index) => {
                const user = meetup.users.find(
                    (u) => u.user.id.toString() === userId
                )?.user;

                if (!user) {
                    // smth went wrong, there should be a user
                } else {
                    let userChanges = `<b>${index + 1}. <a href='https://t.me/${
                        user.username
                    }'> ${user.first_name} </a></b>\n`;
                    if (batchedChanges[userId].added.length) {
                        // userChanges += `<u> Added </u>\n`;
                        batchedChanges[userId].added.forEach((s) => {
                            userChanges += `➕ ${convertDateTimeStrIntoHumanReadable(
                                s[0]
                            )} — ${convertDateTimeStrIntoHumanReadable(
                                s[1]
                            )}\n`;
                        });
                        userChanges += `\n`;
                    }

                    if (batchedChanges[userId].removed.length) {
                        // userChanges += `<u> Removed </u>\n`;
                        batchedChanges[userId].removed.forEach((s) => {
                            userChanges += `➖ ${convertDateTimeStrIntoHumanReadable(
                                s[0]
                            )} — ${convertDateTimeStrIntoHumanReadable(
                                s[1]
                            )}\n`;
                        });
                        userChanges += `\n`;
                    }
                    userChanges += `\n`;
                    updateMsg += userChanges;
                }
            });
        else
            Object.keys(changes).forEach((userId, index) => {
                const user = meetup.users.find(
                    (u) => u.user.id.toString() === userId
                )?.user;

                if (!user) {
                    // smth went wrong, there should be a user
                } else {
                    let userChanges = `<b>${index + 1}. <a href='https://t.me/${
                        user.username
                    }'> ${user.first_name} </a></b>\n`;
                    if (changes[userId].added.length) {
                        userChanges += `<u> Added </u>\n`;
                        changes[userId].added.forEach((s) => {
                            userChanges += `⟶ ${convertDateIntoHumanReadable(
                                s
                            )}\n`;
                        });
                        userChanges += `\n`;
                    }

                    if (changes[userId].removed.length) {
                        userChanges += `<u> Removed </u>\n`;
                        changes[userId].removed.forEach((s) => {
                            userChanges += `⟶ ${convertDateIntoHumanReadable(
                                s
                            )}\n`;
                        });
                        userChanges += `\n`;
                    }
                    userChanges += `\n`;
                    updateMsg += userChanges;
                }
            });
    }

    // if there was a bug and non of the fields has something, dont send anything
    if (!removed.length && !Object.keys(changes).length) {
        return;
    }

    // send message to creator
    bot.telegram
        .sendMessage(meetup.creator.id, updateMsg, {
            reply_to_message_id: meetup.creatorInfoMessageId,
            parse_mode: "HTML",
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: "🔕 Stop receiving notifications",
                            callback_data: `stop_notify__${meetupId}`,
                        },
                    ],
                ],
            },
            disable_web_page_preview: true,
        })
        .then(() => {
            // update the previous meetup
            previousMeetupMap[meetupId] = meetup.users;
        });
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
                subMonths(new Date(), 1)
            )
        ) {
            // deleteDoc(doc.ref);
            delete previousMeetupMap[doc.id];
            console.log("found doc that's expired");
        }
    });
};

// TODO: disabled for now
// clear notifications data every day
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
