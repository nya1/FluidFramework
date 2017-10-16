// tslint:disable

import * as random from "random-js";
import * as MergeTree from "./mergeTree";
import * as ops from "./ops";
import * as fs from "fs";

export function loadTextFromFile(filename: string, mergeTree: MergeTree.MergeTree, segLimit = 0) {
    let content = fs.readFileSync(filename, "utf8");
    return loadText(content, mergeTree, segLimit);
}

export function loadSegments(content: string, segLimit: number, markers = false) {
    content = content.replace(/^\uFEFF/, "");
    const seq = MergeTree.UniversalSequenceNumber;
    const cli = MergeTree.LocalClientId;
    let withProps = true;

    let paragraphs = content.split('\r\n');
    for (let i = 0, len = paragraphs.length; i < len; i++) {
        paragraphs[i] = paragraphs[i].replace(/\r\n/g, ' ').replace(/\u201c|\u201d/g, '"').replace(/\u2019/g, "'");
        if (!markers) {
            paragraphs[i] += "\n";
        }
    }
    let segments = <MergeTree.Segment[]>[];
    for (let paragraph of paragraphs) {
        let pgMarker: MergeTree.Marker;
        if (markers) {
            pgMarker = MergeTree.Marker.make(ops.MarkerBehaviors.Tile,
                { [MergeTree.reservedTileLabelsKey]: ["pg"] }, seq, cli);
        }
        if (withProps) {
            if (paragraph.indexOf("Chapter") >= 0) {
                if (markers) {
                    pgMarker.addProperties({ header: 2 });
                    segments.push(new MergeTree.TextSegment(paragraph, seq, cli));
                }
                else {
                    segments.push(MergeTree.TextSegment.make(paragraph, { fontSize: "140%", lineHeight: "150%" }, seq, cli));
                }
            } else {
                let emphStrings = paragraph.split("_");
                for (let i = 0, len = emphStrings.length; i < len; i++) {
                    if (i & 1) {
                        if (emphStrings[i].length > 0) {
                            segments.push(MergeTree.TextSegment.make(emphStrings[i], { fontStyle: "italic" }, seq, cli));
                        }
                    }
                    else {
                        if (emphStrings[i].length > 0) {
                            segments.push(new MergeTree.TextSegment(emphStrings[i], seq, cli));
                        }
                    }
                }
            }
        } else {
            segments.push(new MergeTree.TextSegment(paragraph, seq, cli));
        }
        if (markers) {
            segments.push(pgMarker);
        }
    }

    if (segLimit > 0) {
        segments.length = segLimit;
    }

    return segments;
}

export function loadText(content: string, mergeTree: MergeTree.MergeTree, segLimit: number, markers = false) {
    const segments = loadSegments(content, segLimit, markers);
    mergeTree.reloadFromSegments(segments);
    // console.log(`Number of Segments: ${segments.length}`);
    // console.log(`Height: ${mergeTree.getStats().maxHeight}`);
    //console.log(segTree.toString());
    return mergeTree;
}

let mt = random.engines.mt19937();
mt.seedWithArray([0xdeadbeef, 0xfeedbed]);

export function findRandomWord(mergeTree: MergeTree.MergeTree, clientId: number) {
    let len = mergeTree.getLength(MergeTree.UniversalSequenceNumber, clientId);
    let pos = random.integer(0, len)(mt);
    // let textAtPos = mergeTree.getText(MergeTree.UniversalSequenceNumber, clientId, pos, pos + 10);
    // console.log(textAtPos);
    let nextWord = mergeTree.searchFromPos(pos, /\s\w+\b/);
    if (nextWord) {
        nextWord.pos += pos;
        // console.log(`next word is '${nextWord.text}' len ${nextWord.text.length} at pos ${nextWord.pos}`);
    }
    return nextWord;
}

