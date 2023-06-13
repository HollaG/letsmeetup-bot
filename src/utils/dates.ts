import { format, parse } from "date-fns";
import { Meetup } from "../types";

/**
 * Parses the date string into a Date object using the standard ISO date format.
 *
 * @param dateStr the string to be parsed
 * @returns Date object
 */
export const dateParser = (dateStr: string) => {
    return parse(dateStr, "yyyy-MM-dd", new Date());
};

/**
 * Encodes the date object into a string using the standard ISO date format.
 *
 * @param date the date object to be encoded
 * @returns string
 *
 */
export const dateEncoder = (date: Date) => {
    return format(date, "yyyy-MM-dd");
};

/**
 * Converts a date encoded string into a human-readable date.
 *
 * @param dateStr the date string to be converted
 * @returns a nicely formatted string
 */
export const convertDateIntoHumanReadable = (dateStr: string) => {
    const date = dateParser(dateStr);
    return format(date, "dd MMM yyyy");
};

/**
 * Converts a date-time encoded string into a human-readable date.
 *
 * @param dateTimeStr the date string to be converted
 * @returns a nicely formatted string
 */
export const convertDateTimeStrIntoHumanReadable = (dateTimeStr: string) => {
    const date = getDate(dateTimeStr);
    const time = getTime(dateTimeStr);

    return `${convertDateIntoHumanReadable(date)} ${convertTimeIntoAMPM(time)}`;
};

/**
 * Returns the date from the formatted string, if it contains the encode separator.
 *
 * @param str The string to be parsed
 * @returns the date
 */
export const getDate = (str: string) => {
    if (str.includes("::")) {
        return str.split("::")[1];
    } else {
        return str;
    }
};
/**
 * Returns the date from the formatted string, if it contains the encode separator.
 *
 * @param str The string to be parsed
 * @returns the time
 */

export const getTime = (str: string) => {
    if (str.includes("::")) {
        return Number(str.split("::")[0]);
    } else {
        return 0;
    }
};

/**
 * Converts a numerical value from 0 to 24*60 into a human-readable time string of the format
 * "hh:mm am/pm".
 *
 * @param time The time in minutes
 * @returns a nicely formatted string
 */
export const convertTimeIntoAMPM = (time: number) => {
    const hours = Math.floor(time / 60);
    const minutes = time % 60;
    const ampm = hours >= 12 ? "pm" : "am";
    const formattedHours = hours % 12 || 12;
    const formattedMinutes = minutes < 10 ? `0${minutes}` : minutes;
    return `${formattedHours}:${formattedMinutes} ${ampm}`;
};

/**
 * Checks to see if the next timing has people who selected it.
 *
 * e.g. if the current time is 12:00pm, and the next time is 12:30pm,
 * this function will check if anyone selected 12:30pm
 *
 * If the next time slot is the next day, always return false
 *
 * @param dateTimeStr the current time to check the next date of
 * @returns true if the next time slot has people who selected it
 */
export const hasPeopleInNextTimeSlot = (
    dateTimeStr: string,
    meetup: Meetup
) => {
    const [time, date] = dateTimeStr.split("::");
    const nextTime = parseInt(time) + 30;
    if (parseInt(time) + 30 >= 24 * 60) {
        // it's the next day, ALWAYS render the stop.
        return false;
    }
    const nextDateTimeStr = `${nextTime}::${date}`;
    const stat = meetup.selectionMap[nextDateTimeStr]
        ? meetup.selectionMap[nextDateTimeStr].length > 0
        : false;
    return stat;
};

/**
 * Checks to see if the PREVIOUS timing has the same # of people and the same people in it.
 * If so, we can merge the two time slots together and don't render THIS current time slot.
 *
 * @param dateTimeStr the current time to check the previous date of
 * @returns true if the previous time slot has the same people and the same # of people    *
 *
 */
export const isSameAsPreviousTimeSlot = (
    dateTimeStr: string,
    meetup: Meetup
) => {
    const [time, date] = dateTimeStr.split("::");
    const prevTime = parseInt(time) - 30;
    if (parseInt(time) < 0) {
        // it's the previous day
        return false;
    }

    const prevDateTimeStr = `${prevTime}::${date}`;
    const curSelected = meetup.selectionMap[dateTimeStr];
    const previousSelected = meetup.selectionMap[prevDateTimeStr];
    if (
        !previousSelected ||
        !curSelected ||
        (previousSelected && previousSelected.length != curSelected.length)
    ) {
        return false;
    }

    // check if the two arrays have the same contents
    const temp: { [key: number]: number } = {};
    curSelected.forEach((user) => (temp[user.id] = 1));
    const isSame = previousSelected.every((user) => temp[user.id] === 1);

    return isSame;
};

/**
 * Checks to see if the NEXT timing has the same # of people and the same people in it.
 * If so, we can merge the two time slots together and don't render THIS current time slot.
 *
 * @param dateTimeStr the current time to check the previous date of
 * @returns true if the previous time slot has the same people and the same # of people    *
 *
 */
export const isSameAsNextTimeSlot = (dateTimeStr: string, meetup: Meetup) => {
    const [time, date] = dateTimeStr.split("::");
    const nextTime = parseInt(time) + 30;
    if (parseInt(time) >= 24 * 60) {
        // it's the previous day
        return false;
    }

    const nextDateTimeStr = `${nextTime}::${date}`;
    const curSelected = meetup.selectionMap[dateTimeStr];
    const nextSelected = meetup.selectionMap[nextDateTimeStr];
    if (
        !nextSelected ||
        !curSelected ||
        (nextSelected && nextSelected.length != curSelected.length)
    ) {
        return false;
    }

    // check if the two arrays have the same contents
    const temp: { [key: number]: number } = {};
    curSelected.forEach((user) => (temp[user.id] = 1));
    const isSame = nextSelected.every((user) => temp[user.id] === 1);

    return isSame;
};

/**
 * Checks to see how many of the next time slots have the same # of people and the same people in it.
 *
 * Stops counting at midnight.
 *
 * @param dateTimeStr the current date and time to check
 * @returns An array [0, 1, ..., n-1] where n and
 * length is equal to the number of consecutive time slots that have the same # of people and the same people in it.
 */
export const getNumberOfConsectiveSelectedTimeSlots = (
    dateTimeStr: string,
    meetup: Meetup
) => {
    const [time, date] = dateTimeStr.split("::");
    let nextTime = parseInt(time) + 30;
    let count = 0;
    while (true) {
        if (nextTime >= 24 * 60) {
            // it's the next day, we stop counting here
            break;
        }
        if (isSameAsPreviousTimeSlot(`${nextTime}::${date}`, meetup)) {
            count++;
            nextTime += 30;
        } else {
            break;
        }
    }
    return Array.from(Array(count).keys());
};

/**
 * Adds 30 minutes to a date-time-str.
 */
export const add30Minutes = (dateTimeStr: string) => {
    const [time, date] = dateTimeStr.split("::");
    let nextTime = parseInt(time) + 30;
    if (nextTime === 24 * 60) nextTime = nextTime - 1;
    return `${nextTime}::${date}`;
};
