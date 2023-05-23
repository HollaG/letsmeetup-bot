/**
 * Generates a Unicode progress bar.
 *
 * @example
 * const str = generateProgressBar(50)
 * // str -> ║■■■■■■□□□□□║
 *
 * @param percent The percentage the bar is filled, from 0 to 100
 */
export const generateProgressBar = (percent: number) => {
    const numFilledBoxes = Math.floor(percent / 10);
    const numEmptyBoxes = 10 - numFilledBoxes;
    return `|${"■".repeat(numFilledBoxes)}${"□".repeat(
        numEmptyBoxes
    )}| ${percent}%`;
};
