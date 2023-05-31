import { initializeApp } from "firebase/app";
import { getAuth, onAuthStateChanged } from "firebase/auth";
import {
    getFirestore,
    collection,
    query,
    where,
    getDocs,
    addDoc,
    onSnapshot,
    doc,
    setDoc,
} from "firebase/firestore";
import { ITelegramUser } from "./types";

import dotenv from "dotenv";
/**
 * https://firebase.google.com/docs/firestore/query-data/listen#listen_to_multiple_documents_in_a_collection
 * https://stackoverflow.com/questions/48606611/firestore-listen-to-update-on-the-entire-collection
 */
dotenv.config();
// config value from add firebase sdk script that showed earlier.
const config = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: "meetup-8903c.firebaseapp.com",
    projectId: "meetup-8903c",
    storageBucket: "meetup-8903c.appspot.com",
    messagingSenderId: "316721016041",
    appId: process.env.FIREBASE_APPID,
    measurementId: "G-41KSDTV1L5",
};

// init app
const fire = initializeApp(config);

const db = getFirestore(fire);
// collection name

const COLLECTION_NAME = process.env.COLLECTION_NAME || "meetups";
console.log(COLLECTION_NAME);

export { db, COLLECTION_NAME };

/**
 * https://firebase.google.com/docs/firestore/query-data/listen#view_changes_between_snapshots
 */

export const createUserIfNotExists = async (
    user: ITelegramUser
): Promise<ITelegramUser> | never => {
    const dbRef = doc(db, "users", user.id.toString());
    try {
        const docRef = await setDoc(dbRef, user);

        return {
            ...user,
        } as ITelegramUser;
    } catch (e) {
        console.log(e);
        throw e;
    }
};

// export default snapshot;
console.log("db.ts ran");
export default db;
